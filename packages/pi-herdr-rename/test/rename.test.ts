import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import herdrRenameExtension from "../extensions/rename.ts";

type Handler = (event: any, ctx: ExtensionContext) => unknown;
type Command = (args: string, ctx: ExtensionContext) => Promise<void>;
type Model = {
	provider: string;
	id: string;
	input: string[];
	reasoning?: boolean;
	thinkingLevelMap?: Record<string, string | null | undefined>;
};
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
	auth?: (model: Model) => Promise<{ ok: true; apiKey?: string } | { ok: false; error: string }>;
	exec?: (args: string[], options?: { signal?: AbortSignal; cwd?: string }) => Promise<ReturnType<typeof success>>;
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
		exec: async (_command: string, args: string[], execOptions?: { signal?: AbortSignal; cwd?: string }) => {
			execCalls.push(args);
			if (options.exec) return options.exec(args, execOptions);
			if (args[0] === "pane" && args[1] === "get") {
				return success(JSON.stringify({ result: { pane: { tab_id: "tab-1", workspace_id: "workspace-1" } } }));
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
			getApiKeyAndHeaders: async (model: Model) => options.auth
				? options.auth(model)
				: { ok: true as const, apiKey: "test-key" },
			getProvider: () => ({
				streamSimple: (model: Model, context: any, completionOptions: any) => ({
					result: async () => {
						const call = { model, context, options: completionOptions };
						completionCalls.push(call);
						return options.complete ? options.complete(call) : response("feat: generated title");
					},
				}),
			}),
		},
		sessionManager: { getBranch: () => options.branch ?? [] },
		ui: {
			notify: (message: string, type?: string) => {
				notifications.push(message);
				notificationTypes.push(type);
			},
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
			JSON.stringify({ maxWords: 4, maxChars: 40 }),
		);
		await writeFile(
			join(dir, "config", "pi-task-models.json"),
			JSON.stringify({
				profiles: {
					fast: { primary: { model: `${defaultModel.provider}/${defaultModel.id}`, thinkingLevel: "off" } },
				},
			}),
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
		assert.match(app.completionCalls[0].context.systemPrompt, /Format: type: subject/);
		assert.match(app.completionCalls[0].context.systemPrompt, /lowercase type.*alphanumeric subject words.*No other punctuation/);
		assert.ok(app.completionCalls[0].context.systemPrompt.length <= 240);

		resolveCompletion(response("  Fix:\nUseful Chat TITLE  "));
		await eventually(() => app.names.length === 1);
		assert.deepEqual(app.names, ["fix: useful chat title"]);
		assert.deepEqual(app.execCalls, []);
	});
});

