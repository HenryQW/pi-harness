#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { checkActionRuntime, disableInspectorSignal, loadActions } from "./actions.mjs";
import { approvalServer, localApproval, probeOutput, runOp, socketPath } from "./bridge.mjs";
import { sshAlias, stopWhenIdle } from "./launcher.mjs";
import { connectHerdr, detectHost, matchesProof, sharedConnection, ssh, trustedConnection, verifyConnection } from "./ssh.mjs";

const exec = promisify(execFile);
const proofDigest = /^[a-f0-9]{64}$/;
const macIdentity = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

const usage = `Usage:
  pi-1password pair <remote-socket> <pi-user> <pi-host-names> --host-proof <digest> [--approval-mac <id>] [--actions-file <absolute-path>]
  pi-1password serve <ssh-host> <remote-socket> [--host-proof <digest>] [--approval-mac <id>] [--actions-file <absolute-path>]

Use the command from /1password pair to start a foreground approval terminal.`;

/** @param {string[]} shared @param {"forward" | "cancel"} operation @param {string} reverse @param {string} host */
async function sharedForward(shared, operation, reverse, host) {
	const { stderr } = await exec(ssh, [...shared, "-O", operation, "-R", reverse, "--", host], {
		timeout: 6000, killSignal: "SIGKILL",
	});
	// OpenSSH can report a refused cancellation on stderr with a zero exit status.
	if (stderr.trim()) throw new Error(stderr.trim());
}

/**
 * @param {string} host
 * @param {string} remoteSocket
 * @param {string | undefined} actionsFile
 * @param {string | undefined} proof
 * @param {boolean} [launched]
 * @param {{user: string, hints: string[]} | "herdr"} [detect]
 * @param {string} [expectedIdentity]
 */
