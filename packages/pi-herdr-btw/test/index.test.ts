import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { writeTaskModelsConfig } from "@henryqw/pi-task-models";
import { DEFAULT_CONFIG, type BtwConfig } from "../internal/config.ts";
import type { BtwPayload } from "../internal/core.ts";
import {
	MERGE_CUSTOM_TYPE,
	MERGE_PROTOCOL_VERSION,
	type MergeRequest,
} from "../internal/merge.ts";
import {
	registerBtwExtension,
	type ConfigStorePort,
	type ContextStorePort,
} from "../extensions/btw.ts";
import { fixturePayload } from "./fixtures.ts";

type Command = {
	handler: (args: string, ctx: any) => Promise<void>;
};

type EventHandler = (event: any, ctx: any) => any;

type ExecResult = {
	code: number;
	stdout: string;
	stderr: string;
	killed?: boolean;
};

const PANE_SPLIT_STDOUT = JSON.stringify({
	id: "cli:pane:split",
	result: { pane: { pane_id: "w1:p9", tab_id: "w1:t1", workspace_id: "w1" }, type: "pane_info" },
});
/** Herdr exec stub: pane split succeeds with a pane ID; agent start returns a ready agent. */
function herdrExec(agentStart?: ExecResult) {
	return async (_command: string, args: string[]): Promise<ExecResult> => {
		if (args[0] === "pane" && args[1] === "split") {
			return { code: 0, stdout: PANE_SPLIT_STDOUT, stderr: "" };
		}
		if (args[0] === "agent" && args[1] === "start") {
			if (agentStart) return agentStart;
			const paneIndex = args.indexOf("--pane");
			const paneId = paneIndex >= 0 ? args[paneIndex + 1] : undefined;
			return {
				code: 0,
				stdout: JSON.stringify({
					result: {
						type: "agent_started",
						agent: { name: args[2], pane_id: paneId, interactive_ready: true },
					},
				}),
				stderr: "",
			};
		}
		return { code: 0, stdout: "", stderr: "" };
	};
}

class FakeStore implements ContextStorePort {
	readonly payloadPath = "/tmp/pi-herdr-btw-test/launch-123/payload.json";
	readonly created: BtwPayload[] = [];
	readonly removed: string[] = [];
	staleRuns = 0;
	readonly operations: string[] = [];
	touchRuns = 0;
	readValue: BtwPayload = fixturePayload({ draftQuestion: "draft" });
	readError: Error | undefined;
	mergeReadError: Error | undefined;
	mergeRequest: unknown;
	retained = 0;

	async create(payload: BtwPayload): Promise<string> {
		this.created.push(payload);
		return this.payloadPath;
	}

	async read(_payloadPath: string): Promise<BtwPayload> {
		if (this.readError) throw this.readError;
		return this.readValue;
	}

	async remove(payloadPath: string): Promise<void> {
		this.removed.push(payloadPath);
		this.mergeRequest = undefined;
	}

	async touch(): Promise<void> {
		this.touchRuns += 1;
	}

	async removeStale(): Promise<void> {
		this.operations.push("removeStale");
		this.staleRuns += 1;
	}

	async listLaunchPayloadPaths(): Promise<string[]> {
		this.operations.push("listLaunchPayloadPaths");
		return [this.payloadPath];
	}

	async writeMergeRequest(_payloadPath: string, request: MergeRequest): Promise<void> {
		this.mergeRequest = request;
	}

	async readMergeRequest(_payloadPath: string): Promise<unknown> {
		if (this.mergeReadError) throw this.mergeReadError;
		return this.mergeRequest;
	}

	async removeIfNoPendingMerge(payloadPath: string): Promise<boolean> {
		if (this.mergeRequest !== undefined) {
			this.retained += 1;
			return false;
		}
		await this.remove(payloadPath);
		return true;
	}
}

class FakeConfigStore implements ConfigStorePort {
	config: BtwConfig = { ...DEFAULT_CONFIG };
	readonly saved: BtwConfig[] = [];
	resetRuns = 0;
	loadError: Error | undefined;

	async load(): Promise<BtwConfig> {
		if (this.loadError) throw this.loadError;
		return { ...this.config };
	}

	async update(mutator: (config: BtwConfig) => BtwConfig): Promise<BtwConfig> {
		this.config = mutator({ ...this.config });
		this.saved.push({ ...this.config });
		return { ...this.config };
	}

	async reset(): Promise<BtwConfig> {
		this.config = { ...DEFAULT_CONFIG };
		this.loadError = undefined;
		this.resetRuns += 1;
		return { ...this.config };
	}
}

