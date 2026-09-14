import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
	OrchestratorRunner,
	STATUS_INSPECTION_BUDGET_MS,
	TERMINATION_SAFETY_BUDGET_MS,
	type AllocationReconciliation,
	type AllocationResult,
	type HostAllocationKind,
	type HostAllocationResult,
	type WorktreeAllocationResult,
	type CheckRunResult,
	type CommandResult,
	type IntegrationResult,
	type OperationContext,
	type OrchestratorRuntime,
	type RebaseResult,
	type ReviewResult,
	type TransientLaunchHandle,
	type VerifiedLaunch,
	withTransientLaunch,
	type WorkerResult,
} from "../src/runner.ts";
import {
	launchRecordFingerprint,
	MAX_PERSISTED_RUNTIME_TEXT_BYTES,
	MAX_POSSIBLE_RESOURCES,
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
	type HostAllocationIntent,
	type HostAllocationPlan,
	type TaskAttempt,
	type TaskRequest,
	type WorktreeAllocationIntent,
	type WorktreeAllocationPlan,
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
	killed?: boolean;
	stdout?: string;
	stderr?: string;
	results?: CommandResult[];
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
	preflightCwds: string[] = [];
	recoverCalls: Record<string, NormalizedLaunchRecord>[] = [];
	allocationCalls: AllocationKind[] = [];
	allocationPlanGoals: string[] = [];
	reconciliationCalls: AllocationKind[] = [];
	agentStartCalls: {
		launchKey: string;
		args: string[];
		exposedPersistedFields: boolean;
	}[] = [];
	workerCalls: {
		goal: string;
		taskId: string;
		workerId: string;
		kind: "initial" | "correction";
		preCandidate: WorkspaceIdentity;
	}[] = [];
	checkCalls: { scope: "task" | "final"; taskId?: string }[] = [];
	reviewCalls: {
		scope: "task" | "final";
		phase: "authoritative" | "final";
		taskId?: string;
		launchKey: string;
		workerTermination?: NonNullable<TaskAttempt["termination"]>["status"];
		args: string[];
		exposedPersistedFields: boolean;
	}[] = [];
	acquisitionCalls: string[] = [];
	transientCleanupCalls: string[] = [];
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
	allocationPlanError?: Error;
	allocationResources: {
		workspace?: { workspaceId: string; rootTabId: string; rootPaneId: string };
		worker_tab?: { tabId: string; paneId: string };
	} = {};
	reconciliation: { outcome: "absent" } | { outcome: "possible"; failure: string; possibleResources?: string[] } = { outcome: "absent" };
	preflightAction?: () => Promise<void>;
	preflightRoot?: string;
	acquireLaunchAction?: (record: NormalizedLaunchRecord) => Promise<void>;
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
			const roleSkills = route.role === "implementer" ? [skillPath] : [];
			const record: Omit<NormalizedLaunchRecord, "fingerprint"> = {
				key,
				...route,
				roleFingerprint: sha256(`${route.role}/${route.modelClass} predefined Role`),
				promptSha256: sha256(`${route.role}/${route.modelClass} predefined Role prompt`),
				promptArgIndex: 4,
				model: `${route.modelClass}-model`,
				thinkingLevel: "high",
				args: ["--model", `${route.modelClass}-model`, "--thinking", "high"],
				env: {},
				tools: route.role === "implementer" ? ["read", "edit"] : ["read"],
				roleExtensions: [extensionPath],
				roleSkills,
				resources: [
					{ kind: "extension", path: extensionPath, sha256: "1".repeat(64) },
					...roleSkills.map((path) => ({ kind: "skill" as const, path, sha256: "2".repeat(64) })),
				],
			};
			return { ...record, fingerprint: launchRecordFingerprint(record) };
		});
	}

	async preflight(input: { request: ExecuteRequest; cwd: string }, context: OperationContext) {
		this.preflightCalls += 1;
		this.preflightCwds.push(input.cwd);
		this.observe("preflight", context);
		await this.preflightAction?.();
		return { root: this.preflightRoot ?? input.cwd, main: { ...this.main }, launchRecords: this.launchRecords(input.request) };
	}

	async recoverLaunchRecords(
		input: { root: string; request: ExecuteRequest; records: Record<string, NormalizedLaunchRecord> },
		context: OperationContext,
	): Promise<LaunchRecord[]> {
		this.observe("recover-launches", context);
		this.recoverCalls.push(structuredClone(input.records));
		return Object.values(input.records).map((record) => structuredClone(record));
	}

	async acquireLaunch(record: NormalizedLaunchRecord, context: OperationContext): Promise<TransientLaunchHandle> {
		this.observe("acquire-launch", context);
		this.acquisitionCalls.push(record.key);
		await this.acquireLaunchAction?.(record);
		const promptPath = `/tmp/ephemeral-role-${this.acquisitionCalls.length}`;
		const args = [...record.args];
		args.splice(record.promptArgIndex, 0, "--append-system-prompt", promptPath);
		const common = {
			key: record.key,
			modelClass: record.modelClass,
			model: record.model,
			thinkingLevel: record.thinkingLevel,
			args,
			env: { ...record.env },
			tools: [...record.tools],
			fingerprint: record.fingerprint,
		};
		const launch = record.role === "implementer"
			? { ...common, role: "implementer" as const }
			: { ...common, role: "reviewer" as const };
		return {
			launch,
			cleanup: async () => { this.transientCleanupCalls.push(record.key); },
		};
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
		input: { readonly goal: ExecuteRequest["goal"]; kind: Exclude<AllocationKind, "worktree">; task: TaskRequest; attempt: TaskAttempt },
		context: OperationContext,
	): Promise<HostAllocationPlan> {
		this.observe("plan-allocation", context);
		this.allocationPlanGoals.push(input.goal);
		if (this.allocationPlanError) throw this.allocationPlanError;
		const worktree = input.attempt.allocations.find((allocation): allocation is WorktreeAllocationIntent => allocation.kind === "worktree")?.worktree;
		if (!worktree) throw new Error("missing worktree plan");
		if (input.kind === "workspace") return {
			kind: "workspace", label: `${input.task.id}-workspace`, worktreeCwd: worktree.cwd,
			mainRoot: worktree.repoRoot, repoKey: worktree.repoRoot, herdrRepoRoot: worktree.repoRoot,
		};
		const workspace = input.attempt.allocations.find((allocation) => allocation.kind === "workspace");
		if (!workspace || workspace.kind !== "workspace" || !workspace.workspaceId || !workspace.rootTabId || !workspace.rootPaneId) {
			throw new Error("missing workspace allocation");
		}
		if (input.kind === "worker_tab") return {
			kind: "worker_tab", label: `${input.task.id}-worker`, workspaceId: workspace.workspaceId,
			workspaceRootTabId: workspace.rootTabId, workspaceRootPaneId: workspace.rootPaneId,
			worktreeCwd: worktree.cwd, leasePath: `/tmp/${input.attempt.correlationToken}.lease`,
		};
		const tab = input.attempt.allocations.find((allocation) => allocation.kind === "worker_tab");
		if (!tab || tab.kind !== "worker_tab" || !tab.tabId || !tab.paneId) throw new Error("missing worker tab allocation");
		return {
			kind: "agent", agentName: `${input.task.id}-agent`, workspaceId: workspace.workspaceId,
			tabId: tab.tabId, paneId: tab.paneId, worktreeCwd: worktree.cwd, leasePath: tab.leasePath,
		};
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
		if (input.intent.kind === "workspace") return {
			kind: "workspace", outcome: "owned",
			...(this.allocationResources.workspace ?? {
				workspaceId: `${input.task.id}-workspace`, rootTabId: `${input.task.id}-root-tab`, rootPaneId: `${input.task.id}-root-pane`,
			}),
		};
		if (input.intent.kind === "worker_tab") return {
			kind: "worker_tab", outcome: "owned",
			...(this.allocationResources.worker_tab ?? { tabId: `${input.task.id}-worker-tab`, paneId: `${input.task.id}-worker-pane` }),
		};
		return { kind: input.intent.kind, outcome: "owned" };
	}

	async allocateWorktree(
		input: { root: string; intent: WorktreeAllocationIntent; task: TaskRequest; attempt: TaskAttempt; onPrepared(worktree: WorktreeAllocationPlan): Promise<void> },
		context: OperationContext,
	): Promise<WorktreeAllocationResult> {
		const planned: WorktreeAllocationPlan = {
			path: `/fake/${input.task.id}-worktree`, cwd: `/fake/${input.task.id}-worktree`, branch: input.task.id,
			repoRoot: "/fake", baseCommit: input.attempt.waveBase.head,
		};
		await input.onPrepared(planned);
		return this.allocation(input, context) as WorktreeAllocationResult;
	}

	async allocateHost(
		input: {
			intent: HostAllocationIntent;
			task: TaskRequest;
			attempt: TaskAttempt;
			acquireLaunch?: () => Promise<TransientLaunchHandle<VerifiedLaunch>>;
		},
		context: OperationContext,
	): Promise<HostAllocationResult> {
		if (input.intent.kind !== "agent") return this.allocation(input, context) as HostAllocationResult;
		if (!input.acquireLaunch) throw new Error("missing Implementer launch acquisition");
		const handle = await input.acquireLaunch();
		return await withTransientLaunch(handle, async (launch) => {
			this.agentStartCalls.push({
				launchKey: launch.key,
				args: [...launch.args],
				exposedPersistedFields: "rawArgs" in launch || "prompt" in launch,
			});
			return this.allocation(input, context) as HostAllocationResult;
		});
	}

	private reconcile<Kind extends AllocationKind>(input: { intent: { kind: Kind } }, context: OperationContext): AllocationReconciliation<Kind> {
		this.observe("reconcile-allocation", context);
		this.reconciliationCalls.push(input.intent.kind);
		return { ...this.reconciliation, kind: input.intent.kind } as AllocationReconciliation<Kind>;
	}

	async reconcileWorktreeAllocation(
		input: { root: string; intent: WorktreeAllocationIntent; task: TaskRequest; attempt: TaskAttempt },
		context: OperationContext,
	): Promise<AllocationReconciliation<"worktree">> {
		return this.reconcile(input, context);
	}

	async reconcileHostAllocation(
		input: { intent: HostAllocationIntent; task: TaskRequest; attempt: TaskAttempt },
		context: OperationContext,
	): Promise<AllocationReconciliation<HostAllocationKind>> {
		return this.reconcile(input, context);
	}

	async runWorker(
		input: {
			readonly goal: ExecuteRequest["goal"];
			task: TaskRequest;
			attempt: TaskAttempt;
			workerId: string;
			kind: "initial" | "correction";
			preCandidate: WorkspaceIdentity;
		},
		context: OperationContext,
	): Promise<WorkerResult> {
		const plan = this.workerPlans.shift() ?? {};
		this.observe("worker", context, plan.expire);
		this.workerCalls.push({
			goal: input.goal,
			taskId: input.task.id,
			workerId: input.workerId,
			kind: input.kind,
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
		if (plan.outcome === "blocked" || plan.outcome === "not_prompted") {
			return { outcome: plan.outcome, diagnostic: plan.diagnostic ?? plan.outcome };
		}
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
		const results: CommandResult[] = plan.results ?? input.checks.map((check) => ({
			...check,
			code: plan.code ?? 0,
			killed: plan.killed,
			stdout: plan.stdout ?? "",
			stderr: plan.stderr ?? (plan.code ? "failed" : ""),
		}));
		return { results, identityAfter: plan.identityAfter ?? { ...input.candidate } };
	}

	async review(
		input: {
			scope: "task" | "final";
			phase: "authoritative" | "final";
			taskId?: string;
			attempt?: TaskAttempt;
			tip: WorkspaceIdentity;
			acquireLaunch(): Promise<TransientLaunchHandle<VerifiedLaunch>>;
		},
		context: OperationContext,
	): Promise<ReviewResult> {
		const plan = this.reviewPlans.shift() ?? {};
		const handle = await input.acquireLaunch();
		return await withTransientLaunch(handle, async (launch) => {
			this.observe("review", context, plan.expire);
			this.reviewCalls.push({
				scope: input.scope,
				phase: input.phase,
				...(input.taskId ? { taskId: input.taskId } : {}),
				launchKey: launch.key,
				...(input.attempt?.termination ? { workerTermination: input.attempt.termination.status } : {}),
				args: [...launch.args],
				exposedPersistedFields: "rawArgs" in launch || "prompt" in launch,
			});
			if (plan.error) throw plan.error;
			return { verdict: plan.verdict ?? "PASS", identityAfter: plan.identityAfter ?? { ...input.tip } };
		});
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
		const allocations = runtime.allocationCalls.length;
		const acquisitions = runtime.acquisitionCalls.length;
		await assert.rejects(runner.execute(request(), root), /already exists/);
		assert.equal(runtime.preflightCalls, 2);
		assert.equal(runtime.acquisitionCalls.length, acquisitions);
		assert.equal(runtime.allocationCalls.length, allocations);
	}
	{
		const { root, runtime, store, runner } = await harness(t);
		const path = store.statePath(root, "request-one");
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, "malformed state\n");
		await assert.rejects(runner.execute(request(), root), /already exists/);
		await assert.rejects(store.load(root, "request-one"));
		assert.equal(await readFile(path, "utf8"), "malformed state\n");
		assert.equal(runtime.preflightCalls, 1);
		assert.equal(runtime.acquisitionCalls.length, 0);
		assert.equal(runtime.allocationCalls.length, 0);
	}
	{
		const { root, runtime, store, runner } = await harness(t);
		const path = store.statePath(root, "request-one");
		runtime.preflightAction = async () => {
			await mkdir(dirname(path), { recursive: true });
			await writeFile(path, "intervening state\n");
		};
		await assert.rejects(runner.execute(request(), root), /already exists/);
		assert.equal(await readFile(path, "utf8"), "intervening state\n");
	}
});

