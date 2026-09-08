import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import type { Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { extensionConfigDir } from "@henryqw/pi-config-store";
import { EphemeralSubagentError, EXECUTION_BUDGET_ENV } from "@henryqw/pi-subagent";
import autoDagExtension from "../extensions/auto-dag.ts";
import {
	AutoDagRunner,
	FileRunStore,
	PrelaunchFailure,
	assertCleanGitWorkspace,
	identifyGitWorkspace,
	type ChildRunInput,
	type CommandResult,
	type ExecCommand,
	type RunnerRuntime,
} from "../src/runner.ts";
import {
	MAX_EXECUTE_REQUEST_BYTES,
	RUN_STATE_VERSION,
	parseExecuteRequest,
	parseRunState,
	type CheckEvidence,
	type ExecuteRequest,
	type RunState,
	type WorkspaceIdentity,
} from "../src/schema.ts";

const execFileAsync = promisify(execFile);
const OID_A = "a".repeat(40);
const OID_B = "b".repeat(40);
const OID_C = "c".repeat(40);

function usage(tokens: number): Usage {
	return {
		input: tokens,
		output: tokens,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: tokens * 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function request(overrides: Partial<ExecuteRequest> = {}): ExecuteRequest {
	return {
		id: "test-run",
		goal: "Deliver checked work.",
		commitsAllowed: false,
		budgetMs: 100_000,
		tasks: [{
			id: "task-a",
			role: "implementer",
			modelClass: "fast",
			requirements: "Implement A.",
			deliverable: "A is available.",
			dependsOn: [],
			checks: [{ command: "check-a", args: [] }],
		}],
		finalChecks: [{ command: "check-final", args: [] }],
		...overrides,
	};
}

function task(id: string, dependsOn: string[] = []) {
	return {
		id,
		role: "implementer",
		modelClass: "fast" as const,
		requirements: `Implement ${id}.`,
		deliverable: `${id} is available.`,
		dependsOn,
		checks: [{ command: `check-${id}`, args: [] }],
	};
}

function runState(root: string, definition = request(), overrides: Partial<RunState> = {}): RunState {
	const workspace = { branch: "refs/heads/main", head: OID_A, index: OID_A, tree: OID_A };
	return {
		version: RUN_STATE_VERSION,
		request: definition,
		root,
		baseHead: OID_A,
		status: "pending",
		tasks: definition.tasks.map((taskRequest) => ({ request: taskRequest, status: "pending", attempts: 0, checks: [] })),
		final: { status: "pending", checks: [] },
		workspace,
		elapsedMs: 0,
		manualInterventions: 0,
		accepted: false,
		createdAt: 100,
		updatedAt: 100,
		...overrides,
	};
}

function checkEvidence(command: string, passed: boolean, at: number, overrides: Partial<CheckEvidence> = {}): CheckEvidence {
	return {
		command,
		args: [],
		workspace: { branch: "refs/heads/main", head: OID_A, index: OID_A, tree: OID_A },
		code: passed ? 0 : 1,
		stdout: "",
		stderr: "",
		passed,
		at,
		...overrides,
	};
}

type ChildPlan = {
	outcome?: "success" | "failure";
	output?: string;
	usage?: Usage;
	mutate?: boolean;
	error?: Error;
};

type CheckPlan = CommandResult & { mutate?: boolean; advanceMs?: number };

class FakeRuntime implements RunnerRuntime {
	clock = 1_000;
	rootCalls = 0;
	workspace: WorkspaceIdentity = { branch: "refs/heads/main", head: OID_A, index: OID_A, tree: OID_A };
	children: ChildPlan[] = [];
	checks = new Map<string, CheckPlan[]>();
	calls: ChildRunInput[] = [];
	checkCalls: string[] = [];
	checkTimeouts: number[] = [];
	childPrelaunchFailure?: PrelaunchFailure;
	readonly root: string;

	constructor(root: string) {
		this.root = root;
	}

	now() { return this.clock; }
	async resolveRoot() {
		this.rootCalls += 1;
		return this.root;
	}
	async assertClean() {}
	async identifyWorkspace() { return { ...this.workspace }; }
	async runChild(input: ChildRunInput) {
		if (this.childPrelaunchFailure) throw this.childPrelaunchFailure;
		this.calls.push(input);
		const plan = this.children.shift() ?? {};
		await input.onLaunch?.();
		this.clock += 100;
		if (plan.error) throw plan.error;
		if (plan.mutate) this.workspace = { ...this.workspace, tree: this.workspace.tree === OID_B ? OID_C : OID_B };
		return {
			outcome: plan.outcome ?? "success" as const,
			exitCode: plan.outcome === "failure" ? 1 : 0,
			output: plan.output ?? "done",
			stderr: "",
			...(plan.usage === undefined ? {} : { usage: plan.usage }),
		};
	}
	async exec(command: string, _args: string[], options: { cwd: string; signal: AbortSignal; timeout: number }): Promise<CommandResult> {
		this.checkCalls.push(command);
		this.checkTimeouts.push(options.timeout);
		const plan = this.checks.get(command)?.shift() ?? { code: 0, stdout: "", stderr: "" };
		this.clock += plan.advanceMs ?? 10;
		if (plan.mutate) this.workspace = { ...this.workspace, tree: this.workspace.tree === OID_B ? OID_C : OID_B };
		return plan;
	}
}

async function harness(createStore?: (agentDir: string) => FileRunStore) {
	const directory = await mkdtemp(join(tmpdir(), "pi-auto-dag-test-"));
	const root = join(directory, "workspace");
	const agentDir = join(directory, "agent");
	await mkdir(root);
	const store = createStore?.(agentDir) ?? new FileRunStore(agentDir);
	const runtime = new FakeRuntime(root);
	return { root, agentDir, runtime, store, runner: new AutoDagRunner(runtime, store) };
}

const realExec: ExecCommand = async (command, args, options) => {
	try {
		const result = await execFileAsync(command, args, {
			cwd: options?.cwd,
			signal: options?.signal,
			timeout: options?.timeout,
		});
		return { code: 0, stdout: result.stdout, stderr: result.stderr, killed: false };
	} catch (error) {
		const failure = error as { code?: number; stdout?: string; stderr?: string; killed?: boolean };
		return {
			code: typeof failure.code === "number" ? failure.code : -1,
			stdout: failure.stdout ?? "",
			stderr: failure.stderr ?? "",
			killed: failure.killed ?? options?.signal?.aborted ?? false,
		};
	}
};

async function initRepository(root: string): Promise<void> {
	await mkdir(root, { recursive: true });
	await execFileAsync("git", ["init", "-q"], { cwd: root });
	await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: root });
	await execFileAsync("git", ["config", "user.name", "Test"], { cwd: root });
	await writeFile(join(root, "tracked.txt"), "tracked\n");
	await execFileAsync("git", ["add", "tracked.txt"], { cwd: root });
	await execFileAsync("git", ["commit", "-qm", "base"], { cwd: root });
}

test("oversized normalized requests fail before workspace or worker activity", async () => {
	const exact = request();
	exact.finalChecks[0]!.args = Array.from({ length: 15 }, () => "x".repeat(16_000));
	const remaining = MAX_EXECUTE_REQUEST_BYTES - Buffer.byteLength(JSON.stringify(exact), "utf8");
	assert.ok(remaining > 0 && exact.goal.length + remaining <= 32_000);
	exact.goal += "x".repeat(remaining);
	assert.equal(Buffer.byteLength(JSON.stringify(exact), "utf8"), MAX_EXECUTE_REQUEST_BYTES);
	assert.equal(parseExecuteRequest(exact).goal, exact.goal);

	const oversized = { ...exact, goal: `${exact.goal}x` };
	const { runner, runtime } = await harness();
	await assert.rejects(
		runner.execute(oversized, runtime.root),
		new RegExp(`normalized request exceeds ${MAX_EXECUTE_REQUEST_BYTES} bytes`),
	);
	assert.equal(runtime.rootCalls, 0);
	assert.equal(runtime.calls.length, 0);
});

test("persisted task definitions must match their canonical top-level definitions", () => {
	const state = runState("/workspace");
	state.tasks[0]!.request = { ...state.tasks[0]!.request, role: " implementer " };
	const parsed = parseRunState(state);
	assert.strictEqual(parsed.tasks[0]!.request, parsed.request.tasks[0]);

	const malformed = structuredClone(state);
	malformed.tasks[0]!.request.requirements = "Different requirements.";
	assert.throws(() => parseRunState(malformed), /task definition for task-a/);
});

test("unknown, duplicate, self, and cyclic dependencies launch no child", async () => {
	for (const tasks of [
		[task("task-a", ["missing"])],
		[task("task-a", ["task-b", "task-b"]), task("task-b")],
		[task("task-a", ["task-a"])],
		[task("task-a", ["task-b"]), task("task-b", ["task-a"])],
	]) {
		const { runner, runtime } = await harness();
		await assert.rejects(runner.execute(request({ tasks }), runtime.root));
		assert.equal(runtime.calls.length, 0);
	}
});

test("tasks launch serially in supplied order after dependencies complete", async () => {
	const { runner, runtime } = await harness();
	const result = await runner.execute(request({ tasks: [task("task-a"), task("task-b", ["task-a"]), task("task-c")] }), runtime.root);
	assert.equal(result.state.accepted, true);
	assert.deepEqual(runtime.calls.filter(({ kind }) => kind === "worker").map(({ task: packet }) => /task "([^"]+)"/.exec(packet)?.[1]), ["task-a", "task-b", "task-c"]);
	assert.deepEqual(runtime.checkCalls, ["check-task-a", "check-task-b", "check-task-c", "check-final"]);
});

test("a task packet contains only direct dependency outputs", async () => {
	const { runner, runtime } = await harness();
	runtime.children.push(
		{ output: "OUTPUT_A" },
		{ output: "OUTPUT_UNRELATED" },
		{ output: "OUTPUT_B" },
	);
	await runner.execute(request({ tasks: [task("task-a"), task("unrelated"), task("task-b", ["task-a"])] }), runtime.root);
	const packet = runtime.calls.filter(({ kind }) => kind === "worker")[2]!.task;
	assert.match(packet, /OUTPUT_A/);
	assert.doesNotMatch(packet, /OUTPUT_UNRELATED/);
});

test("a worker claim cannot complete a task without declared checks", async () => {
	const { runner, runtime } = await harness();
	const invalid = request({ tasks: [{ ...task("task-a"), checks: [] }] });
	await assert.rejects(runner.execute(invalid, runtime.root), /declared v9 schema/);
	assert.equal(runtime.calls.length, 0);
});

test("failed task check blocks acceptance and correction receives actual evidence", async () => {
	const { runner, runtime } = await harness();
	runtime.checks.set("check-a", [
		{ code: 1, stdout: "", stderr: "actual failure" },
		{ code: 0, stdout: "ok", stderr: "" },
	]);
	const result = await runner.execute(request(), runtime.root);
	const workers = runtime.calls.filter(({ kind }) => kind === "worker");
	assert.equal(workers.length, 2);
	assert.match(workers[1]!.task, /Actual prior failure evidence:[\s\S]*actual failure/);
	assert.equal(result.state.tasks[0]!.status, "completed");
	assert.equal(result.state.accepted, true);
});

test("a task receives at most two launched worker attempts", async () => {
	const { runner, runtime } = await harness();
	runtime.checks.set("check-a", [
		{ code: 1, stdout: "", stderr: "first" },
		{ code: 1, stdout: "", stderr: "second" },
	]);
	const result = await runner.execute(request(), runtime.root);
	assert.equal(runtime.calls.filter(({ kind }) => kind === "worker").length, 2);
	assert.equal(result.state.tasks[0]!.attempts, 2);
	assert.equal(result.state.tasks[0]!.status, "needs_attention");
	assert.equal(result.state.accepted, false);
});

test("failed final check leaves completed tasks but prevents request acceptance", async () => {
	const { runner, runtime } = await harness();
	runtime.checks.set("check-final", [{ code: 1, stdout: "", stderr: "integration failed" }]);
	const result = await runner.execute(request(), runtime.root);
	assert.equal(result.state.tasks[0]!.status, "completed");
	assert.equal(result.state.final.status, "needs_attention");
	assert.equal(result.state.accepted, false);
});

test("usage and total elapsed budget persist across deliberate resume", async () => {
	const { runner, runtime } = await harness();
	runtime.children.push({ usage: usage(2) }, { usage: usage(3) });
	runtime.checks.set("check-a", [
		{ code: 1, stdout: "", stderr: "first", advanceMs: 4_400 },
		{ code: 1, stdout: "", stderr: "second", advanceMs: 4_400 },
	]);
	const first = await runner.execute(request({ budgetMs: 10_000 }), runtime.root);
	assert.equal(first.state.usage?.totalTokens, 10);
	const firstElapsed = first.state.elapsedMs;
	runtime.checks.set("check-a", [{ code: 0, stdout: "", stderr: "", advanceMs: 400 }]);
	const resumed = await runner.resume({ id: "test-run", action: "verify", taskId: "task-a" }, runtime.root);
	assert.equal(resumed.state.accepted, true);
	assert.equal(resumed.state.usage?.totalTokens, 10);
	assert.ok(resumed.state.elapsedMs > firstElapsed);
	assert.deepEqual(runtime.checkTimeouts.slice(-2), [1_000, 600]);
	assert.equal(resumed.state.manualInterventions, 1);
});

test("oversized replacement leaves the prior request usable", async () => {
	const definition = request();
	definition.finalChecks[0]!.args = Array.from({ length: 15 }, () => "x".repeat(16_000));
	const padding = MAX_EXECUTE_REQUEST_BYTES - Buffer.byteLength(JSON.stringify(definition), "utf8") - 100;
	assert.ok(padding > 0 && definition.goal.length + padding <= 32_000);
	definition.goal += "x".repeat(padding);

	const { root, runtime, store, runner } = await harness();
	runtime.children.push({ error: new Error("pause") });
	await runner.execute(definition, root);
	const before = await readFile(store.statePath(root, definition.id));
	await assert.rejects(
		runner.resume({
			id: definition.id,
			action: "replace",
			task: { ...definition.tasks[0]!, requirements: "r".repeat(32_000) },
		}, root),
		new RegExp(`normalized request exceeds ${MAX_EXECUTE_REQUEST_BYTES} bytes`),
	);
	assert.deepEqual(await readFile(store.statePath(root, definition.id)), before);

	const replacement = { ...definition.tasks[0]!, requirements: "Use the smaller replacement." };
	const resumed = await runner.resume({ id: definition.id, action: "replace", task: replacement }, root);
	assert.equal(resumed.state.accepted, true);
	assert.equal(resumed.state.request.tasks[0]!.requirements, replacement.requirements);
	assert.strictEqual(resumed.state.tasks[0]!.request, resumed.state.request.tasks[0]);
});

test("manual verification persists the selected task as running before checks", async () => {
	class InterruptingStore extends FileRunStore {
		interruptNextRunningSave = false;

		override async save(state: RunState): Promise<void> {
			await super.save(JSON.parse(JSON.stringify(state)) as RunState);
			if (this.interruptNextRunningSave && state.status === "running" && state.tasks[0]!.status === "running") {
				this.interruptNextRunningSave = false;
				throw new Error("simulated interruption");
			}
		}
	}

	const { root, runtime, store, runner } = await harness((agentDir) => new InterruptingStore(agentDir));
	runtime.checks.set("check-task-a", [
		{ code: 1, stdout: "", stderr: "first" },
		{ code: 1, stdout: "", stderr: "second" },
	]);
	const first = await runner.execute(request({ tasks: [task("task-a"), task("task-b")] }), root);
	assert.equal(first.state.tasks[0]!.status, "needs_attention");
	assert.equal(first.state.tasks[1]!.status, "pending");

	(store as InterruptingStore).interruptNextRunningSave = true;
	await assert.rejects(
		runner.resume({ id: "test-run", action: "verify", taskId: "task-a" }, root),
		/simulated interruption/,
	);
	const recovered = await new AutoDagRunner(runtime, store).status({ id: "test-run" }, root);
	assert.equal(recovered.state.tasks[0]!.status, "needs_attention");
	assert.match(recovered.state.tasks[0]!.failure!, /interrupted while this task/);
	assert.equal(recovered.state.tasks[1]!.status, "pending");
});

test("manual verification replaces stale worker output before a dependent task", async () => {
	const { root, runtime, runner } = await harness();
	runtime.children.push(
		{ output: "STALE_FIRST_OUTPUT" },
		{ output: "STALE_SECOND_OUTPUT" },
		{ output: "dependent complete" },
	);
	runtime.checks.set("check-task-a", [
		{ code: 1, stdout: "", stderr: "first" },
		{ code: 1, stdout: "", stderr: "second" },
	]);
	await runner.execute(request({ tasks: [task("task-a"), task("task-b", ["task-a"])] }), root);
	runtime.checks.set("check-task-a", [{ code: 0, stdout: "ok", stderr: "" }]);

	const resumed = await runner.resume({ id: "test-run", action: "verify", taskId: "task-a" }, root);
	const dependentPacket = runtime.calls.filter(({ kind }) => kind === "worker").at(-1)!.task;
	assert.equal(resumed.state.accepted, true);
	assert.match(resumed.state.tasks[0]!.output!, /Manually verified by Main/);
	assert.match(dependentPacket, /Manually verified by Main/);
	assert.doesNotMatch(dependentPacket, /STALE_(?:FIRST|SECOND)_OUTPUT/);
});

test("interrupted running state becomes needs_attention without replay", async () => {
	const { root, runtime, store, runner } = await harness();
	const definition = request();
	const state: RunState = {
		version: RUN_STATE_VERSION,
		request: definition,
		root,
		baseHead: OID_A,
		status: "running",
		tasks: [{ request: definition.tasks[0]!, status: "running", attempts: 1, checks: [] }],
		final: { status: "pending", checks: [] },
		workspace: { ...runtime.workspace },
		usage: usage(4),
		elapsedMs: 200,
		activeSince: 500,
		manualInterventions: 0,
		accepted: false,
		createdAt: 100,
		updatedAt: 500,
	};
	await store.save(state);
	const result = await runner.status({ id: "test-run" }, root);
	assert.equal(result.state.tasks[0]!.status, "needs_attention");
	assert.match(result.state.tasks[0]!.failure!, /will not replay automatically/);
	assert.equal(result.state.elapsedMs, 700);
	assert.equal(result.state.usage?.totalTokens, 8);
	assert.equal(runtime.calls.length, 0);
});

test("active abort leaves terminal state persistence to the lifecycle owner", async () => {
	let releaseTerminalSave!: () => void;
	const terminalSave = new Promise<void>((resolve) => {
		releaseTerminalSave = resolve;
	});
	class ReorderingStore extends FileRunStore {
		override async save(state: RunState): Promise<void> {
			const snapshot = JSON.parse(JSON.stringify(state)) as RunState;
			const staleAbortWrite = snapshot.status === "running"
				&& snapshot.manualInterventions === 1
				&& snapshot.tasks[0]!.checks.length === 0;
			if (staleAbortWrite) await terminalSave;
			await super.save(snapshot);
			if (snapshot.status === "needs_attention" && snapshot.manualInterventions === 1) releaseTerminalSave();
		}
	}

	const { root, runtime, store, runner } = await harness((agentDir) => new ReorderingStore(agentDir));
	runtime.children.push({ usage: usage(2) });
	let checkStarted!: () => void;
	const checking = new Promise<void>((resolve) => {
		checkStarted = resolve;
	});
	runtime.exec = async (_command, _args, { signal }) => await new Promise<CommandResult>((_resolve, reject) => {
		signal.addEventListener("abort", () => reject(signal.reason), { once: true });
		checkStarted();
	});

	const running = runner.execute(request(), root);
	await checking;
	const aborting = runner.abort({ id: "test-run" }, root);
	const result = await running;
	await aborting;
	const persisted = await store.load(root, "test-run");

	assert.equal(result.state.status, "needs_attention");
	assert.equal(persisted.status, "needs_attention");
	assert.equal(persisted.accepted, false);
	assert.equal(persisted.manualInterventions, 1);
	assert.equal(persisted.usage?.totalTokens, 4);
	assert.equal(persisted.tasks[0]!.status, "needs_attention");
	assert.equal(persisted.tasks[0]!.checks.length, 1);
	assert.equal(persisted.tasks[0]!.checks[0]!.command, "check-a");
	assert.equal(persisted.tasks[0]!.checks[0]!.passed, false);
});

test("launched child error usage persists and is returned once per invocation", async () => {
	const { runner, runtime } = await harness();
	runtime.children.push({ error: new EphemeralSubagentError("timeout", "timed out", undefined, usage(2)) });
	const first = await runner.execute(request(), runtime.root);
	assert.equal(first.state.usage?.totalTokens, 4);
	assert.equal(first.usage?.totalTokens, 4);
	assert.equal(first.state.tasks[0]!.attempts, 1);

	runtime.children.push({ usage: usage(3) });
	const resumed = await runner.resume({ id: "test-run", action: "retry", taskId: "task-a" }, runtime.root);
	assert.equal(resumed.state.usage?.totalTokens, 10);
	assert.equal(resumed.usage?.totalTokens, 6);
	assert.equal(resumed.state.tasks[0]!.attempts, 2);
	assert.equal(resumed.state.accepted, true);
});

test("Role names are resolved as names rather than request IDs", async () => {
	const { runner, runtime } = await harness();
	const definition = request({ tasks: [{ ...task("task-a"), role: "QA Reviewer" }] });
	const result = await runner.execute(definition, runtime.root);
	assert.equal(result.state.accepted, true);
	assert.equal(runtime.calls[0]!.role, "QA Reviewer");
});

test("missing Role or route pauses before any launch", async () => {
	const { runner, runtime } = await harness();
	runtime.childPrelaunchFailure = new PrelaunchFailure("Unknown Subagent Role");
	const result = await runner.execute(request(), runtime.root);
	assert.equal(runtime.calls.length, 0);
	assert.equal(result.state.tasks[0]!.attempts, 0);
	assert.equal(result.state.tasks[0]!.status, "needs_attention");
	assert.match(result.state.tasks[0]!.failure!, /Prelaunch failure/);
});

test("Auto DAG registers no orchestration tools inside an ephemeral subagent child", () => {
	const previous = process.env[EXECUTION_BUDGET_ENV];
	process.env[EXECUTION_BUDGET_ENV] = JSON.stringify({ maxTurns: 50, maxMs: 30 * 60_000, startedAt: Date.now() });
	const tools: string[] = [];
	try {
		autoDagExtension({
			registerTool(tool: { name: string }) {
				tools.push(tool.name);
			},
		} as unknown as ExtensionAPI);
	} finally {
		if (previous === undefined) delete process.env[EXECUTION_BUDGET_ENV];
		else process.env[EXECUTION_BUDGET_ENV] = previous;
	}
	assert.deepEqual(tools, []);
});

test("Reviewer is not launched without an explicit judgment criterion", async () => {
	const { runner, runtime } = await harness();
	await runner.execute(request(), runtime.root);
	assert.deepEqual(runtime.calls.map(({ kind }) => kind), ["worker"]);
});

test("check and Reviewer workspace mutation are rejected", async () => {
	const checkHarness = await harness();
	checkHarness.runtime.checks.set("check-a", [
		{ code: 0, stdout: "", stderr: "", mutate: true },
		{ code: 0, stdout: "", stderr: "", mutate: true },
	]);
	const checkResult = await checkHarness.runner.execute(request(), checkHarness.root);
	assert.equal(checkResult.state.tasks[0]!.status, "needs_attention");
	assert.match(checkResult.state.tasks[0]!.failure!, /mutated the workspace/);

	const reviewHarness = await harness();
	reviewHarness.runtime.children.push(
		{ output: "done" }, { output: "PASS", mutate: true },
		{ output: "fixed" }, { output: "PASS", mutate: true },
	);
	const reviewed = request({
		tasks: [{
			...task("task-a"),
			checks: [{ command: "check-a", args: [] }],
			judgment: { criterion: "The behavior is clear.", role: "reviewer", modelClass: "balanced" },
		}],
	});
	const reviewResult = await reviewHarness.runner.execute(reviewed, reviewHarness.root);
	assert.equal(reviewResult.state.tasks[0]!.status, "needs_attention");
	assert.match(reviewResult.state.tasks[0]!.failure!, /Reviewer mutated/);
});

test("successful checks are not duplicated against an unchanged workspace", async () => {
	const { runner, runtime } = await harness();
	const twoChecks = request({
		tasks: [{ ...task("task-a"), checks: [{ command: "check-one", args: [] }, { command: "check-two", args: [] }] }],
		finalChecks: [{ command: "check-one", args: [] }],
	});
	runtime.checks.set("check-two", [
		{ code: 1, stdout: "", stderr: "fail" },
		{ code: 0, stdout: "", stderr: "" },
	]);
	const result = await runner.execute(twoChecks, runtime.root);
	assert.equal(result.state.accepted, true);
	assert.equal(runtime.checkCalls.filter((command) => command === "check-one").length, 1);
	assert.equal(runtime.checkCalls.filter((command) => command === "check-two").length, 2);
	assert.deepEqual(result.state.tasks[0]!.checks.map(({ command }) => command), ["check-one", "check-two"]);
	assert.equal(result.state.final.checks[0]!.passed, true);
});

test("unverified final judgment stays explicit until deliberate approval on the checked workspace", async () => {
	const { runner, runtime } = await harness();
	runtime.children.push({ output: "done" }, { output: "finding" });
	const definition = request({
		finalJudgment: { criterion: "The combined behavior is coherent.", role: "reviewer", modelClass: "balanced" },
	});
	const first = await runner.execute(definition, runtime.root);
	assert.equal(first.state.accepted, false);
	assert.match(first.state.final.failure!, /remains unverified/);
	const approved = await runner.resume({ id: "test-run", action: "approve_final_judgment" }, runtime.root);
	assert.equal(approved.state.accepted, true);
	assert.equal(approved.state.manualInterventions, 1);
});

test("restarted final verification reuses earlier passes on the current workspace", async () => {
	const { runner, runtime } = await harness();
	runtime.children.push({ output: "done" }, { output: "finding" }, { output: "PASS" });
	const definition = request({
		finalChecks: [{ command: "check-early", args: [] }, { command: "check-late", args: [] }],
		finalJudgment: { criterion: "The combined behavior is coherent.", role: "reviewer", modelClass: "balanced" },
	});
	const first = await runner.execute(definition, runtime.root);
	assert.deepEqual(first.state.final.verifiedWorkspace, runtime.workspace);

	runtime.workspace = { ...runtime.workspace, tree: OID_B };
	runtime.checks.set("check-late", [
		{ code: 1, stdout: "", stderr: "failed" },
		{ code: 0, stdout: "", stderr: "" },
	]);
	const failed = await runner.resume({ id: "test-run", action: "finalize" }, runtime.root);
	assert.equal(failed.state.final.status, "needs_attention");
	assert.ok(failed.state.final.checks.some((check) => check.command === "check-early" && check.passed && check.workspace.tree === OID_B));

	const completed = await runner.resume({ id: "test-run", action: "finalize" }, runtime.root);
	assert.equal(completed.state.accepted, true);
	assert.equal(runtime.checkCalls.filter((command) => command === "check-early").length, 2);
	assert.equal(runtime.checkCalls.filter((command) => command === "check-late").length, 3);
});

test("durable evidence keeps reusable passes and only the latest actionable failure", async () => {
	const { root, store } = await harness();
	const definition = request({
		tasks: [{ ...task("task-a"), checks: [{ command: "check-pass", args: [] }, { command: "check-fail", args: [] }] }],
	});
	const large = "x".repeat(8 * 1024);
	const currentPass = checkEvidence("check-pass", true, 1, { stdout: large, stderr: large });
	const obsoletePass = checkEvidence("check-pass", true, 2, {
		stdout: large,
		workspace: { branch: "refs/heads/main", head: OID_B, index: OID_B, tree: OID_B },
	});
	const failures = Array.from({ length: 150 }, (_, index) => checkEvidence("check-fail", false, 10 + index, {
		stdout: large,
		stderr: large,
	}));
	const state = runState(root, definition, {
		status: "needs_attention",
		tasks: [{
			request: definition.tasks[0]!,
			status: "needs_attention",
			attempts: 2,
			checks: [currentPass, { ...currentPass }, obsoletePass, ...failures],
			failure: "The latest check failed.",
		}],
	});
	assert.ok(Buffer.byteLength(JSON.stringify(state), "utf8") > 2 * 1024 * 1024);

	await store.save(state);
	const persisted = await store.load(root, definition.id);
	assert.equal(persisted.tasks[0]!.checks.length, 2);
	const pass = persisted.tasks[0]!.checks.find(({ passed }) => passed)!;
	assert.equal(pass.stdout, "");
	assert.equal(pass.stderr, "");
	assert.equal(persisted.tasks[0]!.checks.find(({ passed }) => !passed)!.at, 159);
});

test("recovery isolates oversized peers and reports them after saving valid work", async () => {
	const { root, runtime, store, runner } = await harness();
	const definition = request({ id: "valid-run" });
	await store.save(runState(root, definition, {
		status: "running",
		tasks: [{ request: definition.tasks[0]!, status: "running", attempts: 1, checks: [] }],
		activeSince: 500,
		updatedAt: 500,
	}));
	const badPath = store.statePath(root, "bad-peer");
	const badContents = Buffer.alloc(2 * 1024 * 1024 + 1, 0x78);
	await writeFile(badPath, badContents);

	await assert.rejects(store.load(root, "bad-peer"), /pi-auto-dag state exceeds 2097152 bytes/);
	await assert.rejects(runner.recover(root), /request IDs: "bad-peer"/);
	const recovered = await store.load(root, definition.id);
	assert.equal(recovered.status, "needs_attention");
	assert.match(recovered.tasks[0]!.failure!, /will not replay automatically/);
	assert.equal(recovered.elapsedMs, 500);
	assert.deepEqual(await readFile(badPath), badContents);
	assert.equal(runtime.calls.length, 0);
});

test("symlinked config paths cannot route state writes into the workspace", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-auto-dag-symlink-state-"));
	const root = join(directory, "workspace");
	const agentDir = join(directory, "agent");
	await mkdir(root);
	await mkdir(agentDir);
	await symlink(root, join(agentDir, "config"), "dir");
	const runtime = new FakeRuntime(root);
	const runner = new AutoDagRunner(runtime, new FileRunStore(agentDir));

	await assert.rejects(runner.execute(request(), root), /state directory must be outside the Git workspace/);
	assert.deepEqual(await readdir(root), []);
	assert.equal(runtime.calls.length, 0);
});

