import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
	OrchestratorRunner,
	TERMINATION_SAFETY_BUDGET_MS,
	type AllocationReconciliation,
	type AllocationResult,
	type CheckRunResult,
	type CommandResult,
	type IntegrationResult,
	type OperationContext,
	type OrchestratorRuntime,
	type RebaseResult,
	type ReviewResult,
	type WorkerResult,
} from "../src/runner.ts";
import {
	launchRecordFingerprint,
	parseRunState,
	requiredLaunchKeys,
	type AllocationIntent,
	type AllocationKind,
	type CheckCommand,
	type CleanupKind,
	type ExecuteRequest,
	type LaunchRecord,
	type ModelClass,
	type NormalizedLaunchRecord,
	type WorktreeRecord,
	type TaskAttempt,
	type TaskRequest,
	type WorkspaceIdentity,
} from "../src/schema.ts";
import { FileRunStore } from "../src/store.ts";

const oid = (character: string) => character.repeat(40);
const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
const MAIN_A = identity("a");

function identity(character: string, branch = "refs/heads/main"): WorkspaceIdentity {
	const value = oid(character);
	return { branch, head: value, index: value, tree: value };
}

function task(
	id: string,
	dependsOn: string[] = [],
	modelClass: ModelClass = "fast",
	judgment?: { criterion: string; modelClass: ModelClass },
): TaskRequest {
	return {
		id,
		modelClass,
		requirements: `Implement ${id}.`,
		deliverable: `Deliver ${id}.`,
		dependsOn,
		checks: [{ command: `check-${id}`, args: [] }],
		...(judgment ? { judgment } : {}),
	};
}

function request(overrides: Partial<ExecuteRequest> = {}): ExecuteRequest {
	return {
		id: "request-one",
		goal: "Deliver checked work.",
		budgetMs: 10_000,
		tasks: [task("task-a")],
		finalChecks: [{ command: "check-final", args: [] }],
		...overrides,
	};
}

type WorkerPlan = {
	outcome?: WorkerResult["outcome"];
	candidate?: WorkspaceIdentity;
	diagnostic?: string;
	error?: Error;
	expire?: boolean;
};
type CheckPlan = {
	code?: number;
	identityAfter?: WorkspaceIdentity;
	error?: Error;
	expire?: boolean;
	mutateMain?: WorkspaceIdentity;
};
type ReviewPlan = { verdict?: string; identityAfter?: WorkspaceIdentity; error?: Error; expire?: boolean };
type CleanupPlan = { outcome?: "completed" | "absent" | "blocked"; failure?: string; error?: Error; expire?: boolean };
type InspectionPlan = { identity?: WorkspaceIdentity; error?: Error };
type TerminationPlan = { outcome?: "terminated" | "unknown"; failure?: string; error?: Error; expire?: boolean };

class FakeRuntime implements OrchestratorRuntime {
	clock = 1_000;
	main = { ...MAIN_A };
	preflightCalls = 0;
	materializeCalls = 0;
	recoverCalls: Record<string, NormalizedLaunchRecord>[] = [];
	allocationCalls: AllocationKind[] = [];
	reconciliationCalls: AllocationKind[] = [];
	workerCalls: {
		taskId: string;
		workerId: string;
		kind: "initial" | "correction";
		launchKey: string;
		preCandidate: WorkspaceIdentity;
	}[] = [];
	checkCalls: { scope: "task" | "final"; taskId?: string }[] = [];
	reviewCalls: { scope: "task" | "final"; taskId?: string; launchKey: string }[] = [];
	terminationCalls: { workerId: string; candidate: WorkspaceIdentity }[] = [];
	rebaseCalls: { taskId: string; onto: WorkspaceIdentity }[] = [];
	integrationCalls: string[] = [];
	cleanupCalls: CleanupKind[] = [];
	contexts: { hook: string; context: OperationContext }[] = [];
	workerPlans: WorkerPlan[] = [];
	checkPlans: CheckPlan[] = [];
	reviewPlans: ReviewPlan[] = [];
	cleanupPlans: CleanupPlan[] = [];
	inspectionPlans: InspectionPlan[] = [];
	candidateInspectionPlans: InspectionPlan[] = [];
	candidateInspectionCalls: WorkspaceIdentity[] = [];
	terminationPlans: TerminationPlan[] = [];
	retainedCandidate?: WorkspaceIdentity;
	allocationFailure?: { kind: AllocationKind; error?: Error; result?: AllocationResult };
	allocationResources: Partial<Record<AllocationKind, Record<string, string>>> = {};
	reconciliation: AllocationReconciliation = { outcome: "absent" };
	preflightAction?: () => Promise<void>;
	preflightRoot?: string;
	materializeAction?: () => Promise<void>;
	workerBarrierSize = 0;
	expireHook?: string;
	private barrierResolvers: (() => void)[] = [];
	private token = 0;
	private candidate = 0;

	now(): number { return this.clock; }
	randomToken(): string { return `token-${String(++this.token).padStart(16, "0")}`; }

	private observe(hook: string, context: OperationContext, expire = false): void {
		this.contexts.push({ hook, context });
		if (expire || this.expireHook === hook) this.clock = context.deadline;
	}

	private nextOidCharacter(): string {
		return "bcdef1234567890"[this.candidate++ % 15]!;
	}

	private launchRecords(input: ExecuteRequest): LaunchRecord[] {
		return [...requiredLaunchKeys(input).entries()].map(([key, route]) => {
			const extensionPath = `/roles/${route.role}-${route.modelClass}.ts`;
			const skillPath = `/skills/${route.role}.md`;
			const rawArgs = ["--model", `${route.modelClass}-model`, "--thinking", "high"];
			const rawPrompt = `Implement with ${route.modelClass}.`;
			const record: Omit<NormalizedLaunchRecord, "fingerprint"> = {
				key,
				...route,
				model: `${route.modelClass}-model`,
				thinkingLevel: "high",
				rawArgs,
				env: {},
				tools: route.role === "implementer" ? ["read", "edit"] : ["read"],
				roleExtensions: [extensionPath],
				roleSkills: [skillPath],
				resources: [
					{ kind: "extension", path: extensionPath, sha256: "1".repeat(64) },
					{ kind: "skill", path: skillPath, sha256: "2".repeat(64) },
				],
				...(route.role === "implementer" ? { prompt: {
					rawValue: rawPrompt,
					path: `/private/${key.replace("/", "-")}.prompt`,
					mode: 0o600 as const,
					sha256: sha256(rawPrompt),
					finalArgs: [...rawArgs, "--prompt-file", `/private/${key.replace("/", "-")}.prompt`],
				} } : {}),
			};
			return { ...record, fingerprint: launchRecordFingerprint(record) };
		});
	}