test("preflight owns no state and final launch acquisition starts only after exclusive creation", async (t) => {
	await t.test("ordered success", async (t) => {
		const { root, runtime, store, runner } = await harness(t);
		const startedAt = runtime.clock;
		runtime.preflightAction = async () => {
			await assert.rejects(store.load(root, "request-one"));
			runtime.clock += 250;
		};
		runtime.acquireLaunchAction = async () => {
			const persisted = await store.load(root, "request-one");
			const attempt = persisted.state.tasks[0]!.attempts[0]!;
			assert.equal(attempt.allocations.at(-1)!.kind, "agent");
			assert.equal(attempt.allocations.at(-1)!.status, "allocating");
			assert.deepEqual(runtime.allocationCalls, ["worktree", "workspace", "worker_tab"]);
		};

		const completed = await runner.execute(request(), root);
		assert.equal(completed.state.deadlineStartedAt, startedAt);
		assert.equal(completed.state.createdAt, startedAt + 250);
		assert.equal(completed.state.deadline, startedAt + completed.state.request.budgetMs);
		assert.ok(runtime.contexts.findIndex(({ hook }) => hook === "preflight")
			< runtime.contexts.findIndex(({ hook }) => hook === "acquire-launch"));
		assert.ok(runtime.contexts.findIndex(({ hook }) => hook === "acquire-launch")
			< runtime.contexts.map(({ hook }) => hook).lastIndexOf("allocate"));
	});

	await t.test("preflight failure creates nothing", async (t) => {
		const { root, runtime, store, runner } = await harness(t);
		runtime.preflightAction = async () => { throw new Error("Herdr unavailable"); };
		await assert.rejects(runner.execute(request(), root), /Herdr unavailable/);
		await assert.rejects(store.load(root, "request-one"));
		assert.equal(runtime.acquisitionCalls.length, 0);
		assert.equal(runtime.allocationCalls.length, 0);
	});

	await t.test("preflight consumes the same deadline before any state or allocation", async (t) => {
		const { root, runtime, store, runner } = await harness(t);
		const startedAt = runtime.clock;
		runtime.expireHook = "preflight";
		await assert.rejects(runner.execute(request({ budgetMs: 1_000 }), root), /deadline/i);
		assert.deepEqual(runtime.contexts.map(({ hook }) => hook), ["preflight"]);
		assert.equal(runtime.contexts[0]!.context.deadline, startedAt + 1_000);
		assert.equal(runtime.contexts[0]!.context.timeoutMs, 1_000);
		await assert.rejects(store.load(root, "request-one"));
		assert.equal(runtime.acquisitionCalls.length, 0);
		assert.equal(runtime.allocationCalls.length, 0);
	});

	await t.test("launch acquisition failure remains durable and fail-closed", async (t) => {
		const { root, runtime, store, runner } = await harness(t);
		runtime.acquireLaunchAction = async () => { throw new Error("ephemeral launch failed"); };
		const failed = await runner.execute(request(), root);
		assert.equal(failed.state.status, "needs_attention");
		assert.match(failed.state.tasks[0]!.failure!, /ephemeral launch failed/);
		assert.equal(runtime.workerCalls.length, 0);
		assert.equal(runtime.acquisitionCalls.length, 1);
		assert.doesNotMatch(JSON.stringify((await store.load(root, "request-one")).state), /append-system-prompt|ephemeral-role/);
	});

	await t.test("nested cwd uses only the canonical preflight Git root for state", async (t) => {
		const { root, runtime, store, runner } = await harness(t);
		const nested = join(root, "nested");
		await mkdir(nested);
		runtime.preflightRoot = realpathSync.native(root);
		const completed = await runner.execute(request(), nested);
		assert.equal(completed.state.root, realpathSync.native(root));
		assert.deepEqual(runtime.preflightCwds, [realpathSync.native(nested)]);
		assert.equal((await store.load(root, "request-one")).state.root, realpathSync.native(root));
		await assert.rejects(store.load(nested, "request-one"));
	});
});

