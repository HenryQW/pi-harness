import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { withWorktreeLock } from "@henryqw/pi-herdr";
import herdrRenameExtension from "../internal/rename.ts";

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

function herdrFixture(checkoutPath: string) {
	const workspace = { workspace_id: "workspace-1", label: "worktree-brave-meadow-4aa8", tokens: {} as Record<string, string>, worktree: { checkout_path: checkoutPath, is_linked_worktree: true } };
	const tabs = [1, 2].map((number) => ({ tab_id: `tab-${number}`, workspace_id: workspace.workspace_id, label: `Tab ${number}`, number, pane_count: 1 }));
	const panes = tabs.map((tab, index) => ({ pane_id: `pane-${index + 1}`, tab_id: tab.tab_id, workspace_id: workspace.workspace_id, cwd: checkoutPath }));
	const state = { workspace, tabs, panes, branch: "worktree/generated", branches: [] as readonly string[] };
	const json = (type: string, fields: object) => success(JSON.stringify({ result: { type, ...fields } }));
	return { ...state, state, exec: async (args: string[]) => {
		if (args[0] === "branch" && args[1] === "--show-current") return success(state.branch);
		if (args[0] === "for-each-ref") return success(state.branches.join("\n"));
		if ((args[0] === "branch" && args[1] === "-m") || args[0] === "switch") state.branch = args[2];
		if (args[0] === "pane" && args[1] === "get") return json("pane_info", { pane: panes.find((pane) => pane.pane_id === args[2]) });
		if (args[0] === "tab" && args[1] === "get") return json("tab_info", { tab: tabs.find((tab) => tab.tab_id === args[2]) });
		if (args[0] === "tab" && args[1] === "list") return json("tab_list", { tabs });
		if (args[0] === "workspace" && args[1] === "get") return json("workspace_info", { workspace });
		if (args[0] === "workspace" && args[1] === "report-metadata") {
			const [key, value] = args[6].split("="); workspace.tokens[key] = value;
		}
		if (args[1] === "rename" && args[0] === "tab") tabs.find((tab) => tab.tab_id === args[2])!.label = args[3];
		if (args[1] === "rename" && args[0] === "workspace") workspace.label = args[3];
		return success("{}");
	} };
}