test("durable state stays in Auto DAG's config home without workspace drift", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-auto-dag-state-"));
	const root = join(directory, "workspace");
	const agentDir = join(directory, "agent");
	await initRepository(root);
	const store = new FileRunStore(agentDir);
	let clock = 1_000;
	const runtime: RunnerRuntime = {
		now: () => clock++,
		async resolveRoot() { return root; },
		assertClean: (workspace, signal) => assertCleanGitWorkspace(realExec, workspace, signal),
		identifyWorkspace: (workspace, signal) => identifyGitWorkspace(realExec, workspace, signal),
		async runChild(input) {
			await input.onLaunch?.();
			return { outcome: "success", exitCode: 0, output: "done", stderr: "" };
		},
		async exec() { return { code: 0, stdout: "", stderr: "", killed: false }; },
	};
	const result = await new AutoDagRunner(runtime, store).execute(request(), root);
	const statePath = store.statePath(root, "test-run");
	const ownedPath = relative(extensionConfigDir("pi-auto-dag", agentDir), statePath);
	assert.equal(result.state.accepted, true);
	assert.match(ownedPath, /^state[\\/][0-9a-f]{64}[\\/]test-run\.json$/);
	assert.equal(JSON.parse(await readFile(statePath, "utf8")).request.id, "test-run");
	assert.equal((await execFileAsync("git", ["status", "--porcelain"], { cwd: root })).stdout, "");
});