test("host planning rejection stops after the exact worktree without allocating or prompting", async (t) => {
	const { root, runtime, runner } = await harness(t);
	const goal = "Keep the request goal in every worker assignment.";
	runtime.allocationPlanError = new Error("Worker assignment exceeds 98304 bytes.");
	const stopped = await runner.execute(request({ goal }), root);
	const attempt = stopped.state.tasks[0]!.attempts[0]!;

	assert.equal(stopped.state.tasks[0]!.status, "needs_attention");
	assert.deepEqual(attempt.allocations.map(({ kind, status }) => ({ kind, status })), [{ kind: "worktree", status: "owned" }]);
	assert.deepEqual(runtime.allocationCalls, ["worktree"]);
	assert.deepEqual(runtime.allocationPlanGoals, [goal]);
	assert.equal(runtime.workerCalls.length, 0);
	assert.equal(attempt.prompts.length, 0);
});

test("owned allocation metadata is persisted exactly without adopting possible resources", async (t) => {
	const { root, runtime, runner } = await harness(t);
	runtime.allocationResources = {
		workspace: { workspaceId: "workspace-7", rootTabId: "tab-root-8", rootPaneId: "pane-root-9" },
		worker_tab: { tabId: "tab-11", paneId: "pane-worker-13" },
	};
	const completed = await runner.execute(request(), root);
	const allocations = completed.state.tasks[0]!.attempts[0]!.allocations;
	const workspace = allocations.find((allocation) => allocation.kind === "workspace");
	const workerTab = allocations.find((allocation) => allocation.kind === "worker_tab");
	assert.ok(workspace?.kind === "workspace");
	assert.ok(workerTab?.kind === "worker_tab");
	assert.deepEqual(
		{ workspaceId: workspace.workspaceId, rootTabId: workspace.rootTabId, rootPaneId: workspace.rootPaneId },
		runtime.allocationResources.workspace,
	);
	assert.deepEqual({ tabId: workerTab.tabId, paneId: workerTab.paneId }, runtime.allocationResources.worker_tab);
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
	assert.deepEqual(runtime.agentStartCalls.map(({ launchKey }) => launchKey), ["implementer/fast", "implementer/frontier"]);
	assert.deepEqual(runtime.reviewCalls.map(({ launchKey }) => launchKey), ["reviewer/balanced", "reviewer/fav"]);
});

