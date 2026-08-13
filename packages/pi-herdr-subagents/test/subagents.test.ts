import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import subagentsExtension from "../extensions/subagents.ts";
import subagentExtension from "../internal/subagent.ts";
import {
	completionNotice,
	parseCompletionNotice,
	parseCompletionNotices,
	parsePendingResult,
	parseTerminalResult,
	PROTOCOL_VERSION,
} from "../internal/protocol.ts";

type Handler = (event: any, ctx: ExtensionContext) => any;
type Tool = { description?: string; executionMode?: string; execute: (...args: any[]) => Promise<any>; parameters: any };
type Command = { handler: (args: string, ctx: ExtensionContext) => Promise<void> };

const success = (stdout: string) => ({ stdout, stderr: "", code: 0, killed: false });
const failure = (code: string) => ({ stdout: "", stderr: JSON.stringify({ error: { code, message: code } }), code: 1, killed: false });
type TestModel = {
	provider: string;
	id: string;
	input: string[];
	reasoning?: boolean;
	thinkingLevelMap?: Partial<Record<string, string | null>>;
	contextWindow?: number;
};

const model = { provider: "test-provider", id: "test-model", reasoning: true, contextWindow: 100_000 };

async function withEnvironment(values: Record<string, string | undefined>, run: () => Promise<void>): Promise<void> {
	const before = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
	for (const [key, value] of Object.entries(values)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	try {
		await run();
	} finally {
		for (const [key, value] of before) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

function mainHarness(options: {
	limitInput?: string;
	promptFailure?: boolean;
	promptIndeterminate?: boolean;
	closeFailures?: number;
	closeKilled?: boolean;
	listFailuresAfterCreate?: number;
	malformedTabs?: () => boolean;
	tabs?: () => boolean;
	noModel?: boolean;
	thinkingLevel?: string;
	trusted?: boolean;
	malformedCreatedIdentity?: boolean;
	tabCreateFailureAfterCreation?: boolean;
	abortAfterStart?: AbortController;
	mainName?: string | null;
	selectResults?: Array<string | undefined>;
	availableModels?: TestModel[];
	onModelRegistryRefresh?: (options: { allowNetwork?: boolean }) => Promise<void> | void;
} = {}) {
	const handlers = new Map<string, Handler>();
	const tools = new Map<string, Tool>();
	const commands = new Map<string, Command>();
	const calls: string[][] = [];
	const notices: string[] = [];
	const closed: string[] = [];
	const widgets: Array<[string, string[] | undefined]> = [];
	const selectResults = [...(options.selectResults ?? [])];
	let limitInput = options.limitInput;
	let mainName: string | null = options.mainName ?? null;
	let tabPresent = !options.tabCreateFailureAfterCreation;
	let tabLabel = "existing";
	let closeFailures = options.closeFailures ?? 0;
	let listFailuresAfterCreate = options.listFailuresAfterCreate ?? 0;
	let tabId = "tab-1";
	let paneId = "pane-1";
	let subagentName = "";
	const cwd = "/work/project";
	const ctx = {
		cwd,
		model: options.noModel ? undefined : model,
		thinkingLevel: Object.hasOwn(options, "thinkingLevel") ? options.thinkingLevel : "high",
		isProjectTrusted: () => options.trusted ?? true,
		modelRegistry: {
			getAvailable: () => options.availableModels ?? [{ ...model, input: ["text"] }],
			refresh: async (refreshOptions: { allowNetwork?: boolean } = {}) => {
				await options.onModelRegistryRefresh?.(refreshOptions);
			},
		},
		sessionManager: { getBranch: () => [] },
		mode: "tui",
		ui: {
			theme: { fg: (_color: string, value: string) => value },
			setWidget: (key: string, lines: string[] | undefined) => widgets.push([key, lines]),
			notify: (message: string) => notices.push(message),
			input: async () => limitInput,
			select: async () => selectResults.shift(),
		},
	} as unknown as ExtensionContext;
	const api = {
		on(event: string, handler: Handler) { handlers.set(event, handler); },
		registerTool(tool: Tool & { name: string }) { tools.set(tool.name, tool); },
		registerCommand(name: string, command: Command) { commands.set(name, command); },
		exec: async (_command: string, args: string[], execOptions?: { signal?: AbortSignal }) => {
			calls.push(args);
			if (execOptions?.signal?.aborted) return { stdout: "", stderr: "", code: 0, killed: true };
			if (args.some((value) => value.includes("\0"))) throw new TypeError("spawn arguments cannot contain NUL bytes");
			if (args[0] === "tab" && args[1] === "list") {
				if (tabPresent && listFailuresAfterCreate > 0) {
					listFailuresAfterCreate--;
					return failure("tab_list_failed");
				}
				const tab = options.malformedTabs?.()
					? { tab_id: tabId, label: tabLabel }
					: { tab_id: tabId, workspace_id: "workspace-1", label: tabLabel };
				return success(JSON.stringify({ result: { type: "tab_list", tabs: tabPresent && (options.tabs?.() ?? true) ? [tab] : [] } }));
			}
			if (args[0] === "agent" && args[1] === "get") {
				return success(JSON.stringify({ result: { type: "agent_info", agent: { name: mainName, pane_id: "main-pane", workspace_id: "workspace-1" } } }));
			}
			if (args[0] === "agent" && args[1] === "rename") {
				mainName = args[3];
				return success(JSON.stringify({ result: { type: "agent_info", agent: { name: mainName, pane_id: "main-pane", workspace_id: "workspace-1" } } }));
			}
			if (args[0] === "tab" && args[1] === "create") {
				tabPresent = true;
				tabLabel = args[args.indexOf("--label") + 1];
				if (options.tabCreateFailureAfterCreation) return { stdout: "", stderr: "", code: 0, killed: true };
				return success(JSON.stringify({ result: { type: "tab_created", tab: { tab_id: tabId, workspace_id: "workspace-1", focused: false, pane_count: 1 }, root_pane: { pane_id: paneId, tab_id: tabId, workspace_id: options.malformedCreatedIdentity ? "wrong-workspace" : "workspace-1", focused: false, cwd } } }));
			}
			if (args[0] === "agent" && args[1] === "start") {
				subagentName = args[2];
				options.abortAfterStart?.abort();
				return success(JSON.stringify({ result: { type: "agent_started", agent: { name: subagentName, pane_id: paneId, tab_id: tabId, workspace_id: "workspace-1", interactive_ready: true } } }));
			}
			if (args[0] === "agent" && args[1] === "prompt") {
				if (options.promptFailure) return failure("agent_prompt_failed");
				if (options.promptIndeterminate) return { stdout: "", stderr: "", code: 0, killed: true };
				return success(JSON.stringify({ result: { type: "agent_prompted", agent: { name: args[2], pane_id: paneId, tab_id: tabId, workspace_id: "workspace-1" } } }));
			}
			if (args[0] === "tab" && args[1] === "close") {
				if (closeFailures > 0) {
					closeFailures--;
					return options.closeKilled ? { stdout: "", stderr: "", code: 0, killed: true } : failure("tab_close_failed");
				}
				closed.push(args[2]);
				tabPresent = false;
				return success(JSON.stringify({ result: { type: "ok" } }));
			}
			throw new Error(`Unhandled Herdr command: ${args.join(" ")}`);
		},
	} as unknown as ExtensionAPI;
	subagentsExtension(api);
	return { api, ctx, handlers, tools, commands, calls, notices, closed, widgets, get subagentName() { return subagentName; }, setLimitInput: (value: string) => { limitInput = value; }, setTabPresent: (value: boolean) => { tabPresent = value; }, set tab(id: string) { tabId = id; }, set pane(id: string) { paneId = id; } };
}

function subagentHarness(options: { branch?: any[]; wait?: () => Promise<any>; promptFailure?: boolean } = {}) {
	const handlers = new Map<string, Handler>();
	const tools = new Map<string, Tool>();
	const calls: string[][] = [];
	let branch = options.branch ?? [];
	const ctx = {
		cwd: "/work/project",
		sessionManager: { getBranch: () => branch },
	} as unknown as ExtensionContext;
	const api = {
		on(event: string, handler: Handler) { handlers.set(event, handler); },
		registerTool(tool: Tool & { name: string }) { tools.set(tool.name, tool); },
		exec: async (_command: string, args: string[], execOptions?: { signal?: AbortSignal }) => {
			calls.push(args);
			if (execOptions?.signal?.aborted) return { stdout: "", stderr: "", code: 0, killed: true };
			if (args[0] === "agent" && args[1] === "wait") {
				return options.wait ? await options.wait() : success(JSON.stringify({ result: { type: "agent_info", agent: { agent_status: "idle" } } }));
			}
			if (args[0] === "agent" && args[1] === "prompt") {
				return options.promptFailure ? failure("agent_prompt_failed") : success(JSON.stringify({ result: { type: "agent_prompted" } }));
			}
			throw new Error(`Unhandled Herdr command: ${args.join(" ")}`);
		},
	} as unknown as ExtensionAPI;
	return { api, ctx, handlers, tools, calls, setBranch: (value: any[]) => { branch = value; } };
}

async function pendingFile(task = "write test file") {
	const dir = await mkdtemp(join(tmpdir(), "pi-herdr-subagents-test-"));
	const path = join(dir, "result.json");
	const taskId = "123e4567-e89b-42d3-a456-426614174000";
	const createdAt = "2026-08-10T00:00:00.000Z";
	await writeFile(path, `${JSON.stringify({ version: PROTOCOL_VERSION, taskId, state: "pending", task, createdAt })}\n`, { mode: 0o600 });
	return { dir, path, taskId, task, createdAt };
}

test("Main registers only bounded public surface and launches exact Subagent", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-herdr-subagents-agent-"));
	await withEnvironment({ HERDR_ENV: "1", HERDR_WORKSPACE_ID: "workspace-1", HERDR_PANE_ID: "main-pane", PI_CODING_AGENT_DIR: agentDir }, async () => {
		const app = mainHarness();
		await app.handlers.get("session_start")?.({}, app.ctx);
		assert.ok(app.tools.has("delegate_task"));
		assert.ok(app.commands.has("subagent-widget"));

		const delegated = await app.tools.get("delegate_task")!.execute("call-1", { task: "inspect code and report" }, undefined, undefined, app.ctx);
		assert.equal(delegated.terminate, true);
		const output = delegated.content[0].text as string;
		const resultPath = output.match(/^Result: (.+)$/m)?.[1];
		assert.ok(resultPath);
		assert.match(output, /^Delegated Task [0-9a-f-]+/m);
		assert.match(output, /^Stop: herdr tab close tab-1$/m);
		const created = app.calls.find((args) => args[0] === "tab" && args[1] === "create")!;
		assert.ok(created.includes("--no-focus"));
		assert.equal(created[created.indexOf("--cwd") + 1], "/work/project");

		const pending = JSON.parse(await readFile(resultPath!, "utf8"));
		const terminal = { version: PROTOCOL_VERSION, taskId: pending.taskId, state: "finished", task: pending.task, result: "done\u0000\nnext", error: null, createdAt: pending.createdAt, finishedAt: "2026-08-10T00:01:00.000Z" } as const;
		await writeFile(resultPath!, JSON.stringify(terminal));
		assert.deepEqual(
			await app.handlers.get("input")?.({ source: "interactive", text: completionNotice("/tmp/not-owned.json", terminal.taskId) }, app.ctx),
			{ action: "continue" },
		);
		assert.deepEqual(app.closed, []);
		const input = await app.handlers.get("input")?.({ source: "interactive", text: completionNotice(resultPath!, terminal.taskId) }, app.ctx);
		assert.equal(input.action, "transform");
		assert.match(input.text, /completed Delegated Task .* \(finished\)/);
		assert.equal(input.text.includes("done"), false);
		assert.deepEqual(app.closed, []);
		assert.match(app.widgets.at(-1)?.[1]?.[0] ?? "", /^✓ inspect code and report • 100k • test-model • high • /);
		await app.commands.get("subagent-widget")!.handler("clear", app.ctx);
		assert.deepEqual(app.closed, ["tab-1"]);
		assert.deepEqual(app.widgets.at(-1), ["subagent-status", undefined]);
	});
	await rm(agentDir, { recursive: true, force: true });
});

test("widget removes manually closed live Subagent", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval", "Date"] });
	const agentDir = await mkdtemp(join(tmpdir(), "pi-herdr-subagents-widget-"));
	await withEnvironment({ HERDR_ENV: "1", HERDR_WORKSPACE_ID: "workspace-1", HERDR_PANE_ID: "main-pane", PI_CODING_AGENT_DIR: agentDir }, async () => {
		const app = mainHarness();
		await app.tools.get("delegate_task")!.execute("call", { task: "stop this live task" }, undefined, undefined, app.ctx);
		app.setTabPresent(false);
		t.mock.timers.tick(1_000);
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.deepEqual(app.widgets.at(-1), ["subagent-status", undefined]);
	});
	await rm(agentDir, { recursive: true, force: true });
});

test("Subagent widget shows a red error, retains terminal tabs, and clears only terminal tabs", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-herdr-subagents-widget-"));
	await withEnvironment({ HERDR_ENV: "1", HERDR_WORKSPACE_ID: "workspace-1", HERDR_PANE_ID: "main-pane", PI_CODING_AGENT_DIR: agentDir }, async () => {
		const app = mainHarness({ closeFailures: 1 });
		const delegated = await app.tools.get("delegate_task")!.execute("call", { task: "review widget status" }, undefined, undefined, app.ctx);
		assert.match(app.widgets.at(-1)?.[1]?.[0] ?? "", /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] review widget status • 100k • test-model • high • /);
		const resultPath = (delegated.content[0].text as string).match(/^Result: (.+)$/m)![1];
		const pending = JSON.parse(await readFile(resultPath, "utf8"));
		await writeFile(resultPath, JSON.stringify({
			version: PROTOCOL_VERSION, taskId: pending.taskId, state: "failed", task: pending.task, result: null,
			error: { stopReason: "error", message: "broken" }, createdAt: pending.createdAt, finishedAt: "2026-08-10T00:01:00.000Z",
		}));
		await app.handlers.get("input")?.({ source: "interactive", text: completionNotice(resultPath, pending.taskId) }, app.ctx);
		assert.match(app.widgets.at(-1)?.[1]?.[0] ?? "", /^! review widget status • 100k • test-model • high • /);
		await app.commands.get("subagent-widget")!.handler("clear", app.ctx);
		assert.deepEqual(app.closed, []);
		assert.match(app.notices.at(-2) ?? "", /Couldn't close Subagent tab tab-1/);
		await app.commands.get("subagent-widget")!.handler("clear", app.ctx);
		assert.deepEqual(app.closed, ["tab-1"]);
		assert.deepEqual(app.widgets.at(-1), ["subagent-status", undefined]);
	});
	await rm(agentDir, { recursive: true, force: true });
});

