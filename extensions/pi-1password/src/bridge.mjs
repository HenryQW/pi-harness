import { execFile } from "node:child_process";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { createServer, request } from "node:http";
import { dirname, isAbsolute, normalize } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const opPath = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin";
// 1Password's Developer ID signing requirement for the native CLI.
const opRequirement = 'anchor apple generic and identifier "com.1password.op" and certificate leaf[subject.OU] = "2BUA8C4S2C"';
export const probeScript = [
	`PATH=${opPath}; export PATH`,
	'test "$(/usr/bin/uname -s)" = Darwin || exit 1',
	'op=$(command -v op) || exit 1',
	`/usr/bin/codesign --verify --strict -R='${opRequirement}' "$op" || exit 1`,
	`identity=$(/usr/sbin/ioreg -rd1 -c IOPlatformExpertDevice | /usr/bin/awk -F '"' '$2 == "IOPlatformUUID" {print $4}')`,
	'printf "%s\\n" "$identity" "$op"',
	'exec "$op" --version',
].join("\n");

/** @param {string} output */
export function parseProbe(output) {
	const [identity, executable, version, extra] = output.trim().split("\n");
	if (!/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(identity) ||
		!executable?.startsWith("/") || !/^\d+\.\d+\.\d+(?:[-+][\w.+-]+)?$/.test(version) || extra !== undefined) return null;
	return { identity: identity.toLowerCase(), executable };
}

/** @param {string} file @param {string[]} args */
export async function probeOutput(file, args) {
	try {
		const { stdout } = await exec(file, args, { timeout: 6000, maxBuffer: 64 * 1024, killSignal: "SIGKILL" });
		return stdout;
	} catch {
		return null;
	}
}

/** @param {typeof probeOutput} [probe] */
export async function localApproval(probe = probeOutput) {
	if (process.platform !== "darwin") return null;
	const output = await probe("/bin/sh", ["-c", probeScript]);
	const approval = output && parseProbe(output);
	return approval ? { ...approval, executable: await realpath(approval.executable) } : null;
}
const requestBytes = 4096;
const resultBytes = 1024 * 1024;
const timeoutMs = 60_000;

/** @param {unknown} value @returns {value is string} */
export function isActionName(value) {
	return typeof value === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(value);
}

/** @param {unknown} value */
export function socketPath(value) {
	if (typeof value !== "string" || !isAbsolute(value) || normalize(value) !== value ||
		!/^\/[a-zA-Z0-9._/-]+$/.test(value) || value.endsWith("/") || Buffer.byteLength(value) > 100) {
		throw new Error("Use an absolute socket path of at most 100 bytes with no spaces or shell characters.");
	}
	return value;
}

/** @param {string} directory */
async function checkSocketDirectory(directory) {
	const stat = await lstat(directory);
	if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o7777) !== 0o700) {
		throw new Error("Use a private 0700 directory owned by your user for the approval socket.");
	}
}

/** @param {string} path */
export async function prepareSocketDirectory(path) {
	const directory = dirname(socketPath(path));
	const parents = await checkProtectedAncestors(directory);
	await checkAccessGrants(parents);
	try {
		await mkdir(directory, { mode: 0o700 });
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
	}
	await checkSocketDirectory(directory);
	await checkAccessGrants([directory]);
}

/** @param {string} path */
async function checkSocket(path) {
	const directory = dirname(socketPath(path));
	await checkSocketDirectory(directory);
	const parents = await checkProtectedAncestors(directory);
	const socket = await lstat(path);
	if (!socket.isSocket() || socket.uid !== process.getuid?.() || (socket.mode & 0o7777) !== 0o600) {
		throw new Error("Use a 0600 approval socket owned by your user.");
	}
	await checkAccessGrants([path, directory, ...parents]);
}

/** @param {string[]} paths */
export async function checkAccessGrants(paths) {
	if (process.platform !== "darwin") return;
	const access = await probeOutput("/bin/ls", ["-dle", "--", ...paths]);
	if (!access || /^\s*\d+:.*\ballow\s/m.test(access)) {
		throw new Error("Use approval files and parent directories without extra access grants.");
	}
}

/** @param {string} path */
export async function checkProtectedAncestors(path) {
	const uid = process.getuid?.();
	const paths = [];
	let ancestor = dirname(path);
	for (;;) {
		paths.push(ancestor);
		const stat = await lstat(ancestor);
		const untrustedWrite = (stat.mode & 0o022) !== 0 && (stat.mode & 0o1000) === 0;
		if (!stat.isDirectory() || (stat.uid !== 0 && stat.uid !== uid) || untrustedWrite) {
			throw new Error("Parent directories must belong to your user or root and protect their entries.");
		}
		const parent = dirname(ancestor);
		if (parent === ancestor) break;
		ancestor = parent;
	}
	return paths;
}

/**
 * @param {unknown} value
 * @returns {value is string}
 */
export function validText(value) {
	return typeof value === "string" && value.trim() === value && value.length > 0 &&
		Buffer.byteLength(value) <= 1024 && !/\p{C}/u.test(value);
}