	async preflight(input: { request: ExecuteRequest; root: string }, context: OperationContext) {
		this.preflightCalls += 1;
		this.observe("preflight", context);
		await this.preflightAction?.();
		return { root: this.preflightRoot ?? input.root, main: { ...this.main }, launchRecords: this.launchRecords(input.request) };
	}

	async materializeLaunchRecords(
		_input: { root: string; request: ExecuteRequest; records: Record<string, NormalizedLaunchRecord> },
		context: OperationContext,
	): Promise<void> {
		this.materializeCalls += 1;
		this.observe("materialize-launches", context);
		await this.materializeAction?.();
	}

	async recoverLaunchRecords(
		input: { root: string; request: ExecuteRequest; records: Record<string, NormalizedLaunchRecord> },
		context: OperationContext,
	): Promise<LaunchRecord[]> {
		this.observe("recover-launches", context);
		this.recoverCalls.push(structuredClone(input.records));
		return Object.values(input.records).map((record) => structuredClone(record));
	}

	async inspectMain(_input: { root: string }, context: OperationContext): Promise<WorkspaceIdentity> {
		this.observe("inspect-main", context);
		const plan = this.inspectionPlans.shift();
		if (plan?.error) throw plan.error;
		return { ...(plan?.identity ?? this.main) };
	}

	async inspectTaskCandidate(
		input: { root: string; task: TaskRequest; attempt: TaskAttempt },
		context: OperationContext,
	): Promise<WorkspaceIdentity> {
		this.observe("inspect-task-candidate", context);
		const plan = this.candidateInspectionPlans.shift();
		if (plan?.error) throw plan.error;
		const candidate = plan?.identity
			?? input.attempt.candidate
			?? { ...input.attempt.waveBase, branch: `refs/heads/${input.task.id}` };
		this.candidateInspectionCalls.push(structuredClone(candidate));
		return structuredClone(candidate);
	}

	async planHostAllocation(
		input: { kind: Exclude<AllocationKind, "worktree">; task: TaskRequest; attempt: TaskAttempt },
		context: OperationContext,
	): Promise<string> {
		this.observe("plan-allocation", context);
		return `${input.task.id}/${input.kind}/${input.attempt.allocationGeneration}`;
	}

	private allocation(input: { intent: { kind: AllocationKind }; task: TaskRequest }, context: OperationContext): AllocationResult {
		this.observe("allocate", context);
		this.allocationCalls.push(input.intent.kind);
		if (this.allocationFailure?.kind === input.intent.kind) {
			const failure = this.allocationFailure;
			this.allocationFailure = undefined;
			if (failure.error) throw failure.error;
			return failure.result!;
		}
		return {
			outcome: "owned",
			resourceId: `${input.task.id}-${input.intent.kind}`,
			...(this.allocationResources[input.intent.kind]
				? { resources: structuredClone(this.allocationResources[input.intent.kind]) }
				: {}),
		};
	}

	async allocateWorktree(
		input: { root: string; intent: AllocationIntent; task: TaskRequest; attempt: TaskAttempt; onPrepared(worktree: WorktreeRecord): Promise<void> },
		context: OperationContext,
	): Promise<AllocationResult> {
		const planned: WorktreeRecord = {
			path: `${input.task.id}-worktree`, cwd: `${input.task.id}-worktree`, branch: input.task.id,
			repoRoot: "fake-root", baseCommit: input.attempt.waveBase.head,
		};
		await input.onPrepared(planned);
		return this.allocation(input, context);
	}

	async allocateHost(
		input: { intent: AllocationIntent; task: TaskRequest; attempt: TaskAttempt },
		context: OperationContext,
	): Promise<AllocationResult> {
		return this.allocation(input, context);
	}

	private reconcile(input: { intent: { kind: AllocationKind } }, context: OperationContext): AllocationReconciliation {
		this.observe("reconcile-allocation", context);
		this.reconciliationCalls.push(input.intent.kind);
		return this.reconciliation;
	}

	async reconcileWorktreeAllocation(
		input: { root: string; intent: AllocationIntent; task: TaskRequest; attempt: TaskAttempt },
		context: OperationContext,
	): Promise<AllocationReconciliation> {
		return this.reconcile(input, context);
	}

	async reconcileHostAllocation(
		input: { intent: AllocationIntent; task: TaskRequest; attempt: TaskAttempt },
		context: OperationContext,
	): Promise<AllocationReconciliation> {
		return this.reconcile(input, context);
	}

	async runWorker(
		input: {
			task: TaskRequest;
			workerId: string;
			launch: LaunchRecord;
			kind: "initial" | "correction";
			preCandidate: WorkspaceIdentity;
		},
		context: OperationContext,
	): Promise<WorkerResult> {
		const plan = this.workerPlans.shift() ?? {};
		this.observe("worker", context, plan.expire);
		this.workerCalls.push({
			taskId: input.task.id,
			workerId: input.workerId,
			kind: input.kind,
			launchKey: input.launch.key,
			preCandidate: structuredClone(input.preCandidate),
		});
		if (this.workerBarrierSize > 0 && this.workerCalls.length <= this.workerBarrierSize) {
			await new Promise<void>((resolve) => {
				this.barrierResolvers.push(resolve);
				if (this.barrierResolvers.length === this.workerBarrierSize) {
					for (const release of this.barrierResolvers) release();
				}
			});
		}
		if (plan.error) throw plan.error;
		if (plan.outcome === "blocked") return { outcome: "blocked", diagnostic: plan.diagnostic ?? "blocked" };
		if (plan.outcome === "unknown" || plan.outcome === "interrupted") {
			return { outcome: plan.outcome, diagnostic: plan.diagnostic ?? plan.outcome };
		}
		return {
			outcome: "candidate",
			candidate: plan.candidate ?? identity(this.nextOidCharacter(), `refs/heads/${input.task.id}`),
			diagnostic: plan.diagnostic,
		};
	}

	async runChecks(
		input: { scope: "task" | "final"; taskId?: string; checks: CheckCommand[]; candidate: WorkspaceIdentity },
		context: OperationContext,
	): Promise<CheckRunResult> {
		const plan = this.checkPlans.shift() ?? {};
		this.observe(input.scope === "final" ? "final-checks" : "checks", context, plan.expire);
		this.checkCalls.push({ scope: input.scope, ...(input.taskId ? { taskId: input.taskId } : {}) });
		if (plan.mutateMain) this.main = { ...plan.mutateMain };
		if (plan.error) throw plan.error;
		const results: CommandResult[] = input.checks.map((check) => ({
			...check,
			code: plan.code ?? 0,
			stdout: "",
			stderr: plan.code ? "failed" : "",
		}));
		return { results, identityAfter: plan.identityAfter ?? { ...input.candidate } };
	}