test("JIT Role acquisition immediately precedes each launch and durable argv never reaches spawn", async (t) => {
	const { root, runtime, runner } = await harness(t);
	const definition = request({
		tasks: [task("task-a", [], "fast", { criterion: "Review A.", modelClass: "balanced" })],
	});
	const result = await runner.execute(definition, root);
	const implementer = result.state.launchRecords["implementer/fast"]!;
	const reviewer = result.state.launchRecords["reviewer/balanced"]!;
	const spawned = [...runtime.agentStartCalls, ...runtime.reviewCalls];

	assert.deepEqual(runtime.acquisitionCalls, [implementer.key, reviewer.key]);
	assert.deepEqual(runtime.transientCleanupCalls, runtime.acquisitionCalls);
	assert.ok(spawned.every(({ args, exposedPersistedFields }) => {
		const index = args.indexOf("--append-system-prompt");
		return !exposedPersistedFields
			&& index === args.lastIndexOf("--append-system-prompt")
			&& index >= 0
			&& /^\/tmp\/ephemeral-role-\d+$/.test(args[index + 1] ?? "")
			&& !JSON.stringify(result.state).includes(args[index + 1]!);
	}));
	assert.ok(!implementer.args.includes("--append-system-prompt"));
	assert.ok(!reviewer.args.includes("--append-system-prompt"));
	assert.deepEqual(runtime.contexts
		.filter(({ hook }) => ["acquire-launch", "allocate", "worker", "review"].includes(hook))
		.map(({ hook }) => hook), [
			"allocate", "allocate", "allocate", "acquire-launch", "allocate", "worker",
			"acquire-launch", "review",
		]);
	assert.deepEqual(runtime.reviewCalls.map(({ phase, workerTermination }) => ({ phase, workerTermination })), [
		{ phase: "authoritative", workerTermination: "terminated" },
	]);
});

test("resource drift after recovery blocks worker and Reviewer spawn hooks", async (t) => {
	await t.test("Implementer", async (t) => {
		const { root, runtime, runner } = await harness(t);
		runtime.inspectionPlans.push({ error: new Error("pause before dispatch") });
		await runner.execute(request(), root);
		runtime.contexts.length = 0;
		runtime.recoverCalls.length = 0;
		runtime.acquisitionCalls.length = 0;
		runtime.acquireLaunchAction = async (record) => {
			if (record.role === "implementer") throw new Error("Implementer extension fingerprint drifted");
		};

		const stopped = await runner.resume({ id: "request-one", action: "retry", taskId: "task-a" }, root);
		assert.equal(stopped.state.tasks[0]!.status, "needs_attention");
		assert.equal(runtime.recoverCalls.length, 1);
		assert.deepEqual(runtime.acquisitionCalls, ["implementer/fast"]);
		assert.equal(runtime.workerCalls.length, 0);
		assert.ok(runtime.contexts.findIndex(({ hook }) => hook === "recover-launches")
			< runtime.contexts.findIndex(({ hook }) => hook === "acquire-launch"));
	});

	await t.test("Reviewer", async (t) => {
		const { root, runtime, runner } = await harness(t);
		const definition = request({ finalJudgment: { criterion: "Review all work.", modelClass: "balanced" } });
		runtime.checkPlans.push({}, {}, { error: new Error("pause before final review") });
		await runner.execute(definition, root);
		assert.equal(runtime.reviewCalls.length, 0);
		runtime.contexts.length = 0;
		runtime.recoverCalls.length = 0;
		runtime.acquisitionCalls.length = 0;
		runtime.acquireLaunchAction = async (record) => {
			if (record.role === "reviewer") throw new Error("Reviewer extension fingerprint drifted");
		};

		const stopped = await runner.resume({ id: "request-one", action: "finalize" }, root);
		assert.equal(stopped.state.final.status, "interrupted");
		assert.equal(runtime.recoverCalls.length, 1);
		assert.deepEqual(runtime.acquisitionCalls, ["reviewer/balanced"]);
		assert.equal(runtime.reviewCalls.length, 0);
		assert.ok(runtime.contexts.findIndex(({ hook }) => hook === "recover-launches")
			< runtime.contexts.findIndex(({ hook }) => hook === "acquire-launch"));
	});
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

	const obsoletePreliminaryReview = structuredClone(valid);
	Object.assign(obsoletePreliminaryReview.tasks[0]!.attempts[0]!, {
		preliminaryReview: { ...obsoletePreliminaryReview.tasks[0]!.attempts[0]!.authoritativeReview, phase: "preliminary" },
	});
	assert.throws(() => parseRunState(obsoletePreliminaryReview), /preliminaryReview|additional/i);

	const malformedCleanup = structuredClone(valid);
	malformedCleanup.tasks[0]!.attempts[0]!.cleanup[1]!.kind = "worker_tab";
	assert.throws(() => parseRunState(malformedCleanup), /cleanup sequence/i);

	const wrongWorktreeBase = structuredClone(valid);
	(wrongWorktreeBase.tasks[0]!.attempts[0]!.allocations[0] as WorktreeAllocationIntent).worktree!.baseCommit = oid("f");
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
			if (target === "worker" || target === "checks") {
				assert.equal(result.state.tasks[0]!.attempts[0]!.termination?.status, "terminated");
			}
		});
	}
});

