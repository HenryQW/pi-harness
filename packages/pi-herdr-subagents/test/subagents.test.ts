import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import subagentsExtension from "../extensions/subagents.ts";
import workerExtension from "../internal/worker.ts";
import {
	completionNotice,
	parseCompletionNotice,
	parseCompletionNotices,
	parsePendingResult,
	parseTerminalResult,
	PROTOCOL_VERSION,
} from "../internal/protocol.ts";

type Handler = (event: any, ctx: ExtensionContext) => any;
type Tool = { executionMode?: string; execute: (...args: any[]) => Promise<any>; parameters: any };
type Command = { handler: (args: string, ctx: ExtensionContext) => Promise<void> };

const success = (stdout: string) => ({ stdout, stderr: "", code: 0, killed: false });
const failure = (code: string) => ({ stdout: "", stderr: JSON.stringify({ error: { code, message: code } }), code: 1, killed: false });
const model = { provider: "test-provider", id: "test-model" };

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
	tabs?: () => boolean;
	noModel?: boolean;
	thinkingLevel?: string;
	trusted?: boolean;
	malformedCreatedIdentity?: boolean;
	tabCreateFailureAfterCreation?: boolean;
	mainName?: string | null;
} = {}) {
	const handlers = new Map<string, Handler>();
	const tools = new Map<string, Tool>();
	const commands = new Map<string, Command>();
	const calls: string[][] = [];
	const notices: string[] = [];
	const closed: string[] = [];
	let limitInput = options.limitInput;
	let mainName: string | null = options.mainName ?? null;
	let tabPresent = !options.tabCreateFailureAfterCreation;
	let tabLabel = "existing";
	let tabId = "tab-1";
	let paneId = "pane-1";
	let workerName = "";
	const cwd = "/work/project";
	const ctx = {
		cwd,
		model: options.noModel ? undefined : model,
		thinkingLevel: Object.hasOwn(options, "thinkingLevel") ? options.thinkingLevel : "high",
		isProjectTrusted: () => options.trusted ?? true,
		sessionManager: { getBranch: () => [] },
		ui: {
			notify: (message: string) => notices.push(message),
			input: async () => limitInput,
		},
	} as unknown as ExtensionContext;
	const api = {
		on(event: string, handler: Handler) { handlers.set(event, handler); },
		registerTool(tool: Tool & { name: string }) { tools.set(tool.name, tool); },
		registerCommand(name: string, command: Command) { commands.set(name, command); },
		exec: async (_command: string, args: string[]) => {
			calls.push(args);
			if (args.some((value) => value.includes("\0"))) throw new TypeError("spawn arguments cannot contain NUL bytes");
			if (args[0] === "tab" && args[1] === "list") {
				return success(JSON.stringify({ result: { type: "tab_list", tabs: tabPresent && (options.tabs?.() ?? true) ? [{ tab_id: tabId, workspace_id: "workspace-1", label: tabLabel }] : [] } }));
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
				workerName = args[2];
				return success(JSON.stringify({ result: { type: "agent_started", agent: { name: workerName, pane_id: paneId, tab_id: tabId, workspace_id: "workspace-1", interactive_ready: true } } }));
			}
			if (args[0] === "agent" && args[1] === "prompt") {
				if (options.promptFailure) return failure("agent_prompt_failed");
				if (options.promptIndeterminate) return { stdout: "", stderr: "", code: 0, killed: true };
				return success(JSON.stringify({ result: { type: "agent_prompted", agent: { name: args[2], pane_id: paneId, tab_id: tabId, workspace_id: "workspace-1" } } }));
			}
			if (args[0] === "tab" && args[1] === "close") {
				closed.push(args[2]);
				tabPresent = false;
				return success(JSON.stringify({ result: { type: "ok" } }));
			}
			throw new Error(`Unhandled Herdr command: ${args.join(" ")}`);
		},
	} as unknown as ExtensionAPI;
	subagentsExtension(api);
	return { api, ctx, handlers, tools, commands, calls, notices, closed, get workerName() { return workerName; }, setLimitInput: (value: string) => { limitInput = value; }, setTabPresent: (value: boolean) => { tabPresent = value; }, set tab(id: string) { tabId = id; }, set pane(id: string) { paneId = id; } };
}