function createCommandContext() {
	const notifications: Array<{ message: string; type: string }> = [];
	const modelInfo = (provider: string, id: string) => ({
		provider,
		id,
		input: ["text"],
		reasoning: true,
		thinkingLevelMap: { off: "off", minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
	});
	const entries: any[] = [
		{
			type: "message",
			id: "a1b2c3d4",
			parentId: null,
			timestamp: "2026-07-15T00:00:00.000Z",
			message: {
				role: "user",
				content: [{ type: "text", text: "parent question" }],
				timestamp: 1,
			},
		},
	];
	return {
		mode: "tui" as const,
		hasUI: true,
		cwd: "/tmp/project",
		model: { provider: "test-provider", id: "test-model" },
		isProjectTrusted: () => true,
		scopedModels: [],
		modelRegistry: {
			getAvailable: () => [
				modelInfo("test-provider", "test-model"),
				modelInfo("anthropic", "claude-haiku"),
				modelInfo("openai-codex", "gpt-5.6-luna"),
				modelInfo("anthropic", "claude-sonnet"),
			],
			getApiKeyAndHeaders: async () => ({ ok: true }),
		},
		isIdle: () => true,
		getSystemPrompt: () => "parent system prompt",
		sessionManager: {
			getEntries: () => entries,
			getBranch: () => entries,
			getLeafId: () => "a1b2c3d4",
			getSessionId: () => "12345678-1234-1234-1234-123456789abc",
			getSessionFile: () => "/tmp/session.jsonl",
		},
		ui: {
			notify: (message: string, type: string) => notifications.push({ message, type }),
			editor: async (_title: string, prefill?: string) => prefill,
		},
		notifications,
		entries,
	} as any;
}

async function createHarness(
	store: FakeStore,
	execImpl: (command: string, args: string[]) => Promise<ExecResult>,
	configStore = new FakeConfigStore(),
) {
	const commands = new Map<string, Command>();
	const handlers = new Map<string, EventHandler[]>();
	const execCalls: Array<{ command: string; args: string[] }> = [];
	const sentUserMessages: string[] = [];
	const sentMessages: Array<{ message: any; options: any }> = [];
	const timers: Array<ReturnType<typeof setInterval>> = [];
	const originalSetInterval = globalThis.setInterval;
	const pi = {
		registerFlag() {},
		registerCommand(name: string, command: Command) {
			commands.set(name, command);
		},
		on(name: string, handler: EventHandler) {
			const registered = handlers.get(name) ?? [];
			registered.push(handler);
			handlers.set(name, registered);
		},
		async exec(command: string, args: string[]) {
			execCalls.push({ command, args });
			return execImpl(command, args);
		},
		getThinkingLevel: () => "high",
		getActiveTools: () => ["read", "bash"],
		sendUserMessage: (message: string) => sentUserMessages.push(message),
		sendMessage: (message: any, options: any) => sentMessages.push({ message, options }),
	} as unknown as ExtensionAPI;

	// Capture timers created during registration/handlers so tests can clear them.
	(globalThis as any).setInterval = (...args: Parameters<typeof setInterval>) => {
		const timer = originalSetInterval(...args);
		timers.push(timer);
		return timer;
	};
	try {
		await registerBtwExtension(pi, { store, configStore });
	} finally {
		(globalThis as any).setInterval = originalSetInterval;
	}

	async function emit(name: string, event: any, ctx: any) {
		const results = [];
		for (const handler of handlers.get(name) ?? []) results.push(await handler(event, ctx));
		return results;
	}

	function cleanup() {
		for (const timer of timers) clearInterval(timer);
	}

	return { commands, handlers, execCalls, sentUserMessages, sentMessages, configStore, emit, cleanup, timers };
}

async function withParentEnvironment(run: (agentDir: string) => Promise<void>): Promise<void> {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-herdr-btw-task-models-"));
	writeTaskModelsConfig({
		profiles: {
			fast: { primary: { model: "test-provider/test-model", thinkingLevel: "high" } },
		},
		tasks: {},
	}, agentDir);
	const previous = {
		agentDir: process.env.PI_CODING_AGENT_DIR,
		herdr: process.env.HERDR_ENV,
		pane: process.env.HERDR_PANE_ID,
		workspace: process.env.HERDR_WORKSPACE_ID,
		tab: process.env.HERDR_TAB_ID,
	};
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.HERDR_ENV = "1";
	process.env.HERDR_PANE_ID = "w1:p1";
	process.env.HERDR_WORKSPACE_ID = "w1";
	process.env.HERDR_TAB_ID = "w1:t1";
	try {
		await run(agentDir);
	} finally {
		for (const [key, value] of Object.entries({
			PI_CODING_AGENT_DIR: previous.agentDir,
			HERDR_ENV: previous.herdr,
			HERDR_PANE_ID: previous.pane,
			HERDR_WORKSPACE_ID: previous.workspace,
			HERDR_TAB_ID: previous.tab,
		})) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		await rm(agentDir, { recursive: true, force: true });
	}
}

async function withChildEnvironment(payloadPath: string, run: () => Promise<void>): Promise<void> {
	const previousArgv = process.argv;
	process.argv = [...previousArgv, "--pi-herdr-btw-payload", payloadPath];
	try {
		await run();
	} finally {
		process.argv = previousArgv;
	}
}

test("parent command captures native context and launches Herdr without leaking the question", async () => {
	await withParentEnvironment(async () => {
		const store = new FakeStore();
		const harness = await createHarness(store, herdrExec());
		const ctx = createCommandContext();
		await harness.commands.get("btw")?.handler("  secret question  ", ctx);
		harness.cleanup();

		assert.equal(store.staleRuns, 1);
		const payload = store.created[0];
		assert.equal(payload?.draftQuestion, "secret question");
		assert.equal(payload?.parentSessionId, "12345678-1234-1234-1234-123456789abc");
		assert.equal(payload?.parentPaneId, "w1:p1");
		assert.equal(payload?.parentSystemPrompt, "parent system prompt");
		assert.deepEqual(payload?.parentActiveTools, ["read", "bash"]);
		assert.equal(payload?.parentThinkingLevel, "high");
		assert.equal(payload?.messages.length, 1);
		assert.ok(payload?.launchId);
		assert.ok((payload?.capability.length ?? 0) >= 64);
		assert.deepEqual(store.removed, []);
		assert.equal(harness.execCalls.length, 2);
		const splitArgs = harness.execCalls[0]?.args ?? [];
		const startArgs = harness.execCalls[1]?.args ?? [];
		assert.deepEqual(startArgs.slice(startArgs.indexOf("--model"), startArgs.indexOf("--model") + 2), [
			"--model",
			"test-provider/test-model",
		]);
		assert.deepEqual(startArgs.slice(startArgs.indexOf("--thinking"), startArgs.indexOf("--thinking") + 2), [
			"--thinking",
			"high",
		]);
		assert.equal(startArgs.includes("--approve"), true);
		const allArgs = [...splitArgs, ...startArgs];
		assert.deepEqual(splitArgs.slice(0, 2), ["pane", "split"]);
		assert.deepEqual(splitArgs.slice(splitArgs.indexOf("--pane"), splitArgs.indexOf("--pane") + 2), [
			"--pane",
			"w1:p1",
		]);
		assert.deepEqual(startArgs.slice(0, 2), ["agent", "start"]);
		// agent start targets the pane returned by pane split
		assert.deepEqual(startArgs.slice(startArgs.indexOf("--pane"), startArgs.indexOf("--pane") + 2), [
			"--pane",
			"w1:p9",
		]);
		assert.equal(allArgs.some((arg) => arg.includes("secret question")), false);
		assert.equal(allArgs.some((arg) => arg.includes(payload?.capability ?? "!")), false);
		assert.equal(splitArgs.includes("--env"), false);
		assert.deepEqual(startArgs.slice(startArgs.indexOf("--pi-herdr-btw-payload"), startArgs.indexOf("--pi-herdr-btw-payload") + 2), [
			"--pi-herdr-btw-payload",
			"/tmp/pi-herdr-btw-test/launch-123/payload.json",
		]);
		// tools inherit (default) passes the exact active parent tool set
		assert.deepEqual(startArgs.slice(-2), ["--tools", "read,bash"]);
	});
});

test("parent command routes ask, help, and unknown words by exact first word", async () => {
	await withParentEnvironment(async () => {
		const store = new FakeStore();
		const harness = await createHarness(store, herdrExec());
		const ctx = createCommandContext();
		const command = harness.commands.get("btw");

		await command?.handler("help", ctx);
		assert.match(ctx.notifications.at(-1)?.message ?? "", /\/btw ask/);
		assert.equal(store.created.length, 0);

		await command?.handler("ask merge sort", ctx);
		assert.equal(store.created.at(-1)?.draftQuestion, "merge sort");

		await command?.handler("configuration options?", ctx);
		assert.equal(store.created.at(-1)?.draftQuestion, "configuration options?");
		harness.cleanup();
	});
});

test("config routes before Herdr and model launch checks", async () => {
	const previous = { herdr: process.env.HERDR_ENV };
	delete process.env.HERDR_ENV; // not inside Herdr at all
	try {
		const store = new FakeStore();
		const harness = await createHarness(store, async () => ({ code: 0, stdout: "", stderr: "" }));
		const ctx = createCommandContext();
		ctx.model = undefined; // and no model either
		await harness.commands.get("btw")?.handler("config auto-submit on", ctx);
		harness.cleanup();

		assert.equal(harness.configStore.config.autoSubmit, true);
		assert.equal(ctx.notifications.at(-1)?.type, "info");
		assert.equal(harness.execCalls.length, 0);
	} finally {
		if (previous.herdr !== undefined) process.env.HERDR_ENV = previous.herdr;
	}
});

test("config subcommand updates and resets launch defaults, including malformed-config recovery", async () => {
	await withParentEnvironment(async () => {
		const store = new FakeStore();
		const harness = await createHarness(store, async () => ({ code: 0, stdout: "", stderr: "" }));
		const ctx = createCommandContext();
		const command = harness.commands.get("btw");

		await command?.handler("config auto-submit on", ctx);
		await command?.handler("config tools read-only", ctx);
		harness.cleanup();

		assert.equal(harness.configStore.config.autoSubmit, true);
		assert.equal(harness.configStore.config.tools, "read-only");
		assert.equal(harness.configStore.saved.length, 2);

		harness.configStore.loadError = new Error("malformed config");
		await command?.handler("config reset", ctx);
		assert.deepEqual(harness.configStore.config, DEFAULT_CONFIG);
		assert.equal(harness.configStore.resetRuns, 1);
	});
});

test("parent retries agent start on the transient pane-busy error", async () => {
	await withParentEnvironment(async () => {
		const store = new FakeStore();
		let startCalls = 0;
		const busy = JSON.stringify({ error: { code: "agent_pane_busy", message: "pane is busy" } });
		const harness = await createHarness(store, async (_command, args) => {
			if (args[0] === "pane" && args[1] === "split") {
				return { code: 0, stdout: PANE_SPLIT_STDOUT, stderr: "" };
			}
			if (args[0] !== "agent" || args[1] !== "start") return { code: 0, stdout: "", stderr: "" };
			startCalls += 1;
			return startCalls === 1
				? { code: 1, stdout: "", stderr: busy }
				: {
						code: 0,
						stdout: JSON.stringify({
							result: {
								type: "agent_started",
								agent: { name: args[2], pane_id: args[args.indexOf("--pane") + 1], interactive_ready: true },
							},
						}),
						stderr: "",
					};
		});
		await harness.commands.get("btw")?.handler("question", createCommandContext());
		harness.cleanup();

		assert.equal(startCalls, 2);
		assert.deepEqual(store.removed, []);
	});
});

test("parent stops pane-busy retries when its session shuts down during backoff", async () => {
	await withParentEnvironment(async () => {
		const store = new FakeStore();
		let startCalls = 0;
		let startResolve: (() => void) | undefined;
		const startCalled = new Promise<void>((resolve) => (startResolve = resolve));
		const busy = JSON.stringify({ error: { code: "agent_pane_busy", message: "pane is busy" } });
		const harness = await createHarness(store, async (_command, args) => {
			if (args[0] === "pane" && args[1] === "split") {
				return { code: 0, stdout: PANE_SPLIT_STDOUT, stderr: "" };
			}
			if (args[0] === "agent" && args[1] === "start") {
				startCalls += 1;
				startResolve?.();
				return { code: 1, stdout: "", stderr: busy };
			}
			return { code: 0, stdout: "", stderr: "" };
		});
		const ctx = createCommandContext();
		await harness.emit("session_start", { reason: "startup" }, ctx);

		const launch = harness.commands.get("btw")?.handler("question", ctx);
		await startCalled;
		await new Promise((resolve) => setTimeout(resolve, 20));
		await harness.emit("session_shutdown", { reason: "quit" }, {});
		await launch;
		harness.cleanup();

		assert.equal(startCalls, 1);
		assert.deepEqual(harness.execCalls.at(-1)?.args, ["pane", "close", "w1:p9"]);
		assert.deepEqual(store.removed, [store.payloadPath]);
	});
});

test("parent uses authenticated task-profile fallback when primary authentication fails", async () => {
	await withParentEnvironment(async (agentDir) => {
		writeTaskModelsConfig({
			profiles: {
				frontier: {
					primary: { model: "test-provider/test-model", thinkingLevel: "high" },
					fallback: { model: "anthropic/claude-haiku", thinkingLevel: "low" },
				},
			},
			tasks: { "pi-herdr-btw/btw": "frontier" },
		}, agentDir);
		const store = new FakeStore();
		const harness = await createHarness(store, herdrExec());
		const ctx = createCommandContext();
		const authenticated: string[] = [];
		ctx.modelRegistry.getApiKeyAndHeaders = async (model: { provider: string; id: string }) => {
			authenticated.push(`${model.provider}/${model.id}`);
			return { ok: model.id === "claude-haiku" };
		};
		await harness.commands.get("btw")?.handler("question", ctx);
		harness.cleanup();

		assert.deepEqual(authenticated, ["test-provider/test-model", "anthropic/claude-haiku"]);
		const startArgs = harness.execCalls[1]?.args ?? [];
		assert.deepEqual(startArgs.slice(startArgs.indexOf("--model"), startArgs.indexOf("--model") + 2), [
			"--model",
			"anthropic/claude-haiku",
		]);
		assert.deepEqual(startArgs.slice(startArgs.indexOf("--thinking"), startArgs.indexOf("--thinking") + 2), [
			"--thinking",
			"low",
		]);
	});
});

test("parent rejects unavailable or unauthenticated task-profile routes before splitting", async () => {
	await withParentEnvironment(async (agentDir) => {
		writeTaskModelsConfig({
			profiles: { frontier: { primary: { model: "missing/model", thinkingLevel: "high" } } },
			tasks: { "pi-herdr-btw/btw": "frontier" },
		}, agentDir);
		const unavailableStore = new FakeStore();
		const unavailableHarness = await createHarness(unavailableStore, herdrExec());
		const unavailableCtx = createCommandContext();
		await unavailableHarness.commands.get("btw")?.handler("question", unavailableCtx);
		unavailableHarness.cleanup();
		assert.equal(unavailableHarness.execCalls.length, 0);
		assert.equal(unavailableStore.created.length, 0);
		assert.match(unavailableCtx.notifications.at(-1)?.message ?? "", /no available route/);

		writeTaskModelsConfig({
			profiles: { fast: { primary: { model: "test-provider/test-model", thinkingLevel: "high" } } },
			tasks: {},
		}, agentDir);
		const authStore = new FakeStore();
		const authHarness = await createHarness(authStore, herdrExec());
		const authCtx = createCommandContext();
		authCtx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: false });
		await authHarness.commands.get("btw")?.handler("question", authCtx);
		authHarness.cleanup();
		assert.equal(authHarness.execCalls.length, 0);
		assert.equal(authStore.created.length, 0);
		assert.match(authCtx.notifications.at(-1)?.message ?? "", /No authenticated BTW task model route/);
	});
});