test("a failed preliminary check gets one correction before the single authoritative review", async (t) => {
	const { root, runtime, runner } = await harness(t);
	const goal = "Keep this immutable goal in both assignments.";
	runtime.checkPlans.push({ code: 1 }, {}, {});
	const result = await runner.execute(request({
		goal,
		tasks: [task("task-a", [], "fast", { criterion: "Review A.", modelClass: "balanced" })],
	}), root);
	assert.equal(result.state.accepted, true);
	assert.deepEqual(runtime.allocationPlanGoals, [goal, goal, goal]);
	assert.deepEqual(runtime.workerCalls.map(({ kind, goal: assignmentGoal }) => ({ kind, goal: assignmentGoal })), [
		{ kind: "initial", goal },
		{ kind: "correction", goal },
	]);
	assert.equal(new Set(runtime.workerCalls.map(({ workerId }) => workerId)).size, 1);
	assert.equal(runtime.allocationCalls.filter((kind) => kind === "agent").length, 1);
	assert.equal(runtime.candidateInspectionCalls.length, 2);
	assert.equal(runtime.workerCalls[0]!.preCandidate.branch, "refs/heads/task-a");
	assert.deepEqual(runtime.workerCalls[1]!.preCandidate, result.state.tasks[0]!.attempts[0]!.prompts[0]!.candidate);
	assert.deepEqual(result.state.tasks[0]!.attempts[0]!.prompts.map(({ preCandidate }) => preCandidate),
		runtime.workerCalls.map(({ preCandidate }) => preCandidate));
	assert.deepEqual(runtime.reviewCalls.map(({ phase, workerTermination }) => ({ phase, workerTermination })), [
		{ phase: "authoritative", workerTermination: "terminated" },
	]);
});

test("durable check evidence keeps exact identity while retaining output only on one failed-batch diagnostic", async (t) => {
	const checks: CheckCommand[] = [
		{ command: "check-one", args: ["--one"] },
		{ command: "check-two", args: ["--two"] },
		{ command: "check-three", args: ["--three"] },
	];
	const definition = request({ tasks: [{ ...task("task-a"), checks }], finalChecks: checks });

	await t.test("successful batches discard all output", async (t) => {
		const { root, runtime, runner } = await harness(t);
		runtime.checkPlans.push(
			{ stdout: "preliminary stdout", stderr: "preliminary stderr" },
			{ stdout: "authoritative stdout", stderr: "authoritative stderr" },
			{ stdout: "final stdout", stderr: "final stderr" },
		);
		const completed = await runner.execute(definition, root);
		const attempt = completed.state.tasks[0]!.attempts[0]!;
		for (const batch of [attempt.preliminaryChecks!, attempt.authoritativeChecks!, completed.state.final.checks!]) {
			assert.equal(batch.passed, true);
			assert.deepEqual(batch.candidate, batch.identityAfter);
			assert.deepEqual(batch.results.map(({ command, args, code, killed, stdout, stderr }) => ({ command, args, code, killed, stdout, stderr })),
				checks.map(({ command, args }) => ({ command, args, code: 0, killed: false, stdout: "", stderr: "" })));
		}
	});

	await t.test("the first failed or killed command alone retains bounded output", async (t) => {
		const { root, runtime, runner } = await harness(t);
		const oversized = "界".repeat(MAX_PERSISTED_RUNTIME_TEXT_BYTES);
		runtime.checkPlans.push({}, {
			results: [
				{ ...checks[0]!, code: 0, killed: false, stdout: "discard one", stderr: "discard one" },
				{ ...checks[1]!, code: 0, killed: true, stdout: oversized, stderr: oversized },
				{ ...checks[2]!, code: 1, killed: false, stdout: "discard three", stderr: "discard three" },
			],
		});
		const failed = await runner.execute(definition, root);
		const batch = failed.state.tasks[0]!.attempts[0]!.authoritativeChecks!;
		assert.equal(batch.passed, false);
		assert.deepEqual(batch.candidate, batch.identityAfter);
		assert.deepEqual(batch.results.map(({ command, args, code, killed }) => ({ command, args, code, killed })), [
			{ ...checks[0]!, code: 0, killed: false },
			{ ...checks[1]!, code: 0, killed: true },
			{ ...checks[2]!, code: 1, killed: false },
		]);
		assert.deepEqual(batch.results.map(({ stdout, stderr }) => ({ stdout, stderr })), [
			{ stdout: "", stderr: "" },
			{ stdout: batch.results[1]!.stdout, stderr: batch.results[1]!.stderr },
			{ stdout: "", stderr: "" },
		]);
		assert.ok(batch.results[1]!.stdout.endsWith("[truncated]"));
		assert.ok(Buffer.byteLength(batch.results[1]!.stdout, "utf8") <= MAX_PERSISTED_RUNTIME_TEXT_BYTES);
		assert.ok(Buffer.byteLength(batch.results[1]!.stderr, "utf8") <= MAX_PERSISTED_RUNTIME_TEXT_BYTES);
	});

	await t.test("identity drift retains only the final command output", async (t) => {
		const { root, runtime, runner } = await harness(t);
		runtime.checkPlans.push({}, {}, { stdout: "drift stdout", stderr: "drift stderr", identityAfter: identity("f") });
		const superseded = await runner.execute(definition, root);
		const batch = superseded.state.final.checks!;
		assert.equal(batch.passed, false);
		assert.notDeepEqual(batch.candidate, batch.identityAfter);
		assert.deepEqual(batch.results.map(({ stdout, stderr }) => ({ stdout, stderr })), [
			{ stdout: "", stderr: "" },
			{ stdout: "", stderr: "" },
			{ stdout: "drift stdout", stderr: "drift stderr" },
		]);
	});
});

