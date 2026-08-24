import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { parseProjectConfig } from "../src/config.ts";
import { deriveDependencyWaves, hashDeliveryGraph, parseDeliveryGraph, readDeliveryGraph, writeDeliveryGraph } from "../src/graph.ts";
import { startLocalRun } from "../src/intake.ts";
import { createCoreLifecycle, type CoreLifecycle } from "../src/lifecycle.ts";
import type { RunState } from "../src/model.ts";
import { createOrchestratorExtension, ORCHESTRATOR_TOOLS } from "../src/orchestrator.ts";
import {
	createInitialRunState,
	createRun,
	parseRunState,
	readActiveRunId,
	readRunState,
	writeRunState,
} from "../src/state.ts";
import { createTestRoles } from "./support/roles.ts";

const execFile = promisify(execFileCallback);
const RUN_ID = "88888888-8888-4888-8888-888888888888";
const model = {
	provider: "openai-codex-2",
	id: "gpt-test",
	name: "Test",
	api: "openai-responses",
	baseUrl: "https://example.test",
	input: ["text"],
	contextWindow: 100_000,
	maxTokens: 10_000,
	reasoning: true,
	thinkingLevelMap: { high: "high" },
} as const;

const graphInput = {
	id: "execution-boundary",
	goal: "Execute the exact graph.",
	constraints: ["Keep commands exact."],
	non_goals: [],
	issues: [
		{
			id: "web",
			title: "Web",
			objective: "Build the web boundary.",
			acceptance: ["Web works."],
			testing: "npm test -- web",
			depends_on: ["api"],
		},
		{
			id: "cli",
			title: "CLI",
			objective: "Build the CLI boundary.",
			acceptance: ["CLI works."],
			testing: "npm test -- cli",
			depends_on: [],
		},
		{
			id: "api",
			title: "API",
			objective: "Build the API boundary.",
			acceptance: ["API works."],
			testing: "printf 'line\u2028next'\n",
			depends_on: [],
		},
	],
	final_check: { acceptance: ["Integrated checks pass."], testing: "npm test -- 'final check'" },
};

test("Delivery Graph is strict and derives dependency waves", () => {
	const graph = parseDeliveryGraph(graphInput);
	assert.deepEqual(deriveDependencyWaves(graph), [["api", "cli"], ["web"]]);
	assert.throws(() => parseDeliveryGraph({ ...graphInput, status: "approved" }), /Unknown Delivery Graph setting: status/);
	assert.throws(() => parseDeliveryGraph({
		...graphInput,
		issues: [{ ...graphInput.issues[0], profile: "backend" }],
	}), /Unknown Delivery Graph issues\[0\] setting: profile/);
});

test("numeric v5 configuration is accepted while old and unknown contracts fail", () => {
	assert.deepEqual(parseProjectConfig({
		version: 5,
		max_parallel_tasks: 3,
		max_review_rounds: 4,
		required_gate_timeout_ms: 12_345,
	}), {
		version: 5,
		max_parallel_tasks: 3,
		max_review_rounds: 4,
		required_gate_timeout_ms: 12_345,
	});
	assert.throws(() => parseProjectConfig({ version: 4 }), /Unsupported auto-dag configuration version: 4/);
	assert.throws(() => parseProjectConfig({ version: 5, implementation_roles: ["backend"] }), /Unknown auto-dag configuration setting: implementation_roles/);
});

