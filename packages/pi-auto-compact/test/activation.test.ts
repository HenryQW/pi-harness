import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import autoCompact from "../extensions/auto-compact.ts";

type Handler = (event: never, ctx: ExtensionContext) => unknown;
type Command = (args: string, ctx: ExtensionContext) => Promise<void>;

function loadExtension(
	commands = new Map<string, Command>(),
	sendUserMessage: (content: string) => void = () => {},
): Map<string, Handler> {
	const handlers = new Map<string, Handler>();
	autoCompact({
		on(event: string, handler: Handler) {
			handlers.set(event, handler);
		},
		registerCommand(name: string, options: { handler: Command }) {
			commands.set(name, options.handler);
		},
		sendUserMessage,
	} as unknown as ExtensionAPI);
	return handlers;
}

test("suppresses only empty abort caused by pending extension compaction", async () => {
	const tempRoot = await mkdtemp(join(tmpdir(), "pi-auto-compact-abort-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = tempRoot;

	try {
		await writeFile(join(tempRoot, "settings.json"), JSON.stringify({
			compaction: { enabled: false },
		}));
		const handlers = loadExtension();
		const compactionAbort = new AbortController();
		let signal = AbortSignal.abort();
		const ctx = {
			cwd: tempRoot,
			isProjectTrusted: () => true,
			getContextUsage: () => ({ tokens: 75, contextWindow: 100, percent: 75 }),
			compact() {},
			get signal() { return signal; },
		} as unknown as ExtensionContext;
		handlers.get("session_start")?.(
			{ type: "session_start", reason: "startup" } as never,
			ctx,
		);

		const aborted = {
			type: "message_end",
			message: {
				role: "assistant",
				content: [],
				stopReason: "error",
				errorMessage: "This operation was aborted",
			},
		};
		assert.equal(handlers.get("message_end")?.(aborted as never, ctx), undefined);

		signal = compactionAbort.signal;
		handlers.get("turn_start")?.({} as never, ctx);
		compactionAbort.abort();
		assert.equal(handlers.get("message_end")?.({
			...aborted,
			message: { ...aborted.message, content: [{ type: "text", text: "partial" }] },
		} as never, ctx), undefined);
		assert.equal(handlers.get("message_end")?.({
			...aborted,
			message: { ...aborted.message, errorMessage: "Provider failed" },
		} as never, ctx), undefined);
		assert.deepEqual(handlers.get("message_end")?.(aborted as never, ctx), {
			message: {
				...aborted.message,
				stopReason: "stop",
				errorMessage: undefined,
			},
		});
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("configures threshold and ignores obsolete model fields", async () => {
	const tempRoot = await mkdtemp(join(tmpdir(), "pi-auto-compact-config-"));
	const configFile = join(tempRoot, "config", "pi-auto-compact.json");
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = tempRoot;

	try {
		await mkdir(join(tempRoot, "config"), { recursive: true });
		await writeFile(join(tempRoot, "settings.json"), JSON.stringify({ compaction: { enabled: false } }));
		const legacyConfig = {
			autoCompactThreshold: 65,
			compactionModel: "provider/model",
			compactionThinkingLevel: "low",
		};
		await writeFile(configFile, JSON.stringify(legacyConfig));

		const commands = new Map<string, Command>();
		const handlers = loadExtension(commands);
		let compactions = 0;
		let input = "40";
		const notices: string[] = [];
		const ctx = {
			cwd: tempRoot,
			isProjectTrusted: () => true,
			getContextUsage: () => ({ tokens: 60, contextWindow: 100, percent: 60 }),
			compact: () => { compactions++; },
			ui: {
				input: async () => input,
				notify: (message: string) => notices.push(message),
			},
		} as unknown as ExtensionContext;

		handlers.get("session_start")?.(
			{ type: "session_start", reason: "startup" } as never,
			ctx,
		);
		assert.deepEqual(JSON.parse(await readFile(configFile, "utf8")), legacyConfig);
		handlers.get("turn_start")?.({} as never, ctx);
		assert.equal(compactions, 0);

		await commands.get("auto-compact")?.("", ctx);
		assert.deepEqual(JSON.parse(await readFile(configFile, "utf8")), { autoCompactThreshold: 40 });
		handlers.get("turn_start")?.({} as never, ctx);
		assert.equal(compactions, 1);

		input = "20";
		await commands.get("auto-compact")?.("", ctx);
		assert.equal(notices.at(-1), "Auto-compact threshold below 25% is not meaningful.");

		await commands.get("auto-compact")?.("model", ctx);
		assert.equal(notices.at(-1), "Usage: /auto-compact");
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("reports malformed shared task-model config without rewriting it", async () => {
	const tempRoot = await mkdtemp(join(tmpdir(), "pi-auto-compact-task-model-config-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = tempRoot;
	const malformed = "{ not json\\n";

	try {
		await mkdir(join(tempRoot, "config"), { recursive: true });
		await writeFile(join(tempRoot, "settings.json"), JSON.stringify({ compaction: { enabled: false } }));
		const taskModelsFile = join(tempRoot, "config", "pi-task-models.json");
		await writeFile(taskModelsFile, malformed);

		const handlers = loadExtension();
		let compactionInstructions: string | undefined;
		const notices: string[] = [];
		const ctx = {
			cwd: tempRoot,
			isProjectTrusted: () => true,
			getContextUsage: () => ({ tokens: 75, contextWindow: 100, percent: 75 }),
			compact: (options: { customInstructions?: string }) => {
				compactionInstructions = options.customInstructions;
			},
			ui: { notify: (message: string) => notices.push(message) },
		} as unknown as ExtensionContext;

		handlers.get("session_start")?.(
			{ type: "session_start", reason: "startup" } as never,
			ctx,
		);
		handlers.get("turn_start")?.({} as never, ctx);
		await handlers.get("session_before_compact")?.({
			type: "session_before_compact",
			customInstructions: compactionInstructions,
			signal: new AbortController().signal,
			preparation: { fileOps: { read: new Set(), written: new Set(), edited: new Set() } },
			branchEntries: [],
		} as never, ctx);

		assert.deepEqual(notices, ["Couldn't read task model config; using current session model."]);
		assert.equal(await readFile(taskModelsFile, "utf8"), malformed);

		await writeFile(taskModelsFile, "{}\n");
		notices.length = 0;
		await handlers.get("session_before_compact")?.({
			type: "session_before_compact",
			customInstructions: compactionInstructions,
			signal: new AbortController().signal,
			preparation: { fileOps: { read: new Set(), written: new Set(), edited: new Set() } },
			branchEntries: [],
		} as never, ctx);
		assert.deepEqual(notices, ["Task model profile fast is not configured; using current session model."]);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("routes only auto compaction, carries file operations, and tries profile fallback before current model", async () => {
	const tempRoot = await mkdtemp(join(tmpdir(), "pi-auto-compact-model-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = tempRoot;

	try {
		await writeFile(join(tempRoot, "settings.json"), JSON.stringify({ compaction: { enabled: false } }));
		await mkdir(join(tempRoot, "config"), { recursive: true });
		await writeFile(join(tempRoot, "config", "pi-auto-compact.json"), JSON.stringify({ autoCompactThreshold: 50 }));
		await writeFile(join(tempRoot, "config", "pi-task-models.json"), JSON.stringify({
			profiles: {
				fast: {
					primary: { model: "primary/model", thinkingLevel: "off" },
					fallback: { model: "fallback/model", thinkingLevel: "off" },
				},
			},
		}));

		const handlers = loadExtension();
		const authModels: string[] = [];
		const notices: string[] = [];
		let compactions = 0;
		let autoInstructions: string | undefined;
		const ctx = {
			cwd: tempRoot,
			isProjectTrusted: () => true,
			getContextUsage: () => ({ tokens: 75, contextWindow: 100, percent: 75 }),
			compact: (options: { customInstructions?: string }) => {
				compactions++;
				autoInstructions = options.customInstructions;
			},
			modelRegistry: {
				getAvailable: () => [
					{ provider: "primary", id: "model", input: ["text"] },
					{ provider: "fallback", id: "model", input: ["text"] },
				],
				getApiKeyAndHeaders: async (model: { provider: string }) => {
					authModels.push(model.provider);
					return { ok: false, error: "missing" };
				},
			},
			ui: { notify: (message: string) => notices.push(message) },
		} as unknown as ExtensionContext;

		handlers.get("session_start")?.(
			{ type: "session_start", reason: "startup" } as never,
			ctx,
		);
		handlers.get("turn_start")?.({} as never, ctx);
		assert.equal(compactions, 1);
		assert.ok(autoInstructions);

		const fileOps = {
			read: new Set(["current-read.ts"]),
			written: new Set<string>(),
			edited: new Set(["current-edit.ts"]),
		};
		const compactionEvent = {
			type: "session_before_compact",
			reason: "manual",
			signal: new AbortController().signal,
			preparation: { fileOps },
			branchEntries: [
				{ type: "compaction", details: { readFiles: ["stale-read.ts"], modifiedFiles: ["stale-edit.ts"] } },
				{ type: "message" },
				{ type: "compaction", details: { readFiles: ["prior-read.ts"], modifiedFiles: ["prior-edit.ts"] } },
			],
		};
		// Manual /compact remains native even while auto compaction is pending.
		assert.equal(await handlers.get("session_before_compact")?.(compactionEvent as never, ctx), undefined);
		assert.deepEqual(authModels, []);
		assert.deepEqual([...fileOps.read], ["current-read.ts"]);
		assert.deepEqual([...fileOps.edited], ["current-edit.ts"]);

		assert.equal(await handlers.get("session_before_compact")?.({
			...compactionEvent,
			customInstructions: autoInstructions,
		} as never, ctx), undefined);
		assert.deepEqual(authModels, ["primary", "fallback"]);
		assert.deepEqual([...fileOps.read], ["current-read.ts", "prior-read.ts"]);
		assert.deepEqual([...fileOps.edited], ["current-edit.ts", "prior-edit.ts"]);
		assert.deepEqual(notices, ["Configured task model routes failed; using current session model."]);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("uses profile fallback and passes its thinking level to compaction", async () => {
	const tempRoot = await mkdtemp(join(tmpdir(), "pi-auto-compact-thinking-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = tempRoot;
	let requestBody = "";
	const server = createServer(async (request, response) => {
		for await (const chunk of request) requestBody += chunk;
		response.writeHead(200, { "content-type": "text/event-stream" });
		response.write(`data: ${JSON.stringify({
			id: "response",
			model: "model",
			choices: [{ delta: { content: "summary" }, finish_reason: null }],
		})}\n\n`);
		response.write(`data: ${JSON.stringify({
			id: "response",
			model: "model",
			choices: [{ delta: {}, finish_reason: "stop" }],
			usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
		})}\n\n`);
		response.end("data: [DONE]\n\n");
	});

	try {
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		assert.ok(address && typeof address !== "string");
		await mkdir(join(tempRoot, "config"), { recursive: true });
		await writeFile(join(tempRoot, "settings.json"), JSON.stringify({ compaction: { enabled: false } }));
		await writeFile(join(tempRoot, "config", "pi-auto-compact.json"), JSON.stringify({ autoCompactThreshold: 50 }));
		await writeFile(join(tempRoot, "config", "pi-task-models.json"), JSON.stringify({
			profiles: {
				fast: {
					primary: { model: "primary/model", thinkingLevel: "off" },
					fallback: { model: "provider/model", thinkingLevel: "max" },
				},
			},
		}));

		const handlers = loadExtension();
		let autoInstructions: string | undefined;
		const model = {
			id: "model",
			name: "Model",
			api: "openai-completions",
			provider: "provider",
			baseUrl: `http://127.0.0.1:${address.port}/v1`,
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 10_000,
			maxTokens: 1_000,
			thinkingLevelMap: { max: "high" },
			compat: { supportsFinishReason: true, thinkingFormat: "openai" },
		};
		const authModels: string[] = [];
		const ctx = {
			cwd: tempRoot,
			isProjectTrusted: () => true,
			getContextUsage: () => ({ tokens: 75, contextWindow: 100, percent: 75 }),
			compact: (options: { customInstructions?: string }) => {
				autoInstructions = options.customInstructions;
			},
			modelRegistry: {
				getAvailable: () => [
					{ provider: "primary", id: "model", input: ["text"] },
					model,
				],
				getApiKeyAndHeaders: async (candidate: { provider: string }) => {
					authModels.push(candidate.provider);
					return candidate.provider === "primary"
						? { ok: false, error: "missing" }
						: { ok: true, apiKey: "test-key" };
				},
			},
			ui: { notify() {} },
		} as unknown as ExtensionContext;

		handlers.get("session_start")?.(
			{ type: "session_start", reason: "startup" } as never,
			ctx,
		);
		handlers.get("turn_start")?.({} as never, ctx);
		const result = await handlers.get("session_before_compact")?.({
			type: "session_before_compact",
			customInstructions: autoInstructions,
			signal: new AbortController().signal,
			preparation: {
				firstKeptEntryId: "kept",
				messagesToSummarize: [{ role: "user", content: "hello", timestamp: Date.now() }],
				turnPrefixMessages: [],
				isSplitTurn: false,
				tokensBefore: 10,
				fileOps: { read: new Set(), written: new Set(), edited: new Set() },
				settings: { enabled: true, reserveTokens: 1_000, keepRecentTokens: 100 },
			},
			branchEntries: [],
		} as never, ctx) as { compaction?: { summary?: string } } | undefined;

		assert.equal(result?.compaction?.summary, "summary");
		assert.deepEqual(authModels, ["primary", "provider"]);
		assert.equal(JSON.parse(requestBody).reasoning_effort, "high");
	} finally {
		server.close();
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("agent_end compacts without resuming completed work", async () => {
	const tempRoot = await mkdtemp(join(tmpdir(), "pi-auto-compact-agent-end-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = tempRoot;

	try {
		await writeFile(join(tempRoot, "settings.json"), JSON.stringify({ compaction: { enabled: false } }));
		let onComplete: (() => void) | undefined;
		let resumes = 0;
		const handlers = loadExtension(new Map(), () => { resumes++; });
		const ctx = {
			cwd: tempRoot,
			isProjectTrusted: () => true,
			getContextUsage: () => ({ tokens: 75, contextWindow: 100, percent: 75 }),
			compact: (options: { onComplete: () => void }) => { onComplete = options.onComplete; },
			isIdle: () => true,
		} as unknown as ExtensionContext;

		handlers.get("session_start")?.(
			{ type: "session_start", reason: "startup" } as never,
			ctx,
		);
		handlers.get("agent_end")?.({ type: "agent_end", messages: [] } as never, ctx);
		assert.ok(onComplete, "agent_end must trigger compaction");
		onComplete();
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(resumes, 0);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("activates only when Pi built-in auto-compaction is disabled", async () => {
	const tempRoot = await mkdtemp(join(tmpdir(), "pi-auto-compact-activation-"));
	const projectDir = join(tempRoot, "project");
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = tempRoot;
	await mkdir(join(projectDir, ".pi"), { recursive: true });

	try {
		for (const scenario of [
			{ name: "default enabled", global: {}, project: {}, rejects: true },
			{
				name: "globally disabled",
				global: { compaction: { enabled: false } },
				project: {},
				rejects: false,
			},
			{
				name: "project re-enabled",
				global: { compaction: { enabled: false } },
				project: { compaction: { enabled: true } },
				rejects: true,
			},
		]) {
			await writeFile(join(tempRoot, "settings.json"), JSON.stringify(scenario.global));
			await writeFile(join(projectDir, ".pi", "settings.json"), JSON.stringify(scenario.project));

			const handlers = loadExtension();
			let compactions = 0;
			const ctx = {
				cwd: projectDir,
				isProjectTrusted: () => true,
				getContextUsage: () => ({ tokens: 75, contextWindow: 100, percent: 75 }),
				compact: () => { compactions++; },
			} as unknown as ExtensionContext;
			const start = () => handlers.get("session_start")?.(
				{ type: "session_start", reason: "startup" } as never,
				ctx,
			);

			if (scenario.rejects) {
				assert.throws(start, /failed to activate.*compaction\.enabled.*false/i, scenario.name);
			} else {
				assert.doesNotThrow(start, scenario.name);
			}
			handlers.get("agent_end")?.({ type: "agent_end", messages: [] } as never, ctx);
			assert.equal(compactions, scenario.rejects ? 0 : 1, scenario.name);
		}
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(tempRoot, { recursive: true, force: true });
	}
});