	async review(
		input: {
			scope: "task" | "final";
			taskId?: string;
			tip: WorkspaceIdentity;
			launch: LaunchRecord;
		},
		context: OperationContext,
	): Promise<ReviewResult> {
		const plan = this.reviewPlans.shift() ?? {};
		this.observe("review", context, plan.expire);
		this.reviewCalls.push({
			scope: input.scope,
			...(input.taskId ? { taskId: input.taskId } : {}),
			launchKey: input.launch.key,
		});
		if (plan.error) throw plan.error;
		return { verdict: plan.verdict ?? "PASS", identityAfter: plan.identityAfter ?? { ...input.tip } };
	}

	async terminateWorker(
		input: { workerId: string; candidate: WorkspaceIdentity },
		context: OperationContext,
	): Promise<{ outcome: "terminated" } | { outcome: "unknown"; failure: string }> {
		const plan = this.terminationPlans.shift() ?? {};
		this.observe("terminate", context, plan.expire);
		this.terminationCalls.push({ workerId: input.workerId, candidate: structuredClone(input.candidate) });
		if (plan.error) throw plan.error;
		if (plan.outcome === "unknown") return { outcome: "unknown", failure: plan.failure ?? "termination unknown" };
		return { outcome: "terminated" };
	}

	async inspectRetainedTask(
		input: { attempt: TaskAttempt },
		context: OperationContext,
	): Promise<WorkspaceIdentity> {
		this.observe("inspect-retained", context);
		return { ...(this.retainedCandidate ?? input.attempt.candidate!) };
	}

	async rebase(
		input: { task: TaskRequest; candidate: WorkspaceIdentity; onto: WorkspaceIdentity },
		context: OperationContext,
	): Promise<RebaseResult> {
		this.observe("rebase", context);
		this.rebaseCalls.push({ taskId: input.task.id, onto: { ...input.onto } });
		const candidate = input.onto.head === MAIN_A.head
			? input.candidate
			: identity(this.nextOidCharacter(), input.candidate.branch);
		return { outcome: "ready", base: { ...input.onto }, candidate: { ...candidate } };
	}

	async integrate(
		input: { task: TaskRequest; candidate: WorkspaceIdentity },
		context: OperationContext,
	): Promise<IntegrationResult> {
		this.observe("integration", context);
		this.integrationCalls.push(input.task.id);
		this.main = identity(input.candidate.head[0]!);
		return { outcome: "integrated", main: { ...this.main } };
	}

	private runCleanup(
		input: { kind: CleanupKind },
		context: OperationContext,
	): { outcome: "completed" | "absent" } | { outcome: "blocked"; failure: string } {
		const plan = this.cleanupPlans.shift() ?? {};
		this.observe("cleanup", context, plan.expire);
		this.cleanupCalls.push(input.kind);
		if (plan.error) throw plan.error;
		if (plan.outcome === "blocked") return { outcome: "blocked", failure: plan.failure ?? "blocked" };
		return { outcome: plan.outcome ?? "completed" };
	}

	async cleanupHost(
		input: { kind: "worker_tab" | "workspace" },
		context: OperationContext,
	): Promise<{ outcome: "completed" | "absent" } | { outcome: "blocked"; failure: string }> {
		return this.runCleanup(input, context);
	}

	async cleanupGit(
		input: { kind: "worktree" | "branch" },
		context: OperationContext,
	): Promise<{ outcome: "completed" | "absent" } | { outcome: "blocked"; failure: string }> {
		return this.runCleanup(input, context);
	}
}

async function harness(t: test.TestContext) {
	const directory = await mkdtemp(join(tmpdir(), "pi-orchestrator-test-"));
	t.after(async () => await rm(directory, { recursive: true, force: true }));
	const root = join(directory, "workspace");
	const agentDir = join(directory, "agent");
	await mkdir(root);
	const runtime = new FakeRuntime();
	const store = new FileRunStore(agentDir);
	return { root, runtime, store, runner: new OrchestratorRunner(runtime, runtime, store) };
}

function productiveCallCount(runtime: FakeRuntime): number {
	return runtime.contexts.filter(({ hook }) => hook !== "cleanup" && hook !== "terminate").length;
}

test("existing valid, malformed, and intervening state files are never replaced", async (t) => {
	{
		const { root, runtime, runner } = await harness(t);
		await runner.execute(request(), root);
		await assert.rejects(runner.execute(request(), root), /already exists/);
		assert.equal(runtime.preflightCalls, 1);
	}
	{
		const { root, runtime, store, runner } = await harness(t);
		const path = store.statePath(root, "request-one");
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, "malformed state\n");
		await assert.rejects(runner.execute(request(), root), /already exists/);
		await assert.rejects(store.load(root, "request-one"));
		assert.equal(await readFile(path, "utf8"), "malformed state\n");
		assert.equal(runtime.preflightCalls, 0);
	}
	{
		const { root, runtime, store, runner } = await harness(t);
		const path = store.statePath(root, "request-one");
		runtime.preflightAction = async () => await writeFile(path, "intervening state\n");
		await assert.rejects(runner.execute(request(), root), /already exists/);
		assert.equal(await readFile(path, "utf8"), "intervening state\n");
	}
});

test("preflight owns no state, while private launch materialization starts only after exclusive creation", async (t) => {
	await t.test("ordered success", async (t) => {
		const { root, runtime, store, runner } = await harness(t);
		const startedAt = runtime.clock;
		runtime.preflightAction = async () => {
			await assert.rejects(store.load(root, "request-one"));
			runtime.clock += 250;
		};
		runtime.materializeAction = async () => {
			const persisted = await store.load(root, "request-one");
			assert.equal(persisted.state.launchMaterialization.status, "materializing");
			assert.equal(persisted.state.tasks[0]!.attempts.length, 0);
			assert.equal(runtime.allocationCalls.length, 0);
		};

		const completed = await runner.execute(request(), root);
		assert.equal(completed.state.launchMaterialization.status, "ready");
		assert.ok(completed.state.launchMaterialization.at !== undefined);
		assert.equal(completed.state.deadlineStartedAt, startedAt);
		assert.equal(completed.state.createdAt, startedAt + 250);
		assert.equal(completed.state.deadline, startedAt + completed.state.request.budgetMs);
		assert.ok(runtime.contexts.findIndex(({ hook }) => hook === "preflight")
			< runtime.contexts.findIndex(({ hook }) => hook === "materialize-launches"));
		assert.ok(runtime.contexts.findIndex(({ hook }) => hook === "materialize-launches")
			< runtime.contexts.findIndex(({ hook }) => hook === "allocate"));
	});

	await t.test("preflight failure creates nothing", async (t) => {
		const { root, runtime, store, runner } = await harness(t);
		runtime.preflightAction = async () => { throw new Error("Herdr unavailable"); };
		await assert.rejects(runner.execute(request(), root), /Herdr unavailable/);
		await assert.rejects(store.load(root, "request-one"));
		assert.equal(runtime.materializeCalls, 0);
		assert.equal(runtime.allocationCalls.length, 0);
	});

	await t.test("materialization failure remains durable and fail-closed", async (t) => {
		const { root, runtime, store, runner } = await harness(t);
		runtime.materializeAction = async () => { throw new Error("private write failed"); };
		const failed = await runner.execute(request(), root);
		assert.equal(failed.state.status, "needs_attention");
		assert.equal(failed.state.launchMaterialization.status, "failed");
		assert.match(failed.state.launchMaterialization.failure!, /private write failed/);
		assert.equal(runtime.allocationCalls.length, 0);
		const persisted = await store.load(root, "request-one");
		assert.equal(persisted.state.launchMaterialization.status, "failed");
		await assert.rejects(
			runner.resume({ id: "request-one", action: "retry", taskId: "task-a" }, root),
			/materialization is failed/,
		);
		assert.equal(runtime.allocationCalls.length, 0);
	});

	await t.test("preflight cannot redirect canonical state ownership", async (t) => {
		const { root, runtime, store, runner } = await harness(t);
		const otherRoot = join(dirname(root), "other-workspace");
		await mkdir(otherRoot);
		runtime.preflightRoot = otherRoot;
		await assert.rejects(runner.execute(request(), root), /canonical request root/);
		await assert.rejects(store.load(root, "request-one"));
		assert.equal(runtime.materializeCalls, 0);
	});
});

