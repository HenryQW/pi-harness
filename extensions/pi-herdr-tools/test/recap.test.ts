import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock } from "node:test";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import idleRecapExtension, { RECAP_IDLE_MS, RECAP_PROMPT_BUDGET_BYTES } from "../internal/recap.ts";

type Handler = (event: any, ctx: ExtensionContext) => unknown;
const model = { provider: "openai-codex", id: "gpt-5.6-luna", input: ["text"] };
const flush = () => new Promise((resolve) => setImmediate(resolve));

function harness(options: { hasUI?: boolean; mode?: string; editorText?: string; complete?: () => Promise<any> } = {}) {
	const handlers = new Map<string, Handler>();
	const signals: AbortSignal[] = [];
	const prompts: string[] = [];
	const widgets: unknown[] = [];
	const notifications: string[] = [];
	const terminalInput = new Set<(data: string) => unknown>();
	const manager = SessionManager.inMemory();
	manager.appendMessage({ role: "user", content: "fix the login crash", timestamp: 1 });
	const api = {
		events: { on: () => () => {}, emit() {} },
		on: (event: string, handler: Handler) => handlers.set(event, handler),
		getSessionName: () => undefined,
	} as unknown as ExtensionAPI;
	const ctx = {
		hasUI: options.hasUI ?? true,
		mode: options.mode ?? "rpc",
		isIdle: () => true,
		scopedModels: [],
		sessionManager: manager,
		modelRegistry: {
			getAvailable: () => [model],
			streamSimple: (_model: unknown, context: { messages: Array<{ content: string }> }, completionOptions: { signal: AbortSignal }) => ({
				result: async () => {
					signals.push(completionOptions.signal);
					prompts.push(context.messages[0].content);
					return options.complete ? options.complete() : { stopReason: "stop", content: [{ type: "text", text: "Goal: fix login. Next: run tests." }] };
				},
			}),
		},
		ui: {
			getEditorText: () => options.editorText ?? "",
			setWidget: (_key: string, content: unknown) => widgets.push(content),
			notify: (message: string) => notifications.push(message),
			onTerminalInput: (handler: (data: string) => unknown) => {
				terminalInput.add(handler);
				return () => terminalInput.delete(handler);
			},
		},
	} as unknown as ExtensionContext;
	idleRecapExtension(api);
	const emit = (event: string, payload: object = {}) => handlers.get(event)?.(payload, ctx);
	const idleFor = async (ms: number) => {
		mock.timers.tick(ms);
		await flush();
	};
	const press = (data: string) => [...terminalInput].map((handler) => handler(data));
	return { emit, idleFor, press, manager, signals, prompts, notifications, shown: () => widgets.filter(Boolean) };
}

async function withTaskModels(run: () => Promise<void>): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "pi-herdr-recap-"));
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	mock.timers.enable({ apis: ["setTimeout"] });
	try {
		await mkdir(join(dir, "config", "pi-task-models"), { recursive: true });
		await writeFile(
			join(dir, "config", "pi-task-models", "config.json"),
			JSON.stringify({ profiles: { fast: { primary: { model: `${model.provider}/${model.id}`, thinkingLevel: "off" } } } }),
		);
		await run();
	} finally {
		mock.timers.reset();
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
		await rm(dir, { recursive: true, force: true });
	}
}

test("a settled run shows a recap only after the idle delay", async () => {
	await withTaskModels(async () => {
		const app = harness();
		app.emit("agent_settled", { aborted: false });
		await app.idleFor(RECAP_IDLE_MS - 1);
		assert.equal(app.signals.length, 0);
		await app.idleFor(1);
		assert.deepEqual(app.shown(), [["↺ Recap: Goal: fix login. Next: run tests."]]);
	});
});

test("user input cancels the idle timer and aborts an in-flight recap", async () => {
	await withTaskModels(async () => {
		let resolve!: (value: unknown) => void;
		const app = harness({ complete: () => new Promise((done) => { resolve = done; }) });
		app.emit("agent_settled", { aborted: false });
		app.emit("input", { source: "interactive", text: "next" });
		await app.idleFor(RECAP_IDLE_MS);
		assert.equal(app.signals.length, 0);

		app.emit("agent_settled", { aborted: false });
		await app.idleFor(RECAP_IDLE_MS);
		assert.equal(app.signals.length, 1);
		app.emit("input", { source: "interactive", text: "next" });
		assert.equal(app.signals[0].aborted, true);
		resolve({ stopReason: "stop", content: [{ type: "text", text: "late" }] });
		await flush();
		assert.deepEqual(app.shown(), []);
	});
});

