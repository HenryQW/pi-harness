#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { hostname, userInfo } from "node:os";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { checkActionRuntime, disableInspectorSignal, loadActions } from "./actions.mjs";
import { approvalServer, localApproval, probeOutput, runOp, socketPath } from "./bridge.mjs";
import { authorizeLauncher, pairingProof, sshAlias, stopWhenIdle } from "./launcher.mjs";

const usage = `Usage:
  pi-1password serve <ssh-host> <remote-socket> [--actions-file <absolute-path>]
  pi-1password authorize <ssh-host> <remote-socket> <proof-digest> <login> <mac-id> <public-key> [--actions-file <absolute-path>]`;

/** @param {string} output @param {string} digest */
function matchesProof(output, digest) {
	const token = output.trim();
	return pairingProof.test(token) && createHash("sha256").update(token).digest("hex") === digest;
}

/**
 * @param {string} host
 * @param {string} remoteSocket
 * @param {string | undefined} actionsFile
 * @param {string | undefined} proof
 */
async function serve(host, remoteSocket, actionsFile, proof) {
	const launched = proof !== undefined;
	if (process.platform !== "darwin" || !process.stdin.isTTY || !process.stderr.isTTY) {
		throw new Error("Start the approval terminal on a Mac with 1Password desktop integration.");
	}
	if (!sshAlias.test(host)) {
		throw new Error("Use an OpenSSH host alias or user@hostname.");
	}
	if (launched && process.env.SSH_ORIGINAL_COMMAND) {
		throw new Error("The launcher only accepts a terminal connection without a command.");
	}
	if (actionsFile && !checkActionRuntime()) {
		process.execve?.(process.execPath, [process.execPath, disableInspectorSignal, ...process.argv.slice(1)], process.env);
		throw new Error("Cannot restart the companion with signal-triggered debugging disabled.");
	}
	const approval = await localApproval();
	if (!approval) throw new Error("Install the native 1Password CLI on the approval Mac.");
	const actions = actionsFile ? await loadActions(actionsFile, approval.executable) : undefined;
	const dir = await mkdtemp("/tmp/pi-1password-");
	const localSocket = join(dir, "op.sock");
	const server = approvalServer({
		identity: approval.identity,
		actions,
		execute: (input, signal) => runOp(approval.executable, input, signal),
	});
	/** @type {import('node:child_process').ChildProcessByStdio<import('node:stream').Writable, import('node:stream').Readable, null> | undefined} */
	let tunnel;
	let stopping = false;
	let cancelIdle = () => {};
	const stop = () => {
		stopping = true;
		cancelIdle();
		server.close();
		server.closeAllConnections();
		tunnel?.stdin.end();
		setTimeout(() => tunnel?.kill(), 2000).unref();
	};
	/** @type {NodeJS.Signals[]} */
	const stopSignals = ["SIGHUP", "SIGINT", "SIGTERM"];
	for (const signal of stopSignals) process.once(signal, stop);
	try {
		// Check the remote directory before the local listener can receive requests.
		const remoteDir = dirname(remoteSocket);
		const checkRemote = [
			'uid=$(/usr/bin/id -u) || exit 1',
			`dir='${remoteDir}'`,
			`socket='${remoteSocket}'`,
			'darwin=$(/usr/bin/uname -s) || exit 1',
			'private_access() {',
			'  [ "$darwin" = Darwin ] || return 0',
			'  access=$(/bin/ls -dle "$@") || return 1',
			'  printf "%s\\n" "$access" | /usr/bin/grep -Eq "^[[:space:]]*[[:digit:]]+:.*[[:space:]]allow[[:space:]]"',
			'  [ "$?" -eq 1 ]',
			'}',
			'[ "$(/usr/bin/find "$dir" -prune -type d -user "$uid" -perm 0700 -print)" = "$dir" ] || exit 1',
			'private_access "$dir" || exit 1',
			'while [ "$dir" != / ]; do',
			'  dir=${dir%/*}; dir=${dir:-/}',
			'  [ "$(/usr/bin/find "$dir" -prune -type d \\( -user 0 -o -user "$uid" \\) \\( -perm -1000 -o \\( ! -perm -020 ! -perm -002 \\) \\) -print)" = "$dir" ] || exit 1',
			'  private_access "$dir" || exit 1',
			'done',
			'[ "$(/usr/bin/find "$socket" -prune -type s -user "$uid" -perm 0600 -print)" = "$socket" ] || exit 1',
			'inode=$(/bin/ls -id "$socket") || exit 1',
			'cleanup() { [ "$(/bin/ls -id "$socket" 2>/dev/null)" != "$inode" ] || /bin/rm -f "$socket"; }',
			"trap cleanup EXIT",
			"trap 'exit 0' HUP INT TERM",
			'private_access "$socket" || exit 1',
			proof ? '/bin/cat "$socket.pair" || exit 1' : "printf '%s\\n' pi-1password-ready",
			"/bin/cat >/dev/null",
		].join("\n");
		tunnel = spawn("/usr/bin/ssh", [
			"-Tax", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
			"-o", "ExitOnForwardFailure=yes", "-o", "ControlPath=none", "-o", "ForkAfterAuthentication=no",
			"-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=2", "-o", "ConnectTimeout=10",
			"-R", `${remoteSocket}:${localSocket}`, host, "/bin/sh -s",
		], { stdio: ["pipe", "pipe", "inherit"] });
		tunnel.stdin.on("error", () => tunnel?.kill());
		tunnel.stdin.write(`${checkRemote}\n`);
		const lines = createInterface({ input: tunnel.stdout });
		const done = once(tunnel, "close");
		const ended = done.then(() => false);
		const timeout = AbortSignal.timeout(15_000);
		const ready = once(lines, "line", { signal: timeout }).then(([line]) => proof ? matchesProof(line, proof) : line === "pi-1password-ready");
		const accepted = await Promise.race([ready, ended]);
		if (stopping) return;
		if (!accepted) throw new Error("Secure Shell setup failed. Check the host, private remote directory, socket permissions, and extra access grants.");
		if (launched) cancelIdle = stopWhenIdle(server, stop);
		server.listen(localSocket);
		await once(server, "listening");
		await chmod(localSocket, 0o600);
		if (stopping) return;
		process.stderr.write(`Approval Mac ${hostname()}. Keep this terminal open for ${host}.\n`);
		await done;
		if (!stopping) throw new Error("The Secure Shell tunnel disconnected.");
	} finally {
		cancelIdle();
		tunnel?.stdin.end();
		tunnel?.kill();
		for (const signal of stopSignals) process.off(signal, stop);
		await new Promise((resolve) => {
			server.close(resolve);
			server.closeAllConnections();
		});
		await rm(dir, { recursive: true, force: true });
	}
}