test("/subagent-model maps all model classes from Pi's available model list and routes Subagent", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-herdr-subagents-models-"));
	const availableModels: TestModel[] = [
		{ provider: "test-provider", id: "frontier-model", input: ["text"], reasoning: true, thinkingLevelMap: { max: "max" } },
		{ provider: "other-provider", id: "fast-model", input: ["text"], reasoning: false },
		{ provider: "test-provider", id: "balanced-model", input: ["text"], reasoning: true },
		{ provider: "other-provider", id: "image-only", input: ["image"], reasoning: false },
	];
	await withEnvironment({ HERDR_ENV: "1", HERDR_WORKSPACE_ID: "workspace-1", HERDR_PANE_ID: "main-pane", PI_CODING_AGENT_DIR: agentDir }, async () => {
		const app = mainHarness({
			availableModels,
			selectResults: [
				"fast", "other-provider/fast-model", "off",
				"balanced", "test-provider/balanced-model", "medium",
				"frontier", "test-provider/frontier-model", "max",
			],
		});
		await app.handlers.get("session_start")?.({}, app.ctx);
		for (let index = 0; index < 3; index++) await app.commands.get("subagent-model")!.handler("", app.ctx);

		assert.deepEqual(JSON.parse(await readFile(join(agentDir, "config", "pi-herdr-subagents.json"), "utf8")), {
			maxConcurrentSubagents: 10,
			models: {
				fast: { model: "other-provider/fast-model", thinkingLevel: "off" },
				balanced: { model: "test-provider/balanced-model", thinkingLevel: "medium" },
				frontier: { model: "test-provider/frontier-model", thinkingLevel: "max" },
			},
		});

		const reloaded = mainHarness({ availableModels });
		await reloaded.handlers.get("session_start")?.({}, reloaded.ctx);
		const delegated = await reloaded.tools.get("delegate_task")!.execute(
			"frontier",
			{ task: "solve complex task", modelClass: "frontier" },
			undefined,
			undefined,
			reloaded.ctx,
		);
		const started = reloaded.calls.find((args) => args[0] === "agent" && args[1] === "start")!;
		assert.equal(started[started.indexOf("--model") + 1], "test-provider/frontier-model");
		assert.equal(started[started.indexOf("--thinking") + 1], "max");
		assert.match(delegated.content[0].text, /^Model: test-provider\/frontier-model \(frontier\)$/m);
		assert.match(delegated.content[0].text, /^Thinking: max$/m);
	});
	await rm(agentDir, { recursive: true, force: true });
});