test("repositories containing submodules fail at the workspace boundary", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-auto-dag-submodule-"));
	const root = join(directory, "workspace");
	const child = join(directory, "child");
	await initRepository(root);
	await initRepository(child);
	await execFileAsync("git", ["-c", "protocol.file.allow=always", "submodule", "add", "../child", "vendor/child"], { cwd: root });
	await execFileAsync("git", ["commit", "-qam", "add submodule"], { cwd: root });
	const store = new FileRunStore(join(directory, "agent"));
	let workspaceIdentified = false;
	let childLaunched = false;
	const runtime: RunnerRuntime = {
		now: () => 1_000,
		async resolveRoot() { return root; },
		assertClean: (workspace, signal) => assertCleanGitWorkspace(realExec, workspace, signal),
		async identifyWorkspace() {
			workspaceIdentified = true;
			return { branch: "refs/heads/main", head: OID_A, index: OID_A, tree: OID_A };
		},
		async runChild() {
			childLaunched = true;
			return { outcome: "success", exitCode: 0, output: "done", stderr: "" };
		},
		async exec() { return { code: 0, stdout: "", stderr: "", killed: false }; },
	};
	await assert.rejects(
		new AutoDagRunner(runtime, store).execute(request(), root),
		/does not support Git repositories containing submodules/,
	);
	assert.equal(workspaceIdentified, false);
	assert.equal(childLaunched, false);
	assert.equal(await store.loadIfPresent(root, "test-run"), undefined);
});

