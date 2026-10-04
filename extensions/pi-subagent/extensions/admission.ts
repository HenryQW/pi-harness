import { realpath } from "node:fs/promises";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Role } from "../dist/index.js";

// `codemode` mutates nothing itself: its sandbox reaches a checkout only through nested tool calls,
// which are admitted by their own names here and limited to the Role's active tools in children.
const READ_ONLY_TOOLS = new Set([
	"read", "grep", "find", "ffgrep", "fffind", "ls", "codegraph_explore", "subagent_status", "codemode", "git_read",
]);

export function roleCanWrite(role: Role): boolean {
	return role.tools.some((tool) => !READ_ONLY_TOOLS.has(tool));
}

export function roleIsReadOnlyScout(role: Role): boolean {
	return !roleCanWrite(role) && role.extensions.length === 0 && !role.mcps?.length;
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
 * Coordinate Pi-owned calls that can mutate one checkout. This is admission,
 * not an OS sandbox: external processes and trusted extension lifecycle code
 * remain outside interception. A model-issued call owns the checkout for the
 * calls it makes through `ctx.executeTool()` (codemode scripts), so its nested
 * writes pass while independent writers wait until it settles.
 */
export function registerCheckoutAdmission(pi: ExtensionAPI, directCanWrite: (input: unknown) => boolean): void {
	const ownerByCheckout = new Map<string, string>();
	const checkoutByRoot = new Map<string, string>();
	const writersByRoot = new Map<string, Set<string>>();
	/** Model-issued ancestor of each in-flight call; Pi names nested calls `<parent id>/<n>`. */
	const rootByCall = new Map<string, string>();
	const release = (toolCallId: string) => {
		const root = rootByCall.get(toolCallId);
		if (root === undefined) return;
		rootByCall.delete(toolCallId);
		const writers = writersByRoot.get(root);
		writers?.delete(toolCallId);
		if (rootByCall.has(root) || writers?.size) return;
		writersByRoot.delete(root);
		const key = checkoutByRoot.get(root);
		if (!key) return;
		checkoutByRoot.delete(root);
		if (ownerByCheckout.get(key) === root) ownerByCheckout.delete(key);
	};
	pi.on("tool_call", async (event, ctx) => {
		const root = event.parentToolCallId === undefined
			? event.toolCallId
			: rootByCall.get(event.parentToolCallId) ?? event.parentToolCallId;
		rootByCall.set(event.toolCallId, root);
		const potentiallyWriting = event.toolName === "delegate_task"
			? directCanWrite(event.input)
			: !READ_ONLY_TOOLS.has(event.toolName);
		if (!potentiallyWriting) return;
		const key = await checkoutKey(pi, ctx);
		// A codemode result can settle while an unawaited nested call is still resolving its checkout.
		if (root !== event.toolCallId && !rootByCall.has(root)) {
			return { block: true, reason: `Parent call ${root} already settled; ${event.toolCallId} is not admitted.` };
		}
		const owner = ownerByCheckout.get(key);
		if (owner && owner !== root) {
			return {
				block: true,
				reason: `Checkout ${key} already has an admitted Pi writer (${owner}); retry after it settles.`,
			};
		}
		ownerByCheckout.set(key, root);
		checkoutByRoot.set(root, key);
		const writers = writersByRoot.get(root) ?? new Set<string>();
		writers.add(event.toolCallId);
		writersByRoot.set(root, writers);
	});
	pi.on("tool_result", (event) => release(event.toolCallId));
	pi.on("tool_execution_end", (event) => release(event.toolCallId));
	pi.on("session_shutdown", () => {
		ownerByCheckout.clear();
		checkoutByRoot.clear();
		writersByRoot.clear();
		rootByCall.clear();
	});
}