test("parent cancels a launch when its session changes during model authentication", async () => {
	await withParentEnvironment(async () => {
		const store = new FakeStore();
		const harness = await createHarness(store, herdrExec());
		const ctx = createCommandContext();
		let resolveAuth: ((value: { ok: boolean }) => void) | undefined;
		let authStartedResolve: (() => void) | undefined;
		const authStarted = new Promise<void>((resolve) => (authStartedResolve = resolve));
		ctx.modelRegistry.getApiKeyAndHeaders = () => {
			authStartedResolve?.();
			return new Promise((resolve) => (resolveAuth = resolve));
		};
		await harness.emit("session_start", { reason: "startup" }, ctx);

		const launch = harness.commands.get("btw")?.handler("question", ctx);
		await authStarted;
		await harness.emit("session_shutdown", { reason: "quit" }, {});
		resolveAuth?.({ ok: true });
		await launch;
		harness.cleanup();

		assert.equal(store.created.length, 0);
		assert.equal(harness.execCalls.length, 0);
	});
});

test("parent retains payload when session cancellation cannot close its known pane", async () => {
	await withParentEnvironment(async () => {
		const store = new FakeStore();
		let resolveStart: ((result: ExecResult) => void) | undefined;
		let startCalledResolve: (() => void) | undefined;
		const startCalled = new Promise<void>((resolve) => (startCalledResolve = resolve));
		const harness = await createHarness(store, async (_command, args) => {
			if (args[0] === "pane" && args[1] === "split") return { code: 0, stdout: PANE_SPLIT_STDOUT, stderr: "" };
			if (args[0] === "agent" && args[1] === "start") {
				startCalledResolve?.();
				return new Promise((resolve) => (resolveStart = resolve));
			}
			return { code: 1, stdout: "", stderr: "close failed" };
		});
		const ctx = createCommandContext();
		await harness.emit("session_start", { reason: "startup" }, ctx);

		const launch = harness.commands.get("btw")?.handler("question", ctx);
		await startCalled;
		await harness.emit("session_shutdown", { reason: "quit" }, {});
		resolveStart?.({ code: 0, stdout: "", stderr: "" });
		await launch;
		harness.cleanup();

		assert.deepEqual(harness.execCalls.at(-1)?.args, ["pane", "close", "w1:p9"]);
		assert.deepEqual(store.removed, []);
		assert.equal(ctx.notifications.at(-1)?.type, "warning");
		assert.match(ctx.notifications.at(-1)?.message ?? "", /cancellation could not close.*cleanup is deferred/);
	});
});