/** @param {string[]} args */
async function main([command, first, second, ...rest]) {
	if ((command === undefined || command === "--help") && first === undefined) {
		process.stdout.write(`${usage}\n`);
		return;
	}
	if (command === "serve" && first && second && validActionArgs(rest)) {
		await serve(first, socketPath(second), rest[1], undefined);
		return;
	}
	const [proof, ...afterProof] = rest;
	if (command === "_launch" && first && second && /^[a-f0-9]{64}$/.test(proof) && validActionArgs(afterProof)) {
		await serve(first, socketPath(second), afterProof[1], proof);
		return;
	}
	const [user, identity, key, ...options] = afterProof;
	if (command === "authorize" && first && second && /^[a-f0-9]{64}$/.test(proof) && user && identity && key && validActionArgs(options)) {
		if (process.platform !== "darwin" || !process.stdin.isTTY || process.env.SSH_CONNECTION) {
			throw new Error("Authorize the launcher in a local terminal on the Approval Mac.");
		}
		if (userInfo().username !== user) throw new Error("Run the pairing command under the selected desktop account.");
		const socket = socketPath(second);
		if (!sshAlias.test(first)) throw new Error("Use an OpenSSH host alias or user@hostname.");
		if (options[1] && (!isAbsolute(options[1]) || normalize(options[1]) !== options[1])) throw new Error("Use an absolute action file path.");
		const approval = await localApproval();
		if (!approval) throw new Error("Install the native 1Password CLI on the approval Mac.");
		if (approval.identity !== identity) throw new Error("Run the pairing command on the selected Approval Mac.");
		const reachable = await probeOutput("/usr/bin/ssh", [
			"-nTax", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ClearAllForwardings=yes",
			"-o", "ConnectTimeout=5", "--", first, `/bin/cat -- '${socket}.pair'`,
		]);
		if (!reachable || !matchesProof(reachable, proof)) throw new Error("Cannot verify this Pi host. Check its SSH alias, access, and the pairing command.");
		const label = await authorizeLauncher(key, [process.execPath, fileURLToPath(import.meta.url), "_launch", first, socket, proof, ...options]);
		process.stdout.write(`Paired ${hostname()} with key ${label}. Request a vault list in Pi to verify the approval terminal.\n`);
		return;
	}
	throw new Error(usage);
}

/** @param {string[]} args */
function validActionArgs(args) {
	return args.length === 0 || (args.length === 2 && args[0] === "--actions-file" && Boolean(args[1]));
}

main(process.argv.slice(2)).catch((error) => {
	process.stderr.write(`${error.message}\n`);
	process.exitCode = 1;
});