async function serve(host, remoteSocket, actionsFile, proof, launched = false, detect, expectedIdentity) {
	if (process.platform !== "darwin" || !process.stdin.isTTY || !process.stderr.isTTY) {
		throw new Error("Start the approval terminal on a Mac with 1Password desktop integration.");
	}
	if (!detect && !sshAlias.test(host)) {
		throw new Error("Use an OpenSSH host alias or user@hostname.");
	}
	if (launched && !detect && process.env.SSH_ORIGINAL_COMMAND) {
		throw new Error("The launcher only accepts a terminal connection without a command.");
	}
	if (actionsFile && !checkActionRuntime()) {
		process.execve?.(process.execPath, [process.execPath, disableInspectorSignal, ...process.argv.slice(1)], process.env);
		throw new Error("Cannot restart the companion with signal-triggered debugging disabled.");
	}
	const approval = await localApproval();
	if (!approval) throw new Error("Install the native 1Password CLI on the approval Mac.");
	if (launched && detect && (await stat("/dev/console")).uid !== process.getuid?.()) {
		throw new Error("Use the logged-in desktop account on the selected Approval Mac.");
	}
	if (expectedIdentity && approval.identity !== expectedIdentity) {
		throw new Error("Run this command on the selected Approval Mac.");
	}
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
	const controller = new AbortController();
	/** @type {string[] | null} */
	let control = null;
	/** @type {(() => Promise<void>) | undefined} */
	let closeConnection;
	let forwarded = false;
	const reverse = `${remoteSocket}:${localSocket}`;
	const stop = () => {
		stopping = true;
		controller.abort();
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
		if (detect === "herdr" && proof) {
			const route = await connectHerdr(remoteSocket, proof, dir, controller.signal);
			({ host, control } = route);
		} else if (detect && detect !== "herdr" && proof) {
			const route = await detectHost(detect.hints, detect.user, remoteSocket, proof, dir, controller.signal);
			({ host, control, close: closeConnection } = route);
		} else if (!launched && proof) {
			const shared = await sharedConnection(host, await probeOutput(ssh, ["-GT", "--", host]));
			const route = await verifyConnection([{ host, shared }], remoteSocket, proof, dir, controller.signal);
			if (!route) throw new Error(`Cannot verify the Pi host through ${host}. Check the SSH alias and run /1password pair again.`);
			({ control, close: closeConnection } = route);
		}
		if (!stopping && control) {
			try {
				await sharedForward(control, "forward", reverse, host);
				forwarded = true;
			} catch (error) {
				// A timed-out request may have allocated a forward before the reply arrived.
				forwarded = error instanceof Error && "killed" in error && error.killed === true;
				throw error;
			}
		}
		if (stopping && !forwarded) return;
		tunnel = spawn(ssh, [
			"-Tax", ...trustedConnection, "-o", "ExitOnForwardFailure=yes",
			...(control ?? ["-o", "ControlPath=none",
				"-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=2", "-o", "ConnectTimeout=10", "-R", reverse]),
			"--", host, "/bin/sh -s",
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
		if (!accepted) throw new Error(proof
			? "Cannot verify the Pi host. Check its SSH alias and run /1password pair again."
			: "Secure Shell setup failed. Check the host, private remote directory, socket permissions, and extra access grants.");
		if (launched) cancelIdle = stopWhenIdle(server, stop);
		server.listen(localSocket);
		await once(server, "listening");
		await chmod(localSocket, 0o600);
		if (stopping) return;
		const state = control && !closeConnection ? "Reusing the SSH connection." : "SSH tunnel connected.";
		const note = launched ? "Ready for requests from the Pi host." : `Keep this terminal open for ${host}.`;
		process.stderr.write(`Approval Mac ${hostname()}. ${state} ${note}\n`);
		await done;
		if (!stopping) throw new Error("The Secure Shell tunnel disconnected.");
	} catch (error) {
		if (!stopping || !(error instanceof Error) || error.name !== "AbortError") throw error;
	} finally {
		cancelIdle();
		tunnel?.stdin.end();
		tunnel?.kill();
		if (control && forwarded) {
			try {
				await sharedForward(control, "cancel", reverse, host);
			} catch {
				if (!closeConnection) {
					process.stderr.write(`Cannot confirm removal of the SSH forward for ${host}. Close the shared connection if reconnection fails.\n`);
					process.exitCode = 1;
				}
			}
		}
		await closeConnection?.();
		for (const signal of stopSignals) process.off(signal, stop);
		await new Promise((resolve) => {
			server.close(resolve);
			server.closeAllConnections();
		});
		await rm(dir, { recursive: true, force: true });
	}
}

/** @param {string[]} args */
async function main(args) {
	const [command, first, second, ...rest] = args;
	if ((command === undefined || command === "--help") && first === undefined) {
		process.stdout.write(`${usage}\n`);
		return;
	}
	if (command === "_ondemand" && first && second === "--host-proof" && rest.length === 3) {
		const [proof, flag, identity] = rest;
		if (proofDigest.test(proof) && flag === "--approval-mac" && macIdentity.test(identity)) {
			await serve("", socketPath(first), undefined, proof, true, "herdr", identity);
			return;
		}
	}
	if (command === "pair" && first && second && /^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(second)) {
		const [names, flag, proof, ...options] = rest;
		const hints = names?.split(",");
		const supplied = approvalOptions(options);
		if (flag === "--host-proof" && proofDigest.test(proof) && hints?.every((hint) => sshAlias.test(hint) && !hint.includes("@")) && supplied) {
			await serve("", socketPath(first), supplied.actionsFile, proof, false, { user: second, hints }, supplied.identity);
			return;
		}
	}
	if (command === "serve" && first && second) {
		const checked = rest[0] === "--host-proof";
		const proof = checked ? rest[1] : undefined;
		const options = approvalOptions(checked ? rest.slice(2) : rest);
		if (sshAlias.test(first) && (!checked || (proof && proofDigest.test(proof))) && options) {
			await serve(first, socketPath(second), options.actionsFile, proof, false, undefined, options.identity);
			return;
		}
	}
	const [proof, ...afterProof] = rest;
	if (command === "_launch" && first && second && proofDigest.test(proof) && validActionArgs(afterProof)) {
		await serve(first, socketPath(second), afterProof[1], proof, true);
		return;
	}
	throw new Error(usage);
}

/** @param {string[]} args */
function approvalOptions(args) {
	const identity = args[0] === "--approval-mac" ? args[1] ?? "" : undefined;
	const remaining = identity === undefined ? args : args.slice(2);
	if ((identity !== undefined && !macIdentity.test(identity)) || !validActionArgs(remaining)) return null;
	return { identity, actionsFile: remaining[1] };
}

/** @param {string[]} args */
function validActionArgs(args) {
	return args.length === 0 || (args.length === 2 && args[0] === "--actions-file" && Boolean(args[1]));
}

main(process.argv.slice(2)).catch((error) => {
	process.stderr.write(`pi-1password: ${error.message}\n`);
	process.exitCode = 1;
});