test("auto_dag_execute is the sole confirmed initial execution boundary", async (t) => {
	const project = await setupProject(t, true);
	const tools = new Map<string, { execute: Function }>();
	const events = new Map<string, Function>();
	let activeTools = ["read", ...Object.values(ORCHESTRATOR_TOOLS)];
	let current: RunState | undefined;
	const starts: Array<{ root: string; pane?: string; expectedGraphHash?: string }> = [];
	const lifecycle: CoreLifecycle = {
		async start(root, pane, expectedGraphHash) {
			starts.push({ root, pane, expectedGraphHash });
			const graph = await readDeliveryGraph(root);
			current = createInitialRunState({
				run_id: RUN_ID,
				graph,
				source_commit: await git(root, "rev-parse", "HEAD"),
				main_worktree: root,
				integration_branch: "integration",
				default_branch: "main",
				created_at: "2026-08-09T00:00:00.000Z",
				main_pane: pane!,
				workspace_id: "main-workspace",
			});
			return current;
		},
		async status() { return current; },
		async resume() { throw new Error("unexpected resume"); },
		async retryGate() { throw new Error("unexpected retry"); },
		async resolve() { throw new Error("unexpected resolve"); },
		async abort() { throw new Error("unexpected abort"); },
		async acknowledgeNotification() { throw new Error("unexpected acknowledgement"); },
		async settleTerminal() { throw new Error("unexpected terminal settlement"); },
	};
	const pi = {
		registerCommand() {},
		registerTool(tool: { name: string; execute: Function }) { tools.set(tool.name, tool); },
		on(name: string, handler: Function) { events.set(name, handler); },
		getActiveTools: () => [...activeTools],
		setActiveTools(names: string[]) { activeTools = [...names]; },
		getCommands: () => [],
		async sendUserMessage() {},
	};
	createOrchestratorExtension({ lifecycle })(pi as never);
	assert.deepEqual([...tools.keys()].sort(), Object.values(ORCHESTRATOR_TOOLS).sort());
	assert.equal(tools.has("auto_dag_start"), false);
	assert.equal(tools.has("auto_dag_approve"), false);

	const context = (mode: "tui" | "rpc", confirm: (title: string, message: string) => Promise<boolean>) => ({
		cwd: project.root,
		mode,
		model,
		scopedModels: [],
		modelRegistry: { getAvailable: () => [model] },
		isProjectTrusted: () => true,
		ui: {
			confirm,
			notify() {},
			setWidget() {},
		},
	});
	await events.get("session_start")!({}, context("rpc", async () => false));
	assert.deepEqual(activeTools, ["read", ORCHESTRATOR_TOOLS.execute, ORCHESTRATOR_TOOLS.status]);

	const execute = tools.get(ORCHESTRATOR_TOOLS.execute)!;
	await assert.rejects(
		execute.execute("rpc", { graph: graphInput }, undefined, undefined, context("rpc", async () => true)),
		/requires interactive TUI mode/,
	);
	await assert.rejects(readFile(join(project.root, ".context", "issues", "graph.json")), /ENOENT/);
	assert.equal(starts.length, 0);

	let confirmation = "";
	const cancelled = await execute.execute("cancel", { graph: graphInput }, undefined, undefined, context("tui", async (title, message) => {
		assert.equal(title, "Execute Auto DAG Delivery Graph?");
		confirmation = message;
		return false;
	}));
	assert.equal(cancelled.content[0].text, "Auto DAG execution cancelled.");
	await assert.rejects(readFile(join(project.root, ".context", "issues", "graph.json")), /ENOENT/);
	assert.equal(await readActiveRunId(project.root), undefined);
	assert.equal(starts.length, 0);

	const canonical = parseDeliveryGraph(graphInput);
	assert.ok(confirmation.includes(`Graph SHA-256: ${quote(hashDeliveryGraph(canonical))}`));
	assert.ok(confirmation.includes('Implementer Role: "implementer"'));
	assert.ok(confirmation.includes('Reviewer Role: "reviewer"'));
	assert.ok(confirmation.includes(`Testing ("implementer"): ${quote(graphInput.issues[2].testing)}`));
	assert.ok(confirmation.includes(`Testing ("reviewer"): ${quote(graphInput.final_check.testing)}`));

	const result = await execute.execute("approve", { graph: graphInput }, undefined, undefined, context("tui", async () => true));
	assert.equal(result.details?.graph_hash, hashDeliveryGraph(canonical));
	assert.deepEqual(starts, [{ root: project.root, pane: "main-pane", expectedGraphHash: hashDeliveryGraph(canonical) }]);
	assert.deepEqual(await readDeliveryGraph(project.root), canonical);
	assert.equal(
		await readFile(join(project.root, ".context", "issues", "graph.json"), "utf8"),
		`${JSON.stringify(canonical, null, 2)}\n`,
	);
});

test("startup rejects a graph changed after confirmation before creating a run", async (t) => {
	const project = await setupProject(t, true);
	await writeDeliveryGraph(project.root, graphInput);
	await assert.rejects(startLocalRun({
		mainWorktree: project.root,
		mainPane: "main-pane",
		workspaceId: "main-workspace",
		expectedGraphHash: "0".repeat(64),
	}), /Delivery Graph changed after execution confirmation/);
	assert.equal(await readActiveRunId(project.root), undefined);
});