function harness(options: {
	sessionName?: string;
	models?: Model[];
	currentModel?: Model;
	branch?: any[];
	complete?: (call: CompletionCall) => Promise<any>;
	herdr?: ReturnType<typeof herdrFixture>;
	exec?: (args: string[], options?: { signal?: AbortSignal; cwd?: string }) => Promise<ReturnType<typeof success> | undefined>;
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
			const override = await options.exec?.(args, execOptions);
			if (override) return override;
			if (options.herdr) return options.herdr.exec(args);
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
		scopedModels: [],
		modelRegistry: {
			getAvailable: () => models,
			streamSimple: (model: Model, context: any, completionOptions: any) => ({
				result: async () => {
					const call = { model, context, options: completionOptions };
					completionCalls.push(call);
					return options.complete ? options.complete(call) : response('{"kind":"feat","subject":"generated title"}');
				},
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
	const dir = await realpath(await mkdtemp(join(tmpdir(), "pi-herdr-rename-")));
	const previous = Object.fromEntries(["PI_CODING_AGENT_DIR", "HERDR_ENV", "HERDR_PANE_ID", "HERDR_SOCKET_PATH", "PI_SUBAGENT_PROCESS_LEASE"].map((key) => [key, process.env[key]]));
	process.env.PI_CODING_AGENT_DIR = dir;
	process.env.HERDR_SOCKET_PATH = "/tmp/rename-test.sock";
	delete process.env.HERDR_ENV;
	delete process.env.HERDR_PANE_ID;
	delete process.env.PI_SUBAGENT_PROCESS_LEASE;
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
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key]; else process.env[key] = value;
		}
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
		await app.commands.get("main-tab")!("", app.ctx);
		assert.match(app.notifications.at(-1) ?? "", /requires a Herdr pane/);
		assert.equal(app.completionCalls.length, 1);
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

		resolveCompletion(response('{"kind":"  Refactor  ","subject":"  Update\\nTask Logic  "}'));
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
					? '{"kind":"chore","subject":"unclear input"}'
					: '{"kind":"fix","subject":"login redirect loop"}',
			),
		});
		await app.handlers.get("session_start")?.({}, app.ctx);
		app.handlers.get("input")?.({ source: "interactive", text: "/fix-login" }, app.ctx);
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.equal(app.completionCalls.length, 0);
		await app.handlers.get("before_agent_start")?.({ messageType: "custom", message: {} }, app.ctx);
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
		for (const [paneCount, workspaceName, isLinkedWorktree, currentBranch, existingBranches, renameWorkspace, gitMutation] of [
			[1, "worktree-brave-meadow-4aa8", true, "fix/title-length", [], true, undefined],
			[2, "lucky-field-f694", true, "feat/new-loader", [], false, undefined],
			[1, "worktree/brave-meadow-4aa8", true, "worktree/brave-meadow-4aa8", [], true, ["branch", "-m", "fix/saved-title"]],
			[1, "worktree-brave-meadow-4aa8", true, "worktree/brave-meadow-4aa8", ["fix/saved-title"], true, ["branch", "-m", "fix/saved-title-2"]],
			[1, "chosen workspace", true, "worktree/brave-meadow-4aa8", [], false, ["branch", "-m", "fix/saved-title"]],
			[1, "worktree-clear-field-8512", false, "worktree/clear-field-8512", [], false, undefined],
			[1, "worktree-quiet-river-1234", true, "", ["fix"], true, ["switch", "-c", "fix-2/saved-title"]],
		] as const) {
			const checkoutPath = await mkdtemp(join(dir, "worktree-"));
			const herdr = herdrFixture(checkoutPath);
			herdr.tabs[0].pane_count = paneCount;
			herdr.workspace.label = workspaceName;
			herdr.workspace.worktree.is_linked_worktree = isLinkedWorktree;
			herdr.state.branch = currentBranch;
			herdr.state.branches = existingBranches;
			const gitCwds: Array<string | undefined> = [];
			const app = harness({
				herdr,
				sessionName: "Saved title",
				branch: [{ type: "custom", customType: "pi-herdr-rename/title", data: { display: "Saved title", branch: "fix/saved-title" } }],
				exec: async (args, options) => {
					if (args[0] === "branch" || args[0] === "switch" || args[0] === "for-each-ref") gitCwds.push(options?.cwd);
				},
			});
			await app.commands.get("main-tab")!("", app.ctx);
			app.execCalls.length = 0; app.notifications.length = 0;
			await app.handlers.get("session_start")?.({}, app.ctx);
			await eventually(() => app.execCalls.some((args) => args[0] === "workspace" && args[1] === "get"));
			await eventually(() => paneCount !== 1 ? app.notifications.length > 0
				: !isLinkedWorktree ? app.execCalls.filter((args) => args[0] === "workspace" && args[1] === "get").length === 3
				: gitCwds.length === 1 + Number(Boolean(gitMutation)) * 2);
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
			assert.deepEqual(gitCwds, Array(isLinkedWorktree && paneCount === 1 ? 1 + Number(Boolean(gitMutation)) * 2 : 0).fill(checkoutPath));
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
		for (const workspaceName of ["Saved title", "Custom workspace"]) {
			const herdr = herdrFixture(await mkdtemp(join(dir, "worktree-")));
			herdr.workspace.label = workspaceName;
			herdr.state.branch = "fix/saved-title";
			const app = harness({
				herdr,
				sessionName: "Saved title",
				branch: [
					{ type: "custom", customType: "pi-herdr-rename/title", data: { display: "Saved title", branch: "fix/saved-title" } },
					{ type: "message", message: { role: "user", content: "update task logic" } },
				],
				complete: async () => response('{"kind":"refactor","subject":"update task logic"}'),
			});
			await app.commands.get("main-tab")!("", app.ctx);
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
				herdr: herdrFixture(checkoutPath),
			});
			await app.commands.get("main-tab")!("", app.ctx);
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