test("post-worker identity rejects a newly added submodule", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-auto-dag-submodule-worker-"));
	const root = join(directory, "workspace");
	const child = join(directory, "child");
	await initRepository(root);
	await initRepository(child);
	let checksRun = false;
	const runtime: RunnerRuntime = {
		now: () => 1_000,
		async resolveRoot() { return root; },
		assertClean: (workspace, signal) => assertCleanGitWorkspace(realExec, workspace, signal),
		identifyWorkspace: (workspace, signal) => identifyGitWorkspace(realExec, workspace, signal),
		async runChild(input) {
			await input.onLaunch?.();
			await execFileAsync("git", ["-c", "protocol.file.allow=always", "submodule", "add", "../child", "vendor/child"], { cwd: root });
			return { outcome: "success", exitCode: 0, output: "done", stderr: "" };
		},
		async exec() {
			checksRun = true;
			return { code: 0, stdout: "", stderr: "", killed: false };
		},
	};

	const result = await new AutoDagRunner(runtime, new FileRunStore(join(directory, "agent"))).execute(request(), root);
	assert.equal(result.state.status, "needs_attention");
	assert.equal(result.state.accepted, false);
	assert.match(result.state.tasks[0]!.failure!, /does not support Git repositories containing submodules/);
	assert.equal(checksRun, false);
});