function workerHarness(options: { branch?: any[]; wait?: () => Promise<any>; promptFailure?: boolean } = {}) {
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
	await writeFile(path, `${JSON.stringify({ version: 1, taskId, state: "pending", task, createdAt })}\n`, { mode: 0o600 });
	return { dir, path, taskId, task, createdAt };
}

test("Main registers only bounded public surface and launches exact Worker", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-herdr-subagents-agent-"));
	await withEnvironment({ HERDR_ENV: "1", HERDR_WORKSPACE_ID: "workspace-1", HERDR_PANE_ID: "main-pane", PI_CODING_AGENT_DIR: agentDir }, async () => {
		const app = mainHarness();
		await app.handlers.get("session_start")?.({}, app.ctx);
		assert.deepEqual([...app.tools.keys()], ["delegate_task"]);
		assert.equal(app.tools.get("delegate_task")?.executionMode, "sequential");
		assert.deepEqual([...app.commands.keys()], ["subagent-limit"]);

		const delegated = await app.tools.get("delegate_task")!.execute("call-1", { task: "inspect code and report" }, undefined, undefined, app.ctx);
		const output = delegated.content[0].text as string;
		const resultPath = output.match(/^Result: (.+)$/m)?.[1];
		assert.ok(resultPath);
		assert.match(output, /^Delegated Task [0-9a-f-]+/m);
		assert.match(output, /^Stop: herdr tab close tab-1$/m);
		assert.equal((await stat(resultPath!)).mode & 0o777, 0o600);
		assert.deepEqual(parsePendingResult(JSON.parse(await readFile(resultPath!, "utf8"))), {
			version: 1,
			taskId: output.match(/^Delegated Task (.+)$/m)![1],
			state: "pending",
			task: "inspect code and report",
			createdAt: (JSON.parse(await readFile(resultPath!, "utf8")) as any).createdAt,
		});
		const created = app.calls.find((args) => args[0] === "tab" && args[1] === "create")!;
		assert.ok(created.includes("--no-focus"));
		assert.equal(created[created.indexOf("--cwd") + 1], "/work/project");
		const taskId = output.match(/^Delegated Task (.+)$/m)![1];
		assert.equal(created[created.indexOf("--label") + 1].length <= 40, true);
		assert.equal(created[created.indexOf("--label") + 1].split(" · ")[0].split(/\s+/).length, 4);
		assert.deepEqual(created.filter((value) => value.startsWith("PI_HERDR_SUBAGENT_")), [
			"PI_HERDR_SUBAGENT_PROTOCOL=1",
			`PI_HERDR_SUBAGENT_TASK_ID=${taskId}`,
			`PI_HERDR_SUBAGENT_RESULT_PATH=${resultPath}`,
			`PI_HERDR_SUBAGENT_MAIN=${app.calls.find((args) => args[0] === "agent" && args[1] === "rename")![3]}`,
		]);
		const started = app.calls.find((args) => args[0] === "agent" && args[1] === "start")!;
		assert.equal(app.calls.find((args) => args[0] === "agent" && args[1] === "prompt")?.[3], "inspect code and report");
		assert.deepEqual(started.slice(started.indexOf("--") + 1), [
			"--no-session", "--no-extensions", "--extension", started[started.indexOf("--extension") + 1],
			"--tools", "read,bash,edit,write,finish_task", "--model", "test-provider/test-model", "--thinking", "high", "--approve",
		]);

		const pending = JSON.parse(await readFile(resultPath!, "utf8"));
		const terminal = { version: 1, taskId: pending.taskId, state: "finished", task: pending.task, result: "done\u0000\nnext", error: null, createdAt: pending.createdAt, finishedAt: "2026-08-10T00:01:00.000Z" } as const;
		await writeFile(resultPath!, JSON.stringify(terminal));
		const spoofed = await app.handlers.get("input")?.({ source: "interactive", text: completionNotice("/tmp/not-owned.json", terminal) }, app.ctx);
		assert.deepEqual(spoofed, { action: "continue" });
		const wrongTask = { ...terminal, task: "other task" } as const;
		await writeFile(resultPath!, JSON.stringify(wrongTask));
		assert.deepEqual(await app.handlers.get("input")?.({ source: "interactive", text: completionNotice(resultPath!, wrongTask) }, app.ctx), { action: "continue" });
		const wrongTaskId = { ...terminal, taskId: "123e4567-e89b-42d3-a456-426614174000" } as const;
		await writeFile(resultPath!, JSON.stringify(wrongTaskId));
		assert.deepEqual(await app.handlers.get("input")?.({ source: "interactive", text: completionNotice(resultPath!, wrongTaskId) }, app.ctx), { action: "continue" });
		await writeFile(resultPath!, JSON.stringify({ version: 1, taskId: terminal.taskId, state: "pending", task: terminal.task, createdAt: terminal.createdAt }));
		assert.deepEqual(await app.handlers.get("input")?.({ source: "interactive", text: completionNotice(resultPath!, terminal) }, app.ctx), { action: "continue" });
		await writeFile(resultPath!, JSON.stringify(terminal));
		const wrongExcerpt = completionNotice(resultPath!, { ...terminal, result: "wrong" });
		assert.deepEqual(await app.handlers.get("input")?.({ source: "interactive", text: wrongExcerpt }, app.ctx), { action: "continue" });
		assert.deepEqual(app.closed, []);
		const input = await app.handlers.get("input")?.({ source: "interactive", text: completionNotice(resultPath!, terminal) }, app.ctx);
		assert.equal(input.action, "transform");
		assert.match(input.text, /completed Delegated Task .* \(finished\)/);
		assert.match(input.text, /done\nnext/);
		assert.equal(input.text.includes("\u0000"), false);
		assert.deepEqual(app.closed, ["tab-1"]);
	});
	await rm(agentDir, { recursive: true, force: true });
});

