import { realpath } from "node:fs/promises";

// Structural host contract keeps this support package independent of Pi runtime imports.
interface AdmissionHost {
	events?: { on(channel: string, handler: (data: unknown) => void): () => void; emit(channel: string, data: unknown): void };
	exec(command: string, args: string[], options: { cwd: string; timeout: number }): Promise<{ code: number; killed?: boolean; stdout: string }>;
	on(event: "tool_call", handler: (event: { toolName: string; toolCallId: string; input: unknown }, ctx: { cwd: string }) => Promise<{ block: true; reason: string } | undefined>): unknown;
	on(event: "tool_result" | "tool_execution_end", handler: (event: { toolCallId: string }) => void): unknown;
	on(event: "session_start" | "session_shutdown", handler: () => void): unknown;
}
const CHANNEL = "pi-herdr:checkout-admission";
type Gate = { block: true; reason: string } | undefined;


// Main's own tools that never change a checkout; every other Main call may write.
// `codemode` mutates nothing itself: its nested tool calls are admitted by their own names.
const MAIN_NON_WRITING_TOOLS = new Set([
	"read", "grep", "find", "ffgrep", "fffind", "ls", "codegraph_explore", "subagent_status", "codemode",
]);

export async function checkoutKey(pi: Pick<AdmissionHost, "exec">, ctx: { cwd: string }): Promise<string> {
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
function createAdmission() {
	let directCanWrite = (_input: unknown) => true;
	const guards = new Map<string, () => Promise<void>>();
	const durable = new Map<string, string>();
	const events = new WeakMap<object, Promise<Gate>>();
	const heldCalls = new Set<string>();
	const ownerByCheckout = new Map<string, string>();
	const calls = new Map<string, { direct: boolean; key?: string }>();
	// One Git lookup per working directory per session; a failed lookup is retried.
	const checkouts = new Map<string, Promise<string>>();
	const lookup = (host: AdmissionHost, ctx: { cwd: string }) => {
		const cached = checkouts.get(ctx.cwd);
		if (cached) return cached;
		const key = checkoutKey(host, ctx);
		checkouts.set(ctx.cwd, key);
		key.catch(() => { if (checkouts.get(ctx.cwd) === key) checkouts.delete(ctx.cwd); });
		return key;
	};
	const release = (toolCallId: string) => {
		if (heldCalls.has(toolCallId)) return;
		const call = calls.get(toolCallId);
		calls.delete(toolCallId);
		if (call?.key && ownerByCheckout.get(call.key) === toolCallId) ownerByCheckout.delete(call.key);
	};
	const refresh = async () => { for (const guard of guards.values()) await guard(); };
	const admit = async (event: { toolName: string; toolCallId: string; input: unknown }, ctx: { cwd: string }, host: AdmissionHost): Promise<Gate> => {
		const direct = event.toolName === "delegate_task";
		if (event.toolName === "background_command" || (direct ? !directCanWrite(event.input) : MAIN_NON_WRITING_TOOLS.has(event.toolName))) return;
		try { await refresh(); }
		catch { return { block: true, reason: "Command ownership recovery failed; writes are blocked. Inspect /commands." }; }
		const call: { direct: boolean; key?: string } = { direct };
		calls.set(event.toolCallId, call);
		const key = await lookup(host, ctx);
		if (calls.get(event.toolCallId) !== call) {
			return { block: true, reason: `Call ${event.toolCallId} already settled; use mode: isolated to keep Main free.` };
		}
		const owner = ownerByCheckout.get(key) ?? [...durable].find(([, checkout]) => checkout === key)?.[0];
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
	};
	const install = (host: AdmissionHost) => {
		host.on("tool_call", (event, ctx) => {
			let result = events.get(event);
			if (!result) { result = admit(event, ctx, host); events.set(event, result); }
			return result;
		});
		host.on("tool_result", (event) => release(event.toolCallId));
		host.on("tool_execution_end", (event) => release(event.toolCallId));
		host.on("session_start", () => checkouts.clear());
		host.on("session_shutdown", () => {
			checkouts.clear();
			for (const toolCallId of calls.keys()) release(toolCallId);
		});
	};
	const hold = (toolCallId: string) => {
		const call = calls.get(toolCallId);
		if (!call?.direct || !call.key) {
			throw new Error(`Direct call ${toolCallId} was not admitted as a checkout writer; delegate again.`);
		}
		heldCalls.add(toolCallId);
		return () => { heldCalls.delete(toolCallId); release(toolCallId); };
	};
	return {
		install, hold,
		classifyDirect: (classify: (input: unknown) => boolean) => { directCanWrite = classify; },
		guard: (name: string, refresh: () => Promise<void>) => { guards.set(name, refresh); },
		restore: (owner: string, checkout: string) => { durable.set(owner, checkout); },
		release: (owner: string) => { durable.delete(owner); },
		async reserve(owner: string, checkout: string): Promise<() => void> {
			await refresh();
			const conflict = [...durable].find(([, key]) => key === checkout)?.[0]
				?? ownerByCheckout.get(checkout)
				?? [...calls].find(([, call]) => call.key === checkout)?.[0];
			if (conflict) throw new Error(`Checkout ${checkout} has an active writer (${conflict}); wait until it stops.`);
			durable.set(owner, checkout);
			return () => { durable.delete(owner); };
		},
	};
}

export type CheckoutAdmission = ReturnType<typeof createAdmission>;

/** Share admission through Pi's public event bus; its per-extension facades have distinct identities. */
export function checkoutAdmission(pi: AdmissionHost): CheckoutAdmission {
	let admission: CheckoutAdmission | undefined;
	pi.events?.emit(CHANNEL, { receive: (value: CheckoutAdmission) => { admission = value; } });
	if (!admission) admission = createAdmission();
	const shared = admission;
	pi.events?.on(CHANNEL, (data) => {
		const request = data as { receive?: (value: CheckoutAdmission) => void } | undefined;
		if (typeof request?.receive === "function") request.receive(shared);
	});
	return shared;
}

export function registerCheckoutAdmission(pi: AdmissionHost, directCanWrite: (input: unknown) => boolean): (toolCallId: string) => () => void {
	const admission = checkoutAdmission(pi);
	admission.classifyDirect(directCanWrite);
	admission.install(pi);
	return admission.hold;
}
