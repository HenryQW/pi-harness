import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import herdrRenameExtension from "../extensions/rename.ts";

type Handler = (event: any, ctx: ExtensionContext) => unknown;
type Command = (args: string, ctx: ExtensionContext) => Promise<void>;
type Model = { provider: string; id: string; input: string[] };
type CompletionCall = { model: Model; context: any; options: any };

const defaultModel: Model = { provider: "openai-codex", id: "gpt-5.6-luna", input: ["text"] };
const response = (text: string, stopReason = "stop") => ({
	stopReason,
	content: [{ type: "text", text }],
});
const success = (stdout = "") => ({ stdout, stderr: "", code: 0, killed: false });

function harness(options: {
	sessionName?: string;
	models?: Model[];
	currentModel?: Model;
	branch?: any[];
	complete?: (call: CompletionCall) => Promise<any>;
	exec?: (args: string[], signal?: AbortSignal) => Promise<ReturnType<typeof success>>;
	select?: string;
} = {}) {
	const handlers = new Map<string, Handler>();
	const commands = new Map<string, Command>();
	const names: string[] = [];
	const notifications: string[] = [];
	const notificationTypes: Array<string | undefined> = [];
	const completionCalls: CompletionCall[] = [];
	const execCalls: string[][] = [];
	const widgets: unknown[] = [];
	const models = options.models ?? [defaultModel];

	const api = {
		on(event: string, handler: Handler) {
			handlers.set(event, handler);
		},
		registerCommand(name: string, command: { handler: Command }) {
			commands.set(name, command.handler);
		},
		getSessionName: () => options.sessionName,
		setSessionName(name: string) {
			names.push(name);
		},
		exec: async (_command: string, args: string[], execOptions?: { signal?: AbortSignal }) => {
			execCalls.push(args);
			if (options.exec) return options.exec(args, execOptions?.signal);
			if (args[0] === "pane" && args[1] === "get") {
				return success(JSON.stringify({ result: { pane: { tab_id: "tab-1" } } }));
			}
			if (args[0] === "tab" && args[1] === "get") {
				return success(JSON.stringify({ result: { tab: { pane_count: 1 } } }));
			}
			return success("{}");
		},
	} as unknown as ExtensionAPI;

	const ctx = {
		model: options.currentModel ?? defaultModel,
		modelRegistry: {
			getAvailable: () => models,
			complete: async (model: Model, context: any, completionOptions: any) => {
				const call = { model, context, options: completionOptions };
				completionCalls.push(call);
				return options.complete ? options.complete(call) : response("generated title");
			},
		},
		sessionManager: { getBranch: () => options.branch ?? [] },
		ui: {
			notify: (message: string, type?: string) => {
				notifications.push(message);
				notificationTypes.push(type);
			},
			select: async () => options.select,
			setWidget: (_key: string, content: unknown) => widgets.push(content),
		},
	} as unknown as ExtensionContext;

	herdrRenameExtension(api);
	return { handlers, commands, ctx, names, notifications, notificationTypes, completionCalls, execCalls, widgets };
}

async function eventually(check: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (check()) return;
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	assert.fail("condition was not reached");
}

async function withAgentDir(run: (dir: string) => Promise<void>): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "pi-herdr-rename-"));
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	const previousPane = process.env.HERDR_PANE_ID;
	process.env.PI_CODING_AGENT_DIR = dir;
	delete process.env.HERDR_PANE_ID;
	try {
		await mkdir(join(dir, "config"), { recursive: true });
		await writeFile(
			join(dir, "config", "pi-herdr-rename.json"),
			JSON.stringify({ model: `${defaultModel.provider}/${defaultModel.id}` }),
		);
		await run(dir);
	} finally {
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
		if (previousPane === undefined) delete process.env.HERDR_PANE_ID;
		else process.env.HERDR_PANE_ID = previousPane;
		await rm(dir, { recursive: true, force: true });
	}
}