test("launch preserves Main name and passes untrusted no-thinking Worker exactly", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-herdr-subagents-agent-"));
	await withEnvironment({ HERDR_ENV: "1", HERDR_WORKSPACE_ID: "workspace-1", HERDR_PANE_ID: "main-pane", PI_CODING_AGENT_DIR: agentDir }, async () => {
		const app = mainHarness({ mainName: "main_existing", thinkingLevel: undefined, trusted: false });
		await app.handlers.get("session_start")?.({}, app.ctx);
		await app.tools.get("delegate_task")!.execute("call", { task: "exact task prompt" }, undefined, undefined, app.ctx);
		const renamed = app.calls.find((args) => args[0] === "agent" && args[1] === "rename");
		assert.equal(renamed, undefined);
		const started = app.calls.find((args) => args[0] === "agent" && args[1] === "start")!;
		assert.equal(started.includes("--thinking"), false);
		assert.equal(started.at(-1), "--no-approve");
		assert.equal(app.calls.find((args) => args[0] === "agent" && args[1] === "prompt")?.[3], "exact task prompt");
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
		await assert.rejects(app.tools.get("delegate_task")!.execute("call", { task: "lost creation response" }, undefined, undefined, app.ctx), /Herdr tab create failed/);
		assert.deepEqual(app.closed, ["tab-1"]);
		assert.equal(app.calls.filter((args) => args[0] === "tab" && args[1] === "list").length, 2);
		const path = app.calls.find((args) => args[0] === "tab" && args[1] === "create")!.find((arg) => arg.startsWith("PI_HERDR_SUBAGENT_RESULT_PATH="))!.slice("PI_HERDR_SUBAGENT_RESULT_PATH=".length);
		await assert.rejects(readFile(path));
	});
	await rm(agentDir, { recursive: true, force: true });
});

test("missing and invalid config use default Worker Limit", async () => {
	const invalid = ["{broken", "[]", "{}", "{\"maxConcurrentWorkers\":0}", "{\"maxConcurrentWorkers\":-1}", "{\"maxConcurrentWorkers\":1.5}", "{\"maxConcurrentWorkers\":\"10\"}"];
	const cases = [{ contents: undefined, warning: false }, ...invalid.map((contents) => ({ contents, warning: true }))];
	for (const item of cases) {
		const agentDir = await mkdtemp(join(tmpdir(), "pi-herdr-subagents-config-"));
		await withEnvironment({ HERDR_ENV: "1", HERDR_WORKSPACE_ID: "workspace-1", HERDR_PANE_ID: "main-pane", PI_CODING_AGENT_DIR: agentDir }, async () => {
			if (item.contents !== undefined) {
				await mkdir(join(agentDir, "config"));
				await writeFile(join(agentDir, "config", "pi-herdr-subagents.json"), item.contents);
			}
			const app = mainHarness();
			await app.handlers.get("session_start")?.({}, app.ctx);
			assert.equal(app.notices.length, item.warning ? 1 : 0);
			for (let index = 0; index < 10; index++) await app.tools.get("delegate_task")!.execute(String(index), { task: `task ${index}` }, undefined, undefined, app.ctx);
			await assert.rejects(app.tools.get("delegate_task")!.execute("limit", { task: "blocked" }, undefined, undefined, app.ctx), /Worker Limit reached \(10\)/);
		});
		await rm(agentDir, { recursive: true, force: true });
	}
});