test("runtime diagnostics, verdicts, and reconciliation evidence are bounded before persistence", async (t) => {
	const oversized = "界".repeat(MAX_PERSISTED_RUNTIME_TEXT_BYTES);
	const assertBounded = (value: string): void => {
		assert.ok(Buffer.byteLength(value, "utf8") <= MAX_PERSISTED_RUNTIME_TEXT_BYTES);
		assert.ok(value.endsWith("[truncated]"));
	};

	await t.test("worker diagnostic and Reviewer verdict", async (t) => {
		const { root, runtime, runner } = await harness(t);
		runtime.workerPlans.push({ outcome: "blocked", diagnostic: oversized });
		runtime.reviewPlans.push({ verdict: oversized });
		const result = await runner.execute(request({
			tasks: [task("task-a", [], "fast", { criterion: "Review A.", modelClass: "balanced" })],
		}), root);
		const attempt = result.state.tasks[0]!.attempts[0]!;
		assertBounded(attempt.prompts[0]!.failure!);
		assertBounded(attempt.authoritativeReview!.verdict);
		assert.equal(result.state.accepted, false);
	});

	await t.test("termination and cleanup failures", async (t) => {
		const terminated = await harness(t);
		terminated.runtime.terminationPlans.push({ outcome: "unknown", failure: oversized });
		const terminationResult = await terminated.runner.execute(request(), terminated.root);
		assertBounded(terminationResult.state.tasks[0]!.attempts[0]!.termination!.failure!);

		const cleaned = await harness(t);
		cleaned.runtime.cleanupPlans.push({ outcome: "blocked", failure: oversized });
		const cleanupResult = await cleaned.runner.execute(request(), cleaned.root);
		assertBounded(cleanupResult.state.tasks[0]!.attempts[0]!.cleanup[0]!.failure!);
	});

	await t.test("possible reconciliation resources", async (t) => {
		const { root, runtime, store, runner } = await harness(t);
		runtime.allocationFailure = { kind: "agent", error: new Error("lost result") };
		await runner.execute(request(), root);
		runtime.reconciliation = {
			outcome: "possible",
			failure: oversized,
			possibleResources: Array.from({ length: MAX_POSSIBLE_RESOURCES + 9 }, (_, index) => `${index}-${oversized}`),
		};
		await assert.rejects(
			runner.resume({ id: "request-one", action: "retry", taskId: "task-a" }, root),
			/was not adopted or closed/,
		);
		const intent = (await store.load(root, "request-one")).state.tasks[0]!.attempts[0]!.allocations.at(-1)!;
		assertBounded(intent.failure!);
		assert.equal(intent.possibleResources?.length, MAX_POSSIBLE_RESOURCES);
		assertBounded(intent.possibleResources![0]!);
		assert.match(intent.possibleResources!.at(-1)!, /additional possible resources were omitted; cleanup remains blocked/);
		assert.equal(intent.status, "unknown");
	});

	await t.test("oversized exact resource identities fail closed instead of being truncated", async (t) => {
		const { root, runtime, store, runner } = await harness(t);
		runtime.allocationResources.workspace = {
			workspaceId: oversized,
			rootTabId: "root-tab",
			rootPaneId: "root-pane",
		};
		const result = await runner.execute(request(), root);
		assert.equal(result.state.status, "needs_attention");
		const intent = (await store.load(root, "request-one")).state.tasks[0]!.attempts[0]!.allocations.at(-1)!;
		assert.equal(intent.kind, "workspace");
		assert.equal(intent.status, "allocating");
		assert.equal("workspaceId" in intent, false);
	});
});

test("a settled implementation block gets one same-agent correction before checks and review", async (t) => {
	const { root, runtime, runner } = await harness(t);
	runtime.workerPlans.push({ outcome: "blocked", diagnostic: "implementation blocked" });
	const result = await runner.execute(request({
		tasks: [task("task-a", [], "fast", { criterion: "Review A.", modelClass: "balanced" })],
	}), root);
	const attempt = result.state.tasks[0]!.attempts[0]!;
	assert.equal(result.state.accepted, true);
	assert.deepEqual(runtime.workerCalls.map(({ kind }) => kind), ["initial", "correction"]);
	assert.equal(new Set(runtime.workerCalls.map(({ workerId }) => workerId)).size, 1);
	assert.equal(attempt.prompts[0]!.failure, "implementation blocked");
	assert.equal(attempt.preliminaryChecks?.passed, true);
	assert.deepEqual(runtime.reviewCalls.map(({ phase, workerTermination }) => ({ phase, workerTermination })), [
		{ phase: "authoritative", workerTermination: "terminated" },
	]);
});

test("a worker blocked before submission terminates without correction", async (t) => {
	const { root, runtime, runner } = await harness(t);
	runtime.workerPlans.push({ outcome: "not_prompted", diagnostic: "blocked before submission" });
	const result = await runner.execute(request(), root);
	const attempt = result.state.tasks[0]!.attempts[0]!;
	assert.equal(result.state.tasks[0]!.status, "needs_attention");
	assert.deepEqual(runtime.workerCalls.map(({ kind }) => kind), ["initial"]);
	assert.equal(attempt.prompts[0]!.status, "not_sent");
	assert.equal(attempt.termination?.status, "terminated");
	assert.equal(runtime.checkCalls.length, 0);
	assert.equal(runtime.reviewCalls.length, 0);
});