test("only the main tab changes workspace and branch; closing it does not promote another", async () => {
	await withAgentDir(async (dir) => {
		process.env.HERDR_ENV = "1"; process.env.HERDR_PANE_ID = "pane-1";
		const herdr = herdrFixture(dir);
		const main = harness({ herdr });
		await main.commands.get("main-tab")!("", main.ctx);
		await main.handlers.get("session_start")?.({}, main.ctx);
		main.handlers.get("input")?.({ source: "interactive", text: "prompt" }, main.ctx);
		await main.handlers.get("before_agent_start")?.({ prompt: "prompt" }, main.ctx);
		await eventually(() => herdr.state.branch === "feat/generated-title");
		assert.equal(herdr.workspace.label, "Generated title");
		process.env.HERDR_PANE_ID = "pane-2";
		const side = harness({ herdr, branch: [{ type: "message", message: { role: "user", content: "side task" } }],
			complete: async () => response('{"kind":"fix","subject":"side task"}') });
		await side.commands.get("rename")!("", side.ctx);
		assert.deepEqual(side.names, ["Side task"]);
		assert.equal(herdr.tabs[1].label, "Side task");
		assert.equal(herdr.workspace.label, "Generated title");
		assert.equal(herdr.state.branch, "feat/generated-title");
		assert.equal(side.execCalls.some((args) => args[0] === "branch"), false);
		await side.commands.get("main-tab")!("", side.ctx);
		assert.equal(herdr.workspace.label, "Side task");
		assert.equal(side.completionCalls.length, 1);
		herdr.tabs.pop(); herdr.panes.pop();
		process.env.HERDR_PANE_ID = "pane-1";
		await main.commands.get("rename")!("", main.ctx);
		assert.equal(herdr.workspace.label, "Side task");
	});
});

test("an unselected restored tab 1 keeps automatic and manual names local", async () => {
	await withAgentDir(async (dir) => {
		process.env.HERDR_ENV = "1"; process.env.HERDR_PANE_ID = "pane-1";
		const herdr = herdrFixture(dir);
		herdr.workspace.tokens.pi_harness_main_tab = "existing-live-token";
		const app = harness({ herdr });
		await app.handlers.get("session_start")?.({}, app.ctx);
		app.handlers.get("input")?.({ source: "interactive", text: "prompt" }, app.ctx);
		await app.handlers.get("before_agent_start")?.({ prompt: "prompt" }, app.ctx);
		await eventually(() => app.notifications.some((message) => message.includes("Run /main-tab")));
		await app.commands.get("rename")!("", app.ctx);
		assert.equal(herdr.tabs[0].label, "Generated title");
		assert.equal(app.names.length, 2);
		assert.equal(herdr.workspace.label, "worktree-brave-meadow-4aa8");
		assert.equal(herdr.state.branch, "worktree/generated");
		assert.equal(herdr.workspace.tokens.pi_harness_main_tab, "existing-live-token");
		assert.equal(app.execCalls.some((args) => args[1] === "report-metadata" || args[0] === "branch"), false);
		await assert.rejects(readFile(join(dir, ".context/pi-harness/pi-herdr-tools/state.json")), { code: "ENOENT" });
	});
});