test("lowered limit leaves live Workers, then reconciliation frees capacity", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-herdr-subagents-limit-"));
	await withEnvironment({ HERDR_ENV: "1", HERDR_WORKSPACE_ID: "workspace-1", HERDR_PANE_ID: "main-pane", PI_CODING_AGENT_DIR: agentDir }, async () => {
		const app = mainHarness({ limitInput: "2" });
		await app.commands.get("subagent-limit")!.handler("", app.ctx);
		await app.tools.get("delegate_task")!.execute("1", { task: "first live" }, undefined, undefined, app.ctx);
		await app.tools.get("delegate_task")!.execute("2", { task: "second live" }, undefined, undefined, app.ctx);
		app.setLimitInput("1");
		await app.commands.get("subagent-limit")!.handler("", app.ctx);
		assert.deepEqual(app.closed, []);
		await assert.rejects(app.tools.get("delegate_task")!.execute("3", { task: "blocked" }, undefined, undefined, app.ctx), /Worker Limit reached \(1\)/);
		app.setTabPresent(false);
		await app.tools.get("delegate_task")!.execute("4", { task: "after reconciliation" }, undefined, undefined, app.ctx);
	});
	await rm(agentDir, { recursive: true, force: true });
});

test("completion releases capacity once and shutdown closes remaining Worker", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-herdr-subagents-cleanup-"));
	await withEnvironment({ HERDR_ENV: "1", HERDR_WORKSPACE_ID: "workspace-1", HERDR_PANE_ID: "main-pane", PI_CODING_AGENT_DIR: agentDir }, async () => {
		const app = mainHarness({ limitInput: "1" });
		await app.commands.get("subagent-limit")!.handler("", app.ctx);
		const first = await app.tools.get("delegate_task")!.execute("1", { task: "first" }, undefined, undefined, app.ctx);
		const firstPath = (first.content[0].text as string).match(/^Result: (.+)$/m)![1];
		const firstPending = JSON.parse(await readFile(firstPath, "utf8"));
		const firstTerminal = { version: 1, taskId: firstPending.taskId, state: "finished", task: firstPending.task, result: "done", error: null, createdAt: firstPending.createdAt, finishedAt: "2026-08-10T00:01:00.000Z" } as const;
		await writeFile(firstPath, JSON.stringify(firstTerminal));
		const notice = completionNotice(firstPath, firstTerminal);
		const input = app.handlers.get("input")!;
		const results = await Promise.all([
			input({ source: "interactive", text: notice }, app.ctx),
			input({ source: "interactive", text: notice }, app.ctx),
		]);
		assert.equal(results.filter((result) => result.action === "transform").length, 1);
		assert.equal(results.filter((result) => result.action === "continue").length, 1);
		assert.equal(app.closed.length, 1);
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
			const terminal = { version: 1, taskId: pending.taskId, state: "finished", task: pending.task, result: `done ${index + 1}`, error: null, createdAt: pending.createdAt, finishedAt: "2026-08-10T00:01:00.000Z" } as const;
			await writeFile(path, JSON.stringify(terminal));
			return { path, terminal };
		}));
		const inputHandler = app.handlers.get("input")!;
		const invalid = `${completionNotice(terminals[0].path, terminals[0].terminal)}${completionNotice(terminals[1].path, { ...terminals[1].terminal, result: "spoofed" })}`;
		assert.deepEqual(await inputHandler({ source: "interactive", text: invalid }, app.ctx), { action: "continue" });
		assert.deepEqual(app.closed, []);
		const duplicate = `${completionNotice(terminals[0].path, terminals[0].terminal)}${completionNotice(terminals[0].path, terminals[0].terminal)}`;
		assert.deepEqual(await inputHandler({ source: "interactive", text: duplicate }, app.ctx), { action: "continue" });
		assert.deepEqual(app.closed, []);
		const merged = terminals.map(({ path, terminal }) => completionNotice(path, terminal)).join("");
		const input = await inputHandler({ source: "interactive", text: merged }, app.ctx);
		assert.equal(input.action, "transform");
		for (const { terminal } of terminals) assert.match(input.text, new RegExp(terminal.taskId));
		assert.equal(app.closed.length, 2);
		await app.commands.get("subagent-limit")!.handler("", app.ctx);
		await app.tools.get("delegate_task")!.execute("3", { task: "capacity was released" }, undefined, undefined, app.ctx);
	});
	await rm(agentDir, { recursive: true, force: true });
});

