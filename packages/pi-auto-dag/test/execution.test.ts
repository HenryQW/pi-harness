import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { parseProjectConfig } from "../src/config.ts";
import { deriveDependencyWaves, hashDeliveryGraph, parseDeliveryGraph, readDeliveryGraph, writeDeliveryGraph } from "../src/graph.ts";
import { preflightLocalRun, startLocalRun, type LocalRunPreflight } from "../src/intake.ts";
import { createCoreLifecycle, type CoreLifecycle } from "../src/lifecycle.ts";
import type { DeliveryGraph, RunState } from "../src/model.ts";
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
	const starts: Array<{ graph: DeliveryGraph; boundary: LocalRunPreflight; pane?: string }> = [];
	const lifecycle: CoreLifecycle = {
		async start(graph, boundary, pane) {
			starts.push({ graph, boundary, pane });
			await writeDeliveryGraph(boundary.main_worktree, graph);
			current = createInitialRunState({
				run_id: RUN_ID,
				graph,
				source_commit: boundary.head,
				main_worktree: boundary.main_worktree,
				integration_branch: boundary.branch,
				default_branch: boundary.default_branch,
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
		async settleTerminal() { return current!; },
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
	assert.equal(starts.length, 1);
	assert.deepEqual(starts[0], {
		graph: canonical,
		boundary: {
			main_worktree: project.root,
			branch: "integration",
			head: await git(project.root, "rev-parse", "HEAD"),
			default_branch: "main",
			config: { version: 5, max_parallel_tasks: 2, max_review_rounds: 3, required_gate_timeout_ms: 60_000 },
		},
		pane: "main-pane",
	});
	assert.deepEqual(await readDeliveryGraph(project.root), canonical);
	assert.equal(
		await readFile(join(project.root, ".context", "issues", "graph.json"), "utf8"),
		`${JSON.stringify(canonical, null, 2)}\n`,
	);

	current = {
		...current!,
		phase: "completed",
		pr: { number: 42, url: "https://example.test/pull/42", head_ref: "integration", base_ref: "main", head_oid: current!.integration_head },
	};
	await events.get("tool_execution_end")!({ toolName: ORCHESTRATOR_TOOLS.status }, context("tui", async () => true));
	assert.ok(activeTools.includes(ORCHESTRATOR_TOOLS.resume));
	assert.equal(activeTools.includes(ORCHESTRATOR_TOOLS.execute), false);
	assert.equal(activeTools.includes(ORCHESTRATOR_TOOLS.abort), false);
});

test("startup rejects a changed confirmed boundary before persisting its graph", async (t) => {
	const project = await setupProject(t, true);
	const boundary = await preflightLocalRun(project.root);
	await writeFile(join(project.agentDir!, "config", "pi-auto-dag.json"), JSON.stringify({
		...boundary.config,
		max_parallel_tasks: boundary.config.max_parallel_tasks + 1,
	}));
	await assert.rejects(startLocalRun({
		graph: parseDeliveryGraph(graphInput),
		confirmedBoundary: boundary,
		mainPane: "main-pane",
		workspaceId: "main-workspace",
	}), /execution boundary changed during confirmation/);
	assert.equal(await readActiveRunId(project.root), undefined);
	await assert.rejects(readFile(join(project.root, ".context", "issues", "graph.json")), /ENOENT/);
});

test("concurrent starts cannot replace the winning run graph", async (t) => {
	const project = await setupProject(t, true);
	const boundary = await preflightLocalRun(project.root);
	const graphs = [parseDeliveryGraph(graphInput), parseDeliveryGraph({ ...graphInput, goal: "Execute the other graph." })];
	const runIds = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
	const results = await Promise.allSettled(graphs.map((graph, index) => startLocalRun({
		graph,
		confirmedBoundary: boundary,
		mainPane: "main-pane",
		workspaceId: "main-workspace",
		uuid: () => runIds[index],
	})));
	const winners = results.filter((result): result is PromiseFulfilledResult<RunState> => result.status === "fulfilled");
	assert.equal(winners.length, 1, results.map((result) => result.status === "rejected" ? String(result.reason) : result.value.run_id).join("\n"));
	assert.deepEqual(await readDeliveryGraph(project.root), winners[0].value.graph);
	assert.equal(await readActiveRunId(project.root), winners[0].value.run_id);
});

test("createRun publishes durable state before the post-claim window and recovers from interruption there", async (t) => {
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
	let duringAfterClaim: RunState | undefined;
	await assert.rejects(
		createRun(project.root, initial, () => "create", async () => {
			duringAfterClaim = await readRunState(project.root, RUN_ID);
			throw new Error("process stopped inside the post-claim window");
		}),
		/process stopped inside the post-claim window/,
	);
	// state.json already existed while afterClaim ran, so a crash there is recoverable via resume/abort.
	assert.equal(duringAfterClaim?.run_id, RUN_ID);
	// A thrown failure (not a crash) still releases the lock and leaves no half-created run behind.
	assert.equal(await readActiveRunId(project.root), undefined);
	assert.equal(await readRunState(project.root, RUN_ID), undefined);
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
	assert.equal(aborted.abort_cleanup_complete, true);
	assert.equal(await readActiveRunId(project.root), RUN_ID);
	const resumed = await lifecycle.resume(project.root);
	assert.equal(resumed.phase, "aborted");
	assert.equal(resumed.notifications.find(({ event_id }) => event_id === pending.event_id)?.delivered_at, undefined);
	assert.equal(await readActiveRunId(project.root), RUN_ID);
	await lifecycle.acknowledgeNotification(project.root, pending.event_id);
	assert.equal(await readActiveRunId(project.root), undefined);
});

test("terminal settlement retains an aborted lock without cleanup proof", async (t) => {
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
	await writeRunState(project.root, { ...initial, phase: "aborted" }, () => "aborted-before-cleanup");
	await createCoreLifecycle().settleTerminal(project.root);
	assert.equal(await readActiveRunId(project.root), RUN_ID);
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
	await assert.rejects(createCoreLifecycle().abort(project.root, "Too late"), /Cannot abort a completed run/);
	assert.equal((await readRunState(project.root, RUN_ID))!.phase, "completed");
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
	assert.equal(blocked.current_notification_id, blockedId);
	assert.deepEqual(parseRunState(JSON.parse(JSON.stringify(firstBlocked))), firstBlocked);
	await writeRunState(project.root, blocked, () => "blocked-two");
	const blockedRoundTrip = (await readRunState(project.root, RUN_ID))!;
	assert.deepEqual(blockedRoundTrip.notifications.map(({ event_id }) => event_id), [blockedId]);

	const lifecycle = createCoreLifecycle({ uuid: () => "ack", now: () => "2026-08-09T01:00:00.000Z" });
	const acknowledged = await lifecycle.acknowledgeNotification(project.root, blockedId);
	const acknowledgedAgain = await lifecycle.acknowledgeNotification(project.root, blockedId);
	assert.equal(acknowledged.notifications[0].delivered_at, "2026-08-09T01:00:00.000Z");
	assert.deepEqual(acknowledgedAgain, acknowledged);
	assert.equal(await readActiveRunId(project.root), RUN_ID);

	const { block_reason: _blockReason, ...unblocked } = acknowledgedAgain;
	await writeRunState(project.root, {
		...unblocked,
		phase: "execution",
		tasks: { ...unblocked.tasks, api: { status: "pending", attempts: 2 } },
	}, () => "unblocked");
	const rearmed = (await readRunState(project.root, RUN_ID))!;
	await writeRunState(project.root, {
		...rearmed,
		phase: "blocked",
		block_reason: blocked.block_reason,
		tasks: blocked.tasks,
	}, () => "blocked-again");
	const blockedAgain = (await readRunState(project.root, RUN_ID))!;
	const blockedIds = blockedAgain.notifications.filter(({ kind }) => kind === "blocked").map(({ event_id }) => event_id);
	assert.equal(blockedIds.length, 2);
	assert.notEqual(blockedIds[0], blockedIds[1]);
	const acknowledgedAgainBlock = await lifecycle.acknowledgeNotification(project.root, blockedIds[1]);

	const { block_reason: _secondBlockReason, ...unblockedAgain } = acknowledgedAgainBlock;
	const completed: RunState = {
		...unblockedAgain,
		phase: "completed",
		tasks: Object.fromEntries(Object.entries(unblockedAgain.tasks).map(([id, task]) => [id, { status: "completed", attempts: task.attempts }])),
		pr: {
			number: 42,
			url: "https://example.test/pull/42",
			head_ref: "integration",
			base_ref: "main",
			head_oid: unblockedAgain.integration_head,
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
	assert.equal(completedRoundTrip.notifications.length, 3);

	const delivered = await lifecycle.acknowledgeNotification(project.root, completedId);
	assert.equal(await readActiveRunId(project.root), undefined);
	assert.deepEqual(await lifecycle.acknowledgeNotification(project.root, completedId), delivered);
});

test("followUp delivery is fire-and-forget: failed or unacknowledged dispatch stays pending until explicit acknowledgement", async (t) => {
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
		tasks: { ...initial.tasks, api: { status: "blocked", attempts: 1, block_reason: "Choose a protocol.", blocked_role: "implementer" } },
	}, () => "blocked");
	const lifecycle = createCoreLifecycle({ uuid: () => "lifecycle", now: () => "2026-08-09T01:00:00.000Z" });
	await lifecycle.abort(project.root, "Cancelled by user");
	const eventId = (await readRunState(project.root, RUN_ID))!.notifications[0].event_id;

	let failSend = true;
	const sent: string[] = [];
	const notifications: string[] = [];
	const tools = new Map<string, { execute: Function }>();
	const events = new Map<string, Function>();
	const pi = {
		registerCommand() {},
		registerTool(tool: { name: string; execute: Function }) { tools.set(tool.name, tool); },
		on(name: string, handler: Function) { events.set(name, handler); },
		getActiveTools: () => [ORCHESTRATOR_TOOLS.status],
		setActiveTools() {},
		getCommands: () => [],
		async sendUserMessage(text: string) {
			if (failSend) throw new Error("model unavailable during startup");
			sent.push(text);
		},
	};
	createOrchestratorExtension({ lifecycle })(pi as never);
	const context = {
		cwd: project.root,
		mode: "rpc" as const,
		ui: {
			notify(_message: string, kind?: string) { if (kind === "warning") notifications.push(_message); },
			setWidget() {},
		},
	};

	// A failed followUp dispatch must not acknowledge the event nor release the lock.
	await events.get("session_start")!({}, context);
	assert.equal(sent.length, 0);
	assert.ok(notifications.some((message) => message.includes("delivery failed")));
	assert.equal((await readRunState(project.root, RUN_ID))!.notifications[0].delivered_at, undefined);
	assert.equal(await readActiveRunId(project.root), RUN_ID);

	// A successful dispatch is still not treated as delivered; the exact event is redelivered.
	failSend = false;
	await events.get("tool_execution_end")!({ toolName: ORCHESTRATOR_TOOLS.status }, context);
	const deliveredMessage = JSON.parse(sent[0]);
	assert.equal(deliveredMessage.type, "auto_dag_notification");
	assert.equal(deliveredMessage.event_id, eventId);
	assert.equal(deliveredMessage.kind, "blocked");
	assert.equal(deliveredMessage.run_id, RUN_ID);
	assert.equal((await readRunState(project.root, RUN_ID))!.notifications[0].delivered_at, undefined);
	assert.equal(await readActiveRunId(project.root), RUN_ID);

	// Flushing again redelivers the same unacknowledged event after the successful send.
	await events.get("tool_execution_end")!({ toolName: ORCHESTRATOR_TOOLS.status }, context);
	const redeliveredMessage = JSON.parse(sent[1]);
	assert.equal(redeliveredMessage.type, "auto_dag_notification");
	assert.equal(redeliveredMessage.event_id, eventId);
	assert.equal(sent.length, 2);

	// Explicit idempotent acknowledgement of the exact event settles the terminal run.
	await tools.get(ORCHESTRATOR_TOOLS.acknowledge)!.execute("ack", { event_id: eventId }, undefined, undefined, context);
	assert.equal((await readRunState(project.root, RUN_ID))!.notifications[0].delivered_at, "2026-08-09T01:00:00.000Z");
	await tools.get(ORCHESTRATOR_TOOLS.acknowledge)!.execute("ack-again", { event_id: eventId }, undefined, undefined, context);
	assert.equal(await readActiveRunId(project.root), undefined);
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
