import { realpath } from "node:fs/promises";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Role } from "../dist/index.js";

// `codemode` mutates nothing itself: its sandbox reaches a checkout only through nested tool calls,
// which are admitted by their own names here and limited to the Role's active tools in children.
const READ_ONLY_TOOLS = new Set([
	"read", "grep", "find", "ffgrep", "fffind", "ls", "codegraph_explore", "subagent_status", "codemode", "git_read",
]);

export function roleCanWrite(role: Role): boolean {
	return role.tools.some((tool) => !READ_ONLY_TOOLS.has(tool)) || role.extensions.length > 0 || Boolean(role.mcps?.length);
}

async function checkoutKey(pi: ExtensionAPI, ctx: ExtensionContext): Promise<string> {
	const cwd = await realpath(ctx.cwd);
	const result = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd, timeout: 5_000 });
	if (result.code !== 0 || result.killed) return cwd;
	const root = result.stdout.replace(/\r?\n$/, "");
	if (!root || /[\r\n\0]/.test(root)) throw new Error("Git returned a malformed checkout root during delegation admission.");
	return await realpath(root);
}

/**
 * Reserve checkouts only for direct writers. Main writes can run together, but
 * each call must finish before a direct writer can start in that checkout.
 * External processes and trusted extension lifecycle code are not intercepted.
 */
export function registerCheckoutAdmission(pi: ExtensionAPI, directCanWrite: (input: unknown) => boolean): (toolCallId: string) => () => void {
	const heldCalls = new Set<string>();
	const ownerByCheckout = new Map<string, string>();
	const calls = new Map<string, { direct: boolean; key?: string }>();
	const release = (toolCallId: string) => {
		if (heldCalls.has(toolCallId)) return;
		const call = calls.get(toolCallId);
		calls.delete(toolCallId);
		if (call?.key && ownerByCheckout.get(call.key) === toolCallId) ownerByCheckout.delete(call.key);
	};
	pi.on("tool_call", async (event, ctx) => {
		const direct = event.toolName === "delegate_task";
		if (direct ? !directCanWrite(event.input) : READ_ONLY_TOOLS.has(event.toolName)) return;
		const call: { direct: boolean; key?: string } = { direct };
		calls.set(event.toolCallId, call);
		const key = await checkoutKey(pi, ctx);
		if (calls.get(event.toolCallId) !== call) {
			return { block: true, reason: `Call ${event.toolCallId} already settled; use mode: isolated to keep Main free.` };
		}
		const owner = ownerByCheckout.get(key);
		const main = direct ? [...calls].find(([, active]) => !active.direct && active.key === key)?.[0] : undefined;
		if (owner || main) {
			release(event.toolCallId);
			return {
				block: true,
				reason: `Checkout ${key} has ${owner ? `an admitted direct writer (${owner})` : `a Main potentially-writing call in flight (${main})`}; retry after it stops, or use mode: isolated to keep Main free.`,
			};
		}
		call.key = key;
		if (direct) ownerByCheckout.set(key, event.toolCallId);
	});
	pi.on("tool_result", (event) => release(event.toolCallId));
	pi.on("tool_execution_end", (event) => release(event.toolCallId));
	pi.on("session_shutdown", () => {
		// Session replacement is not proof that a held direct worker stopped.
		for (const toolCallId of calls.keys()) release(toolCallId);
	});
	// The tool returns a handle before its worker stops. Release only after verified termination.
	return (toolCallId) => {
		const call = calls.get(toolCallId);
		if (!call?.direct || !call.key) {
			throw new Error(`Direct call ${toolCallId} was not admitted as a checkout writer; delegate again with the current Role resources.`);
		}
		heldCalls.add(toolCallId);
		return () => { heldCalls.delete(toolCallId); release(toolCallId); };
	};
}