test("parent command removes sensitive payload after a definite nonzero split failure", async () => {
	await withParentEnvironment(async () => {
		const store = new FakeStore();
		const harness = await createHarness(store, async () => ({
			code: 1,
			stdout: "",
			stderr: "no server",
		}));
		const ctx = createCommandContext();
		await harness.commands.get("btw")?.handler("question", ctx);
		harness.cleanup();

		assert.equal(harness.execCalls.length, 1);
		assert.deepEqual(store.removed, [store.payloadPath]);
		assert.deepEqual(ctx.notifications.at(-1), {
			message: "/btw failed: no server",
			type: "error",
		});
	});
});

test("parent command closes the split pane and removes payload when agent start fails", async () => {
	await withParentEnvironment(async () => {
		const store = new FakeStore();
		const harness = await createHarness(
			store,
			herdrExec({ code: 1, stdout: "", stderr: "pi not found" }),
		);
		const ctx = createCommandContext();
		await harness.commands.get("btw")?.handler("question", ctx);
		harness.cleanup();

		assert.equal(harness.execCalls.length, 3);
		assert.deepEqual(harness.execCalls[2]?.args, ["pane", "close", "w1:p9"]);
		assert.deepEqual(store.removed, [store.payloadPath]);
		assert.deepEqual(ctx.notifications.at(-1), {
			message: "/btw failed: pi not found",
			type: "error",
		});
	});
});

test("parent retains payload and warns when failed agent cleanup cannot close its pane", async () => {
	await withParentEnvironment(async () => {
		const store = new FakeStore();
		const harness = await createHarness(store, async (_command, args) => {
			if (args[0] === "pane" && args[1] === "split") return { code: 0, stdout: PANE_SPLIT_STDOUT, stderr: "" };
			if (args[0] === "agent" && args[1] === "start") return { code: 1, stdout: "", stderr: "pi not found" };
			return { code: 1, stdout: "", stderr: "close failed" };
		});
		const ctx = createCommandContext();
		await harness.commands.get("btw")?.handler("question", ctx);
		harness.cleanup();

		assert.deepEqual(harness.execCalls.at(-1)?.args, ["pane", "close", "w1:p9"]);
		assert.deepEqual(store.removed, []);
		assert.equal(ctx.notifications.at(-1)?.type, "warning");
		assert.match(ctx.notifications.at(-1)?.message ?? "", /could not be closed.*cleanup is deferred/);
	});
});

test("parent closes split pane when agent start throws", async () => {
	await withParentEnvironment(async () => {
		const store = new FakeStore();
		const harness = await createHarness(store, async (_command, args) => {
			if (args[0] === "pane" && args[1] === "split") return { code: 0, stdout: PANE_SPLIT_STDOUT, stderr: "" };
			if (args[0] === "pane" && args[1] === "close") return { code: 0, stdout: "", stderr: "" };
			throw new Error("spawn failed");
		});
		const ctx = createCommandContext();
		await harness.commands.get("btw")?.handler("question", ctx);
		harness.cleanup();

		assert.equal(harness.execCalls.length, 3);
		assert.deepEqual(harness.execCalls[0]?.args.slice(0, 2), ["pane", "split"]);
		assert.deepEqual(harness.execCalls[1]?.args.slice(0, 2), ["agent", "start"]);
		assert.deepEqual(harness.execCalls[2]?.args, ["pane", "close", "w1:p9"]);
		assert.deepEqual(store.removed, [store.payloadPath]);
		assert.match(ctx.notifications.at(-1)?.message ?? "", /spawn failed/);
	});
});

test("parent does not guess pane ownership after a timed-out split", async () => {
	await withParentEnvironment(async () => {
		const store = new FakeStore();
		const harness = await createHarness(store, async () => ({
			code: 1,
			stdout: "",
			stderr: "timeout",
			killed: true,
		}));
		const ctx = createCommandContext();
		await harness.commands.get("btw")?.handler("question", ctx);
		harness.cleanup();

		assert.deepEqual(harness.execCalls.map(({ args }) => args), [
			["pane", "split", "--pane", "w1:p1", "--direction", "right", "--cwd", "/tmp/project", "--focus"],
		]);
		assert.deepEqual(store.removed, [store.payloadPath]);
		assert.equal(ctx.notifications.at(-1)?.type, "error");
		assert.match(ctx.notifications.at(-1)?.message ?? "", /timeout/);
	});
});

test("parent rejects a malformed successful agent start response", async () => {
	await withParentEnvironment(async () => {
		const store = new FakeStore();
		const harness = await createHarness(store, async (_command, args) => {
			if (args[0] === "pane" && args[1] === "split") {
				return { code: 0, stdout: PANE_SPLIT_STDOUT, stderr: "" };
			}
			if (args[0] === "agent" && args[1] === "start") {
				return { code: 0, stdout: "not json", stderr: "" };
			}
			return { code: 0, stdout: "", stderr: "" };
		});
		const ctx = createCommandContext();
		await harness.commands.get("btw")?.handler("question", ctx);
		harness.cleanup();

		assert.deepEqual(harness.execCalls.at(-1)?.args, ["pane", "close", "w1:p9"]);
		assert.deepEqual(store.removed, [store.payloadPath]);
		assert.equal(ctx.notifications.at(-1)?.type, "error");
		assert.match(ctx.notifications.at(-1)?.message ?? "", /invalid or non-interactive/);
	});
});

test("parent does not guess pane ownership when split output has no pane ID", async () => {
	await withParentEnvironment(async () => {
		const store = new FakeStore();
		const harness = await createHarness(store, async () => ({ code: 0, stdout: "not json", stderr: "" }));
		const ctx = createCommandContext();
		await harness.commands.get("btw")?.handler("question", ctx);
		harness.cleanup();

		assert.equal(harness.execCalls.length, 1);
		assert.deepEqual(harness.execCalls[0]?.args.slice(0, 2), ["pane", "split"]);
		assert.deepEqual(store.removed, [store.payloadPath]);
		assert.equal(ctx.notifications.at(-1)?.type, "error");
		assert.match(ctx.notifications.at(-1)?.message ?? "", /pane ID/);
	});
});

test("parent keeps an ambiguously started agent that becomes ready in its exact pane", async () => {
	await withParentEnvironment(async () => {
		const store = new FakeStore();
		const harness = await createHarness(store, async (_command, args) => {
			if (args[0] === "pane" && args[1] === "split") {
				return { code: 0, stdout: PANE_SPLIT_STDOUT, stderr: "" };
			}
			if (args[0] === "agent" && args[1] === "start") {
				return { code: 1, stdout: "", stderr: "timeout", killed: true };
			}
			if (args[0] === "agent" && args[1] === "wait") {
				return {
					code: 0,
					stdout: JSON.stringify({
						result: { type: "agent_info", agent: { pane_id: "w1:p9", agent_status: "idle" } },
					}),
					stderr: "",
				};
			}
			return { code: 0, stdout: "", stderr: "" };
		});
		const ctx = createCommandContext();
		await harness.commands.get("btw")?.handler("question", ctx);
		harness.cleanup();

		const startArgs = harness.execCalls.find(({ args }) => args[0] === "agent" && args[1] === "start")?.args;
		const waitArgs = harness.execCalls.find(({ args }) => args[0] === "agent" && args[1] === "wait")?.args;
		assert.deepEqual(waitArgs, [
			"agent",
			"wait",
			startArgs?.[2],
			"--until",
			"idle",
			"--until",
			"working",
			"--until",
			"blocked",
			"--until",
			"done",
			"--timeout",
			"5000",
		]);
		assert.deepEqual(store.removed, []);
		assert.equal(harness.execCalls.some(({ args }) => args[0] === "pane" && args[1] === "close"), false);
	});
});