test("automatic rename ignores non-user text, starts once without blocking, and caps model input", async () => {
	await withAgentDir(async () => {
		let resolveCompletion!: (value: any) => void;
		const pending = new Promise<any>((resolve) => {
			resolveCompletion = resolve;
		});
		const app = harness({ complete: async () => pending });
		await app.handlers.get("session_start")?.({}, app.ctx);

		app.handlers.get("input")?.({ source: "extension", text: "injected" }, app.ctx);
		app.handlers.get("input")?.({ source: "interactive", text: "   ", images: [{}] }, app.ctx);
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.equal(app.completionCalls.length, 0);

		const text = "A".repeat(1_100);
		const result = app.handlers.get("input")?.({ source: "interactive", text }, app.ctx);
		assert.deepEqual(result, { action: "continue" });
		await eventually(() => app.completionCalls.length === 1);
		app.handlers.get("input")?.({ source: "rpc", text: "second prompt" }, app.ctx);
		assert.equal(app.completionCalls.length, 1);
		assert.equal(app.completionCalls[0].context.messages[0].content.length, 1_000);
		assert.equal(app.completionCalls[0].options.maxRetries, 0);

		resolveCompletion(response("  Useful\nChat TITLE  "));
		await eventually(() => app.names.length === 1);
		assert.deepEqual(app.names, ["useful chat title"]);
		assert.deepEqual(app.execCalls, []);
	});
});

test("saved names skip the model and Herdr tabs rename only when they have one pane", async () => {
	await withAgentDir(async () => {
		process.env.HERDR_PANE_ID = "pane-1";
		for (const [paneCount, expectedTabRenames] of [[1, 1], [2, 0]] as const) {
			const app = harness({
				sessionName: "saved title",
				exec: async (args) => {
					if (args[0] === "pane" && args[1] === "get") {
						return success(JSON.stringify({ result: { pane: { tab_id: "tab-1" } } }));
					}
					if (args[0] === "tab" && args[1] === "get") {
						return success(JSON.stringify({ result: { tab: { pane_count: paneCount } } }));
					}
					return success("{}");
				},
			});
			await app.handlers.get("session_start")?.({}, app.ctx);
			await eventually(() => app.execCalls.some((args) => args[1] === "get" && args[0] === "tab"));
			assert.equal(app.completionCalls.length, 0);
			assert.equal(app.names.length, 0);
			assert.equal(app.execCalls.filter((args) => args[0] === "pane" && args[1] === "rename").length, 1);
			assert.equal(app.execCalls.filter((args) => args[0] === "tab" && args[1] === "rename").length, expectedTabRenames);
		}
	});
});

test("manual rename warns without text and the latest overlapping request wins", async () => {
	await withAgentDir(async () => {
		const empty = harness({ sessionName: "saved" });
		await empty.handlers.get("session_start")?.({}, empty.ctx);
		await empty.commands.get("rename")?.("", empty.ctx);
		assert.match(empty.notifications[0], /No user text/);

		const resolvers: Array<(value: any) => void> = [];
		const signals: AbortSignal[] = [];
		const app = harness({
			sessionName: "saved",
			complete: async (call) => {
				signals.push(call.options.signal);
				return new Promise((resolve) => resolvers.push(resolve));
			},
		});
		await app.handlers.get("session_start")?.({}, app.ctx);
		app.handlers.get("input")?.({ source: "interactive", text: "first prompt" }, app.ctx);
		const first = app.commands.get("rename")!("", app.ctx);
		await eventually(() => resolvers.length === 1);
		app.handlers.get("input")?.({ source: "interactive", text: "second prompt" }, app.ctx);
		const second = app.commands.get("rename")!("", app.ctx);
		await eventually(() => resolvers.length === 2);
		assert.equal(signals[0].aborted, true);
		resolvers[1](response("second title"));
		await second;
		resolvers[0](response("first title"));
		await first;
		assert.deepEqual(app.names, ["second title"]);
	});
});

