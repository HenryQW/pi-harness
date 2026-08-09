import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import multiCodex from "../extensions/multi-codex.ts";

type Handler = (event: any, ctx: any) => unknown;
type Command = (args: string, ctx: any) => Promise<void>;

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
	check: (app: {
		handlers: Map<string, Handler>;
		commands: Map<string, Command>;
		ctx: any;
		setModels: ReturnType<typeof model>[];
		statuses: (string | undefined)[];
		notices: string[];
		sessionEntries: any[];
	}) => Promise<void>,
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
				activeModel = next;
				return true;
			},
		} as unknown as ExtensionAPI);
		await check({ handlers, commands, ctx, setModels, statuses, notices, sessionEntries });
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
		assert.deepEqual(setModels.map((selected) => [selected.provider, selected.id]), [["openai-codex-2", "gpt-5.3-codex"]]);
	});
});