test("abort retains an undelivered blocked notification until acknowledgement", async (t) => {
	const project = await setupProject(t);
	const graph = parseDeliveryGraph({ ...graphInput, issues: [graphInput.issues[2]] });
	const initial = createInitialRunState({
		run_id: RUN_ID,
		graph,
		source_commit: await git(project.root, "rev-parse", "HEAD"),
		main_worktree: project.root,
		integration_branch: "integration",
		default_branch: "main",
		created_at: "2026-08-09T00:00:00.000Z",
		main_pane: "main-pane",
		workspace_id: "main-workspace",
	});
	await createRun(project.root, initial, () => "create");
	await writeRunState(project.root, {
		...initial,
		phase: "blocked",
		block_reason: "API needs a decision.",
		tasks: {
			...initial.tasks,
			api: { status: "blocked", attempts: 1, block_reason: "Choose a protocol.", blocked_role: "implementer" },
		},
	}, () => "blocked");
	const pending = (await readRunState(project.root, RUN_ID))!.notifications[0];
	const lifecycle = createCoreLifecycle({ uuid: () => "lifecycle", now: () => "2026-08-09T01:00:00.000Z" });
	const aborted = await lifecycle.abort(project.root, "Cancelled by user");
	assert.equal(aborted.phase, "aborted");
	assert.equal(await readActiveRunId(project.root), RUN_ID);
	const resumed = await lifecycle.resume(project.root);
	assert.equal(resumed.phase, "aborted");
	assert.equal(resumed.notifications.find(({ event_id }) => event_id === pending.event_id)?.delivered_at, undefined);
	assert.equal(await readActiveRunId(project.root), RUN_ID);
	await lifecycle.acknowledgeNotification(project.root, pending.event_id);
	assert.equal(await readActiveRunId(project.root), undefined);
});

test("terminal settlement releases a completed lock after acknowledgement persistence", async (t) => {
	const project = await setupProject(t);
	const graph = parseDeliveryGraph({ ...graphInput, issues: [graphInput.issues[2]] });
	const initial = createInitialRunState({
		run_id: RUN_ID,
		graph,
		source_commit: await git(project.root, "rev-parse", "HEAD"),
		main_worktree: project.root,
		integration_branch: "integration",
		default_branch: "main",
		created_at: "2026-08-09T00:00:00.000Z",
		main_pane: "main-pane",
		workspace_id: "main-workspace",
	});
	await createRun(project.root, initial, () => "create");
	await writeRunState(project.root, {
		...initial,
		phase: "completed",
		tasks: Object.fromEntries(Object.entries(initial.tasks).map(([id, task]) => [id, { status: "completed", attempts: task.attempts }])),
		pr: {
			number: 42,
			url: "https://example.test/pull/42",
			head_ref: "integration",
			base_ref: "main",
			head_oid: initial.integration_head,
		},
	}, () => "completed");
	const completed = (await readRunState(project.root, RUN_ID))!;
	await writeRunState(project.root, {
		...completed,
		notifications: completed.notifications.map((notification) => ({
			...notification,
			delivered_at: "2026-08-09T01:00:00.000Z",
		})),
	}, () => "delivered");
	assert.equal(await readActiveRunId(project.root), RUN_ID);
	await createCoreLifecycle().settleTerminal(project.root);
	assert.equal(await readActiveRunId(project.root), undefined);
});

