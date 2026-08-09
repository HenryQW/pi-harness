import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test, { type TestContext } from "node:test";
import { runCommand } from "../src/command.ts";
import { loadProjectConfig, parseProjectConfig } from "../src/config.ts";
import { deriveDependencyWaves, hashDeliveryGraph, parseDeliveryGraph } from "../src/graph.ts";
import { assertRunBoundary, startLocalRun } from "../src/intake.ts";
import { createCoreLifecycle } from "../src/lifecycle.ts";
import { DEFAULT_MAX_PARALLEL_TASKS, DEFAULT_MAX_REVIEW_ROUNDS } from "../src/model.ts";
import { createOrchestratorExtension, ORCHESTRATOR_TOOLS } from "../src/orchestrator.ts";
import { PLANNING_TOOLS } from "../src/planning.ts";
import { createInitialRunState, parseRunState, readActiveRunId, readRunState } from "../src/state.ts";
import { createWorkerExtension, createWorkerLaunch, sendWorkerEnvelope, workerAgentName, workerEnvironment, WORKER_ROLE_EVENTS, WORKER_TOOLS } from "../src/worker.ts";

const execFile = promisify(execFileCallback);
const RUN_ID = "11111111-1111-4111-8111-111111111111";

const graph = {
	status: "approved",
	id: "local-dag",
	goal: "Test local intake.",
	constraints: ["local only"],
	non_goals: ["remote execution"],
	issues: [
		{
			id: "core",
			title: "Core",
			profile: "backend",
			objective: "Build the core.",
			acceptance: ["works"],
			testing: "npm test -- core",
			depends_on: [],
		},
		{
			id: "release",
			title: "Release",
			profile: "coder",
			objective: "Release the result.",
			acceptance: ["released"],
			testing: "npm test -- release",
			depends_on: ["core"],
		},
	],
	final_check: { acceptance: ["verified"], testing: "npm test" },
};

test("command runner bounds combined process output", async () => {
	await assert.rejects(
		runCommand(process.execPath, ["-e", "process.stdout.write('12345'); process.stderr.write('67890')"], {
			cwd: process.cwd(),
			maxOutputBytes: 9,
		}),
		/node output exceeded 9 bytes/,
	);
});

test("strict config and local graph validation derive deterministic dependencies", () => {
	const config = parseProjectConfig({
		version: 1,
		profiles: { coder: "/tmp/coder", backend: "/tmp/backend", frontend: "/tmp/frontend", reviewer: "/tmp/reviewer" },
	});
	assert.equal(config.max_parallel_tasks, DEFAULT_MAX_PARALLEL_TASKS);
	assert.equal(config.max_review_rounds, DEFAULT_MAX_REVIEW_ROUNDS);
	assert.throws(() => parseProjectConfig({ ...config, unknown: true }), /Unknown auto-dag configuration setting/);

	const parsed = parseDeliveryGraph(graph);
	assert.deepEqual(deriveDependencyWaves(parsed), [["core"], ["release"]]);
	assert.throws(() => parseDeliveryGraph({ ...graph, unknown: true }), /Unknown Delivery Graph setting/);
	assert.throws(() => parseDeliveryGraph({ ...graph, issues: [{ ...graph.issues[0], id: "../escape" }, ...graph.issues.slice(1)] }), /path-safe lowercase-hyphen ID/);
	assert.throws(() => parseDeliveryGraph({ ...graph, issues: graph.issues.map((issue) => issue.id === "core" ? { ...issue, depends_on: ["release"] } : issue) }), /dependency cycle/);
	assert.throws(() => parseDeliveryGraph({ ...graph, final_check: { ...graph.final_check, acceptance: [] } }), /must contain at least one criterion/);
});

test("initial run state canonicalizes direct graph input before persistence", () => {
	const canonical = parseDeliveryGraph(graph);
	const unsorted = { ...canonical, issues: [canonical.issues[1], canonical.issues[0]] };
	const state = createInitialRunState({
		run_id: RUN_ID,
		graph: unsorted,
		source_commit: "source",
		main_worktree: "/tmp/pi-auto-dag",
		integration_branch: "main",
		default_branch: "main",
		created_at: "2026-08-09T00:00:00.000Z",
		main_pane: "main-pane",
		workspace_id: "main-workspace",
	});

	assert.deepEqual(state.graph.issues.map((issue) => issue.id), ["core", "release"]);
	assert.deepEqual(Object.keys(state.tasks), ["core", "release", "final-check"]);
	assert.equal(parseRunState(JSON.parse(JSON.stringify(state))).graph_hash, state.graph_hash);
});