test("a token change after workspace rename blocks the later Git mutation", async () => {
	await withAgentDir(async (dir) => {
		process.env.HERDR_ENV = "1"; process.env.HERDR_PANE_ID = "pane-1";
		const herdr = herdrFixture(dir);
		const app = harness({ herdr, branch: [{ type: "message", message: { role: "user", content: "rename this" } }],
			exec: async (args) => {
				if (args[0] === "workspace" && args[1] === "rename") {
					const result = await herdr.exec(args);
					herdr.workspace.tokens = {};
					return result;
				}
			} });
		await app.commands.get("main-tab")!("", app.ctx);
		await app.commands.get("rename")!("", app.ctx);
		assert.equal(herdr.workspace.label, "Generated title");
		assert.equal(herdr.state.branch, "worktree/generated");
		assert.equal(app.execCalls.some((args) => args[0] === "switch" || (args[0] === "branch" && args[1] === "-m")), false);
		assert.match(app.notifications.at(-1) ?? "", /token changed.*\/main-tab/);
	});
});

test("rename and main-tab revalidate immediately before workspace mutation", async () => {
	await withAgentDir(async (dir) => {
		process.env.HERDR_ENV = "1"; process.env.HERDR_PANE_ID = "pane-1";
		for (const command of ["rename", "main-tab"]) {
			const herdr = herdrFixture(await mkdtemp(join(dir, "worktree-")));
			let armed = false, reads = 0;
			const app = harness({ herdr, branch: [{ type: "message", message: { role: "user", content: "rename this" } }],
				exec: async (args) => {
					if (armed && args[0] === "workspace" && args[1] === "get" && ++reads === 4) herdr.workspace.tokens = {};
				} });
			await app.commands.get("main-tab")!("", app.ctx);
			herdr.tabs[0].label = "Meaningful label"; armed = true;
			await app.commands.get(command)!("", app.ctx);
			assert.equal(herdr.workspace.label, "worktree-brave-meadow-4aa8");
			assert.match(app.notifications.at(-1) ?? "", /token changed/);
		}
	});
});

test("a delayed rename checks the selection after another session selects its tab", async () => {
	await withAgentDir(async (dir) => {
		process.env.HERDR_ENV = "1"; process.env.HERDR_PANE_ID = "pane-1";
		const herdr = herdrFixture(dir);
		let complete!: (value: any) => void;
		const oldMain = harness({ herdr, branch: [{ type: "message", message: { role: "user", content: "old main" } }],
			complete: async () => new Promise((resolve) => { complete = resolve; }) });
		await oldMain.commands.get("main-tab")!("", oldMain.ctx);
		const pending = oldMain.commands.get("rename")!("", oldMain.ctx);
		await eventually(() => Boolean(complete));
		process.env.HERDR_PANE_ID = "pane-2";
		herdr.tabs[1].label = "Chosen task";
		const newMain = harness({ herdr });
		await newMain.commands.get("main-tab")!("", newMain.ctx);
		assert.equal(herdr.workspace.label, "Chosen task");
		process.env.HERDR_PANE_ID = "pane-1";
		complete(response('{"kind":"fix","subject":"old request"}'));
		await pending;
		assert.equal(herdr.tabs[0].label, "Old request");
		assert.equal(herdr.workspace.label, "Chosen task");
		assert.equal(herdr.state.branch, "worktree/generated");
		assert.equal(newMain.completionCalls.length, 0);
		assert.deepEqual(newMain.names, []);
	});
});

test("multi-pane titles stay local; main-tab copies meaningful shared labels without branch changes", async () => {
	await withAgentDir(async (dir) => {
		process.env.HERDR_ENV = "1"; process.env.HERDR_PANE_ID = "pane-1";
		const herdr = herdrFixture(dir);
		herdr.tabs[0].pane_count = 2;
		const app = harness({ herdr, branch: [{ type: "message", message: { role: "user", content: "rename this pane" } }] });
		await app.commands.get("main-tab")!("", app.ctx);
		herdr.tabs[0].label = "Shared investigation";
		await app.commands.get("rename")!("", app.ctx);
		assert.equal(herdr.tabs[0].label, "Shared investigation");
		assert.equal(herdr.workspace.label, "worktree-brave-meadow-4aa8");
		assert.equal(herdr.state.branch, "worktree/generated");
		assert.match(app.notifications.at(-1) ?? "", /multiple panes/);
		await app.commands.get("main-tab")!("", app.ctx);
		assert.equal(herdr.workspace.label, "Shared investigation");
		assert.equal(herdr.state.branch, "worktree/generated");
		for (const generic of ["1", "Tab 1"]) {
			herdr.tabs[0].label = generic;
			await app.commands.get("main-tab")!("", app.ctx);
			assert.equal(herdr.workspace.label, "Shared investigation");
			assert.match(app.notifications.at(-1) ?? "", /Name the tab/);
		}
		assert.equal(app.completionCalls.length, 1);
	});
});