test("config commands merge disk state without reloading unrelated session settings", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-herdr-subagents-config-"));
	await withEnvironment({ PI_CODING_AGENT_DIR: agentDir }, async () => {
		const availableModels: TestModel[] = [{ ...model, input: ["text"] }];
		const first = mainHarness({
			availableModels,
			selectResults: [
				"fast", "test-provider/test-model", "low",
				"frontier", "test-provider/test-model", "high",
			],
		});
		const second = mainHarness({
			availableModels,
			limitInput: "4",
			selectResults: ["fast", undefined, "balanced", "test-provider/test-model", "medium"],
		});
		await first.handlers.get("session_start")?.({}, first.ctx);
		await second.handlers.get("session_start")?.({}, second.ctx);

		await first.commands.get("subagent-model")!.handler("", first.ctx);
		await second.commands.get("subagent-limit")!.handler("", second.ctx);
		await second.commands.get("subagent-model")!.handler("", second.ctx);
		await second.commands.get("subagent-model")!.handler("", second.ctx);
		await first.commands.get("subagent-model")!.handler("", first.ctx);
		await first.commands.get("subagent-limit")!.handler("", first.ctx);
		assert.deepEqual(JSON.parse(await readFile(join(agentDir, "config", "pi-herdr-subagents.json"), "utf8")), {
			maxConcurrentSubagents: 4,
			models: {
				fast: { model: "test-provider/test-model", thinkingLevel: "low" },
				balanced: { model: "test-provider/test-model", thinkingLevel: "medium" },
				frontier: { model: "test-provider/test-model", thinkingLevel: "high" },
			},
		});
	});
	await rm(agentDir, { recursive: true, force: true });
});

test("config mutation preserves existing POSIX file permissions", async (t) => {
	if (process.platform === "win32") return t.skip("POSIX file modes are unavailable");
	const agentDir = await mkdtemp(join(tmpdir(), "pi-herdr-subagents-config-"));
	const path = join(agentDir, "config", "pi-herdr-subagents.json");
	await withEnvironment({ PI_CODING_AGENT_DIR: agentDir }, async () => {
		await mkdir(join(agentDir, "config"));
		await writeFile(path, JSON.stringify({ maxConcurrentSubagents: 10, models: {} }));
		await chmod(path, 0o600);
		const app = mainHarness({ limitInput: "4" });
		await app.commands.get("subagent-limit")!.handler("", app.ctx);

		assert.equal(JSON.parse(await readFile(path, "utf8")).maxConcurrentSubagents, 4);
		assert.equal((await stat(path)).mode & 0o777, 0o600);
	});
	await rm(agentDir, { recursive: true, force: true });
});

test("config mutation resolves a relative config symlink chain through its symlinked parent", async (t) => {
	if (process.platform === "win32") return t.skip("POSIX symlink and file mode behavior is unavailable");
	const agentDir = await mkdtemp(join(tmpdir(), "pi-herdr-subagents-config-"));
	const path = join(agentDir, "config", "pi-herdr-subagents.json");
	const intermediate = join(agentDir, "storage", "shared", "subagents-link.json");
	const target = join(agentDir, "storage", "data", "subagents.json");
	const linkTarget = "../shared/subagents-link.json";
	const intermediateTarget = "../data/subagents.json";
	await withEnvironment({ PI_CODING_AGENT_DIR: agentDir }, async () => {
		await mkdir(join(agentDir, "storage", "config"), { recursive: true });
		await mkdir(join(agentDir, "storage", "shared"));
		await mkdir(join(agentDir, "storage", "data"));
		await writeFile(target, JSON.stringify({ maxConcurrentSubagents: 10, models: {} }));
		await chmod(target, 0o600);
		await symlink("storage/config", join(agentDir, "config"));
		await symlink(linkTarget, path);
		await symlink(intermediateTarget, intermediate);
		const app = mainHarness({ limitInput: "4" });

		await app.commands.get("subagent-limit")!.handler("", app.ctx);

		assert.equal(JSON.parse(await readFile(target, "utf8")).maxConcurrentSubagents, 4);
	});
	await rm(agentDir, { recursive: true, force: true });
});