/** @param {unknown} input */
export function opArgs(input) {
	if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid 1Password request.");
	const { operation, account, vault } = /** @type {Record<string, unknown>} */ (input);
	const accepted = ["operation", "account"];
	let args;
	switch (operation) {
		case "vaults":
			args = ["vault", "list", "--format=json"];
			break;
		case "items":
			accepted.push("vault");
			if (vault !== undefined && !validText(vault)) throw new Error("Invalid vault.");
			args = ["item", "list", "--format=json"];
			if (vault) args.push(`--vault=${vault}`);
			break;
		default:
			throw new Error("This route supports vault lists and item lists.");
	}
	if (Object.keys(input).some((key) => !accepted.includes(key))) throw new Error("Unexpected 1Password request field.");
	if (account !== undefined && !validText(account)) throw new Error("Invalid account.");
	if (account) args.push(`--account=${account}`);
	return args;
}

/**
 * @param {unknown} input
 * @returns {asserts input is { operation: "action", action: string }}
 */
export function checkActionRequest(input) {
	if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid 1Password action request.");
	const { operation, action } = /** @type {Record<string, unknown>} */ (input);
	if (operation !== "action" || !isActionName(action) || Object.keys(input).length !== 2) {
		throw new Error("Send only an approved 1Password action name.");
	}
}

/**
 * @param {string} operation
 * @param {unknown} rows
 */
export function metadata(operation, rows) {
	if (!Array.isArray(rows)) throw new Error("1Password returned invalid list data.");
	return rows.map((row) => {
		if (!row || typeof row.id !== "string") throw new Error("1Password returned invalid list data.");
		if (operation === "vaults") return { id: row.id, name: String(row.name ?? "") };
		return {
			id: row.id,
			title: String(row.title ?? ""),
			category: String(row.category ?? ""),
			vault: { id: String(row.vault?.id ?? ""), name: String(row.vault?.name ?? "") },
		};
	});
}

/**
 * @param {string} executable
 * @param {{ operation: string }} input
 * @param {AbortSignal} [signal]
 */
export async function runOp(executable, input, signal) {
	const stdout = await runNativeOp(executable, opArgs(input), signal);
	return metadata(input.operation, parseMessage(stdout));
}

/**
 * @param {string} executable
 * @param {string[]} args
 * @param {AbortSignal} [signal]
 */
export async function runNativeOp(executable, args, signal) {
	signal?.throwIfAborted();
	// Use desktop authentication even if Pi or the shell has a service token.
	const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("OP_")));
	env.OP_BIOMETRIC_UNLOCK_ENABLED = "true";
	env.PATH = opPath;
	/** @type {string} */
	let stdout;
	try {
		const pending = exec(executable, args, { env, signal, encoding: "utf8", timeout: timeoutMs, maxBuffer: resultBytes, killSignal: "SIGKILL" });
		const closed = new Promise((resolve) => pending.child.once("close", resolve));
		try {
			({ stdout } = await pending);
		} finally {
			await closed;
		}
	} catch (error) {
		const code = error instanceof Error && "code" in error ? error.code : undefined;
		if (code === "ENOENT") throw new Error("Install the native 1Password CLI on the approval Mac.");
		if (code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") throw new Error("1Password output exceeded the limit.");
		throw new Error("1Password did not complete the request. Check approval and desktop integration on the selected Mac.");
	}
	return stdout;
}

/** @param {string} data */
function parseMessage(data) {
	try {
		return JSON.parse(data);
	} catch {
		throw new Error("Invalid JSON in 1Password response or request.");
	}
}

/**
 * @param {import('node:http').IncomingMessage} stream
 * @param {number} limit
 */
async function body(stream, limit) {
	const chunks = [];
	let length = 0;
	for await (const chunk of stream) {
		length += chunk.length;
		if (length > limit) throw new Error("1Password message exceeded the size limit.");
		chunks.push(chunk);
	}
	return parseMessage(Buffer.concat(chunks, length).toString("utf8"));
}

const actionErrors = Object.freeze({
	unavailable: "This approval Mac has no grant for that action.",
	mismatch: "This tunnel does not match the selected approval Mac. Check its socket and select it again.",
	busy: "The approval Mac is handling another request.",
	failed: "The approved action failed. Check 1Password and the configured service on the approval Mac.",
});