test("subagent automatic and resumed titles preserve assigned Herdr names; rename overrides them", async () => {
	await withAgentDir(async (dir) => {
		process.env.HERDR_ENV = "1"; process.env.HERDR_PANE_ID = "pane-2";
		process.env.PI_SUBAGENT_PROCESS_LEASE = join(dir, "worker.lease");
		const herdr = herdrFixture(dir);
		herdr.tabs[1].label = "D1.1 Assigned task";
		const automatic = harness({ herdr });
		await automatic.handlers.get("session_start")?.({}, automatic.ctx);
		automatic.handlers.get("input")?.({ source: "interactive", text: "task" }, automatic.ctx);
		await automatic.handlers.get("before_agent_start")?.({ prompt: "task" }, automatic.ctx);
		await eventually(() => automatic.names.length === 1);
		assert.deepEqual(automatic.execCalls, []);
		const resumed = harness({ herdr, sessionName: "Saved title", branch: [
			{ type: "custom", customType: "pi-herdr-rename/title", data: { display: "Saved title", branch: "fix/saved-title" } },
			{ type: "message", message: { role: "user", content: "worker task" } },
		] });
		await resumed.handlers.get("session_start")?.({}, resumed.ctx);
		assert.equal(resumed.execCalls.length, 0);
		assert.equal(herdr.tabs[1].label, "D1.1 Assigned task");
		await resumed.commands.get("rename")!("", resumed.ctx);
		assert.equal(herdr.tabs[1].label, "Generated title");
		assert.ok(resumed.execCalls.some((args) => args.join(" ") === "pane rename pane-2 Generated title"));
		assert.equal(herdr.workspace.label, "worktree-brave-meadow-4aa8");
	});
});

test("stale and unavailable shared state never block local names or overwrite malformed files", async () => {
	await withAgentDir(async (dir) => {
		process.env.HERDR_ENV = "1"; process.env.HERDR_PANE_ID = "pane-1";
		const herdr = herdrFixture(dir);
		const app = harness({ herdr, branch: [{ type: "message", message: { role: "user", content: "rename this" } }] });
		await app.commands.get("main-tab")!("", app.ctx);
		await app.commands.get("rename")!("", app.ctx);
		herdr.workspace.tokens = {}; herdr.workspace.label = "Custom workspace";
		await app.commands.get("rename")!("", app.ctx);
		assert.equal(herdr.workspace.label, "Custom workspace");
		assert.match(app.notifications.at(-1) ?? "", /Run \/main-tab/);
		await app.commands.get("main-tab")!("", app.ctx);
		assert.equal(herdr.workspace.label, "Generated title");
		const stateFile = join(dir, ".context/pi-harness/pi-herdr-tools/state.json");
		await writeFile(stateFile, "{broken");
		await app.commands.get("rename")!("", app.ctx);
		assert.equal(await readFile(stateFile, "utf8"), "{broken");
		assert.match(app.notifications.at(-1) ?? "", /main-tab state.*preserved/);
		await rm(join(dir, ".context"), { recursive: true });
		await writeFile(join(dir, ".context"), "not a directory");
		await app.commands.get("rename")!("", app.ctx);
		assert.match(app.notifications.at(-1) ?? "", /Workspace title or branch synchronization failed/);
		assert.equal(app.names.length, 4);
		assert.equal(app.execCalls.filter((args) => args[0] === "tab" && args[1] === "rename").length, 4);
		assert.deepEqual(app.widgets.at(-1), ["renamed to Generated title"]);
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
		resolvers[1](response('{"kind":"feat","subject":"second title"}'));
		await second;
		resolvers[0](response('{"kind":"fix","subject":"first title"}'));
		await first;
		assert.deepEqual(app.names, ["Second title"]);
	});
});