test("Main rejects preconditions, Worker Limit, stale notices, then reconciles closed tabs", async () => {
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
		assert.equal(app.calls.length, 0);
		await app.commands.get("subagent-limit")!.handler("", app.ctx);
		const first = await app.tools.get("delegate_task")!.execute("x", { task: "first" }, undefined, undefined, app.ctx);
		await assert.rejects(app.tools.get("delegate_task")!.execute("y", { task: "second" }, undefined, undefined, app.ctx), /Worker Limit reached/);
		app.setTabPresent(false);
		await app.tools.get("delegate_task")!.execute("z", { task: "reconciled" }, undefined, undefined, app.ctx);
		const path = (first.content[0].text as string).match(/^Result: (.+)$/m)![1];
		const stale = await app.handlers.get("input")?.({ source: "interactive", text: "PI_HERDR_SUBAGENT_COMPLETION_V1 bad\n" }, app.ctx);
		assert.deepEqual(stale, { action: "continue" });
		assert.deepEqual(app.closed, []);
		assert.deepEqual(JSON.parse(await readFile(join(agentDir, "config", "pi-herdr-subagents.json"), "utf8")), { maxConcurrentWorkers: 1 });
		assert.ok(path);
	});
	await rm(agentDir, { recursive: true, force: true });
});

test("Worker Limit command persists immediately and pre-submission launch rolls back", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-herdr-subagents-agent-"));
	await withEnvironment({ HERDR_ENV: "1", HERDR_WORKSPACE_ID: "workspace-1", HERDR_PANE_ID: "main-pane", PI_CODING_AGENT_DIR: agentDir }, async () => {
		const app = mainHarness({ limitInput: "2", promptFailure: true });
		await mkdir(join(agentDir, "config"));
		await writeFile(join(agentDir, "config", "pi-herdr-subagents.json"), "{broken");
		await app.handlers.get("session_start")?.({}, app.ctx);
		assert.match(app.notices[0], /Invalid pi-herdr-subagents config/);
		await app.commands.get("subagent-limit")!.handler("", app.ctx);
		assert.deepEqual(JSON.parse(await readFile(join(agentDir, "config", "pi-herdr-subagents.json"), "utf8")), { maxConcurrentWorkers: 2 });
		await assert.rejects(app.tools.get("delegate_task")!.execute("call", { task: "fails before submit" }, undefined, undefined, app.ctx), /agent prompt failed/);
		assert.deepEqual(app.closed, ["tab-1"]);
		const path = app.calls.find((args) => args[0] === "tab" && args[1] === "create")!.find((arg) => arg.startsWith("PI_HERDR_SUBAGENT_RESULT_PATH="))!.slice("PI_HERDR_SUBAGENT_RESULT_PATH=".length);
		await assert.rejects(readFile(path));
	});
	await rm(agentDir, { recursive: true, force: true });
});

test("indeterminate task submission preserves owned Worker and Result", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-herdr-subagents-agent-"));
	await withEnvironment({ HERDR_ENV: "1", HERDR_WORKSPACE_ID: "workspace-1", HERDR_PANE_ID: "main-pane", PI_CODING_AGENT_DIR: agentDir }, async () => {
		const app = mainHarness({ limitInput: "1", promptIndeterminate: true });
		await app.commands.get("subagent-limit")!.handler("", app.ctx);
		await assert.rejects(
			app.tools.get("delegate_task")!.execute("call", { task: "possibly accepted" }, undefined, undefined, app.ctx),
			/prompt outcome is unknown; Worker may be running and remains owned[\s\S]*Tab: tab-1/,
		);
		assert.deepEqual(app.closed, []);
		const path = app.calls.find((args) => args[0] === "tab" && args[1] === "create")!.find((arg) => arg.startsWith("PI_HERDR_SUBAGENT_RESULT_PATH="))!.slice("PI_HERDR_SUBAGENT_RESULT_PATH=".length);
		const pending = parsePendingResult(JSON.parse(await readFile(path, "utf8")));
		assert.ok(pending);
		await assert.rejects(app.tools.get("delegate_task")!.execute("retry", { task: "must not duplicate" }, undefined, undefined, app.ctx), /Worker Limit reached/);

		const terminal = { version: 1, taskId: pending.taskId, state: "finished", task: pending.task, result: "completed", error: null, createdAt: pending.createdAt, finishedAt: "2026-08-10T00:01:00.000Z" } as const;
		await writeFile(path, JSON.stringify(terminal));
		const input = await app.handlers.get("input")?.({ source: "interactive", text: completionNotice(path, terminal) }, app.ctx);
		assert.equal(input.action, "transform");
		assert.deepEqual(app.closed, ["tab-1"]);
	});
	await rm(agentDir, { recursive: true, force: true });
});