test("owned allocation metadata is persisted exactly without adopting possible resources", async (t) => {
	const { root, runtime, runner } = await harness(t);
	runtime.allocationResources = {
		workspace: { workspaceId: "workspace-7", rootPaneId: "pane-root-9" },
		worker_tab: { tabId: "tab-11", paneId: "pane-worker-13" },
		agent: { processId: "agent-process-17" },
	};
	const completed = await runner.execute(request(), root);
	const allocations = completed.state.tasks[0]!.attempts[0]!.allocations;
	assert.deepEqual(allocations.find(({ kind }) => kind === "workspace")?.resources, runtime.allocationResources.workspace);
	assert.deepEqual(allocations.find(({ kind }) => kind === "worker_tab")?.resources, runtime.allocationResources.worker_tab);
	assert.deepEqual(allocations.find(({ kind }) => kind === "agent")?.resources, runtime.allocationResources.agent);
});

test("ready tasks dispatch in parallel, then integrate in declared dependency-wave order", async (t) => {
	const { root, runtime, runner } = await harness(t);
	runtime.workerBarrierSize = 2;
	const result = await runner.execute(request({
		tasks: [task("task-a"), task("task-b"), task("task-c", ["task-a", "task-b"])],
	}), root);

	assert.equal(result.state.accepted, true);
	assert.deepEqual(result.state.waves.map(({ taskIds }) => taskIds), [["task-a", "task-b"], ["task-c"]]);
	assert.deepEqual(runtime.integrationCalls, ["task-a", "task-b", "task-c"]);
	assert.deepEqual(runtime.workerCalls.slice(0, 2).map(({ taskId }) => taskId).sort(), ["task-a", "task-b"]);
	assert.equal(result.state.waves[1]!.base.head, runtime.rebaseCalls[2]!.onto.head);
});

test("mixed Role/model launches remain keyed and recover exactly before finalization", async (t) => {
	const { root, runtime, runner } = await harness(t);
	const definition = request({
		tasks: [
			task("task-a", [], "fast", { criterion: "Review A.", modelClass: "balanced" }),
			task("task-b", ["task-a"], "frontier"),
		],
		finalJudgment: { criterion: "Review all work.", modelClass: "fav" },
	});
	runtime.checkPlans.push({}, {}, {}, {}, { error: new Error("lost final check result") });
	const interrupted = await runner.execute(definition, root);
	assert.equal(interrupted.state.final.status, "interrupted");
	const originalDeadline = interrupted.state.deadline;
	runtime.clock += 100;
	assert.deepEqual(Object.keys(interrupted.state.launchRecords).sort(), [
		"implementer/fast", "implementer/frontier", "reviewer/balanced", "reviewer/fav",
	]);

	const completed = await runner.resume({ id: definition.id, action: "finalize" }, root);
	assert.equal(completed.state.accepted, true);
	assert.equal(completed.state.deadline, originalDeadline);
	assert.equal(completed.state.deadline, completed.state.deadlineStartedAt + completed.state.request.budgetMs);
	assert.deepEqual(runtime.recoverCalls, [interrupted.state.launchRecords]);
	assert.deepEqual(runtime.workerCalls.map(({ launchKey }) => launchKey), ["implementer/fast", "implementer/frontier"]);
	assert.deepEqual(runtime.reviewCalls.map(({ launchKey }) => launchKey), ["reviewer/balanced", "reviewer/balanced", "reviewer/fav"]);
});

test("completed task and request states require exact authoritative evidence and termination", async (t) => {
	const { root, runner } = await harness(t);
	const valid = (await runner.execute(request(), root)).state;
	assert.doesNotThrow(() => parseRunState(structuredClone(valid)));

	const tamperedLaunch = structuredClone(valid);
	tamperedLaunch.launchRecords["implementer/fast"]!.tools.push("bash");
	assert.throws(() => parseRunState(tamperedLaunch), /fingerprint.*complete contents/i);

	const missingTermination = structuredClone(valid);
	missingTermination.tasks[0]!.attempts[0]!.termination!.status = "unknown";
	assert.throws(() => parseRunState(missingTermination), /worker termination/i);

	const preliminaryOnly = structuredClone(valid);
	preliminaryOnly.tasks[0]!.attempts[0]!.authoritativeChecks!.phase = "preliminary";
	assert.throws(() => parseRunState(preliminaryOnly), /authoritative/i);

	const malformedCleanup = structuredClone(valid);
	malformedCleanup.tasks[0]!.attempts[0]!.cleanup[1]!.kind = "worker_tab";
	assert.throws(() => parseRunState(malformedCleanup), /cleanup sequence/i);

	const wrongWorktreeBase = structuredClone(valid);
	wrongWorktreeBase.tasks[0]!.attempts[0]!.allocations[0]!.worktree!.baseCommit = oid("f");
	assert.throws(() => parseRunState(wrongWorktreeBase), /worktree.*wave base/i);

	const dirtyFinal = structuredClone(valid);
	const dirtyIdentity = { ...dirtyFinal.final.identity!, index: oid("f") };
	dirtyFinal.main = dirtyIdentity;
	dirtyFinal.final.identity = dirtyIdentity;
	dirtyFinal.final.checks!.candidate = dirtyIdentity;
	dirtyFinal.final.checks!.identityAfter = dirtyIdentity;
	assert.throws(() => parseRunState(dirtyFinal), /final checks|clean/i);

	const uncheckedCompletion = structuredClone(valid);
	uncheckedCompletion.accepted = false;
	delete uncheckedCompletion.acceptedAt;
	uncheckedCompletion.final = { status: "pending" };
	assert.throws(() => parseRunState(uncheckedCompletion), /completed.*accepted|accepted.*completed/i);
});

