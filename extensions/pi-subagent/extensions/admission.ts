import { realpath } from "node:fs/promises";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Role } from "../src/index.ts";

const READ_ONLY_TOOLS = new Set([
	"read", "grep", "find", "ffgrep", "fffind", "ls", "codegraph_explore", "subagent_status",
]);

export function roleCanWrite(role: Role): boolean {
	return Boolean(role.extensions.length || role.mcps?.length || role.tools.some((tool) => !READ_ONLY_TOOLS.has(tool)));
}

export interface CheckoutAdmission {
	register(pi: ExtensionAPI, directCanWrite: (input: unknown) => boolean): void;
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
 * remain outside interception.
 */
export function createCheckoutAdmission(): CheckoutAdmission {
	const ownerByCheckout = new Map<string, string>();
	const checkoutByCall = new Map<string, string>();
	const release = (toolCallId: string) => {
		const key = checkoutByCall.get(toolCallId);
		if (!key) return;
		checkoutByCall.delete(toolCallId);
		if (ownerByCheckout.get(key) === toolCallId) ownerByCheckout.delete(key);
	};
	return {
		register(pi, directCanWrite) {
			pi.on("tool_call", async (event, ctx) => {
				const potentiallyWriting = event.toolName === "delegate_task"
					? directCanWrite(event.input)
					: !READ_ONLY_TOOLS.has(event.toolName);
				if (!potentiallyWriting) return;
				const key = await checkoutKey(pi, ctx);
				const owner = ownerByCheckout.get(key);
				if (owner && owner !== event.toolCallId) {
					return {
						block: true,
						reason: `Checkout ${key} already has an admitted Pi writer (${owner}); retry after it settles.`,
					};
				}
				ownerByCheckout.set(key, event.toolCallId);
				checkoutByCall.set(event.toolCallId, key);
			});
			pi.on("tool_result", (event) => release(event.toolCallId));
			pi.on("tool_execution_end", (event) => release(event.toolCallId));
			pi.on("session_shutdown", () => {
				ownerByCheckout.clear();
				checkoutByCall.clear();
			});
		},
	};
}