test("durable blocked/completed notifications retain stable IDs and release completion only after ack", async (t) => {
	const project = await setupProject(t);
	const graph = parseDeliveryGraph({ ...graphInput, issues: [graphInput.issues[2]] });
	const initial = createInitialRunState({
		run_id: RUN_ID,
		graph,
		source_commit: await git(project.root, "rev-parse", "HEAD"),
		main_worktree: project.root,
		integration_branch: "integration",
		default_branch: "main",
		created_at: "2026-08-09T00:00:00.000Z",
		main_pane: "main-pane",
		workspace_id: "main-workspace",
	});
	await createRun(project.root, initial, () => "create");
	const blocked: RunState = {
		...initial,
		phase: "blocked",
		block_reason: "API needs a decision.",
		tasks: {
			...initial.tasks,
			api: { status: "blocked", attempts: 2, block_reason: "Choose a protocol.", blocked_role: "implementer" },
		},
	};
	await writeRunState(project.root, blocked, () => "blocked-one");
	const firstBlocked = (await readRunState(project.root, RUN_ID))!;
	const blockedId = firstBlocked.notifications[0].event_id;
	assert.match(blockedId, new RegExp(`^auto-dag:${RUN_ID}:blocked:[a-f0-9]{64}$`));
	assert.deepEqual(parseRunState(JSON.parse(JSON.stringify(firstBlocked))), firstBlocked);
	await writeRunState(project.root, firstBlocked, () => "blocked-two");
	const blockedRoundTrip = (await readRunState(project.root, RUN_ID))!;
	assert.deepEqual(blockedRoundTrip.notifications.map(({ event_id }) => event_id), [blockedId]);

	const lifecycle = createCoreLifecycle({ uuid: () => "ack", now: () => "2026-08-09T01:00:00.000Z" });
	const acknowledged = await lifecycle.acknowledgeNotification(project.root, blockedId);
	const acknowledgedAgain = await lifecycle.acknowledgeNotification(project.root, blockedId);
	assert.equal(acknowledged.notifications[0].delivered_at, "2026-08-09T01:00:00.000Z");
	assert.deepEqual(acknowledgedAgain, acknowledged);
	assert.equal(await readActiveRunId(project.root), RUN_ID);

	const { block_reason: _blockReason, ...unblocked } = acknowledgedAgain;
	const completed: RunState = {
		...unblocked,
		phase: "completed",
		tasks: Object.fromEntries(Object.entries(unblocked.tasks).map(([id, task]) => [id, { status: "completed", attempts: task.attempts }])),
		pr: {
			number: 42,
			url: "https://example.test/pull/42",
			head_ref: "integration",
			base_ref: "main",
			head_oid: unblocked.integration_head,
		},
	};
	await writeRunState(project.root, completed, () => "completed-one");
	const firstCompleted = (await readRunState(project.root, RUN_ID))!;
	const completedId = firstCompleted.notifications.find(({ kind }) => kind === "completed")!.event_id;
	assert.match(completedId, new RegExp(`^auto-dag:${RUN_ID}:completed:[a-f0-9]{64}$`));
	assert.equal(await readActiveRunId(project.root), RUN_ID);
	await writeRunState(project.root, parseRunState(JSON.parse(JSON.stringify(firstCompleted))), () => "completed-two");
	const completedRoundTrip = (await readRunState(project.root, RUN_ID))!;
	assert.equal(completedRoundTrip.notifications.find(({ kind }) => kind === "completed")!.event_id, completedId);
	assert.equal(completedRoundTrip.notifications.length, 2);

	const delivered = await lifecycle.acknowledgeNotification(project.root, completedId);
	assert.equal(await readActiveRunId(project.root), undefined);
	assert.deepEqual(await lifecycle.acknowledgeNotification(project.root, completedId), delivered);
});

async function setupProject(t: TestContext, withAgentConfig = false): Promise<{ root: string; agentDir?: string }> {
	const root = await mkdtemp(join(tmpdir(), "pi-auto-dag-execution-"));
	t.after(async () => await rm(root, { recursive: true, force: true }));
	await git(root, "init", "-b", "main");
	await git(root, "config", "user.name", "Execution Test");
	await git(root, "config", "user.email", "execution@example.com");
	await writeFile(join(root, ".gitignore"), ".context/\n");
	await git(root, "add", ".gitignore");
	await git(root, "commit", "-m", "initial");
	await git(root, "switch", "-c", "integration");
	if (!withAgentConfig) return { root };

	const agentDir = await mkdtemp(join(tmpdir(), "pi-auto-dag-execution-agent-"));
	t.after(async () => await rm(agentDir, { recursive: true, force: true }));
	await mkdir(join(agentDir, "config"), { recursive: true });
	await createTestRoles(agentDir);
	await writeFile(join(agentDir, "config", "pi-auto-dag.json"), JSON.stringify({
		version: 5,
		max_parallel_tasks: 2,
		max_review_rounds: 3,
		required_gate_timeout_ms: 60_000,
	}));
	await writeFile(join(agentDir, "config", "pi-task-models.json"), JSON.stringify({
		profiles: {
			balanced: { primary: { model: "openai-codex/gpt-test", thinkingLevel: "high" } },
			frontier: { primary: { model: "openai-codex/gpt-test", thinkingLevel: "high" } },
		},
		tasks: {},
	}));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousPane = process.env.HERDR_PANE_ID;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.HERDR_PANE_ID = "main-pane";
	t.after(() => {
		setEnvironment("PI_CODING_AGENT_DIR", previousAgentDir);
		setEnvironment("HERDR_PANE_ID", previousPane);
	});
	return { root, agentDir };
}

function quote(value: string): string {
	return JSON.stringify(value).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (character) => `\\u{${character.codePointAt(0)!.toString(16)}}`);
}

function setEnvironment(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
	return (await execFile("git", args, { cwd })).stdout.trim();
}