test("Git identity streams ordinary temporary indexes beyond 8 KiB", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-auto-dag-large-index-"));
	await initRepository(root);
	const entries = join(root, "entries");
	await mkdir(entries);
	await Promise.all(Array.from({ length: 200 }, async (_, index) => {
		await writeFile(join(entries, `ordinary-${String(index).padStart(4, "0")}-${"x".repeat(40)}.txt`), "tracked\n");
	}));
	await execFileAsync("git", ["add", "entries"], { cwd: root });
	const listing = await execFileAsync("git", ["ls-files", "--stage"], { cwd: root, encoding: "utf8" });
	assert.ok(Buffer.byteLength(listing.stdout, "utf8") > 8 * 1024);
	assert.match((await identifyGitWorkspace(realExec, root)).tree, /^[0-9a-f]{40}$/);
});

test("Git identity isolates temporary objects and preserves the real index and worktree", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-auto-dag-git-"));
	await initRepository(root);
	const commands: string[] = [];
	const exec: ExecCommand = async (command, args, options) => {
		commands.push(command);
		return await realExec(command, args, options);
	};
	const before = await identifyGitWorkspace(exec, root);
	await writeFile(join(root, "tracked.txt"), "changed\n");
	const unstaged = await identifyGitWorkspace(exec, root);
	await execFileAsync("git", ["add", "tracked.txt"], { cwd: root });
	const staged = await identifyGitWorkspace(exec, root);
	assert.equal(staged.tree, unstaged.tree);
	assert.notEqual(staged.index, unstaged.index);
	await execFileAsync("git", ["reset", "-q", "HEAD", "--", "tracked.txt"], { cwd: root });
	await writeFile(join(root, "tracked.txt"), "tracked\n");
	assert.deepEqual(await identifyGitWorkspace(exec, root), before);
	await mkdir(join(root, "new"));
	await writeFile(join(root, "new", "untracked.txt"), "unique untracked auto-dag content\n");
	const blob = (await execFileAsync("git", ["hash-object", "new/untracked.txt"], { cwd: root })).stdout.trim();
	await assert.rejects(execFileAsync("git", ["cat-file", "-e", `${blob}^{blob}`], { cwd: root }));
	const after = await identifyGitWorkspace(exec, root);
	assert.equal(after.head, before.head);
	assert.notEqual(after.tree, before.tree);
	await assert.rejects(execFileAsync("git", ["cat-file", "-e", `${blob}^{blob}`], { cwd: root }));
	await assert.rejects(execFileAsync("git", ["cat-file", "-e", `${after.tree}^{tree}`], { cwd: root }));
	assert.equal(commands.includes("env"), false);
	const cached = await execFileAsync("git", ["diff", "--cached", "--name-only"], { cwd: root });
	assert.equal(cached.stdout, "");
	assert.equal(await readFile(join(root, "new", "untracked.txt"), "utf8"), "unique untracked auto-dag content\n");
});
