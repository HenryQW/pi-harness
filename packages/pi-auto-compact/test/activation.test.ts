import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

test("reads and writes autoCompactThreshold", async () => {
	const tempRoot = await mkdtemp(join(tmpdir(), "pi-auto-compact-config-"));
	const configFile = join(tempRoot, "config", "pi-auto-compact.json");
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = tempRoot;
	const expectedConfig = {
		autoCompactThreshold: 40,
		compactionModel: "provider/model",
	};

	try {
		await mkdir(join(tempRoot, "config"), { recursive: true });
		await writeFile(join(tempRoot, "settings.json"), JSON.stringify({ compaction: { enabled: false } }));
		await writeFile(configFile, JSON.stringify({ ...expectedConfig, autoCompactThreshold: 65 }));

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
		handlers.get("turn_start")?.({} as never, ctx);
		assert.equal(compactions, 0);

		await commands.get("auto-compact")?.("", ctx);
		assert.deepEqual(JSON.parse(await readFile(configFile, "utf8")), expectedConfig);
		handlers.get("turn_start")?.({} as never, ctx);
		assert.equal(compactions, 1);
		assert.deepEqual(notices, ["Auto-compact threshold set to 40%."]);

		input = "20";
		await commands.get("auto-compact")?.("", ctx);
		assert.deepEqual(JSON.parse(await readFile(configFile, "utf8")), expectedConfig);
		assert.equal(notices.at(-1), "Auto-compact threshold below 25% is not meaningful.");
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("routes only auto compaction through the configured model and falls back on auth failure", async () => {
	const tempRoot = await mkdtemp(join(tmpdir(), "pi-auto-compact-model-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = tempRoot;

	try {
		await writeFile(join(tempRoot, "settings.json"), JSON.stringify({ compaction: { enabled: false } }));
		await mkdir(join(tempRoot, "config"), { recursive: true });
		await writeFile(join(tempRoot, "config", "pi-auto-compact.json"), JSON.stringify({
			autoCompactThreshold: 50,
			compactionModel: "provider/model",
		}));

		const handlers = loadExtension();
		const modelLookups: unknown[][] = [];
		const notices: string[] = [];
		let authAttempts = 0;
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
				find: (...args: unknown[]) => {
					modelLookups.push(args);
					return {};
				},
				getApiKeyAndHeaders: async () => {
					authAttempts++;
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

		const compactionEvent = {
			type: "session_before_compact",
			reason: "manual",
			signal: new AbortController().signal,
		};
		// Manual /compact remains native even while auto compaction is pending.
		assert.equal(await handlers.get("session_before_compact")?.(compactionEvent as never, ctx), undefined);
		assert.deepEqual(modelLookups, []);
		assert.equal(authAttempts, 0);

		assert.equal(await handlers.get("session_before_compact")?.({
			...compactionEvent,
			customInstructions: autoInstructions,
		} as never, ctx), undefined);
		assert.deepEqual(modelLookups, [["provider", "model"]]);
		assert.equal(authAttempts, 1);
		assert.deepEqual(notices, [
			"Couldn't authenticate configured compaction model; using current session model.",
		]);
	} finally {
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