test("Subagent Limit recovers a config lock after a reclaimer crashes before rename", async (t) => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-herdr-subagents-config-"));
	const configDir = join(agentDir, "config");
	const path = join(configDir, "pi-herdr-subagents.json");
	const lock = `${path}.lock`;
	let checkedCrashedReclaimer = false;
	await withEnvironment({ PI_CODING_AGENT_DIR: agentDir }, async () => {
		await mkdir(join(lock, `.reclaimer.23456.${"b".repeat(32)}`), { recursive: true });
		await writeFile(join(lock, "owner"), JSON.stringify({ pid: 12345, token: "a".repeat(32) }));
		t.mock.method(process, "kill", (pid: number, signal?: number | NodeJS.Signals) => {
			assert.ok(pid === 12345 || pid === 23456);
			assert.equal(signal, 0);
			if (pid === 23456) checkedCrashedReclaimer = true;
			throw Object.assign(new Error("dead"), { code: "ESRCH" });
		});
		const app = mainHarness({ limitInput: "4" });

		await app.commands.get("subagent-limit")!.handler("", app.ctx);

		assert.equal(checkedCrashedReclaimer, true);
		assert.equal(JSON.parse(await readFile(path, "utf8")).maxConcurrentSubagents, 4);
	});
	await rm(agentDir, { recursive: true, force: true });
});

test("Subagent Limit fails busy for malformed, live, and EPERM config-lock owners", async (t) => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-herdr-subagents-config-"));
	const path = join(agentDir, "config", "pi-herdr-subagents.json");
	const lock = `${path}.lock`;
	let now = 0;
	t.mock.method(Date, "now", () => now += 1_000);
	t.mock.method(process, "kill", (pid: number, signal?: number | NodeJS.Signals) => {
		assert.equal(signal, 0);
		if (pid === 23456) throw Object.assign(new Error("not permitted"), { code: "EPERM" });
		assert.equal(pid, 12345);
	});
	await withEnvironment({ PI_CODING_AGENT_DIR: agentDir }, async () => {
		for (const owner of [
			"12345",
			JSON.stringify({ pid: 12345, token: "a".repeat(32) }),
			JSON.stringify({ pid: 23456, token: "b".repeat(32) }),
		]) {
			await mkdir(lock, { recursive: true });
			await writeFile(join(lock, "owner"), owner);
			const app = mainHarness({ limitInput: "4" });

			await app.commands.get("subagent-limit")!.handler("", app.ctx);

			assert.deepEqual(app.notices, ["Subagent config is busy; try again."]);
			await rm(lock, { recursive: true, force: true });
		}
	});
	await rm(agentDir, { recursive: true, force: true });
});

test("concurrent config commands retain independent updates and valid JSON", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-herdr-subagents-config-"));
	await withEnvironment({ PI_CODING_AGENT_DIR: agentDir }, async () => {
		const availableModels: TestModel[] = [{ ...model, input: ["text"] }];
		const first = mainHarness({
			availableModels,
			selectResults: ["fast", "test-provider/test-model", "low"],
		});
		const second = mainHarness({
			availableModels,
			selectResults: ["balanced", "test-provider/test-model", "high"],
		});
		await first.handlers.get("session_start")?.({}, first.ctx);
		await second.handlers.get("session_start")?.({}, second.ctx);

		await Promise.all([
			first.commands.get("subagent-model")!.handler("", first.ctx),
			second.commands.get("subagent-model")!.handler("", second.ctx),
		]);

		assert.deepEqual(JSON.parse(await readFile(join(agentDir, "config", "pi-herdr-subagents.json"), "utf8")), {
			maxConcurrentSubagents: 10,
			models: {
				fast: { model: "test-provider/test-model", thinkingLevel: "low" },
				balanced: { model: "test-provider/test-model", thinkingLevel: "high" },
			},
		});
	});
	await rm(agentDir, { recursive: true, force: true });
});

test("delegate_task rejects stale explicit routes and falls back from stale implicit balanced route", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-herdr-subagents-models-"));
	await withEnvironment({ HERDR_ENV: "1", HERDR_WORKSPACE_ID: "workspace-1", HERDR_PANE_ID: "main-pane", PI_CODING_AGENT_DIR: agentDir }, async () => {
		const availableModels: TestModel[] = [{ ...model, input: ["text"] }];
		const app = mainHarness({ availableModels, selectResults: ["balanced", "test-provider/test-model", "low"] });
		await app.handlers.get("session_start")?.({}, app.ctx);
		await assert.rejects(
			app.tools.get("delegate_task")!.execute("missing", { task: "simple", modelClass: "balanced" }, undefined, undefined, app.ctx),
			/No balanced Subagent model configured/,
		);
		await app.commands.get("subagent-model")!.handler("", app.ctx);
		availableModels[0].thinkingLevelMap = { low: null };
		await assert.rejects(
			app.tools.get("delegate_task")!.execute("stale-thinking", { task: "simple", modelClass: "balanced" }, undefined, undefined, app.ctx),
			/Configured balanced Subagent thinking level is unavailable/,
		);
		const thinkingFallback = await app.tools.get("delegate_task")!.execute("thinking-fallback", { task: "simple" }, undefined, undefined, app.ctx);
		assert.match(thinkingFallback.content[0].text, /^Model: test-provider\/test-model \(Main\)$/m);

		availableModels.length = 0;
		const reloaded = mainHarness({ availableModels });
		await reloaded.handlers.get("session_start")?.({}, reloaded.ctx);
		await assert.rejects(
			reloaded.tools.get("delegate_task")!.execute("stale-model", { task: "simple", modelClass: "balanced" }, undefined, undefined, reloaded.ctx),
			/Configured balanced Subagent model is unavailable/,
		);
		const modelFallback = await reloaded.tools.get("delegate_task")!.execute("model-fallback", { task: "simple" }, undefined, undefined, reloaded.ctx);
		assert.match(modelFallback.content[0].text, /^Model: test-provider\/test-model \(Main\)$/m);
	});
	await rm(agentDir, { recursive: true, force: true });
});

