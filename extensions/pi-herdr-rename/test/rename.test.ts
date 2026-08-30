import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { withWorktreeLock } from "@henryqw/pi-herdr";
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
	const entries: Array<{ customType: string; data: unknown }> = [];
	const models = options.models ?? [defaultModel];
	const sessionBranch = [...(options.branch ?? [])];
	let sessionName = options.sessionName;

	const api = {
		events: { on: () => () => {}, emit() {} },
		on(event: string, handler: Handler) {
			handlers.set(event, handler);
		},
		registerCommand(name: string, command: { handler: Command }) {
			commands.set(name, command.handler);
		},
		getSessionName: () => sessionName,
		setSessionName(name: string) {
			sessionName = name;
			names.push(name);
		},
		appendEntry(customType: string, data: unknown) {
			entries.push({ customType, data });
			sessionBranch.push({ type: "custom", customType, data });
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
		sessionManager: { getBranch: () => sessionBranch },
		ui: {
			notify: (message: string, type?: string) => {
				notifications.push(message);
				notificationTypes.push(type);
			},
			setWidget: (_key: string, content: unknown) => widgets.push(content),
		},
	} as unknown as ExtensionContext;

	herdrRenameExtension(api);
	return { handlers, commands, ctx, names, notifications, notificationTypes, completionCalls, execCalls, widgets, entries };
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
	const previousHerdrEnv = process.env.HERDR_ENV;
	const previousPane = process.env.HERDR_PANE_ID;
	process.env.PI_CODING_AGENT_DIR = dir;
	delete process.env.HERDR_ENV;
	delete process.env.HERDR_PANE_ID;
	try {
		await mkdir(join(dir, "config", "pi-task-models"), { recursive: true });
		await writeFile(
			join(dir, "config", "pi-task-models", "config.json"),
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
		if (previousHerdrEnv === undefined) delete process.env.HERDR_ENV;
		else process.env.HERDR_ENV = previousHerdrEnv;
		if (previousPane === undefined) delete process.env.HERDR_PANE_ID;
		else process.env.HERDR_PANE_ID = previousPane;
		await rm(dir, { recursive: true, force: true });
	}
}

test("a pane ID without Herdr mode only persists the Pi title", async () => {
	await withAgentDir(async () => {
		process.env.HERDR_ENV = "0";
		process.env.HERDR_PANE_ID = "pane-1";
		const app = harness({
			sessionName: "saved",
			branch: [{ type: "message", message: { role: "user", content: "rename this conversation" } }],
		});
		await app.handlers.get("session_start")?.({}, app.ctx);
		await app.commands.get("rename")?.("", app.ctx);

		assert.deepEqual(app.names, ["Generated title"]);
		assert.deepEqual(app.entries, [{ customType: "pi-herdr-rename/title", data: { display: "Generated title", branch: "feat/generated-title" } }]);
		assert.deepEqual(app.execCalls, []);
	});
});

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
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.equal(app.completionCalls.length, 0);
		await app.handlers.get("before_agent_start")?.({ prompt: text }, app.ctx);
		await eventually(() => app.completionCalls.length === 1);
		app.handlers.get("input")?.({ source: "rpc", text: "second prompt" }, app.ctx);
		assert.equal(app.completionCalls.length, 1);
		assert.equal(app.completionCalls[0].context.messages[0].content.length, 1_000);
		assert.equal(app.completionCalls[0].options.maxRetries, 0);
		assert.equal("maxTokens" in app.completionCalls[0].options, false);
		assert.match(app.completionCalls[0].context.systemPrompt, /type: subject/);
		assert.match(app.completionCalls[0].context.systemPrompt, /semantic word, max 12 characters.*natural task phrase.*3-4.*max 4 words and 20 characters/);
		assert.ok(app.completionCalls[0].context.systemPrompt.length <= 240);

		resolveCompletion(response("  Refactor:\nUpdate Task Logic  "));
		await eventually(() => app.names.length === 1);
		assert.deepEqual(app.names, ["Update task logic"]);
		assert.deepEqual(app.entries, [{ customType: "pi-herdr-rename/title", data: { display: "Update task logic", branch: "refactor/update-task-logic" } }]);
		assert.deepEqual(app.execCalls, []);
	});
});