test("manual rename uses only the latest five user messages", async () => {
	await withAgentDir(async () => {
		const branch = [
			{ type: "message", message: { role: "user", content: "oldest ignored request" } },
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "oldest answer" }] } },
			{ type: "message", message: { role: "user", content: "first included request" } },
			{
				type: "message",
				message: {
					role: "user",
					content: [
						{ type: "thinking", thinking: "private reasoning" },
						{ type: "text", text: "A".repeat(1_200) },
						{ type: "toolCall", name: "secret tool" },
					],
				},
			},
			{ type: "message", message: { role: "toolResult", content: [{ type: "text", text: "tool output" }] } },
			{ type: "message", message: { role: "user", content: "third included request" } },
			{ type: "message", message: { role: "user", content: "  " } },
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "assistant answer" }] } },
			{ type: "message", message: { role: "user", content: "fourth included request" } },
			{ type: "message", message: { role: "user", content: [{ type: "thinking", thinking: "hidden" }] } },
			{ type: "message", message: { role: "user", content: "latest included request" } },
		];
		const app = harness({ sessionName: "saved", branch });
		await app.handlers.get("session_start")?.({}, app.ctx);
		await app.commands.get("rename")?.("", app.ctx);

		const context = app.completionCalls[0].context.messages[0].content as string;
		assert.ok(context.length <= 5_000);
		assert.doesNotMatch(context, /oldest ignored|oldest answer|private reasoning|secret tool|tool output|assistant answer/);
		assert.match(context, /user: first included request/);
		assert.match(context, /user: third included request/);
		assert.match(context, /user: fourth included request/);
		assert.match(context, /user: latest included request/);
		assert.equal(context.match(/A/g)?.length, 1_000);
		assert.equal(context.match(/^user:/gm)?.length, 5);
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

test("rename uses its assigned profile and its fallback after an invalid title", async () => {
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
				fast: { primary: { model: "main/reliable", thinkingLevel: "off" } },
				frontier: {
					primary: { model: "primary/fast", thinkingLevel: "low" },
					fallback: { model: "fallback/fast", thinkingLevel: "low" },
				},
			},
			tasks: { "pi-herdr-tools/rename": "frontier" },
		}));

		const app = harness({
			sessionName: "saved",
			branch: [{ type: "message", message: { role: "user", content: "prompt" } }],
			models: [primary, fallback, currentModel],
			currentModel,
			complete: async (call) => call.model === primary
				? response("plain title")
				: response('{"kind":"fix","subject":"fallback title"}'),
		});
		await app.handlers.get("session_start")?.({}, app.ctx);
		assert.equal(app.commands.has("rename-model"), false);
		await app.commands.get("rename")?.("", app.ctx);

		assert.deepEqual(app.completionCalls.map((call) => call.model), [primary, primary, fallback]);
		assert.deepEqual(app.completionCalls.map((call) => call.options.maxRetries), [0, 0, 0]);
		assert.deepEqual(app.completionCalls.map((call) => call.options.reasoning), ["low", "low", "low"]);
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
		const rejected = [
			'{"kind":"extraordinary","subject":"update task logic"}',
			'{"kind":"feat","subject":"one two three four five"}',
			'{"kind":"fix","subject":"abcdefghijklmnopqrstu"}',
		];
		let calls = 0;
		const app = harness({
			sessionName: "saved",
			branch: [{ type: "message", message: { role: "user", content: "rename this" } }],
			complete: async () => {
				const index = Math.floor(calls / 2);
				calls++;
				return index < rejected.length ? response(rejected[index]) : response('{"kind":"refactor","subject":"update task logic"}');
			},
		});
		await app.handlers.get("session_start")?.({}, app.ctx);

		for (let attempt = 0; attempt < 4; attempt++) await app.commands.get("rename")?.("", app.ctx);

		assert.equal(app.notifications.filter((message) => message.includes("invalid title")).length, 3);
		assert.equal(app.completionCalls.length, 7);
		assert.deepEqual(app.names, ["Update task logic"]);
		assert.deepEqual(app.entries, [{ customType: "pi-herdr-rename/title", data: { display: "Update task logic", branch: "refactor/update-task-logic" } }]);
	});
});