test("session start refreshes stale model metadata", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-herdr-subagents-models-"));
	await withEnvironment({ HERDR_ENV: "1", HERDR_WORKSPACE_ID: "workspace-1", HERDR_PANE_ID: "main-pane", PI_CODING_AGENT_DIR: agentDir }, async () => {
		await mkdir(join(agentDir, "config"));
		await writeFile(join(agentDir, "config", "pi-herdr-subagents.json"), JSON.stringify({
			maxConcurrentSubagents: 10,
			models: { fast: { model: "test-provider/test-model", thinkingLevel: "max" } },
		}));
		const availableModels: TestModel[] = [{ ...model, input: ["text"], thinkingLevelMap: { high: "high" } }];
		const app = mainHarness({
			availableModels,
			onModelRegistryRefresh: () => { availableModels[0].thinkingLevelMap = { max: "max" }; },
		});
		await app.handlers.get("session_start")?.({}, app.ctx);
		const delegated = await app.tools.get("delegate_task")!.execute("fast", { task: "use refreshed route", modelClass: "fast" }, undefined, undefined, app.ctx);
		assert.match(delegated.content[0].text, /^Model: test-provider\/test-model \(fast\)$/m);
		assert.match(delegated.content[0].text, /^Thinking: max$/m);
	});
	await rm(agentDir, { recursive: true, force: true });
});

test("untrusted Main launches Subagent without approval or thinking", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-herdr-subagents-agent-"));
	await withEnvironment({ HERDR_ENV: "1", HERDR_WORKSPACE_ID: "workspace-1", HERDR_PANE_ID: "main-pane", PI_CODING_AGENT_DIR: agentDir }, async () => {
		const app = mainHarness({ mainName: "main_existing", thinkingLevel: undefined, trusted: false });
		await app.handlers.get("session_start")?.({}, app.ctx);
		await app.tools.get("delegate_task")!.execute("call", { task: "exact task prompt" }, undefined, undefined, app.ctx);
		const started = app.calls.find((args) => args[0] === "agent" && args[1] === "start")!;
		assert.equal(started.includes("--thinking"), false);
		assert.equal(started.at(-1), "--no-approve");
	});
	await rm(agentDir, { recursive: true, force: true });
});

test("valid tab ID rolls back when later created identity is malformed", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-herdr-subagents-agent-"));
	await withEnvironment({ HERDR_ENV: "1", HERDR_WORKSPACE_ID: "workspace-1", HERDR_PANE_ID: "main-pane", PI_CODING_AGENT_DIR: agentDir }, async () => {
		const app = mainHarness({ malformedCreatedIdentity: true });
		await assert.rejects(app.tools.get("delegate_task")!.execute("call", { task: "bad identity" }, undefined, undefined, app.ctx), /identity/);
		assert.deepEqual(app.closed, ["tab-1"]);
	});
	await rm(agentDir, { recursive: true, force: true });
});

test("indeterminate tab creation closes newly provisioned tab", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-herdr-subagents-agent-"));
	await withEnvironment({ HERDR_ENV: "1", HERDR_WORKSPACE_ID: "workspace-1", HERDR_PANE_ID: "main-pane", PI_CODING_AGENT_DIR: agentDir }, async () => {
		const app = mainHarness({ tabCreateFailureAfterCreation: true });
		await assert.rejects(app.tools.get("delegate_task")!.execute("call", { task: "lost creation response" }, undefined, undefined, app.ctx), /herdr tab create failed/);
		assert.deepEqual(app.closed, ["tab-1"]);
	});
	await rm(agentDir, { recursive: true, force: true });
});

test("failed reconciliation preserves indeterminate tab provisioning", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-herdr-subagents-agent-"));
	await withEnvironment({ HERDR_ENV: "1", HERDR_WORKSPACE_ID: "workspace-1", HERDR_PANE_ID: "main-pane", PI_CODING_AGENT_DIR: agentDir }, async () => {
		const app = mainHarness({ limitInput: "1", tabCreateFailureAfterCreation: true, listFailuresAfterCreate: 1 });
		await app.commands.get("subagent-limit")!.handler("", app.ctx);
		await assert.rejects(
			app.tools.get("delegate_task")!.execute("call", { task: "lost creation and list responses" }, undefined, undefined, app.ctx),
			/tab creation outcome and reconciliation also failed; provisioning remains owned[\s\S]*Inspect: herdr tab list --workspace workspace-1/,
		);
		const path = app.calls.find((args) => args[0] === "tab" && args[1] === "create")!.find((arg) => arg.startsWith("PI_HERDR_SUBAGENT_RESULT_PATH="))!.slice("PI_HERDR_SUBAGENT_RESULT_PATH=".length);
		assert.ok(parsePendingResult(JSON.parse(await readFile(path, "utf8"))));
		await app.handlers.get("session_shutdown")?.({}, app.ctx);
		assert.deepEqual(app.closed, ["tab-1"]);
	});
	await rm(agentDir, { recursive: true, force: true });
});

test("invalid config falls back to default Subagent Limit", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-herdr-subagents-config-"));
	await withEnvironment({ HERDR_ENV: "1", HERDR_WORKSPACE_ID: "workspace-1", HERDR_PANE_ID: "main-pane", PI_CODING_AGENT_DIR: agentDir }, async () => {
		await mkdir(join(agentDir, "config"));
		await writeFile(join(agentDir, "config", "pi-herdr-subagents.json"), "{broken");
		const app = mainHarness();
		await app.handlers.get("session_start")?.({}, app.ctx);
		assert.ok(app.notices.length);
		for (let index = 0; index < 10; index++) await app.tools.get("delegate_task")!.execute(String(index), { task: `task ${index}` }, undefined, undefined, app.ctx);
		await assert.rejects(app.tools.get("delegate_task")!.execute("limit", { task: "blocked" }, undefined, undefined, app.ctx), /Subagent Limit reached \(10\)/);
	});
	await rm(agentDir, { recursive: true, force: true });
});

test("lowered limit leaves live Subagents, then reconciliation frees capacity", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-herdr-subagents-limit-"));
	await withEnvironment({ HERDR_ENV: "1", HERDR_WORKSPACE_ID: "workspace-1", HERDR_PANE_ID: "main-pane", PI_CODING_AGENT_DIR: agentDir }, async () => {
		const app = mainHarness({ limitInput: "2" });
		await app.commands.get("subagent-limit")!.handler("", app.ctx);
		await app.tools.get("delegate_task")!.execute("1", { task: "first live" }, undefined, undefined, app.ctx);
		await app.tools.get("delegate_task")!.execute("2", { task: "second live" }, undefined, undefined, app.ctx);
		app.setLimitInput("1");
		await app.commands.get("subagent-limit")!.handler("", app.ctx);
		await assert.rejects(app.tools.get("delegate_task")!.execute("3", { task: "blocked" }, undefined, undefined, app.ctx), /Subagent Limit reached \(1\)/);
		app.setTabPresent(false);
		await app.tools.get("delegate_task")!.execute("4", { task: "after reconciliation" }, undefined, undefined, app.ctx);
	});
	await rm(agentDir, { recursive: true, force: true });
});

test("malformed tab entries cannot prune Subagent ownership", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-herdr-subagents-agent-"));
	let malformed = false;
	await withEnvironment({ HERDR_ENV: "1", HERDR_WORKSPACE_ID: "workspace-1", HERDR_PANE_ID: "main-pane", PI_CODING_AGENT_DIR: agentDir }, async () => {
		const app = mainHarness({ limitInput: "1", malformedTabs: () => malformed });
		await app.commands.get("subagent-limit")!.handler("", app.ctx);
		await app.tools.get("delegate_task")!.execute("first", { task: "owned task" }, undefined, undefined, app.ctx);
		malformed = true;
		await assert.rejects(app.tools.get("delegate_task")!.execute("malformed", { task: "must not start" }, undefined, undefined, app.ctx), /Herdr tab list entry 1 workspace is invalid/);
		malformed = false;
		await assert.rejects(app.tools.get("delegate_task")!.execute("capacity", { task: "still blocked" }, undefined, undefined, app.ctx), /Subagent Limit reached/);
		await app.handlers.get("session_shutdown")?.({}, app.ctx);
		assert.deepEqual(app.closed, ["tab-1"]);
	});
	await rm(agentDir, { recursive: true, force: true });
});