test("terminal keys and user shell commands cancel a pending recap without consuming keys", async () => {
	await withTaskModels(async () => {
		const app = harness({ mode: "tui" });
		app.emit("agent_settled", { aborted: false });
		assert.deepEqual(app.press("/"), [undefined]);
		await app.idleFor(RECAP_IDLE_MS);
		assert.equal(app.signals.length, 0);
		assert.deepEqual(app.press("x"), []);

		app.emit("agent_settled", { aborted: false });
		app.emit("user_bash", { command: "ls", excludeFromContext: false, cwd: "/" });
		await app.idleFor(RECAP_IDLE_MS);
		assert.equal(app.signals.length, 0);
	});
});

test("a recap keeps compaction summaries and shows each failure once", async () => {
	await withTaskModels(async () => {
		const errors = ["no route", "timeout", "no route"];
		const app = harness({ complete: async () => ({ stopReason: "error", errorMessage: errors.shift(), content: [] }) });
		app.manager.appendCompaction("Goal: ship the login fix.", null, 1_000);
		app.manager.appendMessage({ role: "user", content: "continue", timestamp: 2 });
		for (const text of ["one", "two", "three"]) {
			app.manager.appendMessage({ role: "user", content: text, timestamp: 3 });
			app.emit("agent_settled", { aborted: false });
			await app.idleFor(RECAP_IDLE_MS);
		}
		assert.match(app.prompts[0], /Earlier summary: Goal: ship the login fix\./);
		assert.equal(app.prompts.length, 3);
		assert.deepEqual(app.notifications, ["no route", "timeout"]);
	});
});

test("a recap prompt fits one budget and keeps the newest summary and turns", async () => {
	await withTaskModels(async () => {
		const app = harness();
		app.manager.appendCompaction(`Goal: old plan. ${"x".repeat(4_096)}`, null, 1_000);
		app.manager.branchWithSummary(app.manager.getLeafId(), `Goal: ship the login fix. ${"y".repeat(64 * 1024)}`);
		for (let turn = 0; turn < 20; turn += 1) {
			app.manager.appendMessage({ role: "user", content: `turn ${turn} ${"z".repeat(4_096)}`, timestamp: 2 });
		}
		app.emit("agent_settled", { aborted: false });
		await app.idleFor(RECAP_IDLE_MS);
		assert.ok(Buffer.byteLength(app.prompts[0], "utf8") <= RECAP_PROMPT_BUDGET_BYTES);
		assert.match(app.prompts[0], /^Earlier summary: Goal: ship the login fix\./);
		assert.doesNotMatch(app.prompts[0], /old plan/);
		assert.match(app.prompts[0], /turn 19 z+$/);
	});
});

test("a recap for a leaf that changed during the request is not shown", async () => {
	await withTaskModels(async () => {
		let resolve!: (value: unknown) => void;
		const app = harness({ complete: () => new Promise((done) => { resolve = done; }) });
		app.emit("agent_settled", { aborted: false });
		await app.idleFor(RECAP_IDLE_MS);
		app.manager.appendMessage({ role: "user", content: "background entry", timestamp: 2 });
		resolve({ stopReason: "stop", content: [{ type: "text", text: "stale" }] });
		await flush();
		assert.deepEqual(app.shown(), []);
	});
});

test("no recap starts without UI or with composer text", async () => {
	await withTaskModels(async () => {
		for (const app of [harness({ hasUI: false }), harness({ editorText: "draft" })]) {
			app.emit("agent_settled", { aborted: false });
			await app.idleFor(RECAP_IDLE_MS);
			assert.equal(app.signals.length, 0);
		}
	});
});

test("a recap repeats only after new activity on the branch", async () => {
	await withTaskModels(async () => {
		const app = harness();
		app.emit("agent_settled", { aborted: false });
		await app.idleFor(RECAP_IDLE_MS);
		app.emit("agent_settled", { aborted: false });
		await app.idleFor(RECAP_IDLE_MS);
		assert.equal(app.signals.length, 1);

		app.manager.appendMessage({ role: "user", content: "also add a test", timestamp: 2 });
		app.emit("agent_settled", { aborted: false });
		await app.idleFor(RECAP_IDLE_MS);
		assert.equal(app.signals.length, 2);
	});
});
