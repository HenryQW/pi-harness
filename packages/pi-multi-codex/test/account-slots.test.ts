import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	createAssistantMessageEventStream,
	type AssistantMessage,
	type Context,
	type Provider,
} from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import multiCodex, { createCodexAliasProvider } from "../extensions/multi-codex.ts";

type ProviderRegistration = Provider<"openai-codex-responses">;
type CommandHandler = (args: string, ctx: ExtensionContext) => Promise<void>;
type EventHandler = (event: never, ctx: ExtensionContext) => unknown;

const oauth = {
	type: "oauth",
	access: "access-token",
	refresh: "refresh-token",
	expires: Date.now() + 60_000,
};

async function withAgentDir(
	auth: Record<string, unknown>,
	check: (providers: ProviderRegistration[], commands: Map<string, CommandHandler>, handlers: Map<string, EventHandler>) => Promise<void> | void,
): Promise<void> {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-multi-codex-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		await writeFile(join(agentDir, "auth.json"), JSON.stringify(auth));
		const providers: ProviderRegistration[] = [];
		const commands = new Map<string, CommandHandler>();
		const handlers = new Map<string, EventHandler>();
		multiCodex({
			on(event: string, handler: EventHandler) {
				handlers.set(event, handler);
			},
			registerCommand(name: string, options: { handler: CommandHandler }) {
				commands.set(name, options.handler);
			},
			registerProvider(provider: ProviderRegistration) {
				providers.push(provider);
			},
		} as unknown as ExtensionAPI);
		await check(providers, commands, handlers);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(agentDir, { recursive: true, force: true });
	}
}

function contextWithNotices(notices: string[]): ExtensionContext {
	return {
		ui: { notify: (message: string) => notices.push(message) },
	} as unknown as ExtensionContext;
}

test("discovers canonical OAuth slots and ignores invalid or API-key entries", async () => {
	await withAgentDir(
		{
			openai: oauth,
			"openai-codex": oauth,
			"openai-codex-2": oauth,
			"openai-codex-3": { type: "api_key", key: "ignored" },
			"openai-codex-0": oauth,
			"openai-codex-1": oauth,
			"openai-codex-02": oauth,
			"openai-codex-4.5": oauth,
			"openai-codex-9007199254740993": oauth,
			"openai-codex-999999999999999999999999999999999999999999999999999999999999": oauth,
			"openai-codex-5": oauth,
		},
		async (providers) => {
			assert.deepEqual(providers.map((provider) => provider.id), ["openai-codex-2", "openai-codex-5"]);
			for (const provider of providers) {
				assert.equal(provider.name, `OpenAI Codex #${Number(provider.id.slice("openai-codex-".length))}`);
				assert.ok(provider.auth.oauth);
				assert.ok(provider.getModels().length > 0);
				assert.ok(provider.getModels().every((model) => model.provider === provider.id));
			}
		},
	);
});

test("notifies exact startup message when no Codex OAuth slot exists", async () => {
	await withAgentDir(
		{ "openai-codex-2": { type: "api_key", key: "ignored" } },
		async (_providers, _commands, handlers) => {
			const notices: string[] = [];
			handlers.get("session_start")?.({} as never, contextWithNotices(notices));
			assert.deepEqual(notices, ["No Codex OAuth accounts found. Run /login and select OpenAI Codex."]);
		},
	);
});

test("codex-add chooses lowest free slot and does not write auth.json", async () => {
	await withAgentDir(
		{ "openai-codex": oauth, "openai-codex-4": oauth },
		async (providers, commands) => {
			const notices: string[] = [];
			const handler = commands.get("codex-add");
			assert.ok(handler);
			const ctx = contextWithNotices(notices);
			await handler("", ctx);
			await handler("", ctx);
			assert.deepEqual(providers.map((provider) => provider.id), [
				"openai-codex-4",
				"openai-codex-2",
				"openai-codex-3",
			]);
			assert.deepEqual(notices, [
				"Codex slot 2 ready. Run /login and select OpenAI Codex #2.",
				"Codex slot 3 ready. Run /login and select OpenAI Codex #3.",
			]);
			assert.deepEqual(JSON.parse(await readFile(join(process.env.PI_CODING_AGENT_DIR!, "auth.json"), "utf8")), {
				"openai-codex": oauth,
				"openai-codex-4": oauth,
			});
		},
	);
});