test("completion releases capacity once and shutdown closes remaining Subagent", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-herdr-subagents-cleanup-"));
	await withEnvironment({ HERDR_ENV: "1", HERDR_WORKSPACE_ID: "workspace-1", HERDR_PANE_ID: "main-pane", PI_CODING_AGENT_DIR: agentDir }, async () => {
		const app = mainHarness({ limitInput: "1" });
		await app.commands.get("subagent-limit")!.handler("", app.ctx);
		const first = await app.tools.get("delegate_task")!.execute("1", { task: "first" }, undefined, undefined, app.ctx);
		const firstPath = (first.content[0].text as string).match(/^Result: (.+)$/m)![1];
		const firstPending = JSON.parse(await readFile(firstPath, "utf8"));
		const firstTerminal = { version: PROTOCOL_VERSION, taskId: firstPending.taskId, state: "finished", task: firstPending.task, result: "done", error: null, createdAt: firstPending.createdAt, finishedAt: "2026-08-10T00:01:00.000Z" } as const;
		await writeFile(firstPath, JSON.stringify(firstTerminal));
		const notice = completionNotice(firstPath, firstTerminal.taskId);
		const input = app.handlers.get("input")!;
		const results = await Promise.all([
			input({ source: "interactive", text: notice }, app.ctx),
			input({ source: "interactive", text: notice }, app.ctx),
		]);
		assert.equal(results.filter((result) => result.action === "transform").length, 1);
		assert.equal(results.filter((result) => result.action === "continue").length, 1);
		assert.equal(app.closed.length, 0);
		await app.tools.get("delegate_task")!.execute("2", { task: "second" }, undefined, undefined, app.ctx);
		await app.handlers.get("session_shutdown")?.({}, app.ctx);
		assert.deepEqual(app.closed, ["tab-1", "tab-1"]);
	});
	await rm(agentDir, { recursive: true, force: true });
});

test("Main accepts merged parallel Completion Notices atomically", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-herdr-subagents-merged-"));
	await withEnvironment({ HERDR_ENV: "1", HERDR_WORKSPACE_ID: "workspace-1", HERDR_PANE_ID: "main-pane", PI_CODING_AGENT_DIR: agentDir }, async () => {
		const app = mainHarness({ limitInput: "1" });
		const delegated = [
			await app.tools.get("delegate_task")!.execute("1", { task: "first parallel task" }, undefined, undefined, app.ctx),
			await app.tools.get("delegate_task")!.execute("2", { task: "second parallel task" }, undefined, undefined, app.ctx),
		];
		const terminals = await Promise.all(delegated.map(async (item, index) => {
			const path = (item.content[0].text as string).match(/^Result: (.+)$/m)![1];
			const pending = JSON.parse(await readFile(path, "utf8"));
			const terminal = { version: PROTOCOL_VERSION, taskId: pending.taskId, state: "finished", task: pending.task, result: `done ${index + 1}`, error: null, createdAt: pending.createdAt, finishedAt: "2026-08-10T00:01:00.000Z" } as const;
			await writeFile(path, JSON.stringify(terminal));
			return { path, terminal };
		}));
		const inputHandler = app.handlers.get("input")!;
		const invalid = `${completionNotice(terminals[0].path, terminals[0].terminal.taskId)}${completionNotice("/tmp/not-owned.json", terminals[1].terminal.taskId)}`;
		assert.deepEqual(await inputHandler({ source: "interactive", text: invalid }, app.ctx), { action: "continue" });
		const duplicate = `${completionNotice(terminals[0].path, terminals[0].terminal.taskId)}${completionNotice(terminals[0].path, terminals[0].terminal.taskId)}`;
		assert.deepEqual(await inputHandler({ source: "interactive", text: duplicate }, app.ctx), { action: "continue" });
		const merged = terminals.map(({ path, terminal }) => completionNotice(path, terminal.taskId)).join("");
		const input = await inputHandler({ source: "interactive", text: merged }, app.ctx);
		assert.equal(input.action, "transform");
		for (const { terminal } of terminals) assert.match(input.text, new RegExp(terminal.taskId));
		await app.commands.get("subagent-limit")!.handler("", app.ctx);
		await app.tools.get("delegate_task")!.execute("3", { task: "capacity was released" }, undefined, undefined, app.ctx);
	});
	await rm(agentDir, { recursive: true, force: true });
});

test("Main rejects invalid launch input and reconciles closed tabs", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-herdr-subagents-agent-"));
	await withEnvironment({ HERDR_ENV: undefined, HERDR_WORKSPACE_ID: undefined, HERDR_PANE_ID: undefined, PI_CODING_AGENT_DIR: agentDir }, async () => {
		const unavailable = mainHarness();
		await assert.rejects(unavailable.tools.get("delegate_task")!.execute("x", { task: "task" }, undefined, undefined, unavailable.ctx), /requires Herdr/);
	});
	await withEnvironment({ HERDR_ENV: "1", HERDR_WORKSPACE_ID: "workspace-1", HERDR_PANE_ID: "main-pane", PI_CODING_AGENT_DIR: agentDir }, async () => {
		const noModel = mainHarness({ noModel: true });
		await assert.rejects(noModel.tools.get("delegate_task")!.execute("x", { task: "task" }, undefined, undefined, noModel.ctx), /active Pi model/);
		const app = mainHarness({ limitInput: "1" });
		await assert.rejects(app.tools.get("delegate_task")!.execute("x", { task: "  " }, undefined, undefined, app.ctx), /blank/);
		await assert.rejects(app.tools.get("delegate_task")!.execute("x", { task: "bad\0task" }, undefined, undefined, app.ctx), /delegate_task task must not contain NUL bytes/);
		await app.commands.get("subagent-limit")!.handler("", app.ctx);
		await app.tools.get("delegate_task")!.execute("x", { task: "first" }, undefined, undefined, app.ctx);
		await assert.rejects(app.tools.get("delegate_task")!.execute("y", { task: "second" }, undefined, undefined, app.ctx), /Subagent Limit reached/);
		app.setTabPresent(false);
		await app.tools.get("delegate_task")!.execute("z", { task: "reconciled" }, undefined, undefined, app.ctx);
		const stale = await app.handlers.get("input")?.({ source: "interactive", text: "PI_HERDR_SUBAGENT_COMPLETION_V1 bad\n" }, app.ctx);
		assert.deepEqual(stale, { action: "continue" });
	});
	await rm(agentDir, { recursive: true, force: true });
});