test("a colon-form reply is rejected and repaired once before the route falls back", async () => {
	await withAgentDir(async () => {
		const app = harness({
			sessionName: "saved",
			branch: [{ type: "message", message: { role: "user", content: "rename this" } }],
			complete: async (call) => call.context.messages.length === 1
				? response("debug: sentry missing")
				: response('{"kind":"debug","subject":"sentry recording"}'),
		});
		await app.handlers.get("session_start")?.({}, app.ctx);
		await app.commands.get("rename")?.("", app.ctx);

		assert.equal(app.completionCalls.length, 2);
		const repair = app.completionCalls[1].context.messages;
		assert.equal(repair.length, 2);
		assert.match(repair[1].content, /Your previous reply was rejected/);
		assert.match(repair[1].content, /debug: sentry missing/);
		assert.doesNotMatch(app.notifications.join("\n"), /invalid title/);
		assert.deepEqual(app.names, ["Sentry recording"]);
		assert.deepEqual(app.entries, [{ customType: "pi-herdr-rename/title", data: { display: "Sentry recording", branch: "debug/sentry-recording" } }]);
	});
});

test("a JSON reply is accepted with wrapping text and normalized casing", async () => {
	await withAgentDir(async () => {
		const app = harness({
			sessionName: "saved",
			branch: [{ type: "message", message: { role: "user", content: "rename this" } }],
			complete: async () => response('Sure: {"kind":"Fix","subject":"Login Crash"} done'),
		});
		await app.handlers.get("session_start")?.({}, app.ctx);
		await app.commands.get("rename")?.("", app.ctx);

		assert.equal(app.completionCalls.length, 1);
		assert.deepEqual(app.names, ["Login crash"]);
		assert.deepEqual(app.entries, [{ customType: "pi-herdr-rename/title", data: { display: "Login crash", branch: "fix/login-crash" } }]);
	});
});

test("a malformed candidate is skipped for a later well-formed object", async () => {
	await withAgentDir(async () => {
		const app = harness({
			sessionName: "saved",
			branch: [{ type: "message", message: { role: "user", content: "rename this" } }],
			complete: async () => response('Consider {"kind":"fix"} then\n{"kind":"debug","subject":"sentry recording"}.\n'),
		});
		await app.handlers.get("session_start")?.({}, app.ctx);
		await app.commands.get("rename")?.("", app.ctx);

		assert.equal(app.completionCalls.length, 1);
		assert.deepEqual(app.names, ["Sentry recording"]);
	});
});

test("rename reports a missing shared task-model config", async () => {
	await withAgentDir(async (dir) => {
		await rm(join(dir, "config", "pi-task-models", "config.json"));
		const app = harness({
			sessionName: "saved",
			branch: [{ type: "message", message: { role: "user", content: "prompt" } }],
		});
		await app.handlers.get("session_start")?.({}, app.ctx);
		await app.commands.get("rename")?.("", app.ctx);
		assert.equal(app.completionCalls.length, 0);
		assert.deepEqual(app.names, []);
		assert.deepEqual(app.notifications, ["Task model config is missing. Run /task-models to configure task routes."]);
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
		await app.commands.get("rename")?.("", app.ctx);
		assert.equal(app.completionCalls.length, 0);
		assert.deepEqual(app.names, []);
		assert.match(app.notifications.at(-1) ?? "", /pi-task-models\/config.json is disabled: invalid JSON/);
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