test("Protocol rejects malformed, extra, state, path, excerpt, and control input", () => {
	const terminal = {
		version: 1, taskId: "123e4567-e89b-42d3-a456-426614174000", state: "failed", task: "task", result: null,
		error: { stopReason: "error", message: "bad" }, createdAt: "2026-08-10T00:00:00.000Z", finishedAt: "2026-08-10T00:01:00.000Z",
	} as const;
	assert.ok(parseTerminalResult(terminal));
	assert.equal(parseTerminalResult({ ...terminal, extra: true }), undefined);
	const raw = completionNotice("/tmp/result.json", terminal);
	assert.deepEqual(parseCompletionNotice(raw), { version: 1, taskId: terminal.taskId, resultPath: "/tmp/result.json", excerpt: "bad" });
	assert.deepEqual(parseCompletionNotices(`${raw}${raw}`), [parseCompletionNotice(raw), parseCompletionNotice(raw)]);
	for (const malformed of ["bad", `${raw}\n`, `${raw.slice(0, -1)}!`]) assert.equal(parseCompletionNotice(malformed), undefined);
	for (const malformed of [` ${raw}`, `${raw} ${raw}`, `${raw}\n${raw}`, `${raw}x${raw}`]) assert.equal(parseCompletionNotices(malformed), undefined);
	const altered = JSON.stringify({ version: 1, taskId: terminal.taskId, resultPath: "/tmp/result.json", excerpt: "wrong" });
	assert.equal(parseCompletionNotice(`PI_HERDR_SUBAGENT_COMPLETION_V1 ${Buffer.from(altered).toString("base64url")}`)?.excerpt, "wrong");
	const controls = JSON.stringify({ version: 1, taskId: terminal.taskId, resultPath: "/tmp/result.json", excerpt: "bad\u0000" });
	assert.equal(parseCompletionNotice(`PI_HERDR_SUBAGENT_COMPLETION_V1 ${Buffer.from(controls).toString("base64url")}`), undefined);
	const long = { ...terminal, state: "finished", result: "😀".repeat(501), error: null } as const;
	const capped = parseCompletionNotice(completionNotice("/tmp/result.json", long));
	assert.equal(capped?.excerpt.length, 1_000);
	assert.equal(capped?.excerpt, "😀".repeat(500));
});

test("Worker sole finish atomically stores Result, waits, then sends one notice", async () => {
	const pending = await pendingFile();
	await withEnvironment({
		PI_HERDR_SUBAGENT_PROTOCOL: "1", PI_HERDR_SUBAGENT_TASK_ID: pending.taskId,
		PI_HERDR_SUBAGENT_RESULT_PATH: pending.path, PI_HERDR_SUBAGENT_MAIN: "main_deadbeef",
	}, async () => {
		const app = workerHarness({ branch: [{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "finish-1", name: "finish_task" }] } }] });
		await workerExtension(app.api);
		assert.deepEqual([...app.tools.keys()], ["finish_task"]);
		assert.equal(app.tools.get("finish_task")?.executionMode, "sequential");
		const result = await app.tools.get("finish_task")!.execute("finish-1", { result: "complete" }, undefined, undefined, app.ctx);
		assert.equal(result.terminate, true);
		assert.deepEqual(app.calls.map((args) => args.slice(0, 2)), [["agent", "wait"], ["agent", "prompt"]]);
		const stored = parseTerminalResult(JSON.parse(await readFile(pending.path, "utf8")));
		assert.equal(stored?.state, "finished");
		assert.equal((await stat(pending.path)).mode & 0o777, 0o600);
		assert.deepEqual(parseCompletionNotice(app.calls[1][3]), { version: 1, taskId: pending.taskId, resultPath: pending.path, excerpt: "complete" });
	});
	await rm(pending.dir, { recursive: true, force: true });
});