test("definitive prompt failure rolls back tab and Result", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-herdr-subagents-agent-"));
	await withEnvironment({ HERDR_ENV: "1", HERDR_WORKSPACE_ID: "workspace-1", HERDR_PANE_ID: "main-pane", PI_CODING_AGENT_DIR: agentDir }, async () => {
		const app = mainHarness({ limitInput: "2", promptFailure: true });
		await assert.rejects(app.tools.get("delegate_task")!.execute("call", { task: "fails before submit" }, undefined, undefined, app.ctx), /agent prompt failed/);
		assert.deepEqual(app.closed, ["tab-1"]);
		const path = app.calls.find((args) => args[0] === "tab" && args[1] === "create")!.find((arg) => arg.startsWith("PI_HERDR_SUBAGENT_RESULT_PATH="))!.slice("PI_HERDR_SUBAGENT_RESULT_PATH=".length);
		await assert.rejects(readFile(path));
	});
	await rm(agentDir, { recursive: true, force: true });
});

test("rollback close failure preserves owned Subagent and Result", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-herdr-subagents-agent-"));
	await withEnvironment({ HERDR_ENV: "1", HERDR_WORKSPACE_ID: "workspace-1", HERDR_PANE_ID: "main-pane", PI_CODING_AGENT_DIR: agentDir }, async () => {
		const app = mainHarness({ limitInput: "1", promptFailure: true, closeFailures: 1 });
		await app.commands.get("subagent-limit")!.handler("", app.ctx);
		await assert.rejects(
			app.tools.get("delegate_task")!.execute("call", { task: "definitive prompt failure" }, undefined, undefined, app.ctx),
			/launch failed and Subagent tab cleanup also failed; Subagent remains owned[\s\S]*Tab: tab-1[\s\S]*Stop: herdr tab close tab-1/,
		);
		const path = app.calls.find((args) => args[0] === "tab" && args[1] === "create")!.find((arg) => arg.startsWith("PI_HERDR_SUBAGENT_RESULT_PATH="))!.slice("PI_HERDR_SUBAGENT_RESULT_PATH=".length);
		assert.ok(parsePendingResult(JSON.parse(await readFile(path, "utf8"))));
		await assert.rejects(app.tools.get("delegate_task")!.execute("retry", { task: "must stay blocked" }, undefined, undefined, app.ctx), /Subagent Limit reached/);
		await app.handlers.get("session_shutdown")?.({}, app.ctx);
		assert.deepEqual(app.closed, ["tab-1"]);
	});
	await rm(agentDir, { recursive: true, force: true });
});

test("pre-aborted task submission rolls back Subagent and Result", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-herdr-subagents-agent-"));
	await withEnvironment({ HERDR_ENV: "1", HERDR_WORKSPACE_ID: "workspace-1", HERDR_PANE_ID: "main-pane", PI_CODING_AGENT_DIR: agentDir }, async () => {
		const controller = new AbortController();
		const app = mainHarness({ abortAfterStart: controller });
		await assert.rejects(
			app.tools.get("delegate_task")!.execute("call", { task: "cancel before prompt" }, controller.signal, undefined, app.ctx),
			/aborted before task submission/,
		);
		assert.deepEqual(app.closed, ["tab-1"]);
		assert.equal(app.calls.some((args) => args[0] === "agent" && args[1] === "prompt"), false);
		const path = app.calls.find((args) => args[0] === "tab" && args[1] === "create")!.find((arg) => arg.startsWith("PI_HERDR_SUBAGENT_RESULT_PATH="))!.slice("PI_HERDR_SUBAGENT_RESULT_PATH=".length);
		await assert.rejects(readFile(path));
	});
	await rm(agentDir, { recursive: true, force: true });
});

test("indeterminate task submission preserves owned Subagent and Result", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-herdr-subagents-agent-"));
	await withEnvironment({ HERDR_ENV: "1", HERDR_WORKSPACE_ID: "workspace-1", HERDR_PANE_ID: "main-pane", PI_CODING_AGENT_DIR: agentDir }, async () => {
		const app = mainHarness({ limitInput: "1", promptIndeterminate: true });
		await app.commands.get("subagent-limit")!.handler("", app.ctx);
		await assert.rejects(
			app.tools.get("delegate_task")!.execute("call", { task: "possibly accepted" }, undefined, undefined, app.ctx),
			/prompt outcome is unknown; Subagent may be running and remains owned[\s\S]*Tab: tab-1/,
		);
		assert.deepEqual(app.closed, []);
		const path = app.calls.find((args) => args[0] === "tab" && args[1] === "create")!.find((arg) => arg.startsWith("PI_HERDR_SUBAGENT_RESULT_PATH="))!.slice("PI_HERDR_SUBAGENT_RESULT_PATH=".length);
		const pending = parsePendingResult(JSON.parse(await readFile(path, "utf8")));
		assert.ok(pending);
		await assert.rejects(app.tools.get("delegate_task")!.execute("retry", { task: "must not duplicate" }, undefined, undefined, app.ctx), /Subagent Limit reached/);

		const terminal = { version: PROTOCOL_VERSION, taskId: pending.taskId, state: "finished", task: pending.task, result: "completed", error: null, createdAt: pending.createdAt, finishedAt: "2026-08-10T00:01:00.000Z" } as const;
		await writeFile(path, JSON.stringify(terminal));
		const input = await app.handlers.get("input")?.({ source: "interactive", text: completionNotice(path, terminal.taskId) }, app.ctx);
		assert.equal(input.action, "transform");
		assert.deepEqual(app.closed, []);
	});
	await rm(agentDir, { recursive: true, force: true });
});

test("Protocol rejects malformed, extra, old-version, and control input", () => {
	const terminal = {
		version: PROTOCOL_VERSION, taskId: "123e4567-e89b-42d3-a456-426614174000", state: "failed", task: "task", result: null,
		error: { stopReason: "error", message: "bad" }, createdAt: "2026-08-10T00:00:00.000Z", finishedAt: "2026-08-10T00:01:00.000Z",
	} as const;
	assert.ok(parseTerminalResult(terminal));
	assert.equal(parseTerminalResult({ ...terminal, extra: true }), undefined);
	const raw = completionNotice("/tmp/result.json", terminal.taskId);
	assert.deepEqual(parseCompletionNotice(raw), { version: PROTOCOL_VERSION, taskId: terminal.taskId, resultPath: "/tmp/result.json" });
	assert.deepEqual(parseCompletionNotices(`${raw}${raw}`), [parseCompletionNotice(raw), parseCompletionNotice(raw)]);
	for (const malformed of ["bad", `${raw}\n`, `${raw.slice(0, -1)}!`]) assert.equal(parseCompletionNotice(malformed), undefined);
	for (const malformed of [` ${raw}`, `${raw} ${raw}`, `${raw}\n${raw}`, `${raw}x${raw}`]) assert.equal(parseCompletionNotices(malformed), undefined);
	for (const value of [
		{ version: PROTOCOL_VERSION, taskId: terminal.taskId, resultPath: "/tmp/result.json", excerpt: "old field" },
		{ version: 1, taskId: terminal.taskId, resultPath: "/tmp/result.json" },
		{ version: PROTOCOL_VERSION, taskId: terminal.taskId, resultPath: "/tmp/bad\u0000path" },
	]) {
		assert.equal(parseCompletionNotice(`PI_HERDR_SUBAGENT_COMPLETION_V2 ${Buffer.from(JSON.stringify(value)).toString("base64url")}`), undefined);
	}
});