test("worker agent names hash opaque identities into the Herdr contract", () => {
	const name = workerAgentName("w1V", RUN_ID, "account-slots", "implementer");
	const longName = workerAgentName("Workspace".repeat(20), RUN_ID, "account-slots", "implementer");
	for (const candidate of [name, longName]) {
		assert.match(candidate, /^[a-z][a-z0-9_-]{0,31}$/);
		assert.equal(candidate.length, 30);
	}
	assert.equal(name, workerAgentName("w1V", RUN_ID, "account-slots", "implementer"));
	assert.notEqual(name, workerAgentName("w2V", RUN_ID, "account-slots", "implementer"));
	assert.notEqual(name, workerAgentName("w1V", "22222222-2222-4222-8222-222222222222", "account-slots", "implementer"));
	assert.notEqual(name, workerAgentName("w1V", RUN_ID, "other-task", "implementer"));
	assert.notEqual(name, workerAgentName("w1V", RUN_ID, "account-slots", "reviewer"));
});

test("persisted state rejects obsolete and malformed durable values", () => {
	const state = createInitialRunState({
		run_id: RUN_ID,
		graph: parseDeliveryGraph(graph),
		source_commit: "source",
		main_worktree: "/tmp/pi-auto-dag",
		integration_branch: "main",
		default_branch: "main",
		created_at: "2026-08-09T00:00:00.000Z",
		main_pane: "main-pane",
		workspace_id: "main-workspace",
	});

	assert.throws(() => parseRunState({ ...state, abort_cleanup_pending: true }), /Unknown run state setting: abort_cleanup_pending/);
	assert.throws(() => parseRunState({ ...state, tasks: { ...state.tasks, core: { ...state.tasks.core, worker_ready: true } } }), /Unknown run state.tasks.core setting: worker_ready/);
	assert.throws(() => parseRunState({ ...state, tasks: { ...state.tasks, core: { ...state.tasks.core, status: 1 } } }), /run state.tasks.core.status must be one of/);
	assert.throws(() => parseRunState({ ...state, tasks: { ...state.tasks, core: { ...state.tasks.core, attempts: "1" } } }), /run state.tasks.core.attempts must be a non-negative integer/);
	assert.throws(() => parseRunState({ ...state, tasks: { ...state.tasks, core: { ...state.tasks.core, activity_started_at: "later" } } }), /activity_started_at must be a timestamp/);
	assert.throws(() => parseRunState({ ...state, resolutions: { core: 1 } }), /run state.resolutions.core must be a string/);
	assert.throws(() => parseRunState({ ...state, health: { status: "triaging", head: 1 } }), /run state.health.head must be a string/);
});

test("agent config follows PI_CODING_AGENT_DIR and strictly loads JSON", async (t) => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-auto-dag-agent-config-"));
	t.after(async () => { await rm(agentDir, { recursive: true, force: true }); });
	await mkdir(join(agentDir, "config"), { recursive: true });
	useAgentDir(t, agentDir);
	const config = {
		version: 1,
		profiles: { coder: "/tmp/coder", backend: "/tmp/backend", frontend: "/tmp/frontend", reviewer: "/tmp/reviewer" },
	};
	await writeFile(join(agentDir, "config", "pi-auto-dag.json"), JSON.stringify(config));
	assert.deepEqual((await loadProjectConfig()).profiles, config.profiles);
	await writeFile(join(agentDir, "config", "pi-auto-dag.json"), "version: 1\n");
	await assert.rejects(loadProjectConfig(), /not valid JSON/);
	await rm(join(agentDir, "config", "pi-auto-dag.json"));
	await assert.rejects(loadProjectConfig(), /Cannot read pi-auto-dag configuration/);
});