/** @param {{ identity: string, execute: (input: { operation: string }, signal: AbortSignal) => Promise<unknown>, actions?: ReadonlyMap<string, (signal: AbortSignal) => Promise<void>> }} options */
export function approvalServer({ identity, execute, actions = new Map() }) {
	let busy = false;
	return createServer({ headersTimeout: 5000, requestTimeout: 5000, keepAliveTimeout: 1000 }, async (req, res) => {
		res.setHeader("content-type", "application/json");
		if (req.method === "GET" && req.url === "/status") {
			if (req.headers["x-pi-approval-mac"] !== identity) {
				res.writeHead(403).end();
				return;
			}
			const output = JSON.stringify({ busy, actions: Array.from(actions.keys()).sort() });
			if (Buffer.byteLength(output) > resultBytes) {
				res.writeHead(500).end();
				return;
			}
			res.end(output);
			return;
		}
		if (req.method !== "POST" || req.url !== "/op") {
			res.writeHead(404).end();
			return;
		}
		const controller = new AbortController();
		res.once("close", () => controller.abort());
		let acquired = false;
		try {
			const input = await body(req, requestBytes);
			controller.signal.throwIfAborted();
			if (input?.operation === "action") {
				checkActionRequest(input);
				const action = actions.get(input.action);
				const error = req.headers["x-pi-approval-mac"] !== identity ? "mismatch" : busy ? "busy" : !action ? "unavailable" : null;
				if (error || !action) {
					res.writeHead(400).end(JSON.stringify({ actionError: error }));
					return;
				}
				busy = acquired = true;
				try {
					await action(controller.signal);
				} catch {
					res.writeHead(400).end(JSON.stringify({ actionError: "failed" }));
					return;
				}
				res.end(JSON.stringify({ completed: true }));
				return;
			}
			opArgs(input);
			if (req.headers["x-pi-approval-mac"] !== identity) throw new Error(actionErrors.mismatch);
			if (busy) throw new Error(actionErrors.busy);
			busy = acquired = true;
			const result = await execute(input, controller.signal);
			const output = JSON.stringify({ result });
			if (Buffer.byteLength(output) > resultBytes) throw new Error("1Password output exceeded the limit.");
			res.end(output);
		} catch (error) {
			res.writeHead(400).end(JSON.stringify({ error: error instanceof Error ? error.message : "1Password request failed." }));
		} finally {
			if (acquired) busy = false;
		}
	});
}

/**
 * @param {string} path
 * @param {string | undefined} payload
 * @param {AbortSignal | undefined} signal
 * @param {string} identity
 * @returns {Promise<unknown>}
 */
async function send(path, payload, signal, identity) {
	try {
		await checkSocket(path);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") {
			throw new Error("The approval Mac is disconnected. Start its Secure Shell tunnel or select another target.");
		}
		throw error;
	}
	const status = payload === undefined;
	const deadline = AbortSignal.timeout(status ? 5000 : timeoutMs + 5000);
	return new Promise((resolve, reject) => {
		const req = request({
			socketPath: path,
			method: status ? "GET" : "POST",
			path: status ? "/status" : "/op",
			agent: false,
			signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
			headers: {
				"x-pi-approval-mac": identity,
				...(payload !== undefined && { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }),
			},
		}, (res) => {
			if (status && res.statusCode !== 200) {
				res.destroy();
				const message = res.statusCode === 404 ? "Status is unavailable. Check the selected socket route. If the route is correct, update pi-1password on the approval Mac and restart its approval terminal."
					: res.statusCode === 403 ? actionErrors.mismatch : "The approval terminal could not report its status.";
				reject(new Error(message));
				return;
			}
			body(res, resultBytes).then(resolve, reject);
		});
		req.once("error", (error) => {
			const code = "code" in error ? error.code : undefined;
			if (code === "ECONNREFUSED" || code === "ENOENT") {
				reject(new Error("The approval Mac is disconnected. Start its Secure Shell tunnel or select another target."));
			} else if (status && deadline.aborted && !signal?.aborted) {
				reject(new Error("The approval terminal did not report its status within 5 seconds."));
			} else {
				reject(error);
			}
		});
		req.end(payload);
	});
}

/** @param {string} path @param {AbortSignal | undefined} signal @param {string} identity */
export async function approvalStatus(path, signal, identity) {
	const response = /** @type {{ busy?: unknown, actions?: unknown } | null} */ (await send(path, undefined, signal, identity));
	if (typeof response?.busy !== "boolean" || !Array.isArray(response.actions) ||
		!response.actions.every(isActionName) || Object.keys(response).length !== 2) {
		throw new Error("The approval terminal returned an invalid status.");
	}
	return { busy: response.busy, actions: response.actions };
}

/**
 * @param {string} path
 * @param {{ operation: string, account?: string, vault?: string, action?: string }} input
 * @param {AbortSignal | undefined} signal
 * @param {string} identity
 */
export async function forward(path, input, signal, identity) {
	if (input.operation === "action") checkActionRequest(input);
	else opArgs(input);
	const response = /** @type {{ result?: unknown, error?: unknown, completed?: unknown, actionError?: unknown }} */ (
		await send(path, JSON.stringify(input), signal, identity)
	);
	if (input.operation === "action") {
		if (response?.completed === true) return true;
		const code = response?.actionError;
		if (typeof code === "string" && Object.hasOwn(actionErrors, code)) {
			throw new Error(actionErrors[/** @type {keyof typeof actionErrors} */ (code)]);
		}
		throw new Error(actionErrors.failed);
	}
	if (typeof response?.error === "string") throw new Error(response.error);
	return metadata(input.operation, response?.result);
}