test("one absolute deadline bounds workers, checks, reviews, integration, and final checks", async (t) => {
	for (const target of ["worker", "checks", "review", "integration", "final-checks"] as const) {
		await t.test(target, async (t) => {
			const { root, runtime, runner } = await harness(t);
			const definition = request({
				budgetMs: 1_000,
				tasks: [task("task-a", [], "fast", target === "review" ? { criterion: "Review A.", modelClass: "balanced" } : undefined)],
			});
			if (target === "worker") runtime.workerPlans.push({ expire: true });
			if (target === "checks") runtime.checkPlans.push({ expire: true });
			if (target === "review") runtime.reviewPlans.push({ expire: true });
			if (target === "integration") runtime.expireHook = "integration";
			if (target === "final-checks") runtime.checkPlans.push({}, {}, { expire: true });

			const result = await runner.execute(definition, root);
			assert.equal(result.state.accepted, false);
			assert.ok(runtime.contexts.some(({ hook }) => hook === target));
			const productive = runtime.contexts.filter(({ hook }) => hook !== "cleanup" && hook !== "terminate");
			assert.equal(new Set(productive.map(({ context }) => context.deadline)).size, 1);
			assert.equal(new Set(productive.map(({ context }) => context.signal)).size, 1);
			assert.ok(productive.every(({ context }) => context.timeoutMs > 0 && context.timeoutMs <= definition.budgetMs));
		});
	}
});

test("a failed preliminary gate gets one correction in the same recorded worker", async (t) => {
	const { root, runtime, runner } = await harness(t);
	runtime.checkPlans.push({ code: 1 }, {}, {});
	const result = await runner.execute(request(), root);
	assert.equal(result.state.accepted, true);
	assert.deepEqual(runtime.workerCalls.map(({ kind }) => kind), ["initial", "correction"]);
	assert.equal(new Set(runtime.workerCalls.map(({ workerId }) => workerId)).size, 1);
	assert.equal(runtime.allocationCalls.filter((kind) => kind === "agent").length, 1);
	assert.equal(runtime.candidateInspectionCalls.length, 2);
	assert.equal(runtime.workerCalls[0]!.preCandidate.branch, "refs/heads/task-a");
	assert.deepEqual(runtime.workerCalls[1]!.preCandidate, result.state.tasks[0]!.attempts[0]!.prompts[0]!.candidate);
	assert.deepEqual(result.state.tasks[0]!.attempts[0]!.prompts.map(({ preCandidate }) => preCandidate),
		runtime.workerCalls.map(({ preCandidate }) => preCandidate));
});

test("every prompt uses a fresh exact candidate inspection and safety termination is non-productive", async (t) => {
	await t.test("correction drift", async (t) => {
		const { root, runtime, runner } = await harness(t);
		const initial = identity("a", "refs/heads/task-a");
		const drifted = identity("f", "refs/heads/task-a");
		runtime.candidateInspectionPlans.push({ identity: initial }, { identity: drifted });
		runtime.checkPlans.push({ code: 1 });
		const stopped = await runner.execute(request(), root);
		const attempt = stopped.state.tasks[0]!.attempts[0]!;
		assert.equal(stopped.state.tasks[0]!.status, "needs_attention");
		assert.deepEqual(runtime.workerCalls.map(({ kind }) => kind), ["initial"]);
		assert.equal(attempt.prompts.length, 1);
		assert.deepEqual(attempt.prompts[0]!.preCandidate, initial);
		assert.deepEqual(attempt.termination?.candidate, drifted);
		assert.equal(attempt.termination?.status, "terminated");
	});

	await t.test("blocked-worker correction drift", async (t) => {
		const { root, runtime, runner } = await harness(t);
		const initial = identity("a", "refs/heads/task-a");
		const drifted = identity("f", "refs/heads/task-a");
		runtime.candidateInspectionPlans.push({ identity: initial }, { identity: drifted });
		runtime.workerPlans.push({ outcome: "blocked", diagnostic: "worker blocked" });
		const stopped = await runner.execute(request(), root);
		const attempt = stopped.state.tasks[0]!.attempts[0]!;
		assert.deepEqual(runtime.workerCalls.map(({ kind }) => kind), ["initial"]);
		assert.equal(attempt.prompts.length, 1);
		assert.deepEqual(attempt.prompts[0]!.preCandidate, initial);
		assert.deepEqual(attempt.termination?.candidate, drifted);
		assert.match(stopped.state.tasks[0]!.failure!, /identity drifted/);
	});

	await t.test("invalid inspected identity", async (t) => {
		const { root, runtime, runner } = await harness(t);
		const dirty = { ...identity("a", "refs/heads/task-a"), index: oid("f") };
		runtime.candidateInspectionPlans.push({ identity: dirty });
		const stopped = await runner.execute(request(), root);
		const attempt = stopped.state.tasks[0]!.attempts[0]!;
		assert.equal(attempt.prompts.length, 0);
		assert.equal(runtime.workerCalls.length, 0);
		assert.deepEqual(attempt.termination?.candidate, dirty);
		assert.match(stopped.state.tasks[0]!.failure!, /invalid owned worktree identity/);
	});

	await t.test("inspection failure", async (t) => {
		const { root, runtime, runner } = await harness(t);
		runtime.candidateInspectionPlans.push({ error: new Error("candidate inspection failed") });
		const stopped = await runner.execute(request(), root);
		const attempt = stopped.state.tasks[0]!.attempts[0]!;
		assert.equal(attempt.prompts.length, 0);
		assert.equal(runtime.workerCalls.length, 0);
		assert.equal(attempt.termination?.workerId, "task-a-agent");
		assert.equal(attempt.termination?.status, "terminated");
		const termination = runtime.contexts.find(({ hook }) => hook === "terminate")!;
		assert.equal(termination.context.deadline, runtime.clock + TERMINATION_SAFETY_BUDGET_MS);
		assert.notEqual(termination.context.deadline, stopped.state.deadline);
		assert.deepEqual(runtime.contexts.filter(({ context }) => context.deadline === termination.context.deadline)
			.map(({ hook }) => hook), ["terminate"]);
	});
});