test("manual rename uses the latest three text rounds within a 4,000 character budget", async () => {
	await withAgentDir(async () => {
		const branch = [
			{ type: "message", message: { role: "user", content: "oldest ignored request" } },
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "oldest answer" }] } },
			{ type: "message", message: { role: "user", content: "first included request" } },
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "private reasoning" },
						{ type: "text", text: "A".repeat(1_200) },
						{ type: "toolCall", name: "secret tool" },
					],
				},
			},
			{ type: "message", message: { role: "toolResult", content: [{ type: "text", text: "tool output" }] } },
			{ type: "message", message: { role: "user", content: "second included request" } },
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "second answer" }] } },
			{ type: "message", message: { role: "user", content: "latest included request" } },
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "latest answer" }] } },
		];
		const app = harness({ sessionName: "saved", branch });
		await app.handlers.get("session_start")?.({}, app.ctx);
		await app.commands.get("rename")?.("", app.ctx);

		const context = app.completionCalls[0].context.messages[0].content as string;
		assert.ok(context.length <= 4_000);
		assert.doesNotMatch(context, /oldest ignored|oldest answer|private reasoning|secret tool|tool output/);
		assert.match(context, /user: first included request/);
		assert.match(context, /user: second included request/);
		assert.match(context, /user: latest included request/);
		assert.equal(context.match(/A/g)?.length, 1_000);
		assert.ok(context.indexOf("first included") < context.indexOf("latest included"));
	});
});

test("manual rename widget shows progress, result, then disappears", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	await withAgentDir(async () => {
		const app = harness({
			sessionName: "saved",
			branch: [{ type: "message", message: { role: "user", content: "rename this conversation" } }],
		});
		await app.handlers.get("session_start")?.({}, app.ctx);
		await app.commands.get("rename")?.("", app.ctx);

		assert.equal(typeof app.widgets.at(-2), "function");
		assert.deepEqual(app.widgets.at(-1), ["renamed to generated title"]);
		t.mock.timers.tick(2_000);
		assert.equal(app.widgets.at(-1), undefined);
	});
});

test("automatic rename warns when the rename model errors", async () => {
	await withAgentDir(async () => {
		const app = harness({
			complete: async () => ({ ...response("", "error"), errorMessage: "Provider failed" }),
		});
		await app.handlers.get("session_start")?.({}, app.ctx);
		app.handlers.get("input")?.({ source: "interactive", text: "prompt" }, app.ctx);
		await eventually(() => app.notifications.length > 0);

		assert.equal(app.notifications.at(-1), "Provider failed");
		assert.equal(app.notificationTypes.at(-1), "warning");
		assert.deepEqual(app.names, []);
	});
});

test("shutdown aborts automatic generation and invalid titles make no change", async () => {
	await withAgentDir(async () => {
		let resolveCompletion!: (value: any) => void;
		let signal!: AbortSignal;
		const app = harness({
			complete: async (call) => {
				signal = call.options.signal;
				return new Promise((resolve) => {
					resolveCompletion = resolve;
				});
			},
		});
		await app.handlers.get("session_start")?.({}, app.ctx);
		app.handlers.get("input")?.({ source: "interactive", text: "prompt" }, app.ctx);
		await eventually(() => Boolean(signal));
		app.handlers.get("session_shutdown")?.({}, app.ctx);
		assert.equal(signal.aborted, true);
		resolveCompletion(response("one two three four five six"));
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.deepEqual(app.names, []);

		const invalid = harness({ complete: async () => response("one two three four five six") });
		await invalid.handlers.get("session_start")?.({}, invalid.ctx);
		invalid.handlers.get("input")?.({ source: "interactive", text: "prompt" }, invalid.ctx);
		await eventually(() => invalid.completionCalls.length === 1);
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.deepEqual(invalid.names, []);
	});
});

