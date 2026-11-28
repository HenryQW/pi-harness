import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { link, lstat, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ApprovalDisconnectedError, approvalStatus, checkAccessGrants, checkProtectedAncestors, prepareSocketDirectory, probeOutput } from "./bridge.mjs";

export const sshAlias = /^(?:[a-zA-Z0-9_][a-zA-Z0-9_.-]*@)?[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
export const pairingProof = /^[a-zA-Z0-9_-]{32}$/;
const login = /^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/;
const idleMs = 10 * 60_000;

/** @param {unknown} value */
export function launchUser(value) {
	if (typeof value !== "string" || !login.test(value)) throw new Error("Use the macOS login name on the Approval Mac.");
	return value;
}

/** @param {string[]} args */
export async function launcherKey(args) {
	const name = createHash("sha256").update(JSON.stringify(args)).digest().subarray(0, 16).toString("base64url");
	return join(await realpath(homedir()), ".pi-1password", `launch-${name}`);
}

/** @param {string} path */
async function checkKey(path) {
	const key = await lstat(path);
	if (!key.isFile() || key.uid !== process.getuid?.() || (key.mode & 0o7777) !== 0o600) {
		throw new Error("Use a private 0600 file owned by your user.");
	}
	await checkAccessGrants([path, ...await checkProtectedAncestors(path)]);
}

/** @param {string} socket */
export async function pairingToken(socket) {
	await prepareSocketDirectory(socket);
	const path = `${socket}.pair`;
	try {
		await checkKey(path);
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
		const dir = await mkdtemp(join(dirname(socket), "pair-"));
		try {
			const token = join(dir, "token");
			await writeFile(token, `${randomBytes(24).toString("base64url")}\n`, { mode: 0o600 });
			await link(token, path).catch((error) => { if (error.code !== "EEXIST") throw error; });
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}
	await checkKey(path);
	const token = (await readFile(path, "utf8")).trim();
	if (!pairingProof.test(token)) throw new Error("The Pi host pairing proof is invalid.");
	return token;
}

/** @param {import('node:http').Server} server @param {() => void} stop @param {number} [interval] */
export function stopWhenIdle(server, stop, interval = idleMs) {
	let timer = setTimeout(stop, interval);
	let active = true;
	let pending = 0;
	/** @param {import('node:http').IncomingMessage} request @param {import('node:http').ServerResponse} response */
	const track = (request, response) => {
		if (request.method !== "POST") return;
		clearTimeout(timer);
		pending++;
		response.once("close", () => { if (--pending === 0 && active) timer = setTimeout(stop, interval); });
	};
	server.on("request", track);
	return () => { active = false; clearTimeout(timer); server.off("request", track); };
}

/** @param {string} target @param {typeof probeOutput} [probe] */
export async function launcherAddress(target, probe = probeOutput) {
	const output = await probe("/usr/bin/ssh", ["-G", "--", target]);
	const host = /^hostname (\S+)$/m.exec(output ?? "")?.[1];
	const port = /^port (\d{1,5})$/m.exec(output ?? "")?.[1];
	if (host && port && Number(port) >= 1 && Number(port) <= 65535 && (isIP(host) || /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(host))) {
		const trust = [];
		for (const option of ["hostkeyalias", "userknownhostsfile", "globalknownhostsfile"]) {
			const value = new RegExp(`^${option} (.+)$`, "m").exec(output ?? "")?.[1];
			if (value) trust.push("-o", `${option}=${value}`);
		}
		return { host, port, trust };
	}
	throw new Error("Cannot resolve the Herdr machine address for the approval launcher.");
}

export class ApprovalLauncher {
	/** @type {Map<string, { close: () => void, ready: Promise<void> }>} */
	#running = new Map();
	#closed = false;

	close() {
		this.#closed = true;
		for (const connection of this.#running.values()) connection.close();
		this.#running.clear();
	}

	/** @param {string} socket */
	waitForStart(socket) {
		return this.#running.get(socket)?.ready;
	}

	/** @param {{ socket: string, identity: string, host: string, port: string, user: string, key: string, trust?: string[] }} route */
	async start({ socket, identity, host, port, user, key, trust = [] }) {
		try {
			await checkKey(key);
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") {
				throw new Error("No launcher key matches this route. Run /1password pair to get the start command.");
			}
			throw error;
		}
		this.#checkOpen();
		const previous = this.#running.get(socket);
		if (previous) return previous.ready;
		// Ignore user client options so only the dedicated key can authenticate this connection.
		return this.#start(socket, identity, [
			"-F", "/dev/null", "-ttax", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
			"-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none", "-o", "CertificateFile=none",
			"-o", "ClearAllForwardings=yes", "-o", "ConnectTimeout=5", "-o", "ServerAliveInterval=15",
			"-o", "ServerAliveCountMax=2", ...trust, "-i", key, "-l", user, "-p", port, "--", host,
		], 15_000);
	}

	/** @param {string} socket @param {string} identity @param {string} target @param {string} command */
	startOnDemand(socket, identity, target, command) {
		this.#checkOpen();
		const previous = this.#running.get(socket);
		if (previous) return previous.ready;
		return this.#start(socket, identity, [
			"-ttax", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "UpdateHostKeys=no",
			"-o", "ClearAllForwardings=yes", "-o", "PermitLocalCommand=no", "-o", "ForkAfterAuthentication=no",
			"-o", "ConnectTimeout=5", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=2",
			"--", target, command,
		], 45_000);
	}

	#checkOpen() {
		if (this.#closed) throw new Error("The Pi session ended before the approval terminal could start.");
	}

	/** @param {string} socket @param {string} identity @param {string[]} args @param {number} timeout */
	#start(socket, identity, args, timeout) {
		const child = spawn("/usr/bin/ssh", args, { stdio: ["pipe", "pipe", "ignore"] });
		let output = "";
		child.stdout.setEncoding("utf8").on("data", (chunk) => { output = (output + chunk).slice(-4096); });
		const closed = new AbortController();
		const signal = AbortSignal.any([closed.signal, AbortSignal.timeout(timeout)]);
		const ready = (async () => {
			try {
				while (!signal.aborted) {
					try {
						await approvalStatus(socket, signal, identity);
						return;
					} catch (error) {
						// OpenSSH binds the remote socket before the companion starts its listener.
						const code = error instanceof Error && "code" in error ? error.code : undefined;
						if (!(error instanceof ApprovalDisconnectedError) && code !== "EPIPE" && code !== "ECONNRESET") throw error;
						await delay(100, undefined, { signal });
					}
				}
				signal.throwIfAborted();
			} catch (error) {
				child.kill();
				if (!signal.aborted) throw error;
				const detail = /^pi-1password: ([ -~]+)\r?$/m.exec(output)?.[1];
				throw new Error(detail ?? "Cannot start the approval terminal. Run /1password pair to get the start command.");
			}
		})();
		const entry = { close: () => { closed.abort(); child.kill(); }, ready };
		this.#running.set(socket, entry);
		const finished = () => {
			closed.abort();
			if (this.#running.get(socket) === entry) this.#running.delete(socket);
		};
		child.once("error", finished);
		child.once("close", finished);
		return ready;
	}
}