test("task-dispatch exceptions terminate the exact worker", async (t) => {
	await t.test("candidate inspection", async (t) => {
		const { root, runtime, runner } = await harness(t);
		runtime.candidateInspectionPlans.push({ error: new Error("candidate inspection lost") });
		const result = await runner.execute(request(), root);
		const attempt = result.state.tasks[0]!.attempts[0]!;
		assert.equal(result.state.tasks[0]!.status, "needs_attention");
		assert.equal(attempt.termination?.status, "terminated");
		assert.equal(runtime.workerCalls.length, 0);
	});

	await t.test("preliminary checks", async (t) => {
		const { root, runtime, runner } = await harness(t);
		runtime.checkPlans.push({ error: new Error("check transport lost") });
		const result = await runner.execute(request(), root);
		const attempt = result.state.tasks[0]!.attempts[0]!;
		assert.equal(result.state.tasks[0]!.status, "needs_attention");
		assert.equal(attempt.termination?.status, "terminated");
		assert.deepEqual(runtime.workerCalls.map(({ kind }) => kind), ["initial"]);
		assert.equal(runtime.checkCalls.length, 1);
		assert.equal(runtime.reviewCalls.length, 0);
	});
});

test("a correction resumed after recovery terminates on failures", async (t) => {
	const prepareCorrection = async () => {
		const harnessResult = await harness(t);
		const { root, runtime, store, runner } = harnessResult;
		runtime.candidateInspectionPlans.push(
			{ identity: identity("a", "refs/heads/task-a") },
			{ identity: identity("f", "refs/heads/task-a") },
		);
		runtime.checkPlans.push({ code: 1 });
		await runner.execute(request(), root);
		const handle = await store.load(root, "request-one");
		delete handle.state.tasks[0]!.attempts[0]!.termination;
		handle.state.tasks[0]!.status = "needs_attention";
		handle.state.status = "needs_attention";
		await handle.save();
		runtime.terminationCalls.length = 0;
		return { ...harnessResult, handle };
	};

	await t.test("correction checks", async () => {
		const { root, runtime, runner } = await prepareCorrection();
		runtime.checkPlans.push({ error: new Error("correction check transport lost") });
		const result = await runner.resume({ id: "request-one", action: "retry", taskId: "task-a" }, root);
		assert.equal(result.state.tasks[0]!.status, "needs_attention");
		assert.equal(result.state.tasks[0]!.attempts[0]!.termination?.status, "terminated");
		assert.deepEqual(runtime.workerCalls.map(({ kind }) => kind), ["initial", "correction"]);
		assert.equal(runtime.terminationCalls.length, 1);
	});

	await t.test("launch recovery deadline", async () => {
		const { root, runtime, store, runner, handle } = await prepareCorrection();
		runtime.clock = handle.state.deadline;
		await assert.rejects(
			runner.resume({ id: "request-one", action: "retry", taskId: "task-a" }, root),
			/deadline/i,
		);
		const persisted = await store.load(root, "request-one");
		assert.equal(persisted.state.tasks[0]!.attempts[0]!.termination?.status, "terminated");
		assert.deepEqual(runtime.workerCalls.map(({ kind }) => kind), ["initial"]);
		assert.equal(runtime.terminationCalls.length, 1);
	});
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

test("authoritative task review failures enter attention after termination without correction", async (t) => {
	const cases: [string, ReviewPlan][] = [
		["drift", { verdict: "PASS", identityAfter: identity("f", "refs/heads/task-a") }],
		["throw", { error: new Error("review transport lost") }],
		["empty", { verdict: "" }],
		["whitespace", { verdict: "PASS\n" }],
		["ambiguity", { verdict: "UNCLEAR" }],
	];
	for (const [name, plan] of cases) {
		await t.test(name, async (t) => {
			const { root, runtime, runner } = await harness(t);
			runtime.reviewPlans.push(plan);
			const result = await runner.execute(request({
				tasks: [task("task-a", [], "fast", { criterion: "Review A.", modelClass: "balanced" })],
			}), root);
			const attempt = result.state.tasks[0]!.attempts[0]!;
			assert.equal(result.state.tasks[0]!.status, "needs_attention");
			assert.equal(attempt.termination?.status, "terminated");
			assert.equal(attempt.preliminaryChecks?.passed, true);
			assert.equal(attempt.authoritativeChecks?.passed, true);
			assert.equal(runtime.rebaseCalls.length, 1);
			assert.deepEqual(runtime.reviewCalls.map(({ phase, workerTermination }) => ({ phase, workerTermination })), [
				{ phase: "authoritative", workerTermination: "terminated" },
			]);
			assert.equal(runtime.integrationCalls.length, 0);
			if (name === "throw") assert.equal(attempt.authoritativeReview, undefined);
			if (name === "empty") {
				assert.equal(attempt.authoritativeReview?.verdict, "");
				assert.equal(attempt.authoritativeReview?.passed, false);
			}
			await assert.rejects(
				runner.resume({ id: "request-one", action: "retry", taskId: "task-a" }, root),
				/correction is unavailable/,
			);
			assert.deepEqual(runtime.workerCalls.map(({ kind }) => kind), ["initial"]);
		});
	}
});

test("verify reruns the authoritative review on retained work without relaunching the Implementer", async (t) => {
	const { root, runtime, runner } = await harness(t);
	runtime.reviewPlans.push({ verdict: "NEEDS_WORK" }, { verdict: "PASS" });
	const definition = request({
		tasks: [task("task-a", [], "fast", { criterion: "Review A.", modelClass: "balanced" })],
	});
	const stopped = await runner.execute(definition, root);
	assert.equal(stopped.state.tasks[0]!.status, "needs_attention");
	assert.equal(stopped.state.tasks[0]!.attempts[0]!.authoritativeReview?.passed, false);
	runtime.retainedCandidate = identity("f", "refs/heads/task-a");

	const completed = await runner.resume({ id: definition.id, action: "verify", taskId: "task-a" }, root);
	assert.equal(completed.state.accepted, true);
	assert.deepEqual(runtime.workerCalls.map(({ kind }) => kind), ["initial"]);
	assert.deepEqual(runtime.reviewCalls.map(({ phase, workerTermination }) => ({ phase, workerTermination })), [
		{ phase: "authoritative", workerTermination: "terminated" },
		{ phase: "authoritative", workerTermination: "terminated" },
	]);
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
		workerId: attempt.allocations.find((allocation) => allocation.kind === "agent")!.agentName,
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
	assert.equal(recovered.main?.status, "current");
	assert.deepEqual(recovered.continuation, { id: "request-one", action: "retry", taskId: "task-a" });
	const completed = await runner.resume(recovered.continuation!, root);
	assert.equal(completed.state.accepted, true);
});

test("status inspects Main read-only with a bounded context and suppresses drift-invalid recovery", async (t) => {
	const { root, runtime, store, runner } = await harness(t);
	runtime.inspectionPlans.push({ error: new Error("initial inspection unavailable") });
	const waiting = await runner.execute(request(), root);
	assert.deepEqual(waiting.continuation, { id: "request-one", action: "retry", taskId: "task-a" });
	const persistedBefore = JSON.stringify((await store.load(root, "request-one")).state);
	const statusStartedAt = runtime.clock;
	runtime.main = identity("f");
	const controller = new AbortController();
	const contextStart = runtime.contexts.length;

	const drifted = await runner.status("request-one", root, controller.signal);
	assert.equal(drifted.main?.status, "drifted");
	assert.deepEqual(drifted.main, { status: "drifted", expected: MAIN_A, actual: identity("f") });
	assert.match(drifted.text, /Main: drifted/);
	assert.equal(drifted.continuation, undefined);
	assert.equal(JSON.stringify((await store.load(root, "request-one")).state), persistedBefore);
	const statusContexts = runtime.contexts.slice(contextStart);
	assert.deepEqual(statusContexts.map(({ hook }) => hook), ["inspect-main"]);
	assert.equal(statusContexts[0]!.context.deadline, statusStartedAt + STATUS_INSPECTION_BUDGET_MS);
	assert.equal(statusContexts[0]!.context.timeoutMs, STATUS_INSPECTION_BUDGET_MS);

	runtime.inspectionPlans.push({ error: new Error("read failed") });
	const unavailable = await runner.status("request-one", root);
	assert.equal(unavailable.main?.status, "unavailable");
	assert.match(unavailable.text, /read-only Main inspection failed: read failed/i);
	assert.equal(unavailable.continuation, undefined);
	assert.equal(JSON.stringify((await store.load(root, "request-one")).state), persistedBefore);
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
	assert.deepEqual(interrupted.continuation, { id: "request-one", action: "verify", taskId: "task-a" });
	const beforeProductive = productiveCallCount(runtime);

	const cleaned = await runner.resume(interrupted.continuation!, root);
	assert.equal(cleaned.state.tasks[0]!.status, "completed");
	assert.equal(cleaned.state.accepted, false);
	assert.equal(cleaned.state.final.status, "pending");
	assert.ok(cleaned.state.tasks[0]!.attempts[0]!.cleanup.every(({ status }) => status === "completed"));
	assert.equal(productiveCallCount(runtime), beforeProductive);
	assert.equal(cleaned.state.recovery, undefined);
	assert.equal(cleaned.continuation, undefined);

	const expiredDeadline = cleaned.state.deadline;
	const continuationContextIndex = runtime.contexts.length;
	await assert.rejects(
		runner.resume({ id: "request-one", action: "finalize" }, root),
		/deadline is exhausted/,
	);
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
	runtime.main = identity("f");
	const expiredStatus = await runner.status("request-one", root);
	assert.equal(expiredStatus.main?.status, "drifted");
	assert.deepEqual(expiredStatus.continuation, { id: "request-one", action: "verify", taskId: "task-a" });
	const beforeProductive = productiveCallCount(runtime);

	const cleaned = await runner.resume(expiredStatus.continuation!, root);
	assert.equal(productiveCallCount(runtime), beforeProductive);
	assert.equal(cleaned.state.tasks[1]!.status, "needs_attention");
	assert.equal(cleaned.continuation, undefined);

	const expiredDeadline = cleaned.state.deadline;
	const continuationContextIndex = runtime.contexts.length;
	await assert.rejects(
		runner.resume({ id: "request-one", action: "retry", taskId: "task-b" }, root),
		/deadline is exhausted/,
	);
	assert.equal(runtime.contexts.length, continuationContextIndex);
	assert.equal((await store.load(root, "request-one")).state.deadline, expiredDeadline);
});

test("expired status suppresses productive verify continuations", async (t) => {
	const { root, runtime, runner } = await harness(t);
	runtime.reviewPlans.push({ verdict: "NEEDS_WORK" });
	const waiting = await runner.execute(request({
		tasks: [task("task-a", [], "fast", { criterion: "Review A.", modelClass: "balanced" })],
	}), root);
	assert.deepEqual(waiting.continuation, { id: "request-one", action: "verify", taskId: "task-a" });
	runtime.clock = waiting.state.deadline;

	const expired = await runner.status("request-one", root);
	assert.equal(expired.main?.status, "current");
	assert.equal(expired.continuation, undefined);
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

	await t.test("whitespace-padded final PASS fails", async (t) => {
		const { root, runtime, runner } = await harness(t);
		runtime.reviewPlans.push({ verdict: " PASS " });
		const failed = await runner.execute(request({
			finalJudgment: { criterion: "The whole request is correct.", modelClass: "balanced" },
		}), root);
		assert.equal(failed.state.status, "final_failed");
		assert.equal(failed.state.accepted, false);
		assert.equal(failed.state.final.review?.verdict, " PASS ");
		assert.equal(failed.state.final.review?.passed, false);
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