test("Subagent sole finish atomically stores Result, waits, then sends one notice", async () => {
	const pending = await pendingFile();
	await withEnvironment({
		PI_HERDR_SUBAGENT_PROTOCOL: String(PROTOCOL_VERSION), PI_HERDR_SUBAGENT_TASK_ID: pending.taskId,
		PI_HERDR_SUBAGENT_RESULT_PATH: pending.path, PI_HERDR_SUBAGENT_MAIN: "main_deadbeef",
	}, async () => {
		const app = subagentHarness({ branch: [{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "finish-1", name: "finish_task" }] } }] });
		await subagentExtension(app.api);
		assert.ok(app.tools.has("finish_task"));
		const result = await app.tools.get("finish_task")!.execute("finish-1", { result: "complete" }, undefined, undefined, app.ctx);
		assert.equal(result.terminate, true);
		const stored = parseTerminalResult(JSON.parse(await readFile(pending.path, "utf8")));
		assert.equal(stored?.state, "finished");
		assert.deepEqual(parseCompletionNotice(app.calls[1][3]), { version: PROTOCOL_VERSION, taskId: pending.taskId, resultPath: pending.path });
	});
	await rm(pending.dir, { recursive: true, force: true });
});

test("Subagent notifies Main after aborted settlement without reusing aborted signal", async () => {
	const pending = await pendingFile();
	await withEnvironment({
		PI_HERDR_SUBAGENT_PROTOCOL: String(PROTOCOL_VERSION), PI_HERDR_SUBAGENT_TASK_ID: pending.taskId,
		PI_HERDR_SUBAGENT_RESULT_PATH: pending.path, PI_HERDR_SUBAGENT_MAIN: "main_deadbeef",
	}, async () => {
		const app = subagentHarness({ branch: [{ type: "message", message: { role: "assistant", stopReason: "aborted", content: [] } }] });
		await subagentExtension(app.api);
		(app.ctx as any).signal = AbortSignal.abort();
		await app.handlers.get("agent_settled")?.({}, app.ctx);
		const stored = parseTerminalResult(JSON.parse(await readFile(pending.path, "utf8")));
		assert.deepEqual(stored?.error, { stopReason: "aborted", message: "aborted" });
	});
	await rm(pending.dir, { recursive: true, force: true });
});

test("Subagent rejects mixed finish, latches duplicates, preserves failed delivery, and terminal-errors only", async () => {
	const pending = await pendingFile();
	await withEnvironment({
		PI_HERDR_SUBAGENT_PROTOCOL: String(PROTOCOL_VERSION), PI_HERDR_SUBAGENT_TASK_ID: pending.taskId,
		PI_HERDR_SUBAGENT_RESULT_PATH: pending.path, PI_HERDR_SUBAGENT_MAIN: "main_deadbeef",
	}, async () => {
		let releaseWait!: () => void;
		let waitStarted!: () => void;
		const waiting = new Promise<void>((resolve) => { releaseWait = resolve; });
		const started = new Promise<void>((resolve) => { waitStarted = resolve; });
		const app = subagentHarness({
			branch: [{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "finish-1", name: "finish_task" }] } }],
			wait: async () => { waitStarted(); await waiting; return success(JSON.stringify({ result: { type: "agent_info", agent: { agent_status: "idle" } } })); },
		});
		await subagentExtension(app.api);
		const first = app.tools.get("finish_task")!.execute("finish-1", { result: "complete" }, undefined, undefined, app.ctx);
		await started;
		await assert.rejects(app.tools.get("finish_task")!.execute("finish-1", { result: "again" }, undefined, undefined, app.ctx), /already terminal/);
		releaseWait();
		await first;
		assert.equal((parseTerminalResult(JSON.parse(await readFile(pending.path, "utf8")))?.state), "finished");
	});
	await rm(pending.dir, { recursive: true, force: true });

	const mixed = await pendingFile();
	await withEnvironment({ PI_HERDR_SUBAGENT_PROTOCOL: String(PROTOCOL_VERSION), PI_HERDR_SUBAGENT_TASK_ID: mixed.taskId, PI_HERDR_SUBAGENT_RESULT_PATH: mixed.path, PI_HERDR_SUBAGENT_MAIN: "main_deadbeef" }, async () => {
		const app = subagentHarness({ branch: [{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "finish-1", name: "finish_task" }, { type: "toolCall", id: "edit-1", name: "edit" }] } }] });
		await subagentExtension(app.api);
		await assert.rejects(app.tools.get("finish_task")!.execute("finish-1", { result: "no" }, undefined, undefined, app.ctx), /sole tool/);
		assert.ok(parsePendingResult(JSON.parse(await readFile(mixed.path, "utf8"))));
		app.setBranch([{ type: "message", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Need user answer" }] } }]);
		await app.handlers.get("agent_settled")?.({}, app.ctx);
		assert.ok(parsePendingResult(JSON.parse(await readFile(mixed.path, "utf8"))));
		app.setBranch([{ type: "message", message: { role: "assistant", stopReason: "toolUse", errorMessage: "tool fail", content: [] } }]);
		await app.handlers.get("agent_settled")?.({}, app.ctx);
		assert.ok(parsePendingResult(JSON.parse(await readFile(mixed.path, "utf8"))));
		app.setBranch([{ type: "message", message: { role: "assistant", stopReason: "error", content: [] } }]);
		await app.handlers.get("agent_settled")?.({}, app.ctx);
		const failureResult = parseTerminalResult(JSON.parse(await readFile(mixed.path, "utf8")));
		assert.deepEqual(failureResult?.error, { stopReason: "error", message: "error" });
	});
	await rm(mixed.dir, { recursive: true, force: true });

	const undelivered = await pendingFile();
	await withEnvironment({ PI_HERDR_SUBAGENT_PROTOCOL: String(PROTOCOL_VERSION), PI_HERDR_SUBAGENT_TASK_ID: undelivered.taskId, PI_HERDR_SUBAGENT_RESULT_PATH: undelivered.path, PI_HERDR_SUBAGENT_MAIN: "main_deadbeef" }, async () => {
		const app = subagentHarness({ branch: [{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "finish-1", name: "finish_task" }] } }], promptFailure: true });
		await subagentExtension(app.api);
		await assert.rejects(app.tools.get("finish_task")!.execute("finish-1", { result: "durable" }, undefined, undefined, app.ctx), /agent prompt failed/);
		assert.equal(parseTerminalResult(JSON.parse(await readFile(undelivered.path, "utf8")))?.state, "finished");
		await assert.rejects(app.tools.get("finish_task")!.execute("finish-1", { result: "again" }, undefined, undefined, app.ctx), /already terminal/);
	});
	await rm(undelivered.dir, { recursive: true, force: true });
});