test("preliminary review drift, throws, and ambiguous verdicts terminate in attention without correction", async (t) => {
	const cases: [string, ReviewPlan][] = [
		["drift", { verdict: "PASS", identityAfter: identity("f", "refs/heads/task-a") }],
		["throw", { error: new Error("review transport lost") }],
		["ambiguity", { verdict: "UNCLEAR" }],
	];
	for (const [name, plan] of cases) {
		await t.test(name, async (t) => {
			const { root, runtime, runner } = await harness(t);
			runtime.reviewPlans.push(plan);
			const result = await runner.execute(request({
				tasks: [task("task-a", [], "fast", { criterion: "Review A.", modelClass: "balanced" })],
			}), root);
			assert.equal(result.state.tasks[0]!.status, "needs_attention");
			assert.equal(result.state.tasks[0]!.attempts[0]!.termination?.status, "terminated");
			await assert.rejects(
				runner.resume({ id: "request-one", action: "retry", taskId: "task-a" }, root),
				/correction is unavailable/,
			);
			assert.deepEqual(runtime.workerCalls.map(({ kind }) => kind), ["initial"]);
		});
	}
});

test("review crash boundaries persist attention and never become correction-eligible", async (t) => {
	const cases: [string, ReviewPlan, "missing" | "non-pass" | "drift"][] = [
		["passed checks awaiting or interrupted review", { error: new Error("review transport lost") }, "missing"],
		["persisted non-PASS review", { verdict: "NEEDS_WORK" }, "non-pass"],
		["persisted drifted review", { verdict: "PASS", identityAfter: identity("f", "refs/heads/task-a") }, "drift"],
	];
	for (const [name, plan, evidence] of cases) {
		await t.test(name, async (t) => {
			const { root, runtime, store, runner } = await harness(t);
			runtime.reviewPlans.push(plan);
			await runner.execute(request({
				tasks: [task("task-a", [], "fast", { criterion: "Review A.", modelClass: "balanced" })],
			}), root);
			const handle = await store.load(root, "request-one");
			const taskState = handle.state.tasks[0]!;
			const attempt = taskState.attempts[0]!;
			assert.equal(attempt.preliminaryChecks?.passed, true);
			assert.equal(evidence === "missing", attempt.preliminaryReview === undefined);
			if (evidence === "non-pass") {
				assert.equal(attempt.preliminaryReview?.passed, false);
				assert.deepEqual(attempt.preliminaryReview?.identityAfter, attempt.candidate);
			}
			if (evidence === "drift") {
				assert.equal(attempt.preliminaryReview?.passed, false);
				assert.notDeepEqual(attempt.preliminaryReview?.identityAfter, attempt.candidate);
			}

			delete attempt.termination;
			handle.state.status = "running";
			handle.state.waves[0]!.status = "dispatching";
			taskState.status = "working";
			taskState.failure = undefined;
			await handle.save();

			const recovered = await runner.status("request-one", root);
			assert.equal(recovered.state.tasks[0]!.status, "needs_attention");
			assert.equal(recovered.state.tasks[0]!.attempts[0]!.termination?.status, "unknown");
			assert.match(recovered.state.tasks[0]!.failure!, /ambiguous boundary/);
			await assert.rejects(
				runner.resume({ id: "request-one", action: "retry", taskId: "task-a" }, root),
				/correction is unavailable/,
			);
			assert.deepEqual(runtime.workerCalls.map(({ kind }) => kind), ["initial"]);
			const persisted = await store.load(root, "request-one");
			assert.equal(persisted.state.tasks[0]!.status, "needs_attention");
			assert.equal(persisted.state.tasks[0]!.attempts[0]!.termination?.status, "terminated");
			assert.equal(runtime.terminationCalls.at(-1)?.workerId, "task-a-agent");
		});
	}
});

test("verify accepts a manually repaired candidate only after recorded worker termination", async (t) => {
	const { root, runtime, runner } = await harness(t);
	runtime.checkPlans.push({ code: 1 }, { code: 1 });
	const blocked = await runner.execute(request(), root);
	assert.equal(blocked.state.tasks[0]!.attempts[0]!.termination?.status, "terminated");
	runtime.retainedCandidate = identity("f", "refs/heads/task-a");
	const verified = await runner.resume({ id: "request-one", action: "verify", taskId: "task-a" }, root);
	assert.equal(verified.state.accepted, true);
	assert.equal(verified.state.tasks[0]!.attempts[0]!.integrationCandidate!.head, oid("f"));
});

test("manual verify rejects a clean retained candidate with the wave-base head", async (t) => {
	const { root, runtime, runner } = await harness(t);
	runtime.checkPlans.push({ code: 1 }, { code: 1 });
	await runner.execute(request(), root);
	runtime.retainedCandidate = identity("a", "refs/heads/task-a");
	await assert.rejects(
		runner.resume({ id: "request-one", action: "verify", taskId: "task-a" }, root),
		/must differ from its wave base/,
	);
	assert.equal(runtime.integrationCalls.length, 0);
});

test("an interrupted prompt enters attention and is never replayed", async (t) => {
	const { root, runtime, runner } = await harness(t);
	runtime.workerPlans.push({ error: new Error("transport interrupted") });
	const interrupted = await runner.execute(request(), root);
	const attempt = interrupted.state.tasks[0]!.attempts[0]!;
	assert.equal(interrupted.state.tasks[0]!.status, "needs_attention");
	assert.equal(attempt.prompts[0]!.status, "ambiguous");
	assert.equal(attempt.termination?.status, "terminated");
	assert.deepEqual(runtime.terminationCalls, [{
		workerId: attempt.allocations.find(({ kind }) => kind === "agent")!.resourceId!,
		candidate: attempt.prompts[0]!.preCandidate,
	}]);
	await assert.rejects(
		runner.resume({ id: "request-one", action: "retry", taskId: "task-a" }, root),
		/never replayed/,
	);
	assert.equal(runtime.workerCalls.length, 1);
});

test("abort terminates only exact saved active workers under one non-productive safety deadline", async (t) => {
	const { root, runtime, store, runner } = await harness(t);
	runtime.workerPlans.push(
		{ error: new Error("task-a prompt interrupted") },
		{ error: new Error("task-b prompt interrupted") },
	);
	await runner.execute(request({ tasks: [task("task-a"), task("task-b")] }), root);
	const handle = await store.load(root, "request-one");
	const retainedAllocations = handle.state.tasks.map(({ attempts }) => structuredClone(attempts[0]!.allocations));
	for (const taskState of handle.state.tasks) delete taskState.attempts[0]!.termination;
	await handle.save();

	runtime.terminationCalls.length = 0;
	const contextStart = runtime.contexts.length;
	const productiveBefore = productiveCallCount(runtime);
	const cleanupBefore = runtime.cleanupCalls.length;
	const abortStartedAt = runtime.clock;
	runtime.terminationPlans.push(
		{ outcome: "terminated" },
		{ outcome: "unknown", failure: "process state unavailable" },
	);
	const aborted = await runner.abort("request-one", root);

	assert.equal(aborted.state.status, "aborted");
	assert.equal(aborted.state.accepted, false);
	assert.deepEqual(runtime.terminationCalls.map(({ workerId }) => workerId), ["task-a-agent", "task-b-agent"]);
	for (const [index, call] of runtime.terminationCalls.entries()) {
		assert.deepEqual(call.candidate, aborted.state.tasks[index]!.attempts[0]!.prompts[0]!.preCandidate);
	}
	assert.equal(aborted.state.tasks[0]!.attempts[0]!.termination?.status, "terminated");
	assert.equal(aborted.state.tasks[1]!.attempts[0]!.termination?.status, "unknown");
	assert.match(aborted.state.tasks[1]!.attempts[0]!.termination?.failure ?? "", /process state unavailable/);
	assert.deepEqual(aborted.state.tasks.map(({ attempts }) => attempts[0]!.allocations), retainedAllocations);
	assert.equal(runtime.cleanupCalls.length, cleanupBefore);
	assert.equal(productiveCallCount(runtime), productiveBefore);
	const abortContexts = runtime.contexts.slice(contextStart);
	assert.deepEqual(abortContexts.map(({ hook }) => hook), ["terminate", "terminate"]);
	assert.deepEqual([...new Set(abortContexts.map(({ context }) => context.deadline))], [
		abortStartedAt + TERMINATION_SAFETY_BUDGET_MS,
	]);
	assert.equal(aborted.continuation, undefined);
});