test("saved names keep semantic branches, replace generated branches, and preserve custom workspace names", async () => {
	await withAgentDir(async () => {
		process.env.HERDR_PANE_ID = "pane-1";
		for (const [paneCount, workspaceName, isLinkedWorktree, branch, existingBranches, workspaceBranch, gitMutation] of [
			[1, "worktree-brave-meadow-4aa8", true, "fix/title-length", [], "fix/title-length", undefined],
			[2, "lucky-field-f694", true, "feat/new-loader", [], "feat/new-loader", undefined],
			[1, "worktree/brave-meadow-4aa8", true, "worktree/brave-meadow-4aa8", [], "fix/saved-title", ["branch", "-m", "fix/saved-title"]],
			[1, "worktree-brave-meadow-4aa8", true, "worktree/brave-meadow-4aa8", ["fix/saved-title"], "fix/saved-title-2", ["branch", "-m", "fix/saved-title-2"]],
			[1, "chosen workspace", true, "worktree/brave-meadow-4aa8", [], undefined, ["branch", "-m", "fix/saved-title"]],
			[1, "worktree-clear-field-8512", false, "worktree/clear-field-8512", [], undefined, undefined],
			[1, "worktree-quiet-river-1234", true, "", ["fix"], "fix-2/saved-title", ["switch", "-c", "fix-2/saved-title"]],
		] as const) {
			const gitCwds: Array<string | undefined> = [];
			const app = harness({
				sessionName: "fix: saved title",
				exec: async (args, options) => {
					if (args[0] === "branch" || args[0] === "switch" || args[0] === "for-each-ref") gitCwds.push(options?.cwd);
					if (args.join("\0") === "branch\0--show-current") return success(`${branch}\n`);
					if (args[0] === "for-each-ref") return success(existingBranches.join("\n"));
					if (args[0] === "pane" && args[1] === "get") {
						return success(JSON.stringify({ result: { pane: { tab_id: "tab-1", workspace_id: "workspace-1" } } }));
					}
					if (args[0] === "tab" && args[1] === "get") {
						return success(JSON.stringify({ result: { tab: { pane_count: paneCount } } }));
					}
					if (args[0] === "workspace" && args[1] === "get") {
						return success(JSON.stringify({ result: { workspace: { label: workspaceName, worktree: { checkout_path: "/repo/worktree", is_linked_worktree: isLinkedWorktree } } } }));
					}
					return success("{}");
				},
			});
			await app.handlers.get("session_start")?.({}, app.ctx);
			await eventually(() => app.execCalls.some((args) => args[0] === "workspace" && args[1] === "get"));
			await new Promise((resolve) => setTimeout(resolve, 0));
			assert.equal(app.completionCalls.length, 0);
			assert.equal(app.names.length, 0);
			assert.equal(app.execCalls.filter((args) => args[0] === "pane" && args[1] === "rename").length, 1);
			assert.equal(app.execCalls.filter((args) => args[0] === "tab" && args[1] === "rename").length, paneCount === 1 ? 1 : 0);
			assert.deepEqual(
				app.execCalls.filter((args) => (args[0] === "branch" && args[1] === "-m") || args[0] === "switch"),
				gitMutation ? [gitMutation] : [],
			);
			assert.deepEqual(gitCwds, Array(isLinkedWorktree ? 1 + Number(Boolean(gitMutation)) * 2 : 0).fill("/repo/worktree"));
			assert.equal(app.execCalls.filter((args) => args[0] === "for-each-ref").length, Number(Boolean(gitMutation)));
			if (gitMutation) {
				assert.ok(app.execCalls.some((args) => args.join("\0") === "for-each-ref\0--format=%(refname:short)\0refs/heads"));
			}
			assert.equal(app.execCalls.filter((args) => args[0] === "workspace" && args[1] === "rename").length, Number(Boolean(workspaceBranch)));
			if (workspaceBranch) {
				assert.ok(app.execCalls.some((args) => args.join("\0") === `workspace\0rename\0workspace-1\0${workspaceBranch}`));
			}
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
		resolvers[1](response("feat: second title"));
		await second;
		resolvers[0](response("fix: first title"));
		await first;
		assert.deepEqual(app.names, ["feat: second title"]);
	});
});

test("manual rename uses the latest three text rounds within a 2,000 character budget", async () => {
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
		assert.ok(context.length <= 2_000);
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
		assert.deepEqual(app.widgets.at(-1), ["renamed to feat: generated title"]);
		t.mock.timers.tick(2_000);
		assert.equal(app.widgets.at(-1), undefined);
	});
});

test("rename never uses the current session model without a configured fallback", async () => {
	await withAgentDir(async () => {
		const currentModel: Model = { provider: "main", id: "reliable", input: ["text"] };
		const app = harness({
			models: [defaultModel, currentModel],
			currentModel,
			complete: async () => ({ ...response("", "error"), errorMessage: "Provider failed" }),
		});
		await app.handlers.get("session_start")?.({}, app.ctx);
		app.handlers.get("input")?.({ source: "interactive", text: "prompt" }, app.ctx);
		await eventually(() => app.notifications.length > 0);

		assert.equal(app.notifications.at(-1), "Provider failed");
		assert.equal(app.notificationTypes.at(-1), "warning");
		assert.deepEqual(app.completionCalls.map((call) => call.model), [defaultModel]);
		assert.deepEqual(app.names, []);
	});
});