test("parent closes its known pane when reconciliation finds the named agent elsewhere", async () => {
	await withParentEnvironment(async () => {
		const store = new FakeStore();
		const harness = await createHarness(store, async (_command, args) => {
			if (args[0] === "pane" && args[1] === "split") {
				return { code: 0, stdout: PANE_SPLIT_STDOUT, stderr: "" };
			}
			if (args[0] === "agent" && args[1] === "start") {
				return { code: 1, stdout: "", stderr: "timeout", killed: true };
			}
			if (args[0] === "agent" && args[1] === "wait") {
				return {
					code: 0,
					stdout: JSON.stringify({
						result: { type: "agent_info", agent: { pane_id: "w1:p77", agent_status: "idle" } },
					}),
					stderr: "",
				};
			}
			return { code: 0, stdout: "", stderr: "" };
		});
		await harness.commands.get("btw")?.handler("question", createCommandContext());
		harness.cleanup();

		assert.deepEqual(harness.execCalls.at(-1)?.args, ["pane", "close", "w1:p9"]);
		assert.deepEqual(store.removed, [store.payloadPath]);
	});
});

test("parent cleans up its known pane when ambiguous agent start reconciliation finds no agent", async () => {
	await withParentEnvironment(async () => {
		const store = new FakeStore();
		const harness = await createHarness(store, async (_command, args) => {
			if (args[0] === "pane" && args[1] === "split") {
				return { code: 0, stdout: PANE_SPLIT_STDOUT, stderr: "" };
			}
			if (args[0] === "agent" && args[1] === "start") {
				return { code: 1, stdout: "", stderr: "timeout", killed: true };
			}
			if (args[0] === "agent" && args[1] === "wait") {
				return {
					code: 1,
					stdout: "",
					stderr: JSON.stringify({ error: { code: "agent_not_found", message: "not found" } }),
				};
			}
			return { code: 0, stdout: "", stderr: "" };
		});
		const ctx = createCommandContext();
		await harness.commands.get("btw")?.handler("question", ctx);
		harness.cleanup();

		assert.deepEqual(harness.execCalls.at(-1)?.args, ["pane", "close", "w1:p9"]);
		assert.deepEqual(store.removed, [store.payloadPath]);
		assert.equal(ctx.notifications.at(-1)?.type, "error");
	});
});

test("parent retains payload when killed reconciliation reports partial not-found output", async () => {
	await withParentEnvironment(async () => {
		const store = new FakeStore();
		const harness = await createHarness(store, async (_command, args) => {
			if (args[0] === "pane" && args[1] === "split") {
				return { code: 0, stdout: PANE_SPLIT_STDOUT, stderr: "" };
			}
			if (args[0] === "agent" && args[1] === "start") {
				return { code: 1, stdout: "", stderr: "timeout", killed: true };
			}
			if (args[0] === "agent" && args[1] === "wait") {
				return {
					code: 1,
					stdout: "",
					stderr: JSON.stringify({ error: { code: "agent_not_found", message: "not found" } }),
					killed: true,
				};
			}
			return { code: 0, stdout: "", stderr: "" };
		});
		const ctx = createCommandContext();
		await harness.commands.get("btw")?.handler("question", ctx);
		harness.cleanup();

		assert.deepEqual(store.removed, []);
		assert.equal(ctx.notifications.at(-1)?.type, "warning");
		assert.match(ctx.notifications.at(-1)?.message ?? "", /cleanup is deferred/);
	});
});

test("parent command applies configured tools, split, and auto-submit", async () => {
	await withParentEnvironment(async () => {
		const store = new FakeStore();
		const configStore = new FakeConfigStore();
		configStore.config = { autoSubmit: true, tools: "none", split: "down" };
		const harness = await createHarness(store, herdrExec(), configStore);
		await harness.commands.get("btw")?.handler("question", createCommandContext());
		harness.cleanup();

		assert.deepEqual(store.created[0]?.config, configStore.config);
		const splitArgs = harness.execCalls[0]?.args ?? [];
		const args = harness.execCalls[1]?.args ?? [];
		assert.deepEqual(
			splitArgs.slice(splitArgs.indexOf("--direction"), splitArgs.indexOf("--direction") + 2),
			["--direction", "down"],
		);
		assert.equal(args.at(-1), "/btw --launch-draft");
		assert.equal(args.at(-2), "--no-tools");
		assert.equal([...splitArgs, ...args].some((arg) => arg.includes("question")), false);
	});
});

test("parent uses task profile without a current model", async () => {
	await withParentEnvironment(async () => {
		const store = new FakeStore();
		const harness = await createHarness(store, herdrExec());
		const ctx = createCommandContext();
		ctx.model = undefined;
		await harness.commands.get("btw")?.handler("question", ctx);
		harness.cleanup();

		assert.equal(store.created[0]?.metadata.model, null);
		const args = harness.execCalls[1]?.args ?? [];
		assert.deepEqual(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2), [
			"--model",
			"test-provider/test-model",
		]);
		assert.deepEqual(args.slice(args.indexOf("--thinking"), args.indexOf("--thinking") + 2), [
			"--thinking",
			"high",
		]);
	});
});

test("parent omits the launch-draft sentinel when auto-submit is off or there is no draft", async () => {
	await withParentEnvironment(async () => {
		const store = new FakeStore();
		const configStore = new FakeConfigStore();
		const harness = await createHarness(store, herdrExec(), configStore);
		const command = harness.commands.get("btw");

		// auto-submit off (default) with a question -> no sentinel
		await command?.handler("question", createCommandContext());
		assert.equal(
			(harness.execCalls[1]?.args ?? []).some((arg) => arg.includes("--launch-draft")),
			false,
		);

		// auto-submit on but no draft question -> no sentinel
		configStore.config = { ...DEFAULT_CONFIG, autoSubmit: true };
		await command?.handler("", createCommandContext());
		harness.cleanup();
		assert.equal(
			(harness.execCalls[3]?.args ?? []).some((arg) => arg.includes("--launch-draft")),
			false,
		);
	});
});

test("parent merge scan appends the transcript passively and auto-submits the prompt", async () => {
	await withParentEnvironment(async () => {
		const store = new FakeStore();
		const payload = store.readValue;
		store.mergeRequest = {
			protocolVersion: MERGE_PROTOCOL_VERSION,
			requestId: "req-42",
			launchId: payload.launchId,
			parentSessionId: payload.parentSessionId,
			capability: payload.capability,
			createdAt: "2026-07-15T00:05:00.000Z",
			summary: "packaged transcript from the side thread",
			prompt: "apply the side-thread findings",
		} satisfies MergeRequest;
		const harness = await createHarness(store, async () => ({ code: 0, stdout: "", stderr: "" }));
		const ctx = createCommandContext();

		await harness.commands.get("btw")?.handler("merge", ctx);
		harness.cleanup();

		assert.equal(harness.sentMessages.length, 1);
		const sent = harness.sentMessages[0];
		assert.equal(sent?.message.customType, MERGE_CUSTOM_TYPE);
		assert.equal(sent?.message.display, true);
		assert.match(sent?.message.content ?? "", /<btw-merge>\npackaged transcript from the side thread\n<\/btw-merge>/);
		assert.deepEqual(sent?.options, { triggerTurn: false });
		// The transcript itself never triggers a turn; the prompt does.
		assert.deepEqual(harness.sentUserMessages, ["apply the side-thread findings"]);
		assert.deepEqual(store.removed, [store.payloadPath]);
		assert.match(ctx.notifications.at(-1)?.message ?? "", /delivered 1/);
	});
});

