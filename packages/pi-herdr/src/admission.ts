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

export function checkoutToolCanWrite(toolName: string, input: unknown, directCanWrite: (input: unknown) => boolean): boolean {
	return toolName === "delegate_task" ? directCanWrite(input) : !MAIN_NON_WRITING_TOOLS.has(toolName);
}

export async function checkoutKey(pi: Pick<AdmissionHost, "exec">, ctx: { cwd: string }): Promise<string> {
	const cwd = await realpath(ctx.cwd);
	const result = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd, timeout: 5_000 });
	if (result.killed) throw new Error("Git checkout resolution was terminated during delegation admission; writes are blocked.");
	if (result.code !== 0) {
		// Exit 128 also covers unsafe ownership and invalid configuration. Git runs
		// shell aliases at the root, with either .git or an explicit GIT_DIR.
		// Relax discovery restrictions only for this absence check, never for admission.
		if (result.code === 128) {
			const absent = await pi.exec("git", ["-c", "safe.directory=*", "-c", "safe.bareRepository=all",
				"-c", 'alias.pi-admission-non-repository=!test -z "${GIT_DIR+x}" && test ! -e .git && test ! -L .git', "pi-admission-non-repository"], { cwd, timeout: 5_000 });
			if (absent.code === 0 && !absent.killed) return cwd;
		}
		throw new Error(`Git checkout resolution failed (exit ${result.code}) during delegation admission; writes are blocked.`);
	}
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
	let directCheckouts: ((input: unknown, ctx: { cwd: string }) => Promise<readonly string[]>) | undefined;
	const guards = new Map<string, (checkouts: readonly string[]) => Promise<void>>();
	const durable = new Map<string, readonly string[]>();
	const completed = new Set<string>();
	const events = new WeakMap<object, Promise<Gate>>();
	const heldCalls = new Set<string>();
	const ownerByCheckout = new Map<string, string>();
	const calls = new Map<string, { direct: boolean; keys?: readonly string[] }>();
	let replacing = false;
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
		for (const key of call?.keys ?? []) if (ownerByCheckout.get(key) === toolCallId) ownerByCheckout.delete(key);
	};
	const refresh = async (keys: readonly string[]) => { for (const guard of guards.values()) await guard(keys); };
	const admit = async (event: { toolName: string; toolCallId: string; input: unknown }, ctx: { cwd: string }, host: AdmissionHost): Promise<Gate> => {
		const direct = event.toolName === "delegate_task";
		if (event.toolName === "background_command" || !checkoutToolCanWrite(event.toolName, event.input, directCanWrite)) return;
		if (direct && replacing) return { block: true, reason: "Session replacement is pending; direct writes are blocked. If another extension cancelled replacement, reload before delegation." };
		const call: { direct: boolean; keys?: readonly string[] } = { direct };
		calls.set(event.toolCallId, call);
		let keys: readonly string[];
		try {
			keys = [...new Set([await lookup(host, ctx), ...(direct && directCheckouts ? await directCheckouts(event.input, ctx) : [])])];
		} catch (error) {
			release(event.toolCallId);
			throw error;
		}
		try { await refresh(keys); }
		catch {
			release(event.toolCallId);
			return { block: true, reason: "Command ownership recovery failed; writes are blocked. Inspect /commands." };
		}
		if (calls.get(event.toolCallId) !== call) {
			return { block: true, reason: `Call ${event.toolCallId} already settled; use mode: isolated to keep Main free.` };
		}
		const owner = keys.map((key) => ownerByCheckout.get(key) ?? [...durable].find(([, checkouts]) => checkouts.includes(key))?.[0]).find(Boolean);
		const main = direct ? [...calls].find(([, active]) => !active.direct && active.keys?.some((key) => keys.includes(key)))?.[0] : undefined;
		if (owner || main) {
			release(event.toolCallId);
			return {
				block: true,
				reason: `Checkout set ${keys.join(", ")} has ${owner ? `an admitted direct writer (${owner})` : `a Main potentially-writing call in flight (${main})`}; retry after it stops, or use mode: isolated to keep Main free.`,
			};
		}
		call.keys = keys;
		if (direct) for (const key of keys) ownerByCheckout.set(key, event.toolCallId);
	};
	const install = (host: AdmissionHost) => {
		host.on("tool_call", (event, ctx) => {
			let result = events.get(event);
			if (!result) { result = admit(event, ctx, host); events.set(event, result); }
			return result;
		});
		host.on("tool_result", (event) => release(event.toolCallId));
		host.on("tool_execution_end", (event) => release(event.toolCallId));
		host.on("session_start", () => { checkouts.clear(); replacing = false; });
		host.on("session_shutdown", () => {
			checkouts.clear();
			for (const toolCallId of calls.keys()) release(toolCallId);
		});
	};
	const hold = (toolCallId: string) => {
		const call = calls.get(toolCallId);
		if (!call?.direct || !call.keys?.length) {
			throw new Error(`Direct call ${toolCallId} was not admitted as a checkout writer; delegate again.`);
		}
		heldCalls.add(toolCallId);
		return () => { heldCalls.delete(toolCallId); release(toolCallId); };
	};
	return {
		install, hold, supportsCheckoutSets: true as const, supportsDirectJournal: true as const,
		beginReplacement: () => {
			if ([...calls.values()].some(({ direct }) => direct)) return false;
			replacing = true;
			return true;
		},
		admittedCheckouts: (toolCallId: string): readonly string[] => {
			const call = calls.get(toolCallId);
			if (!call?.direct || !call.keys?.length) throw new Error(`Direct call ${toolCallId} was not admitted as a checkout writer; delegate again.`);
			return [...call.keys];
		},
		restoreSet: (owner: string, keys: readonly string[]) => { if (!completed.has(owner)) durable.set(owner, [...keys]); },
		classifyDirect: (classify: (input: unknown) => boolean, select?: typeof directCheckouts) => { directCanWrite = classify; directCheckouts = select; },
		guard: (name: string, refresh: (checkouts: readonly string[]) => Promise<void>) => { guards.set(name, refresh); },
		restore: (owner: string, checkout: string) => { if (!completed.has(owner)) durable.set(owner, [checkout]); },
		release: (owner: string) => { durable.delete(owner); },
		complete: (owner: string) => { completed.add(owner); durable.delete(owner); },
		async reserve(owner: string, checkout: string): Promise<() => void> {
			await refresh([checkout]);
			if (completed.has(owner)) throw new Error("Completed checkout owners cannot reserve again.");
			const conflict = [...durable].find(([, keys]) => keys.includes(checkout))?.[0]
				?? ownerByCheckout.get(checkout)
				?? [...calls].find(([, call]) => call.keys?.includes(checkout))?.[0];
			if (conflict) throw new Error(`Checkout ${checkout} has an active writer (${conflict}); wait until it stops.`);
			durable.set(owner, [checkout]);
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

export function registerCheckoutAdmission(pi: AdmissionHost, directCanWrite: (input: unknown) => boolean,
	directCheckouts?: (input: unknown, ctx: { cwd: string }) => Promise<readonly string[]>,
): (toolCallId: string) => () => void {
	const admission = checkoutAdmission(pi);
	admission.classifyDirect((input) => {
		if (directCanWrite(input) && admission.supportsCheckoutSets !== true && input && typeof input === "object" && Object.hasOwn(input, "repositories")) {
			throw new Error("The active checkout coordinator does not support repository sets. Reload with the current Pi Herdr package before delegation.");
		}
		return directCanWrite(input);
	}, directCheckouts);
	admission.install(pi);
	return admission.hold;
}
