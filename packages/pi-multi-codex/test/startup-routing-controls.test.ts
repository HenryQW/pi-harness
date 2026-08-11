import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import multiCodex from "../extensions/multi-codex.ts";

type Handler = (event: any, ctx: any) => unknown;
type Command = (args: string, ctx: any) => Promise<void>;
type App = {
	agentDir: string;
	handlers: Map<string, Handler>;
	commands: Map<string, Command>;
	ctx: any;
	setModels: ReturnType<typeof model>[];
	statuses: (string | undefined)[];
	notices: string[];
	sessionEntries: any[];
};

const model = (provider = "openai-codex") => ({
	id: "gpt-5.3-codex",
	name: "Codex",
	api: "openai-codex-responses",
	provider,
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 16_384,
});

const credential = (accountId: string) => ({
	type: "oauth",
	access: "access-token",
	refresh: "refresh-token",
	expires: Date.now() + 60_000,
	accountId,
});

const hash = (accountId: string) => createHash("sha256").update(accountId).digest("hex");

async function writeFreshCache(agentDir: string, remaining: Record<number, number>): Promise<void> {
	const now = Date.now();
	await mkdir(join(agentDir, "config", "pi-multi-codex"), { recursive: true });
	await writeFile(join(agentDir, "config", "pi-multi-codex", "usage.json"), JSON.stringify({
		slots: Object.entries(remaining).map(([slot, value]) => ({
			slot: Number(slot),
			accountHash: hash(`account-${slot}`),
			checkedAt: now,
			fetchedAt: now,
			remaining: value,
			reset: Date.now() + 3_600_000,
		})),
		locks: [],
	}));
}

async function withApp(
	remaining: Record<number, number>,
	scopedModels: readonly { model: ReturnType<typeof model> }[] = [],
	check: (app: App) => Promise<void>,
	setModel = async (next: ReturnType<typeof model>, apply: () => void) => {
		apply();
		return true;
	},
): Promise<void> {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-multi-codex-routing-"));
	const prior = process.env.PI_CODING_AGENT_DIR;
	const priorFetch = globalThis.fetch;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	globalThis.fetch = async () => { throw new Error("fresh cache must not fetch"); };
	try {
		await writeFile(join(agentDir, "auth.json"), JSON.stringify(Object.fromEntries(
			Object.keys(remaining).map((slot) => [Number(slot) === 1 ? "openai-codex" : `openai-codex-${slot}`, credential(`account-${slot}`)]),
		)));
		await writeFreshCache(agentDir, remaining);

		let activeModel = model();
		const handlers = new Map<string, Handler>();
		const commands = new Map<string, Command>();
		const setModels: ReturnType<typeof model>[] = [];
		const statuses: (string | undefined)[] = [];
		const notices: string[] = [];
		const sessionEntries: any[] = [];
		const ctx = {
			get model() { return activeModel; },
			modelRegistry: { getProviderAuth: async (provider: string) => ({ auth: { apiKey: `token-${provider}` } }) },
			scopedModels,
			sessionManager: { getBranch() { return sessionEntries; } },
			ui: {
				notify(message: string) { notices.push(message); },
				setStatus(_key: string, text: string | undefined) { statuses.push(text); },
				theme: { fg(color: string, text: string) { return `<${color}>${text}</${color}>`; } },
				async select(_title: string, choices: string[]) { return choices[1]; },
			},
		};
		multiCodex({
			on(event: string, handler: Handler) { handlers.set(event, handler); },
			registerCommand(name: string, command: { handler: Command }) { commands.set(name, command.handler); },
			registerProvider() {},
			appendEntry(customType: string) { sessionEntries.push({ type: "custom", customType }); },
			async setModel(next: ReturnType<typeof model>) {
				setModels.push(next);
				return setModel(next, () => { activeModel = next; });
			},
		} as unknown as ExtensionAPI);
		await check({ agentDir, handlers, commands, ctx, setModels, statuses, notices, sessionEntries });
		handlers.get("session_shutdown")?.({ type: "session_shutdown" }, ctx);
	} finally {
		globalThis.fetch = priorFetch;
		if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = prior;
		await rm(agentDir, { recursive: true, force: true });
	}
}

test("routes once at first agent boundary from fresh seven-day cache", async () => {
	await withApp({ 1: 40, 2: 70, 3: 70 }, [], async ({ handlers, ctx, setModels, statuses }) => {
		handlers.get("session_start")?.({ type: "session_start" }, ctx);
		assert.equal(setModels.length, 0);
		assert.equal(statuses.at(-1), "<warning>Codex #1 · 40% · 7d 1h</warning>");

		await handlers.get("before_agent_start")?.({ type: "before_agent_start" }, ctx);
		assert.deepEqual(setModels.map((selected) => [selected.provider, selected.id]), [["openai-codex-2", "gpt-5.3-codex"]]);
		handlers.get("agent_start")?.({ type: "agent_start" }, ctx);
		await handlers.get("before_agent_start")?.({ type: "before_agent_start" }, ctx);
		assert.equal(setModels.length, 1);
	});
});

test("revalidates cached candidate at agent boundary", async () => {
	await withApp({ 1: 40, 2: 90 }, [], async ({ agentDir, handlers, ctx, setModels }) => {
		handlers.get("session_start")?.({ type: "session_start" }, ctx);
		const cache = join(agentDir, "config", "pi-multi-codex", "usage.json");
		const state = JSON.parse(await readFile(cache, "utf8"));
		state.slots.find((snapshot: { slot: number }) => snapshot.slot === 2).reset = Date.now() - 1;
		await writeFile(cache, JSON.stringify(state));
		await handlers.get("before_agent_start")?.({ type: "before_agent_start" }, ctx);
		assert.equal(setModels.length, 0);
	});
});

