import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import type { Usage } from "@earendil-works/pi-ai";
import { EphemeralSubagentError } from "@henryqw/pi-subagent";
import {
	AutoDagRunner,
	FileRunStore,
	PrelaunchFailure,
	identifyGitWorkspace,
	type ChildRunInput,
	type CommandResult,
	type RunnerRuntime,
} from "../src/runner.ts";
import { RUN_STATE_VERSION, type ExecuteRequest, type RunState, type WorkspaceIdentity } from "../src/schema.ts";

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
	async resolveRoot() { return this.root; }
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

async function harness(store = new FileRunStore()) {
	const root = await mkdtemp(join(tmpdir(), "pi-auto-dag-test-"));
	const runtime = new FakeRuntime(root);
	return { root, runtime, runner: new AutoDagRunner(runtime, store) };
}

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

test("interrupted running state becomes needs_attention without replay", async () => {
	const { root, runtime, runner } = await harness();
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
	await new FileRunStore().save(state);
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

	const store = new ReorderingStore();
	const { root, runtime, runner } = await harness(store);
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

test("Git identity includes staging and untracked content without changing the real index", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-auto-dag-git-"));
	await execFileAsync("git", ["init", "-q"], { cwd: root });
	await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: root });
	await execFileAsync("git", ["config", "user.name", "Test"], { cwd: root });
	await writeFile(join(root, "tracked.txt"), "tracked\n");
	await execFileAsync("git", ["add", "tracked.txt"], { cwd: root });
	await execFileAsync("git", ["commit", "-qm", "base"], { cwd: root });
	const exec = async (command: string, args: string[], options?: { cwd?: string }) => {
		try {
			const result = await execFileAsync(command, args, { cwd: options?.cwd });
			return { code: 0, stdout: result.stdout, stderr: result.stderr };
		} catch (error) {
			const failure = error as { code?: number; stdout?: string; stderr?: string };
			return { code: failure.code ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
		}
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
	await writeFile(join(root, "new", "untracked.txt"), "untracked\n");
	const after = await identifyGitWorkspace(exec, root);
	assert.equal(after.head, before.head);
	assert.notEqual(after.tree, before.tree);
	const cached = await execFileAsync("git", ["diff", "--cached", "--name-only"], { cwd: root });
	assert.equal(cached.stdout, "");
	assert.equal(await readFile(join(root, "new", "untracked.txt"), "utf8"), "untracked\n");
});