test("automatic rename uses expanded first prompt instead of raw input shorthand", async () => {
	await withAgentDir(async () => {
		const app = harness({
			complete: async (call) => response(
				call.context.messages[0].content === "/fix-login"
					? "chore: unclear input"
					: "fix: login redirect loop",
			),
		});
		await app.handlers.get("session_start")?.({}, app.ctx);
		app.handlers.get("input")?.({ source: "interactive", text: "/fix-login" }, app.ctx);
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.equal(app.completionCalls.length, 0);

		await app.handlers.get("before_agent_start")?.({ prompt: "Fix login redirect loop after token expiry" }, app.ctx);
		await eventually(() => app.names.length === 1);
		assert.equal(app.completionCalls[0].context.messages[0].content, "Fix login redirect loop after token expiry");
		assert.deepEqual(app.names, ["Login redirect loop"]);
	});
});

test("manual rename disarms a pending automatic rename", async () => {
	await withAgentDir(async () => {
		const app = harness();
		await app.handlers.get("session_start")?.({}, app.ctx);
		app.handlers.get("input")?.({ source: "interactive", text: "rename this request" }, app.ctx);
		await app.commands.get("rename")?.("", app.ctx);
		await app.handlers.get("before_agent_start")?.({ prompt: "Expanded request" }, app.ctx);

		assert.equal(app.completionCalls.length, 1);
		assert.deepEqual(app.names, ["Generated title"]);
	});
});

test("saved display titles keep semantic branches, replace generated branches, and preserve custom workspace names", async () => {
	await withAgentDir(async (dir) => {
		process.env.HERDR_ENV = "1";
		process.env.HERDR_PANE_ID = "pane-1";
		const checkoutPath = join(dir, "worktree");
		await mkdir(checkoutPath);
		for (const [paneCount, workspaceName, isLinkedWorktree, currentBranch, existingBranches, renameWorkspace, gitMutation] of [
			[1, "worktree-brave-meadow-4aa8", true, "fix/title-length", [], true, undefined],
			[2, "lucky-field-f694", true, "feat/new-loader", [], true, undefined],
			[1, "worktree/brave-meadow-4aa8", true, "worktree/brave-meadow-4aa8", [], true, ["branch", "-m", "fix/saved-title"]],
			[1, "worktree-brave-meadow-4aa8", true, "worktree/brave-meadow-4aa8", ["fix/saved-title"], true, ["branch", "-m", "fix/saved-title-2"]],
			[1, "chosen workspace", true, "worktree/brave-meadow-4aa8", [], false, ["branch", "-m", "fix/saved-title"]],
			[1, "worktree-clear-field-8512", false, "worktree/clear-field-8512", [], false, undefined],
			[1, "worktree-quiet-river-1234", true, "", ["fix"], true, ["switch", "-c", "fix-2/saved-title"]],
		] as const) {
			const gitCwds: Array<string | undefined> = [];
			const app = harness({
				sessionName: "Saved title",
				branch: [{ type: "custom", customType: "pi-herdr-rename/title", data: { display: "Saved title", branch: "fix/saved-title" } }],
				exec: async (args, options) => {
					if (args[0] === "branch" || args[0] === "switch" || args[0] === "for-each-ref") gitCwds.push(options?.cwd);
					if (args.join("\0") === "branch\0--show-current") return success(`${currentBranch}\n`);
					if (args[0] === "for-each-ref") return success(existingBranches.join("\n"));
					if (args[0] === "pane" && args[1] === "get") {
						return success(JSON.stringify({ result: { pane: { tab_id: "tab-1", workspace_id: "workspace-1" } } }));
					}
					if (args[0] === "tab" && args[1] === "get") {
						return success(JSON.stringify({ result: { tab: { pane_count: paneCount } } }));
					}
					if (args[0] === "workspace" && args[1] === "get") {
						return success(JSON.stringify({ result: { workspace: { label: workspaceName, worktree: { checkout_path: checkoutPath, is_linked_worktree: isLinkedWorktree } } } }));
					}
					return success("{}");
				},
			});
			await app.handlers.get("session_start")?.({}, app.ctx);
			await eventually(() => app.execCalls.some((args) => args[0] === "workspace" && args[1] === "get"));
			await eventually(() => !isLinkedWorktree || gitCwds.length === 1 + Number(Boolean(gitMutation)) * 2);
			assert.equal(app.completionCalls.length, 0);
			assert.equal(app.names.length, 0);
			assert.ok(app.execCalls.some((args) => args.join("\0") === "pane\0rename\0pane-1\0Saved title"));
			assert.equal(app.execCalls.filter((args) => args[0] === "pane" && args[1] === "rename").length, 1);
			assert.equal(app.execCalls.filter((args) => args[0] === "tab" && args[1] === "rename").length, paneCount === 1 ? 1 : 0);
			if (paneCount === 1) assert.ok(app.execCalls.some((args) => args.join("\0") === "tab\0rename\0tab-1\0Saved title"));
			assert.deepEqual(
				app.execCalls.filter((args) => (args[0] === "branch" && args[1] === "-m") || args[0] === "switch"),
				gitMutation ? [gitMutation] : [],
			);
			assert.deepEqual(gitCwds, Array(isLinkedWorktree ? 1 + Number(Boolean(gitMutation)) * 2 : 0).fill(checkoutPath));
			assert.equal(app.execCalls.filter((args) => args[0] === "for-each-ref").length, Number(Boolean(gitMutation)));
			if (gitMutation) {
				assert.ok(app.execCalls.some((args) => args.join("\0") === "for-each-ref\0--format=%(refname:short)\0refs/heads"));
			}
			assert.equal(app.execCalls.filter((args) => args[0] === "workspace" && args[1] === "rename").length, Number(renameWorkspace));
			if (renameWorkspace) {
				assert.ok(app.execCalls.some((args) => args.join("\0") === "workspace\0rename\0workspace-1\0Saved title"));
			}
		}
	});
});

