import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG, type BtwConfig } from "../internal/config.ts";
import type { BtwPayload } from "../internal/core.ts";
import {
	MERGE_CUSTOM_TYPE,
	MERGE_PROTOCOL_VERSION,
	MERGE_SUBMISSION_CUSTOM_TYPE,
	type MergeAck,
	type MergeRequest,
} from "../internal/merge.ts";
import {
	decideCacheMode,
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

/** Herdr exec stub: pane split succeeds with a pane ID; agent start uses the given result. */
function herdrExec(agentStart: ExecResult = { code: 0, stdout: "ok", stderr: "" }) {
	return async (_command: string, args: string[]): Promise<ExecResult> => {
		if (args[0] === "pane" && args[1] === "split") {
			return { code: 0, stdout: PANE_SPLIT_STDOUT, stderr: "" };
		}
		return agentStart;
	};
}

class FakeStore implements ContextStorePort {
	readonly payloadPath = "/tmp/pi-herdr-btw-test/launch-123/payload.json";
	readonly created: BtwPayload[] = [];
	readonly removed: string[] = [];
	staleRuns = 0;
	touchRuns = 0;
	readValue: BtwPayload = fixturePayload({ draftQuestion: "draft" });
	readError: Error | undefined;
	mergeRequest: unknown;
	mergeAck: MergeAck | undefined;
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
	}

	async touch(): Promise<void> {
		this.touchRuns += 1;
	}

	async removeStale(): Promise<void> {
		this.staleRuns += 1;
	}

	async listLaunchPayloadPaths(): Promise<string[]> {
		return [this.payloadPath];
	}

	async writeMergeRequest(_payloadPath: string, request: MergeRequest): Promise<void> {
		this.mergeRequest = request;
	}

	async readMergeRequest(_payloadPath: string): Promise<unknown> {
		return this.mergeRequest;
	}

	async writeMergeAck(_payloadPath: string, ack: MergeAck): Promise<void> {
		this.mergeAck = ack;
	}

	async readMergeAck(_payloadPath: string): Promise<unknown> {
		return this.mergeAck;
	}

	async removeIfNoPendingMerge(payloadPath: string): Promise<boolean> {
		if (this.mergeRequest !== undefined && this.mergeAck === undefined) {
			this.retained += 1;
			return false;
		}
		this.removed.push(payloadPath);
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

	async save(config: BtwConfig): Promise<void> {
		this.config = { ...config };
		this.saved.push({ ...config });
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
		scopedModels: [],
		modelRegistry: {
			getApiKeyAndHeaders: async () => ({ ok: true }),
		},
		isIdle: () => true,
		getSystemPrompt: () => "parent system prompt",
		sessionManager: {
			getEntries: () => entries,
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
	const appendedEntries: Array<{ customType: string; data: unknown }> = [];
	const timers: Array<ReturnType<typeof setInterval>> = [];
	const originalSetInterval = globalThis.setInterval;
	const pi = {
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
		appendEntry: (customType: string, data: unknown) => appendedEntries.push({ customType, data }),
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

	return { commands, handlers, execCalls, sentUserMessages, sentMessages, appendedEntries, configStore, emit, cleanup, timers };
}

async function withParentEnvironment(run: () => Promise<void>): Promise<void> {
	const previous = {
		payload: process.env.PI_HERDR_BTW_PAYLOAD,
		herdr: process.env.HERDR_ENV,
		pane: process.env.HERDR_PANE_ID,
		workspace: process.env.HERDR_WORKSPACE_ID,
		tab: process.env.HERDR_TAB_ID,
	};
	delete process.env.PI_HERDR_BTW_PAYLOAD;
	process.env.HERDR_ENV = "1";
	process.env.HERDR_PANE_ID = "w1:p1";
	process.env.HERDR_WORKSPACE_ID = "w1";
	process.env.HERDR_TAB_ID = "w1:t1";
	try {
		await run();
	} finally {
		for (const [key, value] of Object.entries({
			PI_HERDR_BTW_PAYLOAD: previous.payload,
			HERDR_ENV: previous.herdr,
			HERDR_PANE_ID: previous.pane,
			HERDR_WORKSPACE_ID: previous.workspace,
			HERDR_TAB_ID: previous.tab,
		})) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

async function withChildEnvironment(payloadPath: string, run: () => Promise<void>): Promise<void> {
	const previous = process.env.PI_HERDR_BTW_PAYLOAD;
	process.env.PI_HERDR_BTW_PAYLOAD = payloadPath;
	try {
		await run();
	} finally {
		if (previous === undefined) delete process.env.PI_HERDR_BTW_PAYLOAD;
		else process.env.PI_HERDR_BTW_PAYLOAD = previous;
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
		assert.equal(harness.execCalls[0]?.command, "herdr");
		assert.equal(harness.execCalls[1]?.command, "herdr");
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
		assert.ok(
			splitArgs.includes("PI_HERDR_BTW_PAYLOAD=/tmp/pi-herdr-btw-test/launch-123/payload.json"),
		);
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
	const previous = { payload: process.env.PI_HERDR_BTW_PAYLOAD, herdr: process.env.HERDR_ENV };
	delete process.env.PI_HERDR_BTW_PAYLOAD;
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
		if (previous.payload !== undefined) process.env.PI_HERDR_BTW_PAYLOAD = previous.payload;
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
		await command?.handler("config model anthropic/claude-sonnet", ctx);
		await command?.handler("config tools read-only", ctx);
		harness.cleanup();

		assert.equal(harness.configStore.config.autoSubmit, true);
		assert.equal(harness.configStore.config.model, "anthropic/claude-sonnet");
		assert.equal(harness.configStore.config.tools, "read-only");
		assert.equal(harness.configStore.saved.length, 3);

		harness.configStore.loadError = new Error("malformed config");
		await command?.handler("config reset", ctx);
		assert.deepEqual(harness.configStore.config, DEFAULT_CONFIG);
		assert.equal(harness.configStore.resetRuns, 1);
	});
});

test("btw-model saves a selected text model while preserving other settings", async () => {
	const store = new FakeStore();
	const configStore = new FakeConfigStore();
	configStore.config = { ...DEFAULT_CONFIG, autoSubmit: true };
	const harness = await createHarness(store, async () => ({ code: 0, stdout: "", stderr: "" }), configStore);
	const ctx = createCommandContext();
	ctx.modelRegistry = {
		getAvailable: () => [
			{ provider: "image", id: "vision", input: ["image"] },
			{
				provider: "test-provider",
				id: "test-model",
				input: ["text"],
				reasoning: true,
				thinkingLevelMap: { xhigh: "xhigh", max: "max" },
			},
			{ provider: "test-provider", id: "unscoped-model", input: ["text"] },
		],
	};
	ctx.scopedModels = [
		{
			model: {
				provider: "test-provider",
				id: "test-model",
				input: ["text"],
				reasoning: true,
				thinkingLevelMap: { xhigh: "xhigh", max: "max" },
			},
		},
	];
	ctx.ui.select = async (title: string, choices: string[]) => {
		if (title === "BTW model") {
			assert.deepEqual(choices, ["Current session model", "test-provider/test-model"]);
			return "test-provider/test-model";
		}
		assert.equal(title, "Thinking level · test-provider/test-model");
		assert.deepEqual(choices, ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
		return "max";
	};

	await harness.commands.get("btw-model")?.handler("", ctx);
	assert.deepEqual(configStore.config, {
		...DEFAULT_CONFIG,
		autoSubmit: true,
		model: "test-provider/test-model",
		thinkingLevel: "max",
	});
	assert.deepEqual(configStore.saved, [configStore.config]);
	assert.match(ctx.notifications.at(-1)?.message ?? "", /test-provider\/test-model/);
	harness.cleanup();
});

test("btw-model restricts a scoped model to its pinned thinking level", async () => {
	const store = new FakeStore();
	const configStore = new FakeConfigStore();
	const harness = await createHarness(store, async () => ({ code: 0, stdout: "", stderr: "" }), configStore);
	const ctx = createCommandContext();
	ctx.scopedModels = [
		{
			model: {
				provider: "test-provider",
				id: "pinned-model",
				input: ["text"],
				reasoning: true,
				thinkingLevelMap: { low: "low", max: "max" },
			},
			thinkingLevel: "low",
		},
	];
	let pickerCalls = 0;
	ctx.ui.select = async (title: string, choices: string[]) => {
		pickerCalls += 1;
		assert.equal(title, "BTW model");
		assert.deepEqual(choices, ["Current session model", "test-provider/pinned-model"]);
		return "test-provider/pinned-model";
	};

	await harness.commands.get("btw-model")?.handler("", ctx);
	assert.equal(pickerCalls, 1);
	assert.equal(configStore.config.model, "test-provider/pinned-model");
	assert.equal(configStore.config.thinkingLevel, "low");
	harness.cleanup();
});

test("btw-model refuses non-UI mode without opening a picker", async () => {
	const store = new FakeStore();
	const harness = await createHarness(store, async () => ({ code: 0, stdout: "", stderr: "" }));
	const ctx = createCommandContext();
	ctx.hasUI = false;
	let selected = false;
	ctx.ui.select = async () => {
		selected = true;
		return "Current session model";
	};

	await harness.commands.get("btw-model")?.handler("", ctx);
	harness.cleanup();

	assert.equal(selected, false);
	assert.match(ctx.notifications.at(-1)?.message ?? "", /interactive UI/);
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
			startCalls += 1;
			return startCalls === 1
				? { code: 1, stdout: "", stderr: busy }
				: { code: 0, stdout: "ok", stderr: "" };
		});
		await harness.commands.get("btw")?.handler("question", createCommandContext());
		harness.cleanup();

		assert.equal(startCalls, 2);
		assert.deepEqual(store.removed, []);
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

test("parent command removes payload when pane split output has no pane ID", async () => {
	await withParentEnvironment(async () => {
		const store = new FakeStore();
		const harness = await createHarness(store, async () => ({
			code: 0,
			stdout: "not json",
			stderr: "",
		}));
		const ctx = createCommandContext();
		await harness.commands.get("btw")?.handler("question", ctx);
		harness.cleanup();

		assert.equal(harness.execCalls.length, 1);
		assert.deepEqual(store.removed, [store.payloadPath]);
		assert.equal(ctx.notifications.at(-1)?.type, "error");
		assert.match(ctx.notifications.at(-1)?.message ?? "", /pane ID/);
	});
});

test("parent command retains payload for an ambiguous killed launch", async () => {
	await withParentEnvironment(async () => {
		const store = new FakeStore();
		const harness = await createHarness(
			store,
			herdrExec({ code: 1, stdout: "", stderr: "timeout", killed: true }),
		);
		const ctx = createCommandContext();
		await harness.commands.get("btw")?.handler("question", ctx);
		harness.cleanup();

		assert.deepEqual(store.removed, []);
		assert.equal(ctx.notifications.at(-1)?.type, "warning");
		assert.match(ctx.notifications.at(-1)?.message ?? "", /cleanup is deferred/);
	});
});

test("parent command applies configured model, thinking, tools, and split", async () => {
	await withParentEnvironment(async () => {
		const store = new FakeStore();
		const configStore = new FakeConfigStore();
		configStore.config = {
			autoSubmit: true,
			model: "anthropic/claude-haiku",
			thinkingLevel: "low",
			tools: "none",
			split: "down",
		};
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
		assert.deepEqual(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2), [
			"--model",
			"anthropic/claude-haiku",
		]);
		assert.deepEqual(args.slice(args.indexOf("--thinking"), args.indexOf("--thinking") + 2), [
			"--thinking",
			"low",
		]);
		// autoSubmit launches carry the launch-draft sentinel as pi's initial
		// message so the child submits the draft after initial render (avoids
		// the double-paint startup race); the question itself never hits argv.
		assert.equal(args.at(-1), "/btw --launch-draft");
		assert.equal(args.at(-2), "--no-tools");
		assert.equal(
			[...splitArgs, ...args].some((arg) => arg.includes("question")),
			false,
		);
	});
});

test("parent uses saved BTW model without a current model", async () => {
	await withParentEnvironment(async () => {
		const store = new FakeStore();
		const configStore = new FakeConfigStore();
		configStore.config = {
			...DEFAULT_CONFIG,
			model: "openai-codex/gpt-5.6-luna",
			thinkingLevel: "max",
		};
		const harness = await createHarness(store, herdrExec(), configStore);
		const ctx = createCommandContext();
		ctx.model = undefined;
		await harness.commands.get("btw")?.handler("question", ctx);
		harness.cleanup();

		const args = harness.execCalls[1]?.args ?? [];
		assert.deepEqual(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2), [
			"--model",
			"openai-codex/gpt-5.6-luna",
		]);
		assert.deepEqual(args.slice(args.indexOf("--thinking"), args.indexOf("--thinking") + 2), [
			"--thinking",
			"max",
		]);
	});
});

test("parent honors scoped thinking pin for saved BTW model", async () => {
	await withParentEnvironment(async () => {
		const store = new FakeStore();
		const configStore = new FakeConfigStore();
		configStore.config = { ...DEFAULT_CONFIG, model: "anthropic/claude-haiku", thinkingLevel: "max" };
		const harness = await createHarness(store, herdrExec(), configStore);
		const ctx = createCommandContext();
		ctx.scopedModels = [
			{
				model: { provider: "anthropic", id: "claude-haiku", input: ["text"] },
				thinkingLevel: "low",
			},
		];
		await harness.commands.get("btw")?.handler("question", ctx);
		harness.cleanup();

		const args = harness.execCalls[1]?.args ?? [];
		assert.deepEqual(args.slice(args.indexOf("--thinking"), args.indexOf("--thinking") + 2), [
			"--thinking",
			"low",
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
		assert.deepEqual(harness.appendedEntries, [
			{
				customType: MERGE_SUBMISSION_CUSTOM_TYPE,
				data: { requestId: "req-42", launchId: payload.launchId },
			},
		]);
		assert.equal(store.mergeAck?.status, "accepted");
		assert.match(ctx.notifications.at(-1)?.message ?? "", /delivered 1/);
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
		assert.equal(store.mergeAck, undefined);
		assert.match(ctx.notifications.at(-1)?.message ?? "", /pending/);

		idle = true;
		await harness.emit("agent_settled", {}, ctx);
		harness.cleanup();
		assert.equal(harness.sentMessages.length, 1);
		assert.deepEqual(harness.sentUserMessages, ["deferred prompt"]);
		assert.equal((store.mergeAck as MergeAck | undefined)?.status, "accepted");
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
		assert.equal(store.mergeAck?.status, "rejected");
		assert.match(store.mergeAck?.reason ?? "", /capability/);
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

test("child quit keeps the launch directory while a merge is unacknowledged", async () => {
	await withChildEnvironment("/tmp/pi-herdr-btw-test/launch-123/payload.json", async () => {
		const store = new FakeStore();
		const harness = await createHarness(store, async () => ({ code: 0, stdout: "", stderr: "" }));
		harness.cleanup();

		await harness.emit("session_shutdown", { reason: "reload" }, {});
		assert.deepEqual(store.removed, []);

		// pending unacked merge -> retained
		store.mergeRequest = { requestId: "req-1" };
		await harness.emit("session_shutdown", { reason: "quit" }, {});
		assert.deepEqual(store.removed, []);
		assert.equal(store.retained, 1);

		// acknowledged -> removed
		store.mergeAck = {
			protocolVersion: MERGE_PROTOCOL_VERSION,
			requestId: "req-1",
			status: "accepted",
			processedAt: "2026-07-15T00:06:00.000Z",
		};
		await harness.emit("session_shutdown", { reason: "quit" }, {});
		assert.deepEqual(store.removed, [store.payloadPath]);
	});
});

function createChildStartContext() {
	const editorText: string[] = [];
	const widgets: string[][] = [];
	return {
		ctx: {
			mode: "tui",
			ui: {
				setTitle: () => undefined,
				setWidget: (_name: string, lines: string[]) => widgets.push(lines),
				setEditorText: (text: string) => editorText.push(text),
				theme: { fg: (_color: string, text: string) => text },
			},
		},
		editorText,
		widgets,
	};
}

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

test("decideCacheMode explains every fallback reason", () => {
	const payload = fixturePayload();
	const matching = {
		model: "test-provider/test-model",
		activeTools: ["read", "bash"],
		thinkingLevel: "high",
	};
	assert.deepEqual(decideCacheMode(payload, matching), { mode: "native" });
	const noPrompt = decideCacheMode(fixturePayload({ parentSystemPrompt: null }), matching);
	assert.match(noPrompt.reason ?? "", /system prompt/);
	assert.match(
		decideCacheMode(payload, { ...matching, model: "other/model" }).reason ?? "",
		/model/,
	);
	assert.match(
		decideCacheMode(payload, { ...matching, activeTools: ["read"] }).reason ?? "",
		/tool/,
	);
	assert.match(
		decideCacheMode(payload, { ...matching, thinkingLevel: "low" }).reason ?? "",
		/thinking/,
	);
	assert.match(
		decideCacheMode(
			fixturePayload({ config: { ...DEFAULT_CONFIG, model: "anthropic/claude-haiku" } }),
			matching,
		).reason ?? "",
		/model/,
	);
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

test("child merge stays open and polls for the ack when it is not in a Herdr pane", async () => {
	await withChildEnvironment("/tmp/pi-herdr-btw-test/launch-123/payload.json", async () => {
		await withChildPaneId(undefined, async () => {
			const store = new FakeStore();
			const harness = await createHarness(store, async () => ({ code: 0, stdout: "", stderr: "" }));
			harness.cleanup();
			const { ctx, notifications } = createChildMergeContext();

			const originalSetInterval = globalThis.setInterval;
			const timers: Array<ReturnType<typeof setInterval>> = [];
			(globalThis as any).setInterval = (...args: Parameters<typeof setInterval>) => {
				const timer = originalSetInterval(...args);
				timers.push(timer);
				return timer;
			};
			try {
				await harness.commands.get("btw")?.handler("merge apply the findings", ctx);
			} finally {
				(globalThis as any).setInterval = originalSetInterval;
				for (const timer of timers) clearInterval(timer);
			}

			assert.ok(store.mergeRequest);
			assert.deepEqual(harness.execCalls, []);
			assert.match(notifications.at(-1)?.message ?? "", /Merge pending/);
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
		assert.match(notifications.at(-1)?.message ?? "", /already pending/);
	});
});