test("codex-add requires native slot 1", async () => {
	await withAgentDir(
		{ "openai-codex-2": oauth },
		async (providers, commands) => {
			const notices: string[] = [];
			await commands.get("codex-add")?.("", contextWithNotices(notices));
			assert.deepEqual(providers.map((provider) => provider.id), ["openai-codex-2"]);
			assert.deepEqual(notices, ["Run /login and select OpenAI Codex for slot 1 first."]);
		},
	);
});

test("Pi extension loader registers Codex aliases", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-multi-codex-loader-"));
	try {
		await writeFile(join(agentDir, "auth.json"), JSON.stringify({
			"openai-codex": { ...oauth, accountId: "native-account" },
			"openai-codex-2": { ...oauth, accountId: "alias-account" },
		}));
		const child = spawn("pi", ["--list-models", "--extension", fileURLToPath(new URL("../extensions/multi-codex.ts", import.meta.url))], {
			env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
			stdio: "pipe",
		});
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => { stdout += chunk; });
		child.stderr.on("data", (chunk: string) => { stderr += chunk; });
		const [code, signal] = await once(child, "exit") as [number | null, string | null];
		assert.equal(code, 0, stderr || `Pi exited from ${signal}`);
		assert.match(stdout, /^openai-codex-2\s+/m);
	} finally {
		await rm(agentDir, { recursive: true, force: true });
	}
});

test("alias keeps native request provider and rewrites response identity", async () => {
	const model = {
		id: "codex-model",
		name: "Codex Model",
		api: "openai-codex-responses" as const,
		provider: "openai-codex" as const,
		baseUrl: "https://chatgpt.com/backend-api",
		reasoning: true,
		input: ["text"] as ("text")[],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_384,
	};
	const assistantMessage: AssistantMessage = {
		role: "assistant",
		content: [{ type: "toolCall", id: "call-1", name: "demo", arguments: {} }],
		api: model.api,
		provider: "openai-codex",
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
	let requestedProvider: string | undefined;
	let requestedContext: Context | undefined;
	const nativeStream = (requestModel: typeof model, context: Context) => {
		requestedProvider = requestModel.provider;
		requestedContext = context;
		const stream = createAssistantMessageEventStream();
		stream.push({ type: "start", partial: assistantMessage });
		stream.push({ type: "done", reason: "toolUse", message: assistantMessage });
		return stream;
	};
	const native = {
		id: "openai-codex",
		name: "OpenAI Codex",
		auth: {},
		getModels: () => [model],
		stream: nativeStream,
		streamSimple: nativeStream,
	} as unknown as ProviderRegistration;

	const alias = createCodexAliasProvider(native, 2);
	const events = [];
	const requestContext: Context = {
		messages: [{ ...assistantMessage, provider: "openai-codex-2" }],
	};
	for await (const event of alias.stream(alias.getModels()[0], requestContext)) events.push(event);
	assert.equal(requestedProvider, "openai-codex");
	assert.equal(requestedContext?.messages[0]?.role, "assistant");
	if (requestedContext?.messages[0]?.role === "assistant") {
		assert.equal(requestedContext.messages[0].provider, "openai-codex");
	}

	assert.equal(events[0].type, "start");
	if (events[0].type === "start") assert.equal(events[0].partial.provider, "openai-codex-2");
	assert.equal(events[1].type, "done");
	if (events[1].type === "done") {
		assert.equal(events[1].message.provider, "openai-codex-2");
		assert.equal(events[1].message.content[0].type, "toolCall");
		if (events[1].message.content[0].type === "toolCall") assert.equal(events[1].message.content[0].id, "call-1");
	}
});