test("keeps current slot when scope excludes fresher aliases", async () => {
	await withApp({ 1: 40, 2: 90 }, [{ model: model("openai-codex") }], async ({ handlers, ctx, setModels, commands, notices }) => {
		handlers.get("session_start")?.({ type: "session_start" }, ctx);
		await handlers.get("before_agent_start")?.({ type: "before_agent_start" }, ctx);
		assert.equal(setModels.length, 0);

		await commands.get("codex-switch")?.("", ctx);
		assert.equal(setModels.length, 0);
		assert.match(notices.at(-1) ?? "", /model scope.*Restart Pi/i);
	});
});

test("uses live scope changes at agent boundary", async () => {
	const scopedModels = [{ model: model() }];
	await withApp({ 1: 40, 2: 90 }, scopedModels, async ({ handlers, ctx, setModels }) => {
		handlers.get("session_start")?.({ type: "session_start" }, ctx);
		scopedModels.push({ model: model("openai-codex-2") });
		await handlers.get("before_agent_start")?.({ type: "before_agent_start" }, ctx);
		assert.deepEqual(setModels.map((selected) => selected.provider), ["openai-codex-2"]);
	});
});

test("does not route to alias removed from live scope", async () => {
	const scopedModels = [{ model: model() }, { model: model("openai-codex-2") }];
	await withApp({ 1: 40, 2: 90 }, scopedModels, async ({ handlers, ctx, setModels }) => {
		handlers.get("session_start")?.({ type: "session_start" }, ctx);
		scopedModels.pop();
		await handlers.get("before_agent_start")?.({ type: "before_agent_start" }, ctx);
		assert.equal(setModels.length, 0);
	});
});

test("does not reopen automatic routing after session reload", async () => {
	await withApp({ 1: 40, 2: 90 }, [], async ({ handlers, ctx, setModels }) => {
		handlers.get("session_start")?.({ type: "session_start", reason: "new" }, ctx);
		handlers.get("agent_start")?.({ type: "agent_start" }, ctx);
		handlers.get("session_start")?.({ type: "session_start", reason: "reload" }, ctx);
		await handlers.get("before_agent_start")?.({ type: "before_agent_start" }, ctx);
		assert.equal(setModels.length, 0);
	});
});

test("manual switch uses native selector and keeps active model id", async () => {
	await withApp({ 1: 75, 2: 20 }, [], async ({ handlers, commands, ctx, setModels }) => {
		handlers.get("session_start")?.({ type: "session_start" }, ctx);
		await commands.get("codex-switch")?.("", ctx);
		await handlers.get("before_agent_start")?.({ type: "before_agent_start" }, ctx);
		assert.deepEqual(setModels.map((selected) => [selected.provider, selected.id]), [["openai-codex-2", "gpt-5.3-codex"]]);
	});
});

test("manual model selection before first turn closes automatic routing", async () => {
	await withApp({ 1: 40, 2: 90 }, [], async ({ handlers, ctx, setModels }) => {
		handlers.get("session_start")?.({ type: "session_start" }, ctx);
		handlers.get("model_select")?.({ model: model("openai-codex-2") }, ctx);
		await handlers.get("before_agent_start")?.({ type: "before_agent_start" }, ctx);
		assert.equal(setModels.length, 0);
	});
});

test("scoped session skips alias added after session start", async () => {
	await withApp({ 1: 40 }, [{ model: model() }], async ({ agentDir, handlers, commands, ctx, setModels, notices }) => {
		handlers.get("session_start")?.({ type: "session_start" }, ctx);
		await writeFile(join(agentDir, "auth.json"), JSON.stringify({
			"openai-codex": credential("account-1"),
			"openai-codex-2": credential("account-2"),
		}));
		await commands.get("codex-switch")?.("", ctx);
		assert.equal(setModels.length, 0);
		assert.match(notices.at(-1) ?? "", /model scope.*Restart Pi/i);
	});
});

test("serializes automatic switch while first agent boundary is deferred", async () => {
	let release!: () => void;
	const deferred = new Promise<void>((resolve) => { release = resolve; });
	await withApp(
		{ 1: 40, 2: 90 },
		[],
		async ({ handlers, ctx, setModels }) => {
			handlers.get("session_start")?.({ type: "session_start" }, ctx);
			const first = handlers.get("before_agent_start")?.({ type: "before_agent_start" }, ctx);
			await Promise.resolve();
			assert.equal(setModels.length, 1);
			handlers.get("model_select")?.({ model: model("openai-codex") }, ctx);
			await handlers.get("before_agent_start")?.({ type: "before_agent_start" }, ctx);
			assert.equal(setModels.length, 1);
			release();
			await first;
			handlers.get("agent_start")?.({ type: "agent_start" }, ctx);
			await handlers.get("before_agent_start")?.({ type: "before_agent_start" }, ctx);
			assert.deepEqual(setModels.map((selected) => selected.provider), ["openai-codex-2"]);
		},
		async (_next, apply) => {
			await deferred;
			apply();
			return true;
		},
	);
});

test("colors fresh footer at every quota threshold", async () => {
	for (const [remaining, color] of [[50, "success"], [25, "warning"], [24, "error"]] as const) {
		await withApp({ 1: remaining }, [], async ({ handlers, ctx, statuses }) => {
			handlers.get("session_start")?.({ type: "session_start" }, ctx);
			assert.equal(statuses.at(-1), `<${color}>Codex #1 · ${remaining}% · 7d 1h</${color}>`);
		});
	}
});