test("promptless attempts with terminated or uncertain saved agents cannot be retried", async (t) => {
	for (const [name, plan, status] of [
		["terminated", { outcome: "terminated" }, "terminated"],
		["unknown", { outcome: "unknown", failure: "process state unavailable" }, "unknown"],
	] satisfies [string, TerminationPlan, "terminated" | "unknown"][]) {
		await t.test(name, async (t) => {
			const { root, runtime, runner } = await harness(t);
			runtime.candidateInspectionPlans.push({ error: new Error("candidate inspection failed") });
			runtime.terminationPlans.push(plan);
			const stopped = await runner.execute(request(), root);
			const attempt = stopped.state.tasks[0]!.attempts[0]!;
			assert.equal(attempt.prompts.length, 0);
			assert.equal(attempt.allocations.find(({ kind }) => kind === "agent")?.status, "owned");
			assert.equal(attempt.termination?.status, status);

			await assert.rejects(
				runner.resume({ id: "request-one", action: "retry", taskId: "task-a" }, root),
				/promptless attempt.*saved agent.*cannot be retried productively/,
			);
			assert.equal(runtime.allocationCalls.filter((kind) => kind === "agent").length, 1);
			assert.equal(runtime.workerCalls.length, 0);
			assert.deepEqual(runtime.reconciliationCalls, []);
		});
	}
});

test("unknown allocations block adoption, while a proved-absent unprompted start gets one fresh allocation", async (t) => {
	{
		const { root, runtime, runner } = await harness(t);
		runtime.allocationFailure = { kind: "agent", error: new Error("lost result") };
		const interrupted = await runner.execute(request(), root);
		const intent = interrupted.state.tasks[0]!.attempts[0]!.allocations.at(-1)!;
		assert.equal(intent.status, "unknown");
		assert.equal(intent.kind, "agent");
		assert.ok(intent.token);
		runtime.reconciliation = { outcome: "possible", failure: "matching agent exists", possibleResources: ["candidate-agent"] };
		await assert.rejects(
			runner.resume({ id: "request-one", action: "retry", taskId: "task-a" }, root),
			/was not adopted or closed/,
		);
		assert.equal(runtime.allocationCalls.filter((kind) => kind === "agent").length, 1);
	}
	{
		const { root, runtime, runner } = await harness(t);
		runtime.allocationFailure = { kind: "agent", error: new Error("lost result") };
		await runner.execute(request(), root);
		runtime.reconciliation = { outcome: "absent" };
		const completed = await runner.resume({ id: "request-one", action: "retry", taskId: "task-a" }, root);
		assert.equal(completed.state.accepted, true);
		assert.equal(runtime.allocationCalls.filter((kind) => kind === "agent").length, 2);
		assert.equal(runtime.allocationCalls.filter((kind) => kind === "worktree").length, 1);
	}
});

test("pre-wave drift and inspection failure remain actionable without creating an attempt", async (t) => {
	for (const [name, plan] of [
		["drift", { identity: identity("f") }],
		["inspection failure", { error: new Error("inspection unavailable") }],
	] satisfies [string, InspectionPlan][]) {
		await t.test(name, async (t) => {
			const { root, runtime, runner } = await harness(t);
			runtime.inspectionPlans.push(plan);
			const waiting = await runner.execute(request(), root);
			assert.equal(waiting.state.tasks[0]!.status, "needs_attention");
			assert.equal(waiting.state.tasks[0]!.attempts.length, 0);
			assert.deepEqual(waiting.continuation, { id: "request-one", action: "retry", taskId: "task-a" });
			assert.equal(runtime.workerCalls.length, 0);

			const completed = await runner.resume(waiting.continuation!, root);
			assert.equal(completed.state.accepted, true);
		});
	}
});

test("an initial persisted pending scheduler state recovers to a no-attempt retry", async (t) => {
	const { root, runtime, store, runner } = await harness(t);
	runtime.inspectionPlans.push({ error: new Error("inspection unavailable") });
	await runner.execute(request(), root);
	const handle = await store.load(root, "request-one");
	handle.state.status = "pending";
	handle.state.tasks[0]!.status = "pending";
	handle.state.tasks[0]!.failure = undefined;
	await handle.save();

	const recovered = await runner.status("request-one", root);
	assert.equal(recovered.state.tasks[0]!.status, "needs_attention");
	assert.deepEqual(recovered.continuation, { id: "request-one", action: "retry", taskId: "task-a" });
	const completed = await runner.resume(recovered.continuation!, root);
	assert.equal(completed.state.accepted, true);
});

test("cleanup accepts only explicit completed or absent outcomes", async (t) => {
	await t.test("absent", async (t) => {
		const { root, runtime, runner } = await harness(t);
		runtime.cleanupPlans.push({ outcome: "absent" });
		const result = await runner.execute(request(), root);
		assert.equal(result.state.accepted, true);
	});

	await t.test("unexpected", async (t) => {
		const { root, runtime, runner } = await harness(t);
		runtime.cleanupPlans.push({ outcome: "unexpected" as never });
		const result = await runner.execute(request(), root);
		assert.equal(result.state.tasks[0]!.status, "needs_attention");
		assert.equal(result.state.tasks[0]!.attempts[0]!.cleanup[0]!.status, "pending");
		assert.match(result.state.tasks[0]!.failure!, /failed closed/);
		assert.deepEqual(runtime.cleanupCalls, ["worker_tab"]);
	});
});