test("parent does not reuse auth for a model selected during authentication", async () => {
	await withParentEnvironment(async () => {
		const store = new FakeStore();
		const payload = store.readValue;
		store.mergeRequest = {
			protocolVersion: MERGE_PROTOCOL_VERSION,
			requestId: "req-auth-race",
			launchId: payload.launchId,
			parentSessionId: payload.parentSessionId,
			capability: payload.capability,
			createdAt: "2026-07-15T00:05:00.000Z",
			summary: "auth race summary",
			prompt: "auth race prompt",
		} satisfies MergeRequest;
		const harness = await createHarness(store, async () => ({ code: 0, stdout: "", stderr: "" }));
		const ctx = createCommandContext();
		let resolveAuth: ((value: { ok: boolean }) => void) | undefined;
		let resolveAuthStarted: (() => void) | undefined;
		const authStarted = new Promise<void>((resolve) => (resolveAuthStarted = resolve));
		ctx.modelRegistry.getApiKeyAndHeaders = () => {
			resolveAuthStarted?.();
			return new Promise<{ ok: boolean }>((resolve) => {
				resolveAuth = resolve;
			});
		};
		await harness.emit("session_start", { reason: "startup" }, ctx);
		await harness.emit("session_shutdown", { reason: "test" }, {});

		const scan = harness.commands.get("btw")?.handler("merge", ctx);
		await authStarted;
		await harness.emit(
			"model_select",
			{ model: { provider: "other-provider", id: "other-model" } },
			ctx,
		);
		resolveAuth?.({ ok: true });
		await scan;
		harness.cleanup();

		assert.ok(store.mergeRequest);
		assert.deepEqual(store.removed, []);
		assert.equal(harness.sentMessages.length, 0);
		assert.equal(harness.sentUserMessages.length, 0);
	});
});

test("parent cancels an in-flight merge scan on session shutdown", async () => {
	await withParentEnvironment(async () => {
		const store = new FakeStore();
		const payload = store.readValue;
		store.mergeRequest = {
			protocolVersion: MERGE_PROTOCOL_VERSION,
			requestId: "req-shutdown-race",
			launchId: payload.launchId,
			parentSessionId: payload.parentSessionId,
			capability: payload.capability,
			createdAt: "2026-07-15T00:05:00.000Z",
			summary: "shutdown race summary",
			prompt: "shutdown race prompt",
		} satisfies MergeRequest;
		const harness = await createHarness(store, async () => ({ code: 0, stdout: "", stderr: "" }));
		const ctx = createCommandContext();
		let resolveAuth: ((value: { ok: boolean }) => void) | undefined;
		let resolveAuthStarted: (() => void) | undefined;
		const authStarted = new Promise<void>((resolve) => (resolveAuthStarted = resolve));
		ctx.modelRegistry.getApiKeyAndHeaders = () => {
			resolveAuthStarted?.();
			return new Promise<{ ok: boolean }>((resolve) => {
				resolveAuth = resolve;
			});
		};
		await harness.emit("session_start", { reason: "startup" }, ctx);

		const scan = harness.commands.get("btw")?.handler("merge", ctx);
		await authStarted;
		await harness.emit("session_shutdown", { reason: "quit" }, {});
		resolveAuth?.({ ok: true });
		await scan;
		harness.cleanup();

		assert.ok(store.mergeRequest);
		assert.deepEqual(store.removed, []);
		assert.equal(harness.sentMessages.length, 0);
		assert.equal(harness.sentUserMessages.length, 0);
	});
});

test("parent defers startup merge recovery until after initial rendering", async () => {
	await withParentEnvironment(async () => {
		const store = new FakeStore();
		const payload = store.readValue;
		store.mergeRequest = {
			protocolVersion: MERGE_PROTOCOL_VERSION,
			requestId: "req-startup",
			launchId: payload.launchId,
			parentSessionId: payload.parentSessionId,
			capability: payload.capability,
			createdAt: "2026-07-15T00:05:00.000Z",
			summary: "startup summary",
			prompt: "startup prompt",
		} satisfies MergeRequest;
		const harness = await createHarness(store, async () => ({ code: 0, stdout: "", stderr: "" }));
		const ctx = createCommandContext();

		await harness.emit("session_start", { reason: "startup" }, ctx);
		assert.equal(harness.sentMessages.length, 0);
		assert.deepEqual(harness.sentUserMessages, []);

		await new Promise<void>((resolve) => setImmediate(resolve));
		harness.cleanup();
		assert.deepEqual(store.operations.slice(0, 2), ["removeStale", "listLaunchPayloadPaths"]);
		assert.equal(harness.sentMessages.length, 1);
		assert.deepEqual(harness.sentUserMessages, ["startup prompt"]);
	});
});

test("parent defers merge delivery while busy and delivers on agent_settled", async () => {
	await withParentEnvironment(async () => {
		const store = new FakeStore();
		const payload = store.readValue;
		store.mergeRequest = {
			protocolVersion: MERGE_PROTOCOL_VERSION,
			requestId: "req-busy",
			launchId: payload.launchId,
			parentSessionId: payload.parentSessionId,
			capability: payload.capability,
			createdAt: "2026-07-15T00:05:00.000Z",
			summary: "deferred summary",
			prompt: "deferred prompt",
		} satisfies MergeRequest;
		const harness = await createHarness(store, async () => ({ code: 0, stdout: "", stderr: "" }));
		const ctx = createCommandContext();
		let idle = false;
		ctx.isIdle = () => idle;

		await harness.commands.get("btw")?.handler("merge", ctx);
		assert.equal(harness.sentMessages.length, 0);
		assert.deepEqual(harness.sentUserMessages, []);
		assert.ok(store.mergeRequest);
		assert.deepEqual(store.removed, []);
		assert.match(ctx.notifications.at(-1)?.message ?? "", /pending/);

		idle = true;
		await harness.emit("agent_settled", {}, ctx);
		harness.cleanup();
		assert.equal(harness.sentMessages.length, 1);
		assert.deepEqual(harness.sentUserMessages, ["deferred prompt"]);
		assert.deepEqual(store.removed, [store.payloadPath]);
	});
});

test("parent rejects merges that fail capability validation", async () => {
	await withParentEnvironment(async () => {
		const store = new FakeStore();
		const payload = store.readValue;
		store.mergeRequest = {
			protocolVersion: MERGE_PROTOCOL_VERSION,
			requestId: "req-forged",
			launchId: payload.launchId,
			parentSessionId: payload.parentSessionId,
			capability: "f".repeat(64),
			createdAt: "2026-07-15T00:05:00.000Z",
			summary: "forged summary",
			prompt: "forged prompt",
		} satisfies MergeRequest;
		const harness = await createHarness(store, async () => ({ code: 0, stdout: "", stderr: "" }));
		const ctx = createCommandContext();

		await harness.commands.get("btw")?.handler("merge", ctx);
		harness.cleanup();

		assert.equal(harness.sentMessages.length, 0);
		assert.deepEqual(harness.sentUserMessages, []);
		assert.deepEqual(store.removed, [store.payloadPath]);
	});
});

test("child mode blocks prompts when the private payload cannot be read", async () => {
	await withChildEnvironment("/tmp/missing/payload.json", async () => {
		const store = new FakeStore();
		store.readError = new Error("payload missing");
		const harness = await createHarness(store, async () => ({ code: 0, stdout: "", stderr: "" }));
		harness.cleanup();
		const notifications: Array<{ message: string; type: string }> = [];
		const result = await harness.handlers.get("input")?.[0]?.(
			{ text: "question", source: "interactive" },
			{ ui: { notify: (message: string, type: string) => notifications.push({ message, type }) } },
		);
		assert.deepEqual(result, { action: "handled" });
		assert.deepEqual(notifications, [{ message: "/btw is blocked: payload missing", type: "error" }]);
	});
});