test("manual rename updates generated and custom workspace titles", async () => {
	await withAgentDir(async (dir) => {
		process.env.HERDR_ENV = "1";
		process.env.HERDR_PANE_ID = "pane-1";
		const checkoutPath = join(dir, "worktree");
		await mkdir(checkoutPath);
		for (const workspaceName of ["Saved title", "Custom workspace"]) {
			const app = harness({
				sessionName: "Saved title",
				branch: [
					{ type: "custom", customType: "pi-herdr-rename/title", data: { display: "Saved title", branch: "fix/saved-title" } },
					{ type: "message", message: { role: "user", content: "update task logic" } },
				],
				complete: async () => response("refactor: update task logic"),
				exec: async (args) => {
					if (args.join("\0") === "branch\0--show-current") return success("fix/saved-title\n");
					if (args[0] === "pane" && args[1] === "get") {
						return success(JSON.stringify({ result: { pane: { tab_id: "tab-1", workspace_id: "workspace-1" } } }));
					}
					if (args[0] === "tab" && args[1] === "get") {
						return success(JSON.stringify({ result: { tab: { pane_count: 1 } } }));
					}
					if (args[0] === "workspace" && args[1] === "get") {
						return success(JSON.stringify({ result: { workspace: { label: workspaceName, worktree: { checkout_path: checkoutPath, is_linked_worktree: true } } } }));
					}
					return success("{}");
				},
			});
			await app.handlers.get("session_start")?.({}, app.ctx);
			await eventually(() => app.execCalls.some((args) => args[0] === "workspace" && args[1] === "get"));
			await app.commands.get("rename")?.("", app.ctx);

			assert.deepEqual(
				app.execCalls.filter((args) => args[0] === "workspace" && args[1] === "rename"),
				[["workspace", "rename", "workspace-1", "Update task logic"]],
			);
		}
	});
});