test("local intake resolves the Git top-level and boundaries use agent config", async (t) => {
	const project = await makeProject(t);
	const subdirectory = join(project.root, "packages", "app");
	await mkdir(subdirectory, { recursive: true });
	const state = await startLocalRun({ mainWorktree: subdirectory, mainPane: "main-pane", workspaceId: "main-workspace", uuid: () => RUN_ID, now: () => "2026-08-09T00:00:00.000Z" });

	assert.equal(state.main_worktree, project.root);
	assert.equal(state.graph_hash, hashDeliveryGraph(parseDeliveryGraph(graph)));
	assert.equal(await readActiveRunId(project.root), RUN_ID);
	assert.equal((await createCoreLifecycle().status(subdirectory))?.run_id, RUN_ID);
	assert.equal((await readRunState(project.root, RUN_ID))?.source_commit, state.source_commit);
	await assert.rejects(startLocalRun({ mainWorktree: project.root, mainPane: "main-pane", workspaceId: "main-workspace", uuid: () => "22222222-2222-4222-8222-222222222222" }), /active pi-auto-dag run/);

	await writeFile(join(project.agentDir, "config", "pi-auto-dag.json"), JSON.stringify({
		version: 1,
		profiles: project.profiles,
		max_parallel_tasks: 2,
	}));
	assert.equal((await assertRunBoundary(state)).max_parallel_tasks, 2);

	const changedGraph = { ...graph, goal: "Changed local DAG" };
	await writeFile(join(project.root, ".context", "issues", "graph.json"), JSON.stringify(changedGraph));
	await assert.rejects(assertRunBoundary(state), /Delivery Graph changed during the run/);
});

test("local intake rejects selective ignores outside the .context boundary", async (t) => {
	const project = await makeProject(t, ".context/issues/graph.json\n.context/pi-auto-dag/runs/\n.context/pi-auto-dag/active.json\n");
	await assert.rejects(
		startLocalRun({ mainWorktree: project.root, mainPane: "main-pane", workspaceId: "main-workspace", uuid: () => RUN_ID }),
		/.context\/ must be Git-ignored/,
	);
	assert.equal(await readActiveRunId(project.root), undefined);
});