test("child quit keeps the launch directory while a merge is pending", async () => {
	await withChildEnvironment("/tmp/pi-herdr-btw-test/launch-123/payload.json", async () => {
		const store = new FakeStore();
		const harness = await createHarness(store, async () => ({ code: 0, stdout: "", stderr: "" }));
		harness.cleanup();

		await harness.emit("session_shutdown", { reason: "reload" }, {});
		assert.deepEqual(store.removed, []);

		store.mergeRequest = { requestId: "req-1" };
		await harness.emit("session_shutdown", { reason: "quit" }, {});
		assert.deepEqual(store.removed, []);
		assert.equal(store.retained, 1);
	});
});

function createChildStartContext() {
	const editorText: string[] = [];
	const widgets: string[][] = [];
	const notifications: Array<{ message: string; type: string }> = [];
	return {
		ctx: {
			mode: "tui",
			ui: {
				setTitle: () => undefined,
				setWidget: (_name: string, lines: string[]) => widgets.push(lines),
				setEditorText: (text: string) => editorText.push(text),
				notify: (message: string, type: string) => notifications.push({ message, type }),
				theme: { fg: (_color: string, text: string) => text },
			},
		},
		editorText,
		notifications,
		widgets,
	};
}

test("child rearms its heartbeat after a session reload", async () => {
	await withChildEnvironment("/tmp/pi-herdr-btw-test/launch-123/payload.json", async () => {
		const store = new FakeStore();
		const harness = await createHarness(store, async () => ({ code: 0, stdout: "", stderr: "" }));
		assert.equal(harness.timers.length, 1);
		await Promise.resolve();
		const initialTouches = store.touchRuns;

		await harness.emit("session_shutdown", { reason: "reload" }, {});
		await harness.emit("session_start", { reason: "reload" }, { mode: "rpc" });
		harness.cleanup();

		assert.equal(harness.timers.length, 1);
		assert.equal(store.touchRuns, initialTouches + 1);
	});
});

test("child submits the auto-submit draft via the launch-draft sentinel, not session_start", async () => {
	await withChildEnvironment("/tmp/pi-herdr-btw-test/launch-123/payload.json", async () => {
		const store = new FakeStore();
		store.readValue = fixturePayload({
			draftQuestion: "submit this",
			config: { ...DEFAULT_CONFIG, autoSubmit: true, tools: "none" },
		});
		const harness = await createHarness(store, async () => ({ code: 0, stdout: "", stderr: "" }));
		harness.cleanup();
		const { ctx, editorText, widgets } = createChildStartContext();
		await harness.emit("session_start", { reason: "startup" }, ctx);

		// session_start must not send the draft: a message sent there lands in
		// the session entries before renderInitialMessages() and paints twice.
		assert.deepEqual(harness.sentUserMessages, []);
		assert.deepEqual(editorText, []);
		assert.match(widgets[0]?.join("\n") ?? "", /tool-free/);
		assert.equal(widgets[0]?.length, 1);

		// The sentinel (pi's initial message, processed after initial render)
		// performs the one-shot submit.
		const notifications: Array<{ message: string; type: string }> = [];
		const commandCtx = {
			sessionManager: { getEntries: () => [], getLeafId: () => null },
			ui: { notify: (message: string, type: string) => notifications.push({ message, type }) },
		};
		await harness.commands.get("btw")?.handler("--launch-draft", commandCtx);
		assert.deepEqual(harness.sentUserMessages, ["submit this"]);
		assert.deepEqual(notifications, []);

		// One-shot: a replay must not re-submit the draft.
		await harness.commands.get("btw")?.handler("--launch-draft", commandCtx);
		assert.deepEqual(harness.sentUserMessages, ["submit this"]);
	});
});

test("child prefills the editor for non-auto-submit drafts and ignores a stray sentinel", async () => {
	await withChildEnvironment("/tmp/pi-herdr-btw-test/launch-123/payload.json", async () => {
		const store = new FakeStore();
		store.readValue = fixturePayload({ draftQuestion: "/foo behavior" });
		const harness = await createHarness(store, async () => ({ code: 0, stdout: "", stderr: "" }));
		harness.cleanup();
		const { ctx, editorText } = createChildStartContext();
		await harness.emit("session_start", { reason: "startup" }, ctx);

		assert.equal(editorText[0]?.startsWith("\u200b/foo behavior"), true);
		assert.deepEqual(harness.sentUserMessages, []);
		assert.deepEqual(
			await harness.emit("input", { text: "\u200b/foo behavior", source: "interactive" }, {}),
			[{ action: "transform", text: "/foo behavior", images: undefined }],
		);

		// A sentinel against a non-auto-submit payload submits nothing.
		const notifications: Array<{ message: string; type: string }> = [];
		await harness.commands.get("btw")?.handler("--launch-draft", {
			sessionManager: { getEntries: () => [], getLeafId: () => null },
			ui: { notify: (message: string, type: string) => notifications.push({ message, type }) },
		});
		assert.deepEqual(harness.sentUserMessages, []);
	});
});

test("child uses the native prefix when model, tools, and thinking match the parent", async () => {
	await withChildEnvironment("/tmp/pi-herdr-btw-test/launch-123/payload.json", async () => {
		const store = new FakeStore();
		const harness = await createHarness(store, async () => ({ code: 0, stdout: "", stderr: "" }));
		harness.cleanup();
		const ctx = { model: { provider: "test-provider", id: "test-model" } };

		const [startResult] = await harness.emit(
			"before_agent_start",
			{ systemPrompt: "child default prompt" },
			ctx,
		);
		assert.deepEqual(startResult, { systemPrompt: "parent system prompt" });

		const [contextResult] = await harness.emit(
			"context",
			{ messages: [{ role: "user", content: [{ type: "text", text: "side question" }], timestamp: 9 }] },
			ctx,
		);
		const messages = contextResult?.messages ?? [];
		// exact parent prefix, then the bridge suffix, then the child's own messages
		assert.deepEqual(messages[0], store.readValue.messages[0]);
		assert.match(messages[1]?.content?.[0]?.text ?? "", /read-only snapshot of the parent session/);
		assert.match(messages[1]?.content?.[0]?.text ?? "", /side pane/);
		assert.equal(messages.at(-1)?.content?.[0]?.text, "side question");
	});
});

test("child falls back to the portable document when the prefix cannot match", async () => {
	await withChildEnvironment("/tmp/pi-herdr-btw-test/launch-123/payload.json", async () => {
		const store = new FakeStore();
		store.readValue = fixturePayload({ config: { ...DEFAULT_CONFIG, tools: "read-only" } });
		const harness = await createHarness(store, async () => ({ code: 0, stdout: "", stderr: "" }));
		harness.cleanup();
		const ctx = { model: { provider: "test-provider", id: "test-model" } };

		const [startResult] = await harness.emit(
			"before_agent_start",
			{ systemPrompt: "child default prompt" },
			ctx,
		);
		assert.match(startResult?.systemPrompt ?? "", /^child default prompt/);
		assert.match(startResult?.systemPrompt ?? "", /side pane/);

		const [contextResult] = await harness.emit(
			"context",
			{ messages: [{ role: "user", content: [{ type: "text", text: "side question" }], timestamp: 9 }] },
			ctx,
		);
		const messages = contextResult?.messages ?? [];
		assert.equal(messages.length, 2);
		assert.match(messages[0]?.content?.[0]?.text ?? "", /read-only snapshot/);
		assert.match(messages[0]?.content?.[0]?.text ?? "", /<parent-conversation>/);
	});
});