test("semantic branch mutation honors the shared worktree lock", async () => {
	await withAgentDir(async (dir) => {
		process.env.HERDR_ENV = "1";
		process.env.HERDR_PANE_ID = "pane-1";
		const checkoutPath = join(dir, "worktree");
		await mkdir(checkoutPath);
		let releaseLock!: () => void;
		const heldLock = withWorktreeLock(checkoutPath, () => new Promise<void>((resolve) => {
			releaseLock = resolve;
		}));
		await eventually(() => Boolean(releaseLock));
		try {
			const app = harness({
				sessionName: "Saved title",
				branch: [{ type: "message", message: { role: "user", content: "rename this" } }],
				exec: async (args) => {
					if (args.join("\0") === "branch\0--show-current") return success("worktree/generated\n");
					if (args[0] === "for-each-ref") return success("");
					if (args[0] === "pane" && args[1] === "get") {
						return success(JSON.stringify({ result: { pane: { tab_id: "tab-1", workspace_id: "workspace-1" } } }));
					}
					if (args[0] === "tab" && args[1] === "get") {
						return success(JSON.stringify({ result: { tab: { pane_count: 1 } } }));
					}
					if (args[0] === "workspace" && args[1] === "get") {
						return success(JSON.stringify({ result: { workspace: { label: "worktree-rapid-meadow-04ae", worktree: { checkout_path: checkoutPath, is_linked_worktree: true } } } }));
					}
					return success("{}");
				},
			});
			await app.handlers.get("session_start")?.({}, app.ctx);
			await app.commands.get("rename")?.("", app.ctx);

			assert.equal(app.execCalls.filter((args) => args[0] === "branch" || args[0] === "for-each-ref" || args[0] === "switch").length, 0);
			assert.match(app.notifications.at(-1) ?? "", /lock/i);
		} finally {
			releaseLock();
			await heldLock;
		}
	});
});

test("existing and manually changed titles remain untouched", async () => {
	await withAgentDir(async () => {
		process.env.HERDR_ENV = "1";
		process.env.HERDR_PANE_ID = "pane-1";
		const existing = harness({ sessionName: "refactor: update task logic" });
		await existing.handlers.get("session_start")?.({}, existing.ctx);
		assert.deepEqual(existing.execCalls, []);

		const changed = harness({
			sessionName: "Manual title",
			branch: [{ type: "custom", customType: "pi-herdr-rename/title", data: { display: "Saved title", branch: "fix/saved-title" } }],
		});
		await changed.handlers.get("session_start")?.({}, changed.ctx);
		assert.deepEqual(changed.execCalls, []);

		const malformed = harness({
			sessionName: "One two three four five",
			branch: [{ type: "custom", customType: "pi-herdr-rename/title", data: { display: "One two three four five", branch: "fix/saved-title" } }],
		});
		await malformed.handlers.get("session_start")?.({}, malformed.ctx);
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.deepEqual(malformed.execCalls, []);
	});
});