test("extensions separate public lifecycle tools and show active workers", async () => {
	const runningState = createInitialRunState({
		run_id: RUN_ID,
		graph: parseDeliveryGraph(graph),
		source_commit: "source",
		main_worktree: "/tmp/pi-auto-dag",
		integration_branch: "main",
		default_branch: "main",
		created_at: "2026-08-09T00:00:00.000Z",
		main_pane: "main-pane",
		workspace_id: "main-workspace",
	});
	runningState.tasks.core = {
		status: "implementing",
		attempts: 1,
		implementer_agent: "dag-core-i",
		implementer_pane: "pane-core",
		activity_started_at: "2099-01-01T00:00:00.000Z",
	};
	runningState.tasks.release = {
		status: "reviewing",
		attempts: 1,
		reviewer_agent: "dag-release-r",
		reviewer_pane: "pane-release",
		activity_started_at: "2099-01-01T00:00:00.000Z",
	};
	runningState.tasks["final-check"] = {
		status: "blocked",
		attempts: 1,
		blocked_role: "reviewer",
		reviewer_agent: "dag-final-r",
		reviewer_pane: "pane-final",
		activity_started_at: "2099-01-01T00:00:00.000Z",
		block_reason: "needs input",
	};
	runningState.health = {
		status: "triaging",
		head: "head",
		reviewer_agent: "dag-health-r",
		reviewer_pane: "pane-health",
		activity_started_at: "2099-01-01T00:00:00.000Z",
	};
	const publicTools: Array<{ name: string }> = [];
	const publicCommands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
	let activeTools = ["read", ...Object.values(PLANNING_TOOLS), ...Object.values(ORCHESTRATOR_TOOLS)];
	let herdrUnavailable = false;
	let refreshAfterTool: ((_event: unknown, ctx: unknown) => Promise<void>) | undefined;
	createOrchestratorExtension({
		runner: async () => herdrUnavailable ? {
			code: 1,
			stdout: "",
			stderr: "Herdr daemon unavailable",
		} : {
			code: 0,
			stdout: JSON.stringify({ result: { agents: [
				{ pane_id: "pane-core", agent_status: "working", workspace_id: "main-workspace" },
				{ pane_id: "pane-release", agent_status: "idle", workspace_id: "main-workspace" },
				{ pane_id: "pane-health", agent_status: "working", workspace_id: "other-workspace" },
			] } }),
			stderr: "",
		},
		lifecycle: {
			start: async () => { throw new Error("not called"); },
			status: async () => runningState,
			resume: async () => { throw new Error("not called"); },
			resolve: async () => { throw new Error("not called"); },
			abort: async () => { throw new Error("not called"); },
			health: async () => { throw new Error("not called"); },
		},
	})({
		on(event: string, handler: (_event: unknown, ctx: unknown) => Promise<void>) { if (event === "tool_execution_end") refreshAfterTool = handler; },
		registerCommand(name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) { publicCommands.set(name, command); },
		registerTool(tool: { name: string }) { publicTools.push(tool); },
		sendUserMessage() {},
		getActiveTools() { return activeTools; },
		setActiveTools(names: string[]) { activeTools = names; },
	} as never);
	assert.deepEqual(publicTools.map((tool) => tool.name), [...Object.values(PLANNING_TOOLS), ...Object.values(ORCHESTRATOR_TOOLS)]);
	assert.deepEqual([...publicCommands.keys()], ["dag-plan", "dag-widget"]);
	const widgets: unknown[][] = [];
	const notifications: string[] = [];
	const widgetCtx = {
		cwd: "/tmp",
		mode: "tui",
		ui: {
			theme: { fg: (_color: string, text: string) => text },
			setWidget: (...args: unknown[]) => { widgets.push(args); },
			notify(message: string) { notifications.push(message); },
		},
	};
	assert.ok(refreshAfterTool);
	await refreshAfterTool({ toolName: ORCHESTRATOR_TOOLS.start }, widgetCtx);
	assert.deepEqual(widgets.at(-1), ["auto-dag-workers", [
		"Auto DAG workers",
		"● core · coding · working · 0s",
		"○ release · reviewing · idle · 0s",
		"! final-check · blocked · 0s · needs input",
		"! PR health · triaging · missing · 0s",
	]]);
	assert.deepEqual(activeTools, [
		"read",
		...Object.values(PLANNING_TOOLS),
		ORCHESTRATOR_TOOLS.status,
		ORCHESTRATOR_TOOLS.resume,
		ORCHESTRATOR_TOOLS.abort,
		ORCHESTRATOR_TOOLS.resolve,
		ORCHESTRATOR_TOOLS.health,
	]);

	const widgetCommand = publicCommands.get("dag-widget")!;
	await widgetCommand.handler("hide", widgetCtx);
	assert.deepEqual(widgets.at(-1), ["auto-dag-workers", undefined]);
	await widgetCommand.handler("show", widgetCtx);
	assert.equal((widgets.at(-1)?.[1] as string[]).at(-1), "! PR health · triaging · missing · 0s");
	await widgetCommand.handler("fix", widgetCtx);
	assert.equal(notifications.at(-1), "Removed 1 stuck Auto DAG widget entry.");
	assert.deepEqual(widgets.at(-1), ["auto-dag-workers", [
		"Auto DAG workers",
		"● core · coding · working · 0s",
		"○ release · reviewing · idle · 0s",
		"! final-check · blocked · 0s · needs input",
	]]);
	runningState.health.activity_started_at = "2099-01-01T00:00:01.000Z";
	await refreshAfterTool({ toolName: ORCHESTRATOR_TOOLS.status }, widgetCtx);
	assert.equal((widgets.at(-1)?.[1] as string[]).at(-1), "! PR health · triaging · missing · 0s");

	herdrUnavailable = true;
	await widgetCommand.handler("fix", widgetCtx);
	assert.equal(notifications.at(-1), "Auto DAG widget fix could not read Herdr worker status: herdr agent list failed: Herdr daemon unavailable. No entries removed.");
	assert.equal((widgets.at(-1)?.[1] as string[]).length, 5);

	const workerTools: Array<{ name: string; execute: Function }> = [];
	createWorkerExtension({
		runner: async () => ({ code: 0, stdout: "", stderr: "" }),
		environment: {
			PI_AUTO_DAG_WORKER_ROLE: "reviewer",
			PI_AUTO_DAG_WORKER_EVENTS: "submit_review,block_task",
			PI_AUTO_DAG_RUN_ID: RUN_ID,
			PI_AUTO_DAG_ISSUE_ID: "core",
			PI_AUTO_DAG_MAIN_PANE: "main-pane",
		},
	})({ registerTool(tool: { name: string; execute: Function }) { workerTools.push(tool); } } as never);
	assert.deepEqual(workerTools.map((tool) => tool.name), [
		WORKER_TOOLS.submit_review,
		WORKER_TOOLS.block_task,
	]);
	const workerResult = await workerTools[0].execute("call", { commit: "abc123", attempt: 1, review_round: 1, command: "npm test", exit_code: 0, verdict: "approved", findings: [] }) as { content: Array<{ text: string }>; details: unknown; terminate: boolean };
	assert.equal(workerResult.content[0].text, "Sent submit_review for core.");
	assert.equal((workerResult.details as { type: string }).type, "submit_review");
	assert.equal(workerResult.terminate, true);

	const fullCommit = "310a75c7289830d9d3973263488de1140438f6e9";
	const requestCalls: string[][] = [];
	const requestTools: Array<{ prepareArguments: Function; execute: Function }> = [];
	createWorkerExtension({
		runner: async (command, args) => {
			requestCalls.push([command, ...args]);
			return { code: 0, stdout: command === "git" ? `${fullCommit}\n` : "", stderr: "" };
		},
		environment: {
			PI_AUTO_DAG_WORKER_ROLE: "implementer",
			PI_AUTO_DAG_WORKER_EVENTS: "request_review",
			PI_AUTO_DAG_RUN_ID: RUN_ID,
			PI_AUTO_DAG_ISSUE_ID: "core",
			PI_AUTO_DAG_MAIN_PANE: "main-pane",
		},
	})({ registerTool(tool: { prepareArguments: Function; execute: Function }) { requestTools.push(tool); } } as never);
	const prepared = requestTools[0].prepareArguments({ commit: "wrong", attempt: 1, review_round: 1 });
	assert.deepEqual(prepared, { attempt: 1, review_round: 1 });
	const requestResult = await requestTools[0].execute("call", prepared) as { details: { payload: { commit: string } } };
	assert.equal(requestResult.details.payload.commit, fullCommit);
	assert.deepEqual(requestCalls[0], ["git", "rev-parse", "HEAD"]);

	const inertWorkerTools: Array<{ name: string }> = [];
	createWorkerExtension({ environment: {} })({ registerTool(tool: { name: string }) { inertWorkerTools.push(tool); } } as never);
	assert.deepEqual(inertWorkerTools, []);

	const launch = createWorkerLaunch({
		role: "implementer",
		events: WORKER_ROLE_EVENTS.implementer,
		profile_path: "/tmp/coder",
		main_worktree: "/tmp/project",
		run_id: RUN_ID,
		issue_id: "core",
		main_pane: "main-pane",
	});
	assert.deepEqual(launch.args, [
		"--offline", "--no-skills", "--skill", "/tmp/coder/.agents/skills", "--skill", "/tmp/project/.pi/shared-skills/.agents/skills", "--tools",
		"read,bash,edit,write,grep,find,ls,auto_dag_request_review,auto_dag_block_task",
	]);
	const reviewerLaunch = createWorkerLaunch({
		role: "reviewer",
		events: ["submit_review", "block_task"],
		profile_path: "/tmp/reviewer",
		main_worktree: "/tmp/project",
		run_id: RUN_ID,
		issue_id: "core",
		main_pane: "main-pane",
	});
	assert.equal(reviewerLaunch.args.at(-1), "read,bash,grep,find,ls,auto_dag_submit_review,auto_dag_block_task");
	const healthReviewerLaunch = createWorkerLaunch({
		role: "reviewer",
		events: WORKER_ROLE_EVENTS.reviewer,
		profile_path: "/tmp/reviewer",
		main_worktree: "/tmp/project",
		run_id: RUN_ID,
		issue_id: "core",
		main_pane: "main-pane",
	});
	assert.match(healthReviewerLaunch.args.at(-1)!, /auto_dag_submit_health/);

	const calls: unknown[][] = [];
	const envelope = await sendWorkerEnvelope(
		workerEnvironment({
			PI_AUTO_DAG_WORKER_ROLE: "reviewer",
			PI_AUTO_DAG_WORKER_EVENTS: "submit_review,block_task",
			PI_AUTO_DAG_RUN_ID: RUN_ID,
			PI_AUTO_DAG_ISSUE_ID: "core",
			PI_AUTO_DAG_MAIN_PANE: "main-pane",
		}),
		"submit_review",
		{ commit: "abc123", attempt: 1, review_round: 1, command: "npm test", exit_code: 0, verdict: "approved", findings: [] },
		async (...args) => {
			calls.push(args);
			return { code: 0, stdout: "", stderr: "" };
		},
		"/tmp",
	);
	assert.equal(envelope.type, "submit_review");
	assert.deepEqual(calls[0].slice(0, 2), ["herdr", ["agent", "prompt", "main-pane", JSON.stringify(envelope)]]);
});

