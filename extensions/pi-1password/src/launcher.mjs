import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ApprovalDisconnectedError, approvalStatus, checkAccessGrants, checkProtectedAncestors, prepareSocketDirectory, probeOutput } from "./bridge.mjs";

export const sshAlias = /^(?:[a-zA-Z0-9_][a-zA-Z0-9_.-]*@)?[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
export const pairingProof = /^[a-zA-Z0-9_-]{32}$/;
const login = /^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/;
const publicKey = /^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI[a-zA-Z0-9+/]{43}$/;
const idleMs = 10 * 60_000;

/** @param {unknown} value */
export function launchUser(value) {
	if (typeof value !== "string" || !login.test(value)) throw new Error("Use the macOS login name on the Approval Mac.");
	return value;
}

/** @param {string} value */
export function shellQuote(value) {
	return `'${value.replaceAll("'", "'\\''")}'`;
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

/** @param {string} path */
export async function createLauncherKey(path) {
	await prepareSocketDirectory(join(dirname(path), "op.sock"));
	try {
		await checkKey(path);
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
		const dir = await mkdtemp(join(dirname(path), "key-"));
		const temporary = join(dir, "key");
		try {
			if (await probeOutput("/usr/bin/ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", temporary]) === null) {
				throw new Error("Cannot generate the Secure Shell launcher key.");
			}
			await link(temporary, path).catch((error) => { if (error.code !== "EEXIST") throw error; });
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}
	await checkKey(path);
	const output = await probeOutput("/usr/bin/ssh-keygen", ["-y", "-P", "", "-f", path]);
	const key = output?.trim().split(/\s+/).slice(0, 2).join(" ");
	if (!key || !publicKey.test(key)) throw new Error("Cannot read the Secure Shell launcher public key.");
	return key;
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

/** @param {string} key @param {string[]} argv */
export function authorizationLine(key, argv) {
	if (!publicKey.test(key)) throw new Error("Use the launcher public key from Pi.");
	if (argv.some((part) => /\p{C}/u.test(part))) throw new Error("Launcher arguments must be on one line.");
	const script = 'if [ -n "${SSH_ORIGINAL_COMMAND:-}" ] || [ ! -t 0 ]; then ' +
		'printf "%s\\n" "The launcher only accepts a terminal connection without a command." >&2; exit 1; ' +
		'fi; exec /usr/bin/env -i "$@"';
	const command = `exec ${["/bin/sh", "-c", script, "pi-1password", `HOME=${homedir()}`, "PATH=/usr/bin:/bin", ...argv].map(shellQuote).join(" ")}`
		.replace(/[\\"]/g, "\\$&");
	return `restrict,pty,command="${command}" ${key} ${labelForKey(key)}`;
}

/** @param {string} key */
function labelForKey(key) {
	return `pi-1password-${createHash("sha256").update(key).digest("hex").slice(0, 12)}`;
}

/** @param {string} key @param {string[]} argv */
export async function authorizeLauncher(key, argv) {
	const line = authorizationLine(key, argv);
	const dir = join(await realpath(homedir()), ".ssh");
	await mkdir(dir, { mode: 0o700 }).catch((error) => { if (error.code !== "EEXIST") throw error; });
	const path = join(dir, "authorized_keys");
	const parents = await checkProtectedAncestors(path);
	if ((await lstat(dir)).uid !== process.getuid?.()) throw new Error("Use an SSH directory owned by your user.");
	await checkAccessGrants(parents);
	const file = await open(path, constants.O_RDWR | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
	try {
		const stat = await file.stat();
		if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o7022)) {
			throw new Error("Use an authorized_keys file owned by your user without write access for other users.");
		}
		await checkAccessGrants([path]);
		if (stat.size > 1024 * 1024) throw new Error("The authorized_keys file is too large to update.");
		const existing = (await file.readFile("utf8")).split("\n");
		if (!existing.includes(line)) {
			if (existing.some((entry) => entry.includes(key))) {
				throw new Error(`Remove the old ${labelForKey(key)} entry for this key before changing its command.`);
			}
			await file.writeFile(`\n${line}\n`);
		}
		return line.slice(line.lastIndexOf(" ") + 1);
	} finally {
		await file.close();
	}
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

	/** @param {{ socket: string, identity: string, host: string, port: string, user: string, key: string, trust?: string[] }} route */
	async start({ socket, identity, host, port, user, key, trust = [] }) {
		try {
			await checkKey(key);
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") {
				throw new Error("No launcher key matches this route. Pair it again with /1password pair.");
			}
			throw error;
		}
		if (this.#closed) throw new Error("The Pi session ended before the approval terminal could start.");
		const previous = this.#running.get(socket);
		if (previous) return previous.ready;
		// Ignore user client options so only the dedicated key can authenticate this connection.
		const child = spawn("/usr/bin/ssh", [
			"-F", "/dev/null", "-ttax", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
			"-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none", "-o", "CertificateFile=none",
			"-o", "ClearAllForwardings=yes", "-o", "ConnectTimeout=5", "-o", "ServerAliveInterval=15",
			"-o", "ServerAliveCountMax=2", ...trust, "-i", key, "-l", user, "-p", port, "--", host,
		], { stdio: ["pipe", "ignore", "ignore"] });
		const closed = new AbortController();
		const signal = AbortSignal.any([closed.signal, AbortSignal.timeout(15_000)]);
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
				throw new Error("Cannot start the paired approval terminal. Check its pairing, SSH host trust, and reverse tunnel.");
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