test("configured word and character limits control generation and validation", async () => {
	await withAgentDir(async (dir) => {
		await writeFile(
			join(dir, "config", "pi-herdr-rename.json"),
			JSON.stringify({ model: `${defaultModel.provider}/${defaultModel.id}`, maxWords: 2, maxChars: 12 }),
		);
		const titles = ["a b c", "abcdefghijklm", "tiny title"];
		const app = harness({ sessionName: "saved", complete: async () => response(titles.shift() ?? "") });
		await app.handlers.get("session_start")?.({}, app.ctx);
		app.handlers.get("input")?.({ source: "interactive", text: "prompt" }, app.ctx);

		await app.commands.get("rename")?.("", app.ctx);
		await app.commands.get("rename")?.("", app.ctx);
		await app.commands.get("rename")?.("", app.ctx);

		assert.match(app.completionCalls[0].context.systemPrompt, /at most 2 words.*at most 12 characters/);
		assert.equal(app.notifications.filter((message) => message.includes("invalid title")).length, 2);
		assert.deepEqual(app.names, ["tiny title"]);
	});
});

test("rename model config is required, persists selection, and never substitutes another model", async () => {
	await withAgentDir(async (dir) => {
		const config = join(dir, "config", "pi-herdr-rename.json");
		await rm(config);

		const other: Model = { provider: "other", id: "small", input: ["text"] };
		const app = harness({
			sessionName: "saved",
			models: [defaultModel, other],
			currentModel: other,
			select: "other/small",
		});
		await app.handlers.get("session_start")?.({}, app.ctx);
		assert.match(app.notifications.at(-1) ?? "", /Run \/rename-model/);
		await app.handlers.get("session_start")?.({}, app.ctx);
		assert.equal(app.notifications.filter((message) => message.includes("/rename-model")).length, 2);
		app.handlers.get("input")?.({ source: "interactive", text: "prompt" }, app.ctx);
		await app.commands.get("rename")?.("", app.ctx);
		assert.equal(app.completionCalls.length, 0);
		assert.match(app.notifications.at(-1) ?? "", /not configured/);

		await app.commands.get("rename-model")?.("", app.ctx);
		assert.deepEqual(JSON.parse(await readFile(config, "utf8")), {
			model: "other/small",
			maxWords: 4,
			maxChars: 40,
		});
		await app.commands.get("rename")?.("", app.ctx);
		assert.equal(app.completionCalls[0].model.id, other.id);

		await writeFile(config, JSON.stringify({ model: "missing/model" }));
		const unavailable = harness({ sessionName: "saved", models: [defaultModel] });
		await unavailable.handlers.get("session_start")?.({}, unavailable.ctx);
		unavailable.handlers.get("input")?.({ source: "interactive", text: "prompt" }, unavailable.ctx);
		await unavailable.commands.get("rename")?.("", unavailable.ctx);
		assert.equal(unavailable.completionCalls.length, 0);
		assert.match(unavailable.notifications.at(-1) ?? "", /unavailable/);
	});
});

test("later Herdr failure preserves the Pi name and pane rename", async () => {
	await withAgentDir(async () => {
		process.env.HERDR_PANE_ID = "pane-1";
		const app = harness({
			sessionName: "saved",
			exec: async (args) =>
				args[0] === "pane" && args[1] === "get"
					? { stdout: "", stderr: "gone", code: 7, killed: false }
					: success("{}"),
		});
		await app.handlers.get("session_start")?.({}, app.ctx);
		await eventually(() => app.execCalls.some((args) => args[0] === "pane" && args[1] === "get"));
		app.handlers.get("input")?.({ source: "interactive", text: "prompt" }, app.ctx);
		await app.commands.get("rename")?.("", app.ctx);
		assert.deepEqual(app.names, ["generated title"]);
		assert.ok(app.execCalls.some((args) => args[0] === "pane" && args[1] === "rename" && args.at(-1) === "generated title"));
		assert.match(app.notifications.at(-1) ?? "", /herdr pane get failed/);
		assert.equal(app.widgets.at(-1), undefined);
	});
});
