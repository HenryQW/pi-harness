import { lstat } from "node:fs/promises";
import { request } from "node:https";
import { dirname, isAbsolute, normalize } from "node:path";
import { debuglog } from "node:util";
import { createConfigStore, parsers, required } from "@henryqw/pi-config-store";
import { checkAccessGrants, checkProtectedAncestors, isActionName, runNativeOp, validText } from "./bridge.mjs";

/** @param {unknown} value */
function text(value) {
	if (!validText(value)) throw new Error("Use nonempty text without control characters.");
	return value;
}

/** @param {unknown} value */
function reference(value) {
	const input = text(value);
	if (!/^op:\/\/[^/?#]+\/[^/?#]+\/(?:[^/?#]+\/)?[^/?#]+$/.test(input)) {
		throw new Error("Use an exact 1Password field reference.");
	}
	return input;
}

/** @param {unknown} value */
function destination(value) {
	const url = new URL(text(value));
	if (url.protocol !== "https:" || url.username || url.password || url.hash) {
		throw new Error("Use an HTTPS URL without credentials or a fragment.");
	}
	return url.href;
}

const grant = parsers.object({
	account: required(text),
	reference: required(reference),
	url: required(destination),
	header: required(parsers.oneOf(["bearer", "x-api-key"])),
});

/** @param {string} path @param {string} executable */
export async function loadActions(path, executable) {
	if (debuglog("http").enabled || debuglog("https").enabled) {
		throw new Error("Disable Node.js HTTP debug logging before you enable 1Password actions.");
	}
	if (!isAbsolute(path) || normalize(path) !== path || /\p{C}/u.test(path)) throw new Error("Use an absolute action file path.");
	const parents = await checkProtectedAncestors(path);
	const file = await lstat(path);
	if (!file.isFile() || file.nlink !== 1 || file.uid !== process.getuid?.() || (file.mode & 0o7777) !== 0o600) {
		throw new Error("Use a private 0600 action file owned by your user.");
	}
	await checkAccessGrants([path, ...parents]);
	const store = createConfigStore({ extensionId: "pi-1password", path, entries: parsers.record(grant, { key(value) {
		if (!isActionName(value)) throw new Error("Invalid action name.");
		return value;
	} }) });
	const loaded = store.loadSync();
	if (loaded.status !== "ok" || loaded.source !== "file" || loaded.issues.length) {
		throw new Error(`Fix the action file at ${path}. Each action needs an account, field reference, HTTPS URL, and supported header.`);
	}
	return new Map(Object.entries(loaded.value).map(([name, action]) => [name, (/** @type {AbortSignal} */ signal) => runAction(executable, action, signal)]));
}

/** @param {string} executable @param {ReturnType<typeof grant>} action @param {AbortSignal} signal */
async function runAction(executable, action, signal) {
	const deadline = AbortSignal.any([signal, AbortSignal.timeout(60_000)]);
	const value = await runNativeOp(executable, ["read", "--no-newline", action.reference, `--account=${action.account}`], deadline);
	deadline.throwIfAborted();
	if (value.length > 4096 || !/^[\x21-\x7e]+$/.test(value)) throw new Error("Invalid credential for the HTTPS action.");
	await new Promise((resolve, reject) => {
		const req = request(action.url, { method: "GET", signal: deadline, agent: false, rejectUnauthorized: true }, (res) => {
			// Status is the only result. Never read response data or follow redirects.
			const status = res.statusCode ?? 0;
			res.destroy();
			if (status >= 200 && status < 300) resolve(undefined);
			else reject(new Error("The HTTPS action did not succeed."));
		});
		req.once("error", reject);
		// Attach the credential after Node creates the connection options.
		if (action.header === "bearer") req.setHeader("Authorization", `Bearer ${value}`);
		else req.setHeader("X-API-Key", value);
		req.end();
	});
}