test("Worker notifies Main after aborted settlement without reusing aborted signal", async () => {
	const pending = await pendingFile();
	await withEnvironment({
		PI_HERDR_SUBAGENT_PROTOCOL: "1", PI_HERDR_SUBAGENT_TASK_ID: pending.taskId,
		PI_HERDR_SUBAGENT_RESULT_PATH: pending.path, PI_HERDR_SUBAGENT_MAIN: "main_deadbeef",
	}, async () => {
		const app = workerHarness({ branch: [{ type: "message", message: { role: "assistant", stopReason: "aborted", content: [] } }] });
		await workerExtension(app.api);
		(app.ctx as any).signal = AbortSignal.abort();
		await app.handlers.get("agent_settled")?.({}, app.ctx);
		assert.deepEqual(app.calls.map((args) => args.slice(0, 2)), [["agent", "wait"], ["agent", "prompt"]]);
		const stored = parseTerminalResult(JSON.parse(await readFile(pending.path, "utf8")));
		assert.deepEqual(stored?.error, { stopReason: "aborted", message: "aborted" });
	});
	await rm(pending.dir, { recursive: true, force: true });
});

test("Worker rejects mixed finish, latches duplicates, preserves failed delivery, and terminal-errors only", async () => {
	const pending = await pendingFile();
	await withEnvironment({
		PI_HERDR_SUBAGENT_PROTOCOL: "1", PI_HERDR_SUBAGENT_TASK_ID: pending.taskId,
		PI_HERDR_SUBAGENT_RESULT_PATH: pending.path, PI_HERDR_SUBAGENT_MAIN: "main_deadbeef",
	}, async () => {
		let releaseWait!: () => void;
		let waitStarted!: () => void;
		const waiting = new Promise<void>((resolve) => { releaseWait = resolve; });
		const started = new Promise<void>((resolve) => { waitStarted = resolve; });
		const app = workerHarness({
			branch: [{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "finish-1", name: "finish_task" }] } }],
			wait: async () => { waitStarted(); await waiting; return success(JSON.stringify({ result: { type: "agent_info", agent: { agent_status: "idle" } } })); },
		});
		await workerExtension(app.api);
		const first = app.tools.get("finish_task")!.execute("finish-1", { result: "complete" }, undefined, undefined, app.ctx);
		await started;
		await assert.rejects(app.tools.get("finish_task")!.execute("finish-1", { result: "again" }, undefined, undefined, app.ctx), /already terminal/);
		releaseWait();
		await first;
		assert.equal((parseTerminalResult(JSON.parse(await readFile(pending.path, "utf8")))?.state), "finished");
	});
	await rm(pending.dir, { recursive: true, force: true });

	const mixed = await pendingFile();
	await withEnvironment({ PI_HERDR_SUBAGENT_PROTOCOL: "1", PI_HERDR_SUBAGENT_TASK_ID: mixed.taskId, PI_HERDR_SUBAGENT_RESULT_PATH: mixed.path, PI_HERDR_SUBAGENT_MAIN: "main_deadbeef" }, async () => {
		const app = workerHarness({ branch: [{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "finish-1", name: "finish_task" }, { type: "toolCall", id: "edit-1", name: "edit" }] } }] });
		await workerExtension(app.api);
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
	await withEnvironment({ PI_HERDR_SUBAGENT_PROTOCOL: "1", PI_HERDR_SUBAGENT_TASK_ID: undelivered.taskId, PI_HERDR_SUBAGENT_RESULT_PATH: undelivered.path, PI_HERDR_SUBAGENT_MAIN: "main_deadbeef" }, async () => {
		const app = workerHarness({ branch: [{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "finish-1", name: "finish_task" }] } }], promptFailure: true });
		await workerExtension(app.api);
		await assert.rejects(app.tools.get("finish_task")!.execute("finish-1", { result: "durable" }, undefined, undefined, app.ctx), /agent prompt failed/);
		assert.equal(parseTerminalResult(JSON.parse(await readFile(undelivered.path, "utf8")))?.state, "finished");
		await assert.rejects(app.tools.get("finish_task")!.execute("finish-1", { result: "again" }, undefined, undefined, app.ctx), /already terminal/);
	});
	await rm(undelivered.dir, { recursive: true, force: true });
});