test("cleanup-only verify finishes exact cleanup after expiry without productive hooks or acceptance", async (t) => {
	const { root, runtime, store, runner } = await harness(t);
	runtime.cleanupPlans.push({}, { expire: true });
	const interrupted = await runner.execute(request({ budgetMs: 1_000 }), root);
	const attempt = interrupted.state.tasks[0]!.attempts[0]!;
	assert.equal(attempt.integration?.status, "integrated");
	assert.deepEqual(attempt.cleanup.map(({ status }) => status), ["completed", "pending", "pending", "pending"]);
	const beforeProductive = productiveCallCount(runtime);

	const cleaned = await runner.resume({ id: "request-one", action: "verify", taskId: "task-a" }, root);
	assert.equal(cleaned.state.tasks[0]!.status, "completed");
	assert.equal(cleaned.state.accepted, false);
	assert.equal(cleaned.state.final.status, "pending");
	assert.ok(cleaned.state.tasks[0]!.attempts[0]!.cleanup.every(({ status }) => status === "completed"));
	assert.equal(productiveCallCount(runtime), beforeProductive);
	assert.equal(cleaned.state.recovery, undefined);
	assert.deepEqual(cleaned.continuation, { id: "request-one", action: "finalize" });

	const expiredDeadline = cleaned.state.deadline;
	const continuationContextIndex = runtime.contexts.length;
	await assert.rejects(runner.resume(cleaned.continuation!, root), /deadline is exhausted/);
	assert.equal(runtime.contexts.length, continuationContextIndex);
	assert.equal((await store.load(root, "request-one")).state.deadline, expiredDeadline);
	assert.equal(cleaned.state.deadline, cleaned.state.deadlineStartedAt + cleaned.state.request.budgetMs);
});

test("cleanup-only verify exposes a runnable pending-wave continuation without productive work", async (t) => {
	const { root, runtime, store, runner } = await harness(t);
	runtime.cleanupPlans.push({ outcome: "blocked", failure: "workspace still busy" });
	const definition = request({
		tasks: [task("task-a"), task("task-b", ["task-a"])],
	});
	const interrupted = await runner.execute(definition, root);
	runtime.clock = interrupted.state.deadline;
	const beforeProductive = productiveCallCount(runtime);

	const cleaned = await runner.resume({ id: "request-one", action: "verify", taskId: "task-a" }, root);
	assert.equal(productiveCallCount(runtime), beforeProductive);
	assert.equal(cleaned.state.tasks[1]!.status, "needs_attention");
	assert.deepEqual(cleaned.continuation, { id: "request-one", action: "retry", taskId: "task-b" });

	const expiredDeadline = cleaned.state.deadline;
	const continuationContextIndex = runtime.contexts.length;
	await assert.rejects(runner.resume(cleaned.continuation!, root), /deadline is exhausted/);
	assert.equal(runtime.contexts.length, continuationContextIndex);
	assert.equal((await store.load(root, "request-one")).state.deadline, expiredDeadline);
});

test("cleanup-only verify exposes a retained same-wave peer for later verification", async (t) => {
	const { root, runtime, runner } = await harness(t);
	runtime.cleanupPlans.push({ outcome: "blocked", failure: "workspace still busy" });
	const interrupted = await runner.execute(request({
		tasks: [task("task-a"), task("task-b")],
	}), root);
	assert.equal(interrupted.state.tasks[0]!.status, "needs_attention");
	assert.equal(interrupted.state.tasks[1]!.status, "needs_attention");
	assert.equal(interrupted.state.tasks[1]!.attempts[0]!.termination?.status, "terminated");
	assert.deepEqual(interrupted.continuation, { id: "request-one", action: "verify", taskId: "task-a" });
	const beforeProductive = productiveCallCount(runtime);

	const cleaned = await runner.resume(interrupted.continuation!, root);
	assert.equal(productiveCallCount(runtime), beforeProductive);
	assert.equal(cleaned.state.tasks[0]!.status, "completed");
	assert.equal(cleaned.state.tasks[1]!.status, "needs_attention");
	assert.deepEqual(cleaned.continuation, { id: "request-one", action: "verify", taskId: "task-b" });

	const completed = await runner.resume(cleaned.continuation!, root);
	assert.equal(completed.state.accepted, true);
	assert.deepEqual(runtime.integrationCalls, ["task-a", "task-b"]);
});

test("cleanup verification never reintegrates an already accepted task tip", async (t) => {
	const { root, runtime, store, runner } = await harness(t);
	await runner.execute(request(), root);
	const handle = await store.load(root, "request-one");
	handle.state.status = "running";
	handle.state.accepted = false;
	delete handle.state.acceptedAt;
	handle.state.final = { status: "pending" };
	handle.state.tasks[0]!.status = "cleanup";
	await handle.save();
	await runner.status("request-one", root);
	const integrations = runtime.integrationCalls.length;
	const productive = productiveCallCount(runtime);

	const recovered = await runner.resume({ id: "request-one", action: "verify", taskId: "task-a" }, root);
	assert.equal(recovered.state.tasks[0]!.status, "completed");
	assert.equal(recovered.state.accepted, false);
	assert.equal(runtime.integrationCalls.length, integrations);
	assert.equal(productiveCallCount(runtime), productive);
});

test("definitive final failure and Main drift are terminal, while exact final evidence accepts", async (t) => {
	await t.test("definitive failure", async (t) => {
		const { root, runtime, runner } = await harness(t);
		runtime.checkPlans.push({}, {}, { code: 1 });
		const failed = await runner.execute(request(), root);
		assert.equal(failed.state.status, "final_failed");
		const checks = runtime.checkCalls.length;
		await assert.rejects(runner.resume({ id: "request-one", action: "finalize" }, root), /terminal/);
		assert.equal(runtime.checkCalls.length, checks);
	});

	await t.test("final check mutation", async (t) => {
		const { root, runtime, runner } = await harness(t);
		runtime.checkPlans.push({}, {}, { identityAfter: identity("f") });
		const superseded = await runner.execute(request(), root);
		assert.equal(superseded.state.status, "superseded");
		await assert.rejects(runner.resume({ id: "request-one", action: "finalize" }, root), /terminal/);
	});

	await t.test("Main drift after final checks", async (t) => {
		const { root, runtime, runner } = await harness(t);
		runtime.checkPlans.push({}, {}, { mutateMain: identity("f") });
		const superseded = await runner.execute(request(), root);
		assert.equal(superseded.state.status, "superseded");
		assert.match(superseded.state.final.failure!, /drifted after final checks/);
	});

	await t.test("acceptance", async (t) => {
		const { root, runtime, runner } = await harness(t);
		const completed = await runner.execute(request({
			finalJudgment: { criterion: "The whole request is correct.", modelClass: "balanced" },
		}), root);
		assert.equal(completed.state.status, "completed");
		assert.equal(completed.state.accepted, true);
		assert.equal(completed.state.final.status, "passed");
		assert.doesNotThrow(() => parseRunState(structuredClone(completed.state)));
		assert.deepEqual(runtime.reviewCalls.map(({ scope }) => scope), ["final"]);
	});
});