test("automatic and resumed Herdr failures warn", async () => {
	await withAgentDir(async () => {
		process.env.HERDR_ENV = "1";
		process.env.HERDR_PANE_ID = "pane-1";
		const exec = async (args: string[]) =>
			args[0] === "pane" && args[1] === "get"
				? { stdout: "", stderr: "gone", code: 7, killed: false }
				: success("{}");

		const automatic = harness({ exec });
		await automatic.handlers.get("session_start")?.({}, automatic.ctx);
		automatic.handlers.get("input")?.({ source: "interactive", text: "prompt" }, automatic.ctx);
		await automatic.handlers.get("before_agent_start")?.({ prompt: "prompt" }, automatic.ctx);
		await eventually(() => automatic.notifications.length > 0);
		assert.match(automatic.notifications.at(-1) ?? "", /herdr pane get failed/);

		const resumed = harness({
			sessionName: "Saved title",
			branch: [{ type: "custom", customType: "pi-herdr-rename/title", data: { display: "Saved title", branch: "fix/saved-title" } }],
			exec,
		});
		await resumed.handlers.get("session_start")?.({}, resumed.ctx);
		await eventually(() => resumed.notifications.length > 0);
		assert.match(resumed.notifications.at(-1) ?? "", /herdr pane get failed/);
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
		assert.deepEqual(app.names, ["Second title"]);
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
		assert.deepEqual(app.widgets.at(-1), ["renamed to Generated title"]);
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
		await app.handlers.get("before_agent_start")?.({ prompt: "prompt" }, app.ctx);
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
		await writeFile(join(dir, "config", "pi-task-models", "config.json"), JSON.stringify({
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
		assert.deepEqual(app.names, ["Fallback title"]);
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
		await app.handlers.get("before_agent_start")?.({ prompt: "prompt" }, app.ctx);
		await eventually(() => Boolean(signal));
		app.handlers.get("session_shutdown")?.({}, app.ctx);
		assert.equal(signal.aborted, true);
		resolveCompletion(response("one two three four five six"));
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.deepEqual(app.names, []);

		const invalid = harness({ complete: async () => response("plain title") });
		await invalid.handlers.get("session_start")?.({}, invalid.ctx);
		invalid.handlers.get("input")?.({ source: "interactive", text: "prompt" }, invalid.ctx);
		await invalid.handlers.get("before_agent_start")?.({ prompt: "prompt" }, invalid.ctx);
		await eventually(() => invalid.completionCalls.length === 1);
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.deepEqual(invalid.names, []);
	});
});

test("display title limits apply to subject without counting semantic type", async () => {
	await withAgentDir(async () => {
		const titles = [
			"extraordinary: update task logic",
			"feat: one two three four five",
			"fix: abcdefghijklmnopqrstu",
			"refactor: update task logic",
		];
		const app = harness({
			sessionName: "saved",
			branch: [{ type: "message", message: { role: "user", content: "rename this" } }],
			complete: async () => response(titles.shift() ?? ""),
		});
		await app.handlers.get("session_start")?.({}, app.ctx);

		await app.commands.get("rename")?.("", app.ctx);
		await app.commands.get("rename")?.("", app.ctx);
		await app.commands.get("rename")?.("", app.ctx);
		await app.commands.get("rename")?.("", app.ctx);

		assert.match(app.completionCalls[0].context.systemPrompt, /max 4 words and 20 characters/);
		assert.equal(app.notifications.filter((message) => message.includes("invalid title")).length, 3);
		assert.deepEqual(app.names, ["Update task logic"]);
		assert.deepEqual(app.entries, [{ customType: "pi-herdr-rename/title", data: { display: "Update task logic", branch: "refactor/update-task-logic" } }]);
	});
});

test("rename warns once when the shared task-model config is missing", async () => {
	await withAgentDir(async (dir) => {
		await rm(join(dir, "config", "pi-task-models", "config.json"));
		const app = harness({
			sessionName: "saved",
			branch: [{ type: "message", message: { role: "user", content: "prompt" } }],
		});
		await app.handlers.get("session_start")?.({}, app.ctx);
		assert.deepEqual(app.notifications, ["Task model config is missing; run /task-models to configure rename routing."]);
		assert.deepEqual(app.notificationTypes, ["warning"]);
	});
});

test("rename reports an unconfigured fast profile without changing the title", async () => {
	await withAgentDir(async (dir) => {
		await writeFile(join(dir, "config", "pi-task-models", "config.json"), JSON.stringify({ profiles: {} }));
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
		const taskModelsFile = join(dir, "config", "pi-task-models", "config.json");
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
		process.env.HERDR_ENV = "1";
		process.env.HERDR_PANE_ID = "pane-1";
		const app = harness({
			sessionName: "Saved title",
			branch: [{ type: "custom", customType: "pi-herdr-rename/title", data: { display: "Saved title", branch: "fix/saved-title" } }],
			exec: async (args) =>
				args[0] === "pane" && args[1] === "get"
					? { stdout: "", stderr: "gone", code: 7, killed: false }
					: success("{}"),
		});
		await app.handlers.get("session_start")?.({}, app.ctx);
		await eventually(() => app.execCalls.some((args) => args[0] === "pane" && args[1] === "get"));
		app.handlers.get("input")?.({ source: "interactive", text: "prompt" }, app.ctx);
		await app.commands.get("rename")?.("", app.ctx);
		assert.deepEqual(app.names, ["Generated title"]);
		assert.ok(app.execCalls.some((args) => args[0] === "pane" && args[1] === "rename" && args.at(-1) === "Generated title"));
		assert.match(app.notifications.at(-1) ?? "", /herdr pane get failed/);
		assert.equal(app.widgets.at(-1), undefined);
	});
});