function createChildMergeContext(options: { editor?: (title: string, prefill?: string) => Promise<string | undefined> } = {}) {
	const notifications: Array<{ message: string; type: string }> = [];
	const entries = [
		{
			type: "message",
			id: "m1",
			parentId: null,
			timestamp: "2026-07-15T00:00:00.000Z",
			message: {
				role: "user",
				content: [{ type: "text", text: "side question" }],
				timestamp: 1,
			},
		},
		{
			type: "message",
			id: "m2",
			parentId: "m1",
			timestamp: "2026-07-15T00:00:01.000Z",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "the finding" }],
				timestamp: 2,
			},
		},
	];
	const ctx = {
		mode: "tui" as const,
		hasUI: true,
		sessionManager: { getEntries: () => entries, getLeafId: () => "m2" },
		ui: {
			notify: (message: string, type: string) => notifications.push({ message, type }),
			editor:
				options.editor ??
				(async () => {
					throw new Error("editor must not open when a prompt is supplied");
				}),
		},
	};
	return { ctx, notifications };
}

async function withChildPaneId(paneId: string | undefined, run: () => Promise<void>): Promise<void> {
	const previous = process.env.HERDR_PANE_ID;
	if (paneId === undefined) delete process.env.HERDR_PANE_ID;
	else process.env.HERDR_PANE_ID = paneId;
	try {
		await run();
	} finally {
		if (previous === undefined) delete process.env.HERDR_PANE_ID;
		else process.env.HERDR_PANE_ID = previous;
	}
}

test("child merge packages the transcript with the prompt, refocuses the parent, and closes its pane", async () => {
	await withChildEnvironment("/tmp/pi-herdr-btw-test/launch-123/payload.json", async () => {
		await withChildPaneId("w1:p9", async () => {
			const store = new FakeStore();
			const harness = await createHarness(store, async () => ({ code: 0, stdout: "", stderr: "" }));
			harness.cleanup();
			const { ctx } = createChildMergeContext();

			await harness.commands.get("btw")?.handler("merge apply the findings", ctx);

			const request = store.mergeRequest as MergeRequest;
			assert.equal(request.prompt, "apply the findings");
			assert.match(request.summary, /User:\nside question/);
			assert.match(request.summary, /Assistant:\nthe finding/);
			assert.equal(request.launchId, store.readValue.launchId);
			assert.equal(request.capability, store.readValue.capability);
			assert.equal(request.parentSessionId, store.readValue.parentSessionId);
			// Close the loop: focus the parent pane, then close this one.
			assert.deepEqual(harness.execCalls, [
				{ command: "herdr", args: ["agent", "focus", "w1:p1"] },
				{ command: "herdr", args: ["pane", "close", "w1:p9"] },
			]);
		});
	});
});

test("child merge reports completed handoff when no Herdr pane can close", async () => {
	await withChildEnvironment("/tmp/pi-herdr-btw-test/launch-123/payload.json", async () => {
		await withChildPaneId(undefined, async () => {
			const store = new FakeStore();
			const harness = await createHarness(store, async () => ({ code: 0, stdout: "", stderr: "" }));
			harness.cleanup();
			const { ctx, notifications } = createChildMergeContext();

			await harness.commands.get("btw")?.handler("merge apply the findings", ctx);

			assert.ok(store.mergeRequest);
			assert.deepEqual(harness.execCalls, []);
			assert.match(notifications.at(-1)?.message ?? "", /Merge sent/);
		});
	});
});

test("child merge with no prompt composes one in the editor; cancellation writes nothing", async () => {
	await withChildEnvironment("/tmp/pi-herdr-btw-test/launch-123/payload.json", async () => {
		const store = new FakeStore();
		const harness = await createHarness(store, async () => ({ code: 0, stdout: "", stderr: "" }));
		harness.cleanup();
		const editorCalls: Array<{ title: string; prefill?: string }> = [];
		const { ctx, notifications } = createChildMergeContext({
			editor: async (title: string, prefill?: string) => {
				editorCalls.push({ title, prefill });
				return undefined;
			},
		});
		await harness.commands.get("btw")?.handler("merge", ctx);
		assert.match(editorCalls[0]?.title ?? "", /Prompt for the parent/);
		assert.equal(store.mergeRequest, undefined);
		assert.match(notifications.at(-1)?.message ?? "", /cancelled/);
	});
});

test("child merge refuses bare merge without UI", async () => {
	await withChildEnvironment("/tmp/pi-herdr-btw-test/launch-123/payload.json", async () => {
		const store = new FakeStore();
		const harness = await createHarness(store, async () => ({ code: 0, stdout: "", stderr: "" }));
		harness.cleanup();
		let editorOpened = false;
		const { ctx, notifications } = createChildMergeContext({
			editor: async () => {
				editorOpened = true;
				return "prompt";
			},
		});
		ctx.hasUI = false;

		await harness.commands.get("btw")?.handler("merge", ctx);

		assert.equal(editorOpened, false);
		assert.equal(store.mergeRequest, undefined);
		assert.match(notifications.at(-1)?.message ?? "", /interactive UI/);
	});
});

test("child merge refuses an empty side thread", async () => {
	await withChildEnvironment("/tmp/pi-herdr-btw-test/launch-123/payload.json", async () => {
		const store = new FakeStore();
		const harness = await createHarness(store, async () => ({ code: 0, stdout: "", stderr: "" }));
		harness.cleanup();
		const notifications: Array<{ message: string; type: string }> = [];
		const ctx = {
			sessionManager: { getEntries: () => [], getLeafId: () => null },
			ui: {
				notify: (message: string, type: string) => notifications.push({ message, type }),
			},
		};
		await harness.commands.get("btw")?.handler("merge apply the findings", ctx);
		assert.equal(store.mergeRequest, undefined);
		assert.deepEqual(harness.execCalls, []);
		assert.match(notifications.at(-1)?.message ?? "", /no conversation yet/);
	});
});

test("child merge fails closed when pending-delivery lookup fails", async () => {
	await withChildEnvironment("/tmp/pi-herdr-btw-test/launch-123/payload.json", async () => {
		const store = new FakeStore();
		store.mergeReadError = new Error("mailbox unavailable");
		const harness = await createHarness(store, async () => ({ code: 0, stdout: "", stderr: "" }));
		harness.cleanup();
		const { ctx, notifications } = createChildMergeContext();

		await harness.commands.get("btw")?.handler("merge another prompt", ctx);

		assert.equal(store.mergeRequest, undefined);
		assert.deepEqual(harness.execCalls, []);
		assert.equal(notifications.at(-1)?.type, "error");
		assert.match(notifications.at(-1)?.message ?? "", /could not check pending delivery: mailbox unavailable/);
	});
});

test("child merge refuses to stack a second request on a pending one", async () => {
	await withChildEnvironment("/tmp/pi-herdr-btw-test/launch-123/payload.json", async () => {
		const store = new FakeStore();
		store.mergeRequest = { requestId: "req-1" };
		const harness = await createHarness(store, async () => ({ code: 0, stdout: "", stderr: "" }));
		harness.cleanup();
		const notifications: Array<{ message: string; type: string }> = [];
		const ctx = {
			sessionManager: { getEntries: () => [], getLeafId: () => null },
			ui: {
				notify: (message: string, type: string) => notifications.push({ message, type }),
				editor: async () => "should not be reached",
			},
		};
		await harness.commands.get("btw")?.handler("merge another prompt", ctx);
		assert.deepEqual(store.mergeRequest, { requestId: "req-1" });
		assert.match(notifications.at(-1)?.message ?? "", /already sent/);
	});
});
