import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { lstat, readFile, readdir, stat } from "node:fs/promises";
import { isIP } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { probeOutput } from "./bridge.mjs";
import { pairingProof, sshAlias } from "./launcher.mjs";

const exec = promisify(execFile);
export const ssh = "/usr/bin/ssh";
export const trustedConnection = ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "UpdateHostKeys=no",
	"-o", "PermitLocalCommand=no", "-o", "ForkAfterAuthentication=no"];

/** @param {string} output @param {string} digest */
export function matchesProof(output, digest) {
	const token = output.trim();
	return pairingProof.test(token) && createHash("sha256").update(token).digest("hex") === digest;
}

/** @param {string} host @param {string | null} config @param {typeof probeOutput} [probe] */
export async function sharedConnection(host, config, probe = probeOutput) {
	const path = /^controlpath (.+)$/m.exec(config ?? "")?.[1];
	if (!path) return null;
	// Use only this master, without also loading any forwards from the alias.
	const options = ["-F", "none", "-S", path.replaceAll("%", "%%"), "-o", "ProxyCommand=/usr/bin/false"];
	const active = await probe(ssh, [...options, "-O", "check", "--", host]);
	return active === null ? null : options;
}

/** @param {string} host @param {typeof probeOutput} probe @param {boolean} [scan] */
async function herdrConnections(host, probe, scan = false) {
	const uid = process.getuid?.();
	if (uid === undefined) return [];
	const dir = `/tmp/hssh-${uid}`;
	const info = await lstat(dir).catch((error) => { if (error.code !== "ENOENT") throw error; });
	if (!info?.isDirectory() || info.uid !== uid || (info.mode & 0o7777) !== 0o700) return [];
	// Herdr 0.9.5 stores a private master per config and destination. OpenSSH
	// expands %C from the effective host, port, login and jump host.
	/** @type {string | undefined} */
	let suffix;
	if (!scan) {
		const config = await probe(ssh, ["-GT", "-S", `${dir}/%C`, "--", host]);
		suffix = /^controlpath .*\/([a-f0-9]{40})$/m.exec(config ?? "")?.[1];
		if (!suffix) return [];
	}
	const names = (await readdir(dir, { withFileTypes: true })).filter((entry) => entry.isSocket() &&
		/^[a-f0-9]{24}-[a-f0-9]{40}$/.test(entry.name) && (!suffix || entry.name.endsWith(`-${suffix}`)));
	return Promise.all(names.map(async ({ name }) => ({ host,
		shared: await sharedConnection(host, `controlpath ${dir}/${name}`, probe),
	})));
}

/**
 * @param {string} socket
 * @param {string} proof
 * @param {string} dir
 * @param {AbortSignal} signal
 * @param {typeof probeOutput} [probe]
 * @param {typeof herdrConnections} [herdr]
 */
export async function connectHerdr(socket, proof, dir, signal, probe = probeOutput, herdr = herdrConnections) {
	// A mux client needs a destination argument. The socket selects the actual
	// host, and ProxyCommand prevents a fallback connection if the master exits.
	const routes = await herdr("localhost", probe, true);
	const connection = await verifyConnection(routes, socket, proof, dir, signal, probe, async () => null);
	if (connection) return connection;
	throw new Error("No active Herdr SSH tunnel reaches the Pi host. Connect to it from Herdr on the Approval Mac.");
}

/** @param {string} host @param {typeof probeOutput} [probe] */
async function configuration(host, probe = probeOutput) {
	return probe(ssh, ["-GT", "--", host]);
}

/** @param {string} path */
async function optionalFile(path) {
	try {
		return (await stat(path)).isFile() ? await readFile(path, "utf8") : "";
	} catch (error) {
		if (error instanceof Error && "code" in error && ["ENOENT", "EACCES", "EPERM"].includes(String(error.code))) return "";
		throw error;
	}
}