test("orchestrator routes worker envelopes without an LLM turn and keeps tool text compact", async () => {
	const runningState = createInitialRunState({
		run_id: RUN_ID,
		graph: parseDeliveryGraph(graph),
		source_commit: "source",
		main_worktree: "/tmp/pi-auto-dag",
		integration_branch: "main",
		default_branch: "main",
		created_at: "2026-08-09T00:00:00.000Z",
		main_pane: "main-pane",
		workspace_id: "main-workspace",
	});
	let received: unknown;
	let inputHandler: ((event: { text: string }, ctx: unknown) => Promise<{ action: string }>) | undefined;
	const tools: Array<{ name: string; execute: Function }> = [];
	let activeTools = ["read", ...Object.values(PLANNING_TOOLS), ...Object.values(ORCHESTRATOR_TOOLS)];
	createOrchestratorExtension({
		lifecycle: {
			start: async () => runningState,
			status: async () => runningState,
			resume: async (_cwd, envelope) => { received = envelope; return runningState; },
			resolve: async () => runningState,
			abort: async () => runningState,
			health: async () => runningState,
		},
	})({
		on(event: string, handler: unknown) { if (event === "input") inputHandler = handler as typeof inputHandler; },
		registerCommand() {},
		registerTool(tool: { name: string; execute: Function }) { tools.push(tool); },
		sendUserMessage() {},
		getActiveTools() { return activeTools; },
		setActiveTools(names: string[]) { activeTools = names; },
	} as never);
	const notifications: string[] = [];
	const ctx = {
		cwd: "/tmp",
		mode: "rpc",
		ui: {
			theme: { fg: (_color: string, text: string) => text },
			setWidget() {},
			notify(message: string) { notifications.push(message); },
		},
	};
	assert.ok(inputHandler);
	assert.deepEqual(await inputHandler({ text: "ordinary user prompt" }, ctx), { action: "continue" });
	const envelope = {
		version: 1,
		type: "request_review",
		run_id: RUN_ID,
		issue_id: "core",
		role: "implementer",
		payload: { commit: "abc123", attempt: 1, review_round: 1 },
	};
	assert.deepEqual(await inputHandler({ text: JSON.stringify(envelope) }, ctx), { action: "handled" });
	assert.deepEqual(received, envelope);
	assert.match(notifications.at(-1)!, /^Auto DAG .* tasks /);
	assert.deepEqual(await inputHandler({ text: JSON.stringify({ ...envelope, version: 2 }) }, ctx), { action: "handled" });
	assert.match(notifications.at(-1)!, /Unsupported worker envelope version: 2/);
	const status = tools.find((tool) => tool.name === ORCHESTRATOR_TOOLS.status)!;
	const result = await status.execute("call", {}, undefined, undefined, ctx) as { content: Array<{ text: string }>; details: unknown };
	assert.equal(result.details, runningState);
	assert.doesNotMatch(result.content[0].text, /\"graph\"|\"tasks\"/);
});

async function makeProject(t: TestContext, gitignore = ".context/\n"): Promise<{ root: string; profiles: Record<string, string>; agentDir: string }> {
	const root = await mkdtemp(join(tmpdir(), "pi-auto-dag-"));
	t.after(async () => { await rm(root, { recursive: true, force: true }); });
	await git(root, "init", "-b", "main");
	await git(root, "config", "user.email", "test@example.com");
	await git(root, "config", "user.name", "Test User");
	const profiles = Object.fromEntries(await Promise.all(["coder", "backend", "frontend", "reviewer"].map(async (name) => {
		const path = join(root, "profiles", name);
		await mkdir(path, { recursive: true });
		return [name, path];
	}))) as Record<string, string>;
	const agentDir = await mkdtemp(join(tmpdir(), "pi-auto-dag-agent-"));
	t.after(async () => { await rm(agentDir, { recursive: true, force: true }); });
	await mkdir(join(agentDir, "config"), { recursive: true });
	await writeFile(join(agentDir, "config", "pi-auto-dag.json"), JSON.stringify({ version: 1, profiles }));
	useAgentDir(t, agentDir);
	await mkdir(join(root, ".context", "issues"), { recursive: true });
	await writeFile(join(root, ".gitignore"), gitignore);
	await writeFile(join(root, ".context", "issues", "graph.json"), JSON.stringify(graph));
	await git(root, "add", ".");
	await git(root, "commit", "-m", "initial");
	await git(root, "checkout", "-b", "dag");
	return { root, profiles, agentDir };
}

function useAgentDir(t: TestContext, agentDir: string): void {
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	t.after(() => {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
	});
}

async function git(cwd: string, ...args: string[]): Promise<string> {
	const result = await execFile("git", args, { cwd });
	return result.stdout.trim();
}