test("rename defaults to fast and uses its fallback after an invalid title", async () => {
	await withAgentDir(async (dir) => {
		const primary: Model = {
			provider: "primary",
			id: "fast",
			input: ["text"],
			reasoning: true,
			thinkingLevelMap: { low: "low" },
		};
		const fallback: Model = {
			provider: "fallback",
			id: "fast",
			input: ["text"],
			reasoning: true,
			thinkingLevelMap: { low: "low" },
		};
		const currentModel: Model = { provider: "main", id: "reliable", input: ["text"] };
		const legacyConfig = { model: "legacy/model", maxWords: 4, maxChars: 40 };
		await writeFile(join(dir, "config", "pi-herdr-rename.json"), JSON.stringify(legacyConfig));
		await writeFile(join(dir, "config", "pi-task-models.json"), JSON.stringify({
			profiles: {
				fast: {
					primary: { model: "primary/fast", thinkingLevel: "low" },
					fallback: { model: "fallback/fast", thinkingLevel: "low" },
				},
			},
		}));

		const app = harness({
			sessionName: "saved",
			branch: [{ type: "message", message: { role: "user", content: "prompt" } }],
			models: [primary, fallback, currentModel],
			currentModel,
			complete: async (call) => call.model === primary
				? response("plain title")
				: response("fix: fallback title"),
		});
		await app.handlers.get("session_start")?.({}, app.ctx);
		assert.equal(app.commands.has("rename-model"), false);
		await app.commands.get("rename")?.("", app.ctx);

		assert.deepEqual(app.completionCalls.map((call) => call.model), [primary, fallback]);
		assert.deepEqual(app.completionCalls.map((call) => call.options.maxRetries), [0, 0]);
		assert.deepEqual(app.completionCalls.map((call) => call.options.reasoning), ["low", "low"]);
		assert.deepEqual(app.names, ["fix: fallback title"]);
		assert.deepEqual(JSON.parse(await readFile(join(dir, "config", "pi-herdr-rename.json"), "utf8")), legacyConfig);
		assert.doesNotMatch(app.notifications.join("\n"), /invalid title/);
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

		const invalid = harness({ complete: async () => response("plain title") });
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
			JSON.stringify({ maxWords: 2, maxChars: 12 }),
		);
		const titles = ["feat: a b", "fix: abcdefgh", "fix: tiny"];
		const app = harness({ sessionName: "saved", complete: async () => response(titles.shift() ?? "") });
		await app.handlers.get("session_start")?.({}, app.ctx);
		app.handlers.get("input")?.({ source: "interactive", text: "prompt" }, app.ctx);

		await app.commands.get("rename")?.("", app.ctx);
		await app.commands.get("rename")?.("", app.ctx);
		await app.commands.get("rename")?.("", app.ctx);

		assert.match(app.completionCalls[0].context.systemPrompt, /at most 2 words.*at most 12 characters/);
		assert.equal(app.notifications.filter((message) => message.includes("invalid title")).length, 2);
		assert.deepEqual(app.names, ["fix: tiny"]);

		await writeFile(
			join(dir, "config", "pi-herdr-rename.json"),
			JSON.stringify({ maxWords: 1, maxChars: 5 }),
		);
		const fallback = harness({
			sessionName: "saved",
			branch: [{ type: "message", message: { role: "user", content: "prompt" } }],
		});
		await fallback.handlers.get("session_start")?.({}, fallback.ctx);
		await fallback.commands.get("rename")?.("", fallback.ctx);
		assert.match(fallback.completionCalls[0].context.systemPrompt, /at most 4 words.*at most 40 characters/);
	});
});

test("rename reports an unconfigured fast profile without changing the title", async () => {
	await withAgentDir(async (dir) => {
		await writeFile(join(dir, "config", "pi-task-models.json"), JSON.stringify({ profiles: {} }));
		const app = harness({
			sessionName: "saved",
			branch: [{ type: "message", message: { role: "user", content: "prompt" } }],
		});
		await app.handlers.get("session_start")?.({}, app.ctx);
		assert.match(app.notifications.at(-1) ?? "", /Configure rename task profile fast/);
		await app.commands.get("rename")?.("", app.ctx);
		assert.equal(app.completionCalls.length, 0);
		assert.deepEqual(app.names, []);
		assert.match(app.notifications.at(-1) ?? "", /profile fast is not configured/);
	});
});

test("rename reports malformed shared config without rewriting it", async () => {
	await withAgentDir(async (dir) => {
		const taskModelsFile = join(dir, "config", "pi-task-models.json");
		const malformed = "{ not json\\n";
		await writeFile(taskModelsFile, malformed);

		const app = harness({
			sessionName: "saved",
			branch: [{ type: "message", message: { role: "user", content: "prompt" } }],
		});
		await app.handlers.get("session_start")?.({}, app.ctx);
		assert.match(app.notifications[0] ?? "", /Couldn't read task model config/);
		await app.commands.get("rename")?.("", app.ctx);
		assert.equal(app.completionCalls.length, 0);
		assert.deepEqual(app.names, []);
		assert.match(app.notifications.at(-1) ?? "", /Couldn't read task model config/);
		assert.equal(await readFile(taskModelsFile, "utf8"), malformed);
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
		assert.deepEqual(app.names, ["feat: generated title"]);
		assert.ok(app.execCalls.some((args) => args[0] === "pane" && args[1] === "rename" && args.at(-1) === "feat: generated title"));
		assert.match(app.notifications.at(-1) ?? "", /herdr pane get failed/);
		assert.equal(app.widgets.at(-1), undefined);
	});
});