/** @param {string} hint */
async function configAliases(hint) {
	// OpenSSH expands Include directives and reports which files it read.
	const { stderr } = await exec(ssh, ["-GvT", "--", hint], { timeout: 6000, killSignal: "SIGKILL" })
		.catch((error) => {
			if (typeof error.stderr !== "string") throw error;
			return { stderr: error.stderr };
		});
	const paths = new Set(Array.from(stderr.matchAll(/^debug1: Reading configuration data (\/[^\r\n]+)$/gm), (match) => match[1]));
	const files = await Promise.all(Array.from(paths, optionalFile));
	return files.flatMap((file) => Array.from(file.matchAll(/^\s*Host[\t =]+([^\r\n#]+)/gim), (match) =>
		match[1].trim().split(/\s+/).map((host) => host.replace(/^(?:"([^"]+)"|'([^']+)')$/, "$1$2"))).flat());
}

/** @param {string} config */
async function knownHosts(config) {
	// OpenSSH prints expanded paths without quotes. Each absolute path starts with a slash.
	const paths = new Set(Array.from(config.matchAll(/^(?:user|global)knownhostsfile (.+)$/gm), (match) => match[1].split(/\s+(?=\/)/)).flat());
	const files = await Promise.all(Array.from(paths).filter((path) => path.startsWith("/")).map(optionalFile));
	return files.flatMap((file) => Array.from(file.matchAll(/^[\t ]*(?:@cert-authority[\t ]+)?([^@\s#|][^\s]*)\s+/gm),
		(match) => match[1].split(",")).flat());
}

/** @param {string} host */
async function resolveAddresses(host) {
	return Promise.race([
		lookup(host, { all: true, family: 4 }).then((entries) => entries.map(({ address }) => address), (error) => {
			if (["ENOTFOUND", "EAI_AGAIN", "ENODATA"].includes(error.code)) return [];
			throw error;
		}),
		delay(1500, [], { ref: false }),
	]);
}

/**
 * @param {string[]} hints Validated Pi host names and addresses, with at least one entry.
 * @param {string} user Validated SSH user name.
 * @param {string} socket Validated Pi host socket path.
 * @param {string} proof
 * @param {string} dir Private working directory socket path prefix.
 * @param {AbortSignal} signal
 * @param {{ probe?: typeof probeOutput, aliases?: typeof configAliases, known?: typeof knownHosts, connect?: typeof openConnection, resolve?: typeof resolveAddresses, herdr?: typeof herdrConnections }} [sources]
 */
export async function detectHost(hints, user, socket, proof, dir, signal, {
	probe = probeOutput, aliases = configAliases, known = knownHosts, connect = openConnection, resolve = resolveAddresses,
	herdr = herdrConnections,
} = {}) {
	const hostLabel = (/** @type {string} */ name) => isIP(name) ? name : name.split(".")[0];
	const names = new Set(hints.map((hint) => hostLabel(hint.toLowerCase())));
	const addresses = new Set(hints.filter((hint) => isIP(hint) === 4));
	const matches = (/** @type {string | undefined} */ host) => names.has(hostLabel(host?.toLowerCase() ?? ""));
	/** @type {Map<string, Promise<boolean>>} */
	const resolved = new Map();
	const matchesAddress = (/** @type {string | undefined} */ host) => {
		if (!addresses.size || !host || isIP(host)) return false;
		let match = resolved.get(host);
		if (!match) {
			match = resolve(host).then((result) => result.some((address) => addresses.has(address)));
			resolved.set(host, match);
		}
		return match;
	};
	const configs = await Promise.all(hints.map((hint) => configuration(hint, probe)));
	const direct = (await known(configs.filter(Boolean).join("\n"))).flatMap((entry) => {
		const [, host = entry, port] = /^\[([^\]]+)\]:([0-9]{1,5})$/.exec(entry) ?? [];
		if (!sshAlias.test(host) || host.includes("@") || !matches(host)) return [];
		if (!port) return [`${user}@${host}`];
		return Number(port) > 0 && Number(port) <= 65535 ? [`ssh://${user}@${host}:${port}`] : [];
	});
	const configured = (await aliases(hints[0])).filter((host) => sshAlias.test(host) && !host.includes("@"));
	const candidates = Array.from(new Set([
		...configured, ...configured.map((host) => `${user}@${host}`), ...direct, ...hints.map((host) => `${user}@${host}`),
	]));
	/** @type {{host: string, shared: string[] | null}[]} */
	const routes = [];
	for (let start = 0; start < candidates.length; start += 8) {
		signal.throwIfAborted();
		const results = await Promise.all(candidates.slice(start, start + 8).map(async (host) => {
			const config = await configuration(host, probe);
			if (!config) return null;
			const name = /^host (.+)$/m.exec(config)?.[1];
			const address = /^hostname (.+)$/m.exec(config)?.[1];
			if (!matches(name) && !matches(address) && !await matchesAddress(address)) return null;
			const tunnels = await herdr(host, probe);
			const shared = await sharedConnection(host, config, probe);
			return [...tunnels, { host, shared }];
		}));
		for (const route of results) if (route) routes.push(...route);
	}
	const connection = await verifyConnection(routes, socket, proof, dir, signal, probe, connect);
	if (connection) return connection;
	throw new Error("Cannot find a trusted SSH route to the Pi host. Run /1password pair <pi-host-alias> in Pi to set the alias.");
}

/**
 * @param {{host: string, shared: string[] | null}[]} routes
 * @param {string} socket
 * @param {string} proof
 * @param {string} dir
 * @param {AbortSignal} signal
 * @param {typeof probeOutput} [probe]
 * @param {typeof openConnection} [connect]
 * @returns {Promise<{host: string, control: string[], close?: () => Promise<void>} | null>}
 */
export async function verifyConnection(routes, socket, proof, dir, signal, probe = probeOutput, connect = openConnection) {
	const verified = async (/** @type {string} */ host, /** @type {string[]} */ control) => {
		signal.throwIfAborted();
		const output = await probe(ssh, ["-nTax", ...trustedConnection, "-o", "ClearAllForwardings=yes",
			...control, "--", host, `/bin/cat '${socket}.pair'`]);
		return output !== null && matchesProof(output, proof);
	};
	for (const { host, shared } of routes) {
		if (shared && await verified(host, shared)) return { host, control: shared };
	}
	for (const [index, { host }] of routes.entries()) {
		signal.throwIfAborted();
		const connection = await connect(host, `${dir}/ssh-${index}`, signal);
		if (!connection) continue;
		try {
			if (await verified(host, connection.control)) return { host, ...connection };
		} catch (error) {
			await connection.close();
			throw error;
		}
		await connection.close();
	}
	signal.throwIfAborted();
	return null;
}

/** @param {string} host @param {string} path @param {AbortSignal} signal */
async function openConnection(host, path, signal) {
	const child = spawn(ssh, ["-MNax", ...trustedConnection, "-o", "ClearAllForwardings=yes", "-o", "ControlPersist=no",
		"-o", "ConnectTimeout=3", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=2", "-S", path, "--", host],
		{ stdio: "ignore" });
	let finished = false;
	child.on("error", () => { finished = true; });
	const ended = new Promise((resolve) => child.once("close", resolve));
	const close = async () => { child.kill(); await ended; };
	const deadline = Date.now() + 5000;
	try {
		while (!finished && child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
			signal.throwIfAborted();
			if ((await stat(path).catch((error) => { if (error.code !== "ENOENT") throw error; }))?.isSocket()) {
				return { control: ["-F", "none", "-S", path, "-o", "ProxyCommand=/usr/bin/false"], close };
			}
			await delay(50, undefined, { signal });
		}
	} catch (error) {
		await close();
		throw error;
	}
	await close();
	return null;
}
