import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { EphemeralSubagentExecutor } from "@henryqw/pi-subagent";
import {
	IsolatedRunner,
	STATUS_INSPECTION_BUDGET_MS,
	withTransientLaunch,
	type AllocationReconciliation,
	type CheckRunResult,
	type CoordinatorRuntime,
	type GitRuntime,
	type HostAllocationKind,
	type HostAllocationResult,
	type HostRuntime,
	type IntegrationResult,
	type OperationContext,
	type RebaseResult,
	type TaskCandidateInspector,
	type TransientLaunchHandle,
	type VerifiedLaunch,
	type WorkerResult,
	type WorktreeAllocationResult,
} from "../src/runner.ts";
import {
	MAX_PERSISTED_RUNTIME_TEXT_BYTES,
	parseExecuteRequest,
	parseRunState,
	type AllocationKind,
	type ChangesetTaskRequest,
	type CleanupKind,
	type ExecuteRequest,
	type HostAllocationPlan,
	type ModelClass,
	type RunState,
	type TaskRequest,
	type WorkspaceIdentity,
} from "../src/schema.ts";
import { FileRunStore, type RunStateHandle } from "../src/store.ts";

const oid = (character: string): string => character.repeat(40);

function identity(character: string, branch = "refs/heads/main"): WorkspaceIdentity {
	const value = oid(character);
	return { branch, head: value, index: value, tree: value };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 200; attempt += 1) {
		if (predicate()) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("Timed out waiting for the runner test condition.");
}

type RoleCall = { role: string; modelClass: ModelClass };

type WorkerCall = { taskId: string; kind: "initial" | "correction" | "followup" };
type WorkerContextCall = {
	taskId: string;
	contexts: Parameters<HostRuntime["runWorker"]>[0]["contexts"];
};

class FakeRuntime implements CoordinatorRuntime, HostRuntime, GitRuntime, TaskCandidateInspector {
	clock = 1_000;
	main = identity("a");
	workerBarrierSize = 0;
	maxConcurrentWorkers = 0;
	failFinalChecks = 0;
	failPreliminaryChecks = 0;
	expireMainInspections = 0;
	preflightCalls = 0;
	readonly acquisitions: RoleCall[] = [];
	readonly launchCleanups: RoleCall[] = [];
	readonly workerCalls: WorkerCall[] = [];
	readonly workerContextCalls: WorkerContextCall[] = [];
	readonly allocationPlanCalls: HostAllocationKind[] = [];
	readonly worktreeAllocationCalls: string[] = [];
	readonly workspaceAllocationCalls: string[] = [];
	readonly workerTabAllocationCalls: string[] = [];
	readonly workerAllocationCalls: string[] = [];
	readonly reconciliationCalls: AllocationKind[] = [];
	readonly changesetCallOrder: string[] = [];
	readonly candidateInspectionCalls: string[] = [];
	readonly retainedTaskInspectionCalls: string[] = [];
	readonly checkCalls: Array<{ scope: "task" | "final"; taskId?: string }> = [];
	readonly cleanupCalls: CleanupKind[] = [];
	readonly cleanupFailures: Error[] = [];
	readonly workerFailures: Error[] = [];
	readonly workerResults: WorkerResult[] = [];
	workerPause?: (call: WorkerCall) => Promise<void>;
	readonly correctionFailures: string[] = [];
	readonly followupInstructions: string[] = [];
	readonly terminationCalls: Array<{ workerId: string; candidate: WorkspaceIdentity }> = [];
	readonly terminationResults: Array<{ outcome: "terminated" } | { outcome: "unknown"; failure: string }> = [];
	readonly terminationReconciliations: Array<{ outcome: "terminated" | "active" } | { outcome: "unknown"; failure: string }> = [];
	readonly terminationReconciliationCalls: Array<{ workerId: string; candidate: WorkspaceIdentity }> = [];
	readonly integrations: string[] = [];
	readonly rebaseCalls: string[] = [];
	readonly rebaseInputs: Array<{ sourceBase: WorkspaceIdentity; candidate: WorkspaceIdentity; onto: WorkspaceIdentity }> = [];
	readonly mainAfterRebases: WorkspaceIdentity[] = [];
	readonly reviewCalls: Array<RoleCall & { scope: "task" | "final"; taskId?: string; criterion: string }> = [];
	readonly inspectMainCalls: OperationContext[] = [];
	readonly inspectMainFailures: Error[] = [];
	readonly reviewVerdicts: string[] = [];
	private readonly workerBarrierResolvers: Array<() => void> = [];
	private activeWorkers = 0;
	private candidateNumber = 0;

	now(): number {
		return this.clock;
	}

	randomToken(): string {
		return `token-${String(this.candidateNumber + 1).padStart(16, "0")}`;
	}

	async preflight(input: Parameters<CoordinatorRuntime["preflight"]>[0], _context: OperationContext) {
		this.preflightCalls += 1;
		return { root: input.cwd, main: { ...this.main } };
	}

	async acquireLaunch(
		role: string,
		modelClass: ModelClass,
		_context: OperationContext,
	): Promise<TransientLaunchHandle<VerifiedLaunch>> {
		const call = { role, modelClass };
		this.acquisitions.push(call);
		return {
			launch: {
				role,
				modelClass,
				model: `${modelClass}-model`,
				thinkingLevel: "low",
				args: ["--model", `${modelClass}-model`],
				env: {},
				tools: [],
			},
			cleanup: async () => { this.launchCleanups.push(call); },
		};
	}

	async inspectMain(_input: Parameters<GitRuntime["inspectMain"]>[0], context: OperationContext): Promise<WorkspaceIdentity> {
		this.inspectMainCalls.push(context);
		if (this.expireMainInspections > 0) {
			this.expireMainInspections -= 1;
			this.clock = context.deadline;
		}
		const failure = this.inspectMainFailures.shift();
		if (failure) throw failure;
		return { ...this.main };
	}

	async inspectTaskCandidate(
		input: Parameters<TaskCandidateInspector["inspectTaskCandidate"]>[0],
		_context: OperationContext,
	): Promise<WorkspaceIdentity> {
		this.candidateInspectionCalls.push(input.task.id);
		const worktree = input.attempt.allocations.find((allocation) => allocation.kind === "worktree");
		if (!worktree || worktree.kind !== "worktree" || !worktree.worktree) throw new Error("missing worktree");
		return input.attempt.candidate
			? { ...input.attempt.candidate }
			: { ...input.attempt.waveBase, branch: `refs/heads/${worktree.worktree.branch}` };
	}

	async planHostAllocation(
		input: Parameters<HostRuntime["planHostAllocation"]>[0],
		_context: OperationContext,
	): Promise<HostAllocationPlan> {
		this.allocationPlanCalls.push(input.kind);
		const worktree = input.attempt.allocations.find((allocation) => allocation.kind === "worktree");
		if (!worktree || worktree.kind !== "worktree" || !worktree.worktree) throw new Error("missing worktree");
		if (input.kind === "workspace") {
			return {
				kind: "workspace",
				label: `${input.task.id}-workspace`,
				worktreeCwd: worktree.worktree.cwd,
				mainRoot: worktree.worktree.repoRoot,
				repoKey: worktree.worktree.repoRoot,
				herdrRepoRoot: worktree.worktree.repoRoot,
			};
		}
		const workspace = input.attempt.allocations.find((allocation) => allocation.kind === "workspace");
		if (!workspace || workspace.kind !== "workspace" || !workspace.workspaceId || !workspace.rootTabId || !workspace.rootPaneId) {
			throw new Error("missing workspace");
		}
		if (input.kind === "worker_tab") {
			return {
				kind: "worker_tab",
				label: `${input.task.id}-worker`,
				workspaceId: workspace.workspaceId,
				workspaceRootTabId: workspace.rootTabId,
				workspaceRootPaneId: workspace.rootPaneId,
				worktreeCwd: worktree.worktree.cwd,
				leasePath: `/leases/${input.task.id}`,
			};
		}
		const workerTab = input.attempt.allocations.find((allocation) => allocation.kind === "worker_tab");
		if (!workerTab || workerTab.kind !== "worker_tab" || !workerTab.tabId || !workerTab.paneId) {
			throw new Error("missing worker tab");
		}
		return {
			kind: "agent",
			agentName: `${input.task.id}-agent`,
			workspaceId: workspace.workspaceId,
			tabId: workerTab.tabId,
			paneId: workerTab.paneId,
			worktreeCwd: worktree.worktree.cwd,
			leasePath: workerTab.leasePath,
		};
	}

	async allocateWorktree(
		input: Parameters<GitRuntime["allocateWorktree"]>[0],
		_context: OperationContext,
	): Promise<WorktreeAllocationResult> {
		this.worktreeAllocationCalls.push(input.task.id);
		await input.onPrepared({
			path: `/worktrees/${input.task.id}`,
			cwd: `/worktrees/${input.task.id}`,
			branch: input.task.id,
			repoRoot: input.root,
			baseCommit: input.attempt.waveBase.head,
		});
		return { kind: "worktree", outcome: "owned" };
	}

	async allocateHost(
		input: Parameters<HostRuntime["allocateHost"]>[0],
		_context: OperationContext,
	): Promise<HostAllocationResult> {
		if (input.intent.kind === "workspace") {
			this.workspaceAllocationCalls.push(input.task.id);
			return {
				kind: "workspace",
				outcome: "owned",
				workspaceId: `${input.task.id}-workspace-id`,
				rootTabId: `${input.task.id}-root-tab`,
				rootPaneId: `${input.task.id}-root-pane`,
			};
		}
		if (input.intent.kind === "worker_tab") {
			this.workerTabAllocationCalls.push(input.task.id);
			return {
				kind: "worker_tab",
				outcome: "owned",
				tabId: `${input.task.id}-worker-tab`,
				paneId: `${input.task.id}-worker-pane`,
			};
		}
		if (!input.acquireLaunch) throw new Error("agent launch callback is required");
		this.workerAllocationCalls.push(input.intent.agentName);
		this.changesetCallOrder.push(`allocate:${input.intent.agentName}`);
		const handle = await input.acquireLaunch();
		return await withTransientLaunch(handle, async () => ({ kind: "agent" as const, outcome: "owned" as const }));
	}

	private reconcile<Kind extends AllocationKind>(kind: Kind): AllocationReconciliation<Kind> {
		this.reconciliationCalls.push(kind);
		return { kind, outcome: "absent" };
	}

	async reconcileWorktreeAllocation(
		input: Parameters<GitRuntime["reconcileWorktreeAllocation"]>[0],
		_context: OperationContext,
	): Promise<AllocationReconciliation<"worktree">> {
		return this.reconcile(input.intent.kind);
	}

	async reconcileHostAllocation(
		input: Parameters<HostRuntime["reconcileHostAllocation"]>[0],
		_context: OperationContext,
	): Promise<AllocationReconciliation<HostAllocationKind>> {
		return this.reconcile(input.intent.kind);
	}

	async runWorker(
		input: Parameters<HostRuntime["runWorker"]>[0],
		_context: OperationContext,
	): Promise<WorkerResult> {
		const call = { taskId: input.task.id, kind: input.kind };
		this.workerCalls.push(call);
		this.workerContextCalls.push({ taskId: input.task.id, contexts: structuredClone(input.contexts) });
		if (input.kind === "correction" && input.failure !== undefined) this.correctionFailures.push(input.failure);
		if (input.kind === "followup" && input.instruction !== undefined) this.followupInstructions.push(input.instruction);
		this.changesetCallOrder.push(`worker:${input.kind}:${input.workerId}`);
		this.activeWorkers += 1;
		this.maxConcurrentWorkers = Math.max(this.maxConcurrentWorkers, this.activeWorkers);
		try {
			await this.workerPause?.(call);
			await this.waitForWorkerBarrier();
			const failure = this.workerFailures.shift();
			if (failure) throw failure;
			const result = this.workerResults.shift();
			if (result) return structuredClone(result);
			return {
				outcome: "candidate",
				candidate: identity("bcdef123456789"[this.candidateNumber++ % 15]!, `refs/heads/${input.task.id}`),
			};
		} finally {
			this.activeWorkers -= 1;
		}
	}

	async terminateWorker(
		input: Parameters<HostRuntime["terminateWorker"]>[0],
		_context: OperationContext,
	): ReturnType<HostRuntime["terminateWorker"]> {
		this.terminationCalls.push({
			workerId: input.workerId,
			candidate: structuredClone(input.candidate),
		});
		this.changesetCallOrder.push(`terminate:${input.workerId}`);
		return this.terminationResults.shift() ?? { outcome: "terminated" };
	}

	async reconcileWorkerTermination(input: Parameters<HostRuntime["reconcileWorkerTermination"]>[0]): Promise<{ outcome: "terminated" | "active" } | { outcome: "unknown"; failure: string }> {
		this.terminationReconciliationCalls.push({ workerId: input.workerId, candidate: structuredClone(input.candidate) });
		return this.terminationReconciliations.shift() ?? { outcome: "active" };
	}

	async runChecks(input: Parameters<GitRuntime["runChecks"]>[0], _context: OperationContext): Promise<CheckRunResult> {
		this.checkCalls.push({ scope: input.scope, ...(input.taskId ? { taskId: input.taskId } : {}) });
		if (input.scope === "final" && this.failFinalChecks > 0) {
			this.failFinalChecks -= 1;
			throw new Error("final check transport interrupted");
		}
		const preliminary = input.scope === "task" && !input.attempt?.integrationCandidate;
		const failed = preliminary && this.failPreliminaryChecks > 0;
		if (failed) this.failPreliminaryChecks -= 1;
		if (input.scope === "task") {
			this.changesetCallOrder.push(`check:${preliminary ? "preliminary" : "authoritative"}:${failed ? "fail" : "pass"}`);
		}
		return {
			results: input.checks.map((check) => ({ ...check, code: failed ? 1 : 0, killed: false, stdout: "", stderr: "" })),
			identityAfter: { ...input.candidate },
		};
	}

	async review(input: Parameters<GitRuntime["review"]>[0], _context: OperationContext) {
		const handle = await input.acquireLaunch();
		return await withTransientLaunch(handle, async (launch) => {
			if (input.scope === "task") this.changesetCallOrder.push(`review:${input.phase}:${input.taskId}`);
			this.reviewCalls.push({
				role: launch.role,
				modelClass: launch.modelClass,
				scope: input.scope,
				...(input.taskId ? { taskId: input.taskId } : {}),
				criterion: input.criterion,
			});
			return {
				verdict: this.reviewVerdicts.shift() ?? "PASS",
				identityAfter: { ...input.tip },
			};
		});
	}

	async inspectRetainedTask(
		input: Parameters<GitRuntime["inspectRetainedTask"]>[0],
		_context: OperationContext,
	): Promise<WorkspaceIdentity> {
		this.retainedTaskInspectionCalls.push(input.task.id);
		if (!input.attempt.candidate) throw new Error("missing retained candidate");
		return { ...input.attempt.candidate };
	}

	async rebase(input: Parameters<GitRuntime["rebase"]>[0], _context: OperationContext): Promise<RebaseResult> {
		this.rebaseCalls.push(input.task.id);
		this.rebaseInputs.push({
			sourceBase: { ...input.sourceBase },
			candidate: { ...input.candidate },
			onto: { ...input.onto },
		});
		const mainAfter = this.mainAfterRebases.shift();
		if (mainAfter) this.main = { ...mainAfter };
		return { outcome: "ready", base: { ...input.onto }, candidate: { ...input.candidate } };
	}

	async reconcileRebase(input: Parameters<GitRuntime["reconcileRebase"]>[0]): Promise<import("../src/runner.ts").RebaseReconciliation> {
		return { outcome: "not_started" };
	}

	async integrate(input: Parameters<GitRuntime["integrate"]>[0], _context: OperationContext): Promise<IntegrationResult> {
		this.integrations.push(input.task.id);
		this.changesetCallOrder.push(`integrate:${input.task.id}`);
		this.main = identity(input.candidate.head[0]!, input.expectedMain.branch);
		return { outcome: "integrated", main: { ...this.main } };
	}

	async cleanupHost(input: Parameters<HostRuntime["cleanupHost"]>[0], _context: OperationContext) {
		this.cleanupCalls.push(input.kind);
		this.changesetCallOrder.push(`cleanup-host:${input.kind}`);
		const failure = this.cleanupFailures.shift();
		if (failure) throw failure;
		return { outcome: "completed" as const };
	}

	async cleanupGit(input: Parameters<GitRuntime["cleanupGit"]>[0], _context: OperationContext) {
		this.cleanupCalls.push(input.kind);
		this.changesetCallOrder.push(`cleanup-git:${input.kind}`);
		const failure = this.cleanupFailures.shift();
		if (failure) throw failure;
		return { outcome: "completed" as const };
	}

	private async waitForWorkerBarrier(): Promise<void> {
		if (!this.workerBarrierSize || this.workerCalls.length > this.workerBarrierSize) return;
		await new Promise<void>((resolve) => {
			this.workerBarrierResolvers.push(resolve);
			if (this.workerBarrierResolvers.length === this.workerBarrierSize) {
				for (const release of this.workerBarrierResolvers.splice(0)) release();
			}
		});
	}
}

class RecordingStore extends FileRunStore {
	readonly snapshots: RunState[] = [];

	override async create(state: RunState): Promise<RunStateHandle> {
		return this.record(await super.create(state));
	}

	override async load(root: string, id: string): Promise<RunStateHandle> {
		return this.record(await super.load(root, id));
	}

	private record(handle: RunStateHandle): RunStateHandle {
		const save = handle.save.bind(handle);
		handle.save = async () => {
			const snapshot = structuredClone(handle.state);
			await save();
			this.snapshots.push(snapshot);
		};
		return handle;
	}
}

function changesetTask(
	id: string,
	options: {
		role?: string;
		modelClass?: ModelClass;
		dependsOn?: string[];
		contextFrom?: string[];
		checks?: ChangesetTaskRequest["checks"];
		judgment?: ChangesetTaskRequest["judgment"];
	} = {},
): ChangesetTaskRequest {
	return {
		id,
		kind: "changeset",
		role: options.role ?? "implementer",
		modelClass: options.modelClass ?? "fast",
		requirements: `Implement ${id}.`,
		deliverable: `Deliver ${id}.`,
		dependsOn: options.dependsOn ?? [],
		contextFrom: options.contextFrom ?? [],
		checks: options.checks ?? [{ command: `check-${id}`, args: [] }],
		...(options.judgment ? { judgment: options.judgment } : {}),
	};
}

function textTask(id: string, role = "researcher", contextFrom: string[] = []): TaskRequest {
	return {
		id,
		kind: "text",
		role,
		modelClass: "fast",
		requirements: `Research ${id}.`,
		deliverable: `Return ${id}.`,
		dependsOn: [],
		contextFrom,
	};
}

function request(
	id: string,
	tasks: TaskRequest[],
	finalJudgment?: ExecuteRequest["finalJudgment"],
): ExecuteRequest {
	return parseExecuteRequest({
		id,
		goal: "Deliver checked work.",
		mode: "isolated",
		approval: "supervised",
		tasks,
		finalChecks: [{ command: "check-final", args: [] }],
		...(finalJudgment ? { finalJudgment } : {}),
	});
}

const unusedTextExecutor: EphemeralSubagentExecutor = {
	run: async () => { throw new Error("Unexpected text executor invocation."); },
};

async function initializeRepository(root: string): Promise<void> {
	await mkdir(root);
	await writeFile(join(root, "README.md"), "fixture\n");
	execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
	execFileSync("git", ["add", "README.md"], { cwd: root });
	execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "fixture"], { cwd: root });
}

async function harness(
	t: test.TestContext,
	options: {
		executor?: EphemeralSubagentExecutor;
		createStore?: (agentDir: string) => FileRunStore;
		onInteractiveWait?: (requestId: string, taskId: string) => void;
	} = {},
) {
	const directory = await mkdtemp(join(tmpdir(), "pi-subagent-runner-"));
	t.after(async () => await rm(directory, { recursive: true, force: true }));
	const root = join(directory, "workspace");
	await initializeRepository(root);
	const runtime = new FakeRuntime();
	const agentDir = join(directory, "agent");
	const store = options.createStore?.(agentDir) ?? new FileRunStore(agentDir);
	let runner!: IsolatedRunner;
	runner = new IsolatedRunner(
		runtime,
		runtime,
		runtime,
		store,
		options.executor ?? unusedTextExecutor,
		options.onInteractiveWait ?? ((requestId, taskId) => {
			setTimeout(() => runner.acceptCandidate(root, requestId, taskId), 0);
		}),
	);
	return { root, runtime, store, agentDir, runner };
}

function changesetState(state: RunState, id: string) {
	const task = state.tasks.find((candidate) => candidate.taskId === id);
	if (task?.kind !== "changeset") throw new Error(`Expected changeset task ${id}.`);
	return task;
}

function textState(state: RunState, id: string) {
	const task = state.tasks.find((candidate) => candidate.taskId === id);
	if (task?.kind !== "text") throw new Error(`Expected text task ${id}.`);
	return task;
}

function assertParsed(state: RunState): void {
	assert.doesNotThrow(() => parseRunState(structuredClone(state)));
}

function sortedCalls(calls: readonly RoleCall[]): RoleCall[] {
	return [...calls].sort((left, right) => `${left.role}/${left.modelClass}`.localeCompare(`${right.role}/${right.modelClass}`));
}

function runtimeCallCounts(runtime: FakeRuntime) {
	return {
		preflights: runtime.preflightCalls,
		acquisitions: runtime.acquisitions.length,
		allocationPlans: runtime.allocationPlanCalls.length,
		worktreeAllocations: runtime.worktreeAllocationCalls.length,
		workspaceAllocations: runtime.workspaceAllocationCalls.length,
		workerTabAllocations: runtime.workerTabAllocationCalls.length,
		workerAllocations: runtime.workerAllocationCalls.length,
		reconciliations: runtime.reconciliationCalls.length,
		candidateInspections: runtime.candidateInspectionCalls.length,
		retainedTaskInspections: runtime.retainedTaskInspectionCalls.length,
		workers: runtime.workerCalls.length,
		checks: runtime.checkCalls.length,
		terminations: runtime.terminationCalls.length,
		reviews: runtime.reviewCalls.length,
		rebases: runtime.rebaseCalls.length,
		integrations: runtime.integrations.length,
		cleanups: runtime.cleanupCalls.length,
		mainInspections: runtime.inspectMainCalls.length,
	};
}

function runtimeCallDelta(runtime: FakeRuntime, before: ReturnType<typeof runtimeCallCounts>) {
	const after = runtimeCallCounts(runtime);
	return Object.fromEntries(Object.entries(after).map(([key, value]) => [
		key,
		value - before[key as keyof typeof before],
	])) as ReturnType<typeof runtimeCallCounts>;
}

test("scoped changesets accept the exact checked candidate without an interactive wait", async (t) => {
	let waits = 0;
	const { root, runner } = await harness(t, { onInteractiveWait: () => { waits += 1; } });
	const definition = parseExecuteRequest({
		...request("scoped-acceptance", [changesetTask("change")]),
		approval: "scoped",
	});

	const result = await runner.execute(definition, root);
	const attempt = changesetState(result.state, "change").attempts[0]!;
	assert.equal(waits, 0);
	assert.equal(result.state.status, "completed");
	assert.equal(attempt.acceptance?.candidate.head, attempt.candidate?.head);
	assert.equal(attempt.integration?.status, "integrated");
	assertParsed(result.state);
});

test("interactive changesets retain the same worker for queued follow-ups until explicit acceptance", async (t) => {
	const waits: string[] = [];
	const { root, runtime, runner } = await harness(t, {
		onInteractiveWait: (requestId, taskId) => waits.push(`${requestId}/${taskId}`),
	});
	const definition = request("interactive-followups", [changesetTask("change", {
		checks: [{ command: "check-change", args: Array.from({ length: 4 }, () => "x".repeat(10_000)) }],
	})]);
	const execution = runner.execute(definition, root);

	await waitUntil(() => runtime.workerCalls.length === 1);
	assert.throws(
		() => runner.queueFollowup(root, definition.id, "change", "界".repeat(32_000)),
		/Worker assignment exceeds/,
	);
	assert.equal(
		runner.queueFollowup(root, definition.id, "change", "Revise the first candidate without restarting the task."),
		"Queued follow-up for interactive-followups/change.",
	);
	await waitUntil(() => runtime.workerCalls.length === 2);
	assert.equal(
		runner.queueFollowup(root, definition.id, "change", "Polish the revision one more time."),
		"Queued follow-up for interactive-followups/change.",
	);
	await waitUntil(() => runtime.workerCalls.length === 3);
	assert.equal(
		runner.acceptCandidate(root, definition.id, "change"),
		"Acceptance queued for interactive-followups/change.",
	);

	const result = await execution;
	const task = changesetState(result.state, "change");
	assert.equal(result.state.status, "completed");
	assert.deepEqual(runtime.workerCalls, [
		{ taskId: "change", kind: "initial" },
		{ taskId: "change", kind: "followup" },
		{ taskId: "change", kind: "followup" },
	]);
	assert.deepEqual(runtime.followupInstructions, [
		"Revise the first candidate without restarting the task.",
		"Polish the revision one more time.",
	]);
	assert.deepEqual(task.attempts[0]?.prompts.map(({ kind, instruction }) => ({ kind, instruction })), [
		{ kind: "initial", instruction: undefined },
		{ kind: "followup", instruction: "Revise the first candidate without restarting the task." },
		{ kind: "followup", instruction: "Polish the revision one more time." },
	]);
	assert.equal(runtime.terminationCalls.length, 1);
	assert.deepEqual(waits, [
		"interactive-followups/change",
		"interactive-followups/change",
		"interactive-followups/change",
	]);
	assert.throws(
		() => runner.queueFollowup(root, definition.id, "change", "Too late."),
		/not an active interactive changeset/,
	);
	assertParsed(result.state);
});

test("a durable productive lease admits status and abort but blocks concurrent execute and resume", async (t) => {
	let ready!: () => void;
	const awaitingAcceptance = new Promise<void>((resolve) => { ready = resolve; });
	const { root, runtime, runner, agentDir } = await harness(t, {
		onInteractiveWait: () => ready(),
	});
	const otherStore = new FileRunStore(agentDir);
	const otherRunner = new IsolatedRunner(
		runtime,
		runtime,
		runtime,
		otherStore,
		unusedTextExecutor,
	);
	const definition = request("interactive-concurrent-abort", [changesetTask("change")]);
	const execution = runner.execute(definition, root);

	await awaitingAcceptance;
	const persistedBeforeStatus = structuredClone((await otherStore.load(root, definition.id)).state);
	const reported = await otherRunner.status(definition.id, root);
	const reportedTask = changesetState(reported.state, "change");
	assert.equal(reported.state.status, "running");
	assert.equal(reportedTask.status, "awaiting_acceptance");
	assert.equal(reportedTask.attempts[0]?.termination, undefined);
	assert.deepEqual(reported.state, persistedBeforeStatus);
	assert.deepEqual((await otherStore.load(root, definition.id)).state, persistedBeforeStatus);
	assert.deepEqual(reported.main, { status: "current", expected: identity("a"), actual: identity("a") });
	await assert.rejects(
		otherRunner.execute(request("blocked-execute", [changesetTask("other")]), root),
		/Another Pi Subagent productive request is active/,
	);
	await assert.rejects(
		otherRunner.resume({ id: definition.id, action: "retry", taskId: "change" }, root),
		/Another Pi Subagent productive request is active/,
	);
	await assert.rejects(
		runner.resume({ id: definition.id, action: "retry", taskId: "change" }, root),
		/still active/,
	);

	const aborted = await otherRunner.abort(definition.id, root);
	const completedExecution = await execution;
	const abortedAttempt = changesetState(aborted.state, "change").attempts[0]!;
	const agent = abortedAttempt.allocations.find((allocation) => allocation.kind === "agent");
	if (!agent?.agentName || !abortedAttempt.candidate) throw new Error("Expected an exact retained worker fixture.");
	assert.equal(aborted.state.status, "aborted");
	assert.deepEqual(completedExecution.state, aborted.state);
	assert.deepEqual(runtime.terminationCalls, [{ workerId: agent.agentName, candidate: abortedAttempt.candidate }]);
	assert.equal(abortedAttempt.termination?.status, "terminated");
	assert.throws(
		() => runner.queueFollowup(root, definition.id, "change", "Do not revive the aborted worker."),
		/sealed|not an active interactive changeset/,
	);
	assert.throws(
		() => runner.acceptCandidate(root, definition.id, "change"),
		/sealed|not an active interactive changeset/,
	);
	assertParsed(aborted.state);
});

test("rejected interactive waits adopt concurrent durable state before surfacing outer abort", async (t) => {
	let ready!: () => void;
	const awaitingAcceptance = new Promise<void>((resolve) => { ready = resolve; });
	const controller = new AbortController();
	const { root, runtime, runner, agentDir } = await harness(t, {
		onInteractiveWait: () => ready(),
	});
	const definition = request("interactive-outer-state-change", [changesetTask("change")]);
	const execution = runner.execute(definition, root, controller.signal);
	await awaitingAcceptance;

	let locked!: () => void;
	const lifecycleLocked = new Promise<void>((resolve) => { locked = resolve; });
	const concurrentStore = new FileRunStore(agentDir);
	const mutation = concurrentStore.withLock(root, async () => {
		locked();
		controller.abort(new Error("operator interrupted the interactive wait"));
		const handle = await concurrentStore.load(root, definition.id);
		handle.state.status = "aborted";
		handle.state.accepted = false;
		handle.state.updatedAt = runtime.now();
		await handle.save();
	}, { purpose: "abort" });
	await lifecycleLocked;

	const [result] = await Promise.all([execution, mutation]);
	const durable = (await concurrentStore.load(root, definition.id)).state;
	assert.equal(result.state.status, "aborted");
	assert.deepEqual(result.state, durable);
	assert.equal(changesetState(result.state, "change").status, "awaiting_acceptance");
	assertParsed(result.state);
});

test("interrupting an interactive acceptance wait retains the exact worker", async (t) => {
	let ready!: () => void;
	const awaitingAcceptance = new Promise<void>((resolve) => { ready = resolve; });
	const { root, runtime, runner } = await harness(t, {
		onInteractiveWait: () => ready(),
	});
	const controller = new AbortController();
	const definition = request("interactive-interrupt", [changesetTask("change")]);
	const execution = runner.execute(definition, root, controller.signal);

	await awaitingAcceptance;
	controller.abort(new Error("operator interrupted the interactive wait"));
	const result = await execution;
	const task = changesetState(result.state, "change");

	assert.equal(result.state.status, "needs_attention");
	assert.equal(task.status, "needs_attention");
	assert.match(task.failure ?? "", /operator interrupted the interactive wait/);
	assert.equal(runtime.terminationCalls.length, 0);
	assert.equal(task.attempts[0]?.termination, undefined);
	assertParsed(result.state);
});

test("ready changeset waves run concurrently, integrate in request order, and retain exact PASS evidence", async (t) => {
	const { root, runtime, runner } = await harness(t);
	runtime.workerBarrierSize = 2;
	const definition = request("parallel-changes", [
		changesetTask("first", {
			role: "author/one",
			judgment: { role: "judge/first", modelClass: "balanced", criterion: "First change is correct." },
		}),
		changesetTask("second", {
			role: "author/two",
			modelClass: "frontier",
			judgment: { role: "judge/second", modelClass: "fav", criterion: "Second change is correct." },
		}),
		changesetTask("after", { role: "author/after", dependsOn: ["first", "second"] }),
	], { role: "judge/final", modelClass: "balanced", criterion: "The request is correct." });

	const result = await runner.execute(definition, root);
	const first = changesetState(result.state, "first").attempts[0]!;

	assert.equal(result.state.accepted, true);
	assert.deepEqual(result.state.waves.map(({ taskIds }) => taskIds), [["first", "second"], ["after"]]);
	assert.equal(runtime.maxConcurrentWorkers, 2);
	assert.deepEqual(runtime.integrations, ["first", "second", "after"]);
	assert.deepEqual(first.authoritativeChecks?.results, [{
		command: "check-first", args: [], code: 0, killed: false, stdout: "", stderr: "",
	}]);
	assert.equal(first.authoritativeReview?.verdict, "PASS");
	assert.equal(first.authoritativeReview?.passed, true);
	assert.equal(result.state.final.checks?.passed, true);
	assert.equal(result.state.final.review?.verdict, "PASS");
	assert.equal(result.state.final.review?.passed, true);
	assert.deepEqual(sortedCalls(runtime.acquisitions), sortedCalls([
		{ role: "author/one", modelClass: "fast" },
		{ role: "author/two", modelClass: "frontier" },
		{ role: "author/after", modelClass: "fast" },
		{ role: "judge/first", modelClass: "balanced" },
		{ role: "judge/second", modelClass: "fav" },
		{ role: "judge/final", modelClass: "balanced" },
	]));
	assert.deepEqual(sortedCalls(runtime.launchCleanups), sortedCalls(runtime.acquisitions));
	assertParsed(result.state);
});

test("Main movement during rebase records a second exact rebase before integration", async (t) => {
	const { root, runtime, runner } = await harness(t);
	const movedMain = identity("f");
	runtime.mainAfterRebases.push(movedMain);
	const definition = request("consecutive-rebases", [changesetTask("change")]);

	const result = await runner.execute(definition, root);
	const attempt = changesetState(result.state, "change").attempts[0]!;

	assert.equal(result.state.accepted, true);
	assert.equal(runtime.rebaseInputs.length, 2);
	assert.deepEqual(runtime.rebaseInputs.map(({ sourceBase, onto }) => ({ sourceBase, onto })), [
		{ sourceBase: identity("a"), onto: identity("a") },
		{ sourceBase: identity("a"), onto: movedMain },
	]);
	assert.equal(attempt.transitions.length, 2);
	assert.ok(attempt.transitions.every(({ status }) => status === "rebased"));
	assert.deepEqual(attempt.integrationBase, movedMain);
	assert.deepEqual(attempt.termination?.candidate, attempt.integrationCandidate);
	assertParsed(result.state);
});

test("termination reconciliation gates cleanup after durable integration", async (t) => {
	const { root, runtime, runner } = await harness(t);
	runtime.terminationResults.push({ outcome: "unknown", failure: "termination response lost" });
	const definition = request("termination-reconciliation", [changesetTask("change")]);

	const stopped = await runner.execute(definition, root);
	const stoppedAttempt = changesetState(stopped.state, "change").attempts[0]!;
	assert.equal(stopped.state.status, "needs_attention");
	assert.equal(stoppedAttempt.integration?.status, "integrated");
	assert.equal(stoppedAttempt.termination?.status, "unknown");
	assert.equal(runtime.cleanupCalls.length, 0);
	assert.deepEqual(stopped.continuation, { id: definition.id, action: "verify", taskId: "change" });

	runtime.terminationReconciliations.push({ outcome: "unknown", failure: "agent and pane observation disagreed" });
	const blocked = await runner.resume(stopped.continuation!, root);
	assert.equal(changesetState(blocked.state, "change").attempts[0]?.termination?.status, "unknown");
	assert.equal(runtime.cleanupCalls.length, 0);
	assert.deepEqual(blocked.continuation, { id: definition.id, action: "verify", taskId: "change" });

	runtime.terminationReconciliations.push({ outcome: "terminated" });
	const resumed = await runner.resume(blocked.continuation!, root);
	const resumedAttempt = changesetState(resumed.state, "change").attempts[0]!;
	assert.deepEqual(resumed.continuation, { id: definition.id, action: "finalize" });
	assert.equal(resumedAttempt.termination?.status, "terminated");
	assert.equal(runtime.terminationCalls.length, 1);
	assert.deepEqual(runtime.terminationReconciliationCalls, [
		{ workerId: stoppedAttempt.termination!.workerId, candidate: stoppedAttempt.integrationCandidate! },
		{ workerId: stoppedAttempt.termination!.workerId, candidate: stoppedAttempt.integrationCandidate! },
	]);
	assert.deepEqual(runtime.cleanupCalls, ["worker_tab", "workspace", "worktree", "branch"]);
	assertParsed(resumed.state);
	const finalized = await runner.resume(resumed.continuation!, root);
	assert.equal(finalized.state.accepted, true);
	assertParsed(finalized.state);
});

test("text producers feed ordered synthesis context into an integrated changeset", async (t) => {
	const outputs = new Map([
		["source-one", "First source result."],
		["source-two", "Second source result."],
		["synthesis", "Exact synthesized result."],
	]);
	const textCalls: Array<{ taskId: string; prompt: string }> = [];
	let activeTextTasks = 0;
	let maxConcurrentTextTasks = 0;
	let producerStarts = 0;
	let releaseProducers!: () => void;
	const producersReady = new Promise<void>((resolve) => { releaseProducers = resolve; });
	const executor: EphemeralSubagentExecutor = {
		run: async ({ prepare }) => {
			const prepared = await prepare();
			const taskId = /^Task: ([^\n]+)$/m.exec(prepared.task)?.[1];
			const output = taskId ? outputs.get(taskId) : undefined;
			if (!taskId || output === undefined) throw new Error("Unexpected text task prompt.");
			textCalls.push({ taskId, prompt: prepared.task });
			activeTextTasks += 1;
			maxConcurrentTextTasks = Math.max(maxConcurrentTextTasks, activeTextTasks);
			try {
				if (taskId !== "synthesis") {
					producerStarts += 1;
					if (producerStarts === 2) releaseProducers();
					await producersReady;
				}
				return {
					outcome: "success",
					exitCode: 0,
					output,
					outputTruncated: false,
					stderr: "",
				};
			} finally {
				activeTextTasks -= 1;
			}
		},
	};
	const { root, runtime, runner } = await harness(t, { executor });
	const definition = request("text-dataflow", [
		textTask("source-one", "role/source-one"),
		textTask("source-two", "role/source-two"),
		textTask("synthesis", "role/synthesis", ["source-two", "source-one"]),
		changesetTask("apply", {
			role: "role/changeset",
			contextFrom: ["synthesis"],
			judgment: { role: "role/judgment", modelClass: "balanced", criterion: "The synthesis was applied exactly." },
		}),
	]);

	const result = await runner.execute(definition, root);
	const apply = changesetState(result.state, "apply");

	assert.equal(maxConcurrentTextTasks, 2);
	assert.deepEqual(result.state.waves.map(({ taskIds }) => taskIds), [
		["source-one", "source-two"],
		["synthesis"],
		["apply"],
	]);
	const orderedTextCalls = [
		...textCalls.filter(({ taskId }) => taskId !== "synthesis").sort((left, right) => left.taskId.localeCompare(right.taskId)),
		...textCalls.filter(({ taskId }) => taskId === "synthesis"),
	];
	assert.deepEqual(orderedTextCalls, [
		{
			taskId: "source-one",
			prompt: [
				"Task: source-one",
				"Goal:",
				"Deliver checked work.",
				"",
				"Requirements:",
				"Research source-one.",
				"",
				"Deliverable:",
				"Return source-one.",
			].join("\n"),
		},
		{
			taskId: "source-two",
			prompt: [
				"Task: source-two",
				"Goal:",
				"Deliver checked work.",
				"",
				"Requirements:",
				"Research source-two.",
				"",
				"Deliverable:",
				"Return source-two.",
			].join("\n"),
		},
		{
			taskId: "synthesis",
			prompt: [
				"Task: synthesis",
				"Goal:",
				"Deliver checked work.",
				"",
				"Requirements:",
				"Research synthesis.",
				"",
				"Deliverable:",
				"Return synthesis.",
				"",
				"Task data:",
				"Context from task source-two:\nSecond source result.",
				"",
				"Context from task source-one:\nFirst source result.",
			].join("\n"),
		},
	]);
	assert.deepEqual(runtime.workerContextCalls, [{
		taskId: "apply",
		contexts: [{ taskId: "synthesis", text: "Exact synthesized result." }],
	}]);
	assert.deepEqual(sortedCalls(runtime.acquisitions.slice(0, 2)), sortedCalls([
		{ role: "role/source-one", modelClass: "fast" },
		{ role: "role/source-two", modelClass: "fast" },
	]));
	assert.deepEqual(runtime.acquisitions.slice(2), [
		{ role: "role/synthesis", modelClass: "fast" },
		{ role: "role/changeset", modelClass: "fast" },
		{ role: "role/judgment", modelClass: "balanced" },
	]);
	assert.deepEqual(runtime.reviewCalls, [{
		role: "role/judgment",
		modelClass: "balanced",
		scope: "task",
		taskId: "apply",
		criterion: "The synthesis was applied exactly.",
	}]);
	assert.deepEqual(runtime.integrations, ["apply"]);
	assert.equal(apply.status, "completed");
	assert.equal(apply.attempts[0]?.integration?.status, "integrated");
	assert.equal(result.state.status, "completed");
	assert.equal(result.state.accepted, true);
	assert.equal(result.state.final.checks?.passed, true);
	assertParsed(result.state);
});

test("a failed preliminary changeset check gets one same-worker correction before authoritative review", async (t) => {
	const { root, runtime, runner } = await harness(t);
	runtime.failPreliminaryChecks = 1;
	const definition = request("preliminary-correction", [changesetTask("change", {
		judgment: { role: "judge/correction", modelClass: "balanced", criterion: "The corrected change is correct." },
	})]);

	const result = await runner.execute(definition, root);
	const attempt = changesetState(result.state, "change").attempts[0]!;
	const agent = attempt.allocations.find((allocation) => allocation.kind === "agent");
	if (!agent?.agentName) throw new Error("Expected one allocated worker.");

	assert.equal(result.state.version, 4);
	assert.equal(result.state.accepted, true);
	assert.deepEqual(runtime.workerCalls, [
		{ taskId: "change", kind: "initial" },
		{ taskId: "change", kind: "correction" },
	]);
	assert.deepEqual(runtime.workerAllocationCalls, [agent.agentName]);
	assert.deepEqual(runtime.changesetCallOrder, [
		`allocate:${agent.agentName}`,
		`worker:initial:${agent.agentName}`,
		"check:preliminary:fail",
		`worker:correction:${agent.agentName}`,
		"check:preliminary:pass",
		"check:authoritative:pass",
		"review:authoritative:change",
		"integrate:change",
		`terminate:${agent.agentName}`,
		"cleanup-host:worker_tab",
		"cleanup-host:workspace",
		"cleanup-git:worktree",
		"cleanup-git:branch",
	]);
	assert.equal(attempt.preliminaryChecks?.passed, true);
	assert.deepEqual(attempt.acceptance?.candidate, attempt.prompts[1]?.candidate);
	assert.ok((attempt.acceptance?.at ?? 0) > (attempt.prompts[1]?.at ?? Number.MAX_SAFE_INTEGER));
	assert.equal(attempt.authoritativeChecks?.passed, true);
	assert.equal(attempt.authoritativeReview?.passed, true);
	assertParsed(result.state);
});

test("a blocked diagnostic is normalized before same-worker correction", async (t) => {
	const { root, runtime, runner } = await harness(t);
	runtime.workerResults.push({ outcome: "blocked", diagnostic: "diagnostic\n" });

	const result = await runner.execute(request("normalized-correction", [changesetTask("change")]), root);
	const attempt = changesetState(result.state, "change").attempts[0]!;

	assert.equal(result.state.status, "completed");
	assert.deepEqual(runtime.workerCalls, [
		{ taskId: "change", kind: "initial" },
		{ taskId: "change", kind: "correction" },
	]);
	assert.deepEqual(runtime.correctionFailures, ["diagnostic"]);
	assert.equal(attempt.prompts[0]?.failure, "diagnostic");
	assert.equal(attempt.integration?.status, "integrated");
	assert.deepEqual(runtime.integrations, ["change"]);
	assertParsed(result.state);
});

test("a follow-up queued during a failing follow-up is honored", async (t) => {
	for (const failure of ["blocked", "check"] as const) {
		await t.test(failure, async (t) => {
			const waits: string[] = [];
			const { root, runtime, runner } = await harness(t, {
				onInteractiveWait: (requestId, taskId) => waits.push(`${requestId}/${taskId}`),
			});
			const definition = request(`queued-after-${failure}`, [changesetTask("change")]);
			const execution = runner.execute(definition, root);
			await waitUntil(() => waits.length === 1);

			let followupStarted!: () => void;
			let releaseFollowup!: () => void;
			const started = new Promise<void>((resolve) => { followupStarted = resolve; });
			const released = new Promise<void>((resolve) => { releaseFollowup = resolve; });
			let paused = false;
			runtime.workerPause = async (call) => {
				if (call.kind !== "followup" || paused) return;
				paused = true;
				followupStarted();
				await released;
			};
			if (failure === "blocked") runtime.workerResults.push({ outcome: "blocked", diagnostic: "follow-up blocked" });
			else runtime.failPreliminaryChecks = 1;

			runner.queueFollowup(root, definition.id, "change", "First follow-up that will fail.");
			await started;
			runner.queueFollowup(root, definition.id, "change", "Second follow-up must still run.");
			releaseFollowup();
			await waitUntil(() => waits.length === 2);
			runner.acceptCandidate(root, definition.id, "change");

			const result = await execution;
			const attempt = changesetState(result.state, "change").attempts[0]!;
			assert.equal(result.state.status, "completed");
			assert.deepEqual(runtime.workerCalls, [
				{ taskId: "change", kind: "initial" },
				{ taskId: "change", kind: "followup" },
				{ taskId: "change", kind: "followup" },
			]);
			assert.deepEqual(runtime.followupInstructions, [
				"First follow-up that will fail.",
				"Second follow-up must still run.",
			]);
			assert.deepEqual(attempt.prompts.map(({ kind }) => kind), ["initial", "followup", "followup"]);
			assert.equal(attempt.termination?.status, "terminated");
			assert.equal(attempt.integration?.status, "integrated");
			assertParsed(result.state);
		});
	}
});

test("changeset dispatch failure retains the exact allocated worker", async (t) => {
	const { root, runtime, runner } = await harness(t);
	runtime.workerFailures.push(new Error("worker transport failed"));
	const definition = request("dispatch-failure", [changesetTask("change")]);

	const stopped = await runner.execute(definition, root);
	const attempt = changesetState(stopped.state, "change").attempts[0]!;
	const agent = attempt.allocations.find((allocation) => allocation.kind === "agent");
	const preCandidate = attempt.prompts[0]?.preCandidate;
	if (!agent?.agentName || !preCandidate) throw new Error("Expected an allocated worker with a submitted prompt.");

	assert.equal(stopped.state.status, "needs_attention");
	assert.equal(attempt.prompts[0]?.status, "ambiguous");
	assert.equal(attempt.termination, undefined);
	assert.deepEqual(runtime.terminationCalls, []);
	assertParsed(stopped.state);
});

test("abort terminates only the exact active worker without replay", async (t) => {
	const { root, runtime, store, runner } = await harness(t);
	const definition = request("abort-active", [changesetTask("active"), changesetTask("settled")]);
	runtime.workerFailures.push(new Error("active worker transport failed"));
	const stopped = await runner.execute(definition, root);
	const activeTaskId = stopped.state.tasks.find((task) => task.kind === "changeset"
		&& task.attempts[0]?.prompts[0]?.status === "ambiguous")?.taskId;
	const settledTaskId = stopped.state.tasks.find((task) => task.taskId !== activeTaskId)?.taskId;
	if (!activeTaskId || !settledTaskId) throw new Error("Expected one active and one settled worker fixture.");

	const handle = await store.load(root, definition.id);
	const activeAttempt = changesetState(handle.state, activeTaskId).attempts[0]!;
	const activeAgent = activeAttempt.allocations.find((allocation) => allocation.kind === "agent");
	const activeCandidate = activeAttempt.prompts[0]?.preCandidate;
	if (!activeAgent?.agentName || !activeCandidate) throw new Error("Expected an exact active worker fixture.");
	delete activeAttempt.termination;
	await handle.save();
	assertParsed(handle.state);

	runtime.terminationCalls.length = 0;
	const workerCallsBeforeAbort = structuredClone(runtime.workerCalls);
	const aborted = await runner.abort(definition.id, root);
	const abortedActive = changesetState(aborted.state, activeTaskId).attempts[0]!;
	const abortedSettled = changesetState(aborted.state, settledTaskId).attempts[0]!;

	assert.equal(aborted.state.status, "aborted");
	assert.equal(runtime.terminationCalls.length, 2);
	assert.deepEqual(runtime.terminationCalls[0], { workerId: activeAgent.agentName, candidate: activeCandidate });
	assert.deepEqual(runtime.workerCalls, workerCallsBeforeAbort);
	assert.equal(abortedActive.termination?.status, "terminated");
	assert.equal(abortedSettled.termination?.status, "terminated");
	assertParsed(aborted.state);
});

test("status preserves interrupted and ambiguous changeset prompts without productive replay", async (t) => {
	for (const boundary of ["interrupted", "ambiguous"] as const) {
		await t.test(boundary, async (t) => {
			const { root, runtime, store, runner } = await harness(t);
			const definition = request(`status-${boundary}-prompt`, [changesetTask("change", {
				judgment: { role: "judge/status", modelClass: "balanced", criterion: "The retained change is correct." },
			})]);
			runtime.workerFailures.push(new Error("worker result unavailable"));
			await runner.execute(definition, root);

			const handle = await store.load(root, definition.id);
			const task = changesetState(handle.state, "change");
			const attempt = task.attempts[0]!;
			const prompt = attempt.prompts[0]!;
			const agent = attempt.allocations.find((allocation) => allocation.kind === "agent");
			if (!agent?.agentName) throw new Error("Expected an exact allocated worker fixture.");
			delete attempt.termination;
			if (boundary === "interrupted") {
				handle.state.status = "running";
				handle.state.waves[0]!.status = "dispatching";
				task.status = "working";
				task.failure = undefined;
				prompt.status = "submitting";
				prompt.failure = undefined;
			}
			assertParsed(handle.state);
			await handle.save();
			const callsBeforeStatus = runtimeCallCounts(runtime);

			const reported = await runner.status(definition.id, root);
			const reportedAttempt = changesetState(reported.state, "change").attempts[0]!;
			assert.equal(reported.state.version, 4);
			assert.equal(reported.state.status, boundary === "interrupted" ? "running" : "needs_attention");
			assert.equal(reportedAttempt.prompts[0]?.status, boundary === "interrupted" ? "submitting" : "ambiguous");
			assert.equal(reportedAttempt.termination, undefined);
			assert.deepEqual(reported.main, { status: "current", expected: identity("a"), actual: identity("a") });
			assert.equal(reported.continuation, undefined);
			assert.deepEqual(runtimeCallDelta(runtime, callsBeforeStatus), {
				preflights: 0,
				acquisitions: 0,
				allocationPlans: 0,
				worktreeAllocations: 0,
				workspaceAllocations: 0,
				workerTabAllocations: 0,
				workerAllocations: 0,
				reconciliations: 0,
				candidateInspections: 0,
				retainedTaskInspections: 0,
				workers: 0,
				checks: 0,
				terminations: 0,
				reviews: 0,
				rebases: 0,
				integrations: 0,
				cleanups: 0,
				mainInspections: 1,
			});
			assert.deepEqual(runtime.terminationCalls, []);
			assertParsed(reported.state);
		});
	}
});

test("status reports Main drift and inspection expiry or failure without mutation or replay", async (t) => {
	for (const outcome of ["drift", "expiry", "unavailable"] as const) {
		await t.test(outcome, async (t) => {
			const { root, runtime, store, runner } = await harness(t);
			const definition = request(`status-main-${outcome}`, [changesetTask("change")]);
			runtime.inspectMainFailures.push(new Error("initial inspection unavailable"));
			await runner.execute(definition, root);
			const persistedBefore = structuredClone((await store.load(root, definition.id)).state);
			assertParsed(persistedBefore);
			if (outcome === "drift") runtime.main = identity("f");
			if (outcome === "expiry") runtime.expireMainInspections = 1;
			if (outcome === "unavailable") runtime.inspectMainFailures.push(new Error("read failed"));
			const statusStartedAt = runtime.clock;
			const callsBeforeStatus = runtimeCallCounts(runtime);

			const reported = await runner.status(definition.id, root);
			if (outcome === "drift") {
				assert.deepEqual(reported.main, { status: "drifted", expected: identity("a"), actual: identity("f") });
				assert.match(reported.text, /Main: drifted/);
			} else {
				assert.equal(reported.main?.status, "unavailable");
				assert.match(reported.text, outcome === "expiry" ? /deadline is exhausted/i : /read-only Main inspection failed: read failed/i);
			}
			assert.deepEqual(reported.continuation, { id: definition.id, action: "retry", taskId: "change" });
			assert.deepEqual(reported.state, persistedBefore);
			assert.deepEqual((await store.load(root, definition.id)).state, persistedBefore);
			assert.deepEqual(runtimeCallDelta(runtime, callsBeforeStatus), {
				preflights: 0,
				acquisitions: 0,
				allocationPlans: 0,
				worktreeAllocations: 0,
				workspaceAllocations: 0,
				workerTabAllocations: 0,
				workerAllocations: 0,
				reconciliations: 0,
				candidateInspections: 0,
				retainedTaskInspections: 0,
				workers: 0,
				checks: 0,
				terminations: 0,
				reviews: 0,
				rebases: 0,
				integrations: 0,
				cleanups: 0,
				mainInspections: 1,
			});
			const inspection = runtime.inspectMainCalls.at(-1)!;
			assert.equal(inspection.deadline, statusStartedAt + STATUS_INSPECTION_BUDGET_MS);
			assert.equal(inspection.timeoutMs, STATUS_INSPECTION_BUDGET_MS);
			assertParsed(reported.state);
		});
	}
});

test("status permits only pending cleanup recovery after integration", async (t) => {
	const { root, runtime, store, runner } = await harness(t);
	const definition = request("status-cleanup-only", [
		changesetTask("integrated"),
		changesetTask("dependent", { dependsOn: ["integrated"] }),
	]);
	runtime.cleanupFailures.push(new Error("cleanup interrupted"));
	const waiting = await runner.execute(definition, root);
	const waitingAttempt = changesetState(waiting.state, "integrated").attempts[0]!;
	assert.equal(waitingAttempt.integration?.status, "integrated");
	assert.ok(waitingAttempt.cleanup.every(({ status }) => status === "pending"));
	assert.deepEqual(runtime.cleanupCalls, ["worker_tab"]);

	runtime.clock += 10_000;
	runtime.main = identity("f");
	const persistedBefore = structuredClone((await store.load(root, definition.id)).state);
	assertParsed(persistedBefore);
	const callsBeforeStatus = runtimeCallCounts(runtime);
	const reported = await runner.status(definition.id, root);

	assert.equal(reported.main?.status, "drifted");
	assert.deepEqual(reported.continuation, { id: definition.id, action: "verify", taskId: "integrated" });
	assert.deepEqual(reported.state, persistedBefore);
	assert.deepEqual((await store.load(root, definition.id)).state, persistedBefore);
	assert.deepEqual(runtimeCallDelta(runtime, callsBeforeStatus), {
		preflights: 0,
		acquisitions: 0,
		allocationPlans: 0,
		worktreeAllocations: 0,
		workspaceAllocations: 0,
		workerTabAllocations: 0,
		workerAllocations: 0,
		reconciliations: 0,
		candidateInspections: 0,
		retainedTaskInspections: 0,
		workers: 0,
		checks: 0,
		terminations: 0,
		reviews: 0,
		rebases: 0,
		integrations: 0,
		cleanups: 0,
		mainInspections: 1,
	});

	const callsBeforeCleanup = runtimeCallCounts(runtime);
	const cleaned = await runner.resume(reported.continuation!, root);
	assert.deepEqual(runtimeCallDelta(runtime, callsBeforeCleanup), {
		preflights: 0,
		acquisitions: 0,
		allocationPlans: 0,
		worktreeAllocations: 0,
		workspaceAllocations: 0,
		workerTabAllocations: 0,
		workerAllocations: 0,
		reconciliations: 0,
		candidateInspections: 0,
		retainedTaskInspections: 0,
		workers: 0,
		checks: 0,
		terminations: 0,
		reviews: 0,
		rebases: 0,
		integrations: 0,
		cleanups: 4,
		mainInspections: 0,
	});
	assert.deepEqual(runtime.cleanupCalls.slice(-4), ["worker_tab", "workspace", "worktree", "branch"]);
	assert.equal(changesetState(cleaned.state, "integrated").status, "completed");
	assert.equal(changesetState(cleaned.state, "dependent").status, "needs_attention");
	assert.equal(cleaned.state.final.status, "pending");
	assert.equal(cleaned.state.accepted, false);
	assert.deepEqual(cleaned.continuation, { id: definition.id, action: "retry", taskId: "dependent" });
	assertParsed(cleaned.state);
});

test("failures enter needs_attention and require explicit recovery actions", async (t) => {
	await t.test("retry", async (t) => {
		const { root, runtime, runner } = await harness(t);
		const definition = request("retry-change", [changesetTask("change")]);
		runtime.inspectMainFailures.push(new Error("Main inspection unavailable"));

		const stopped = await runner.execute(definition, root);
		assert.equal(stopped.state.status, "needs_attention");
		assert.equal(changesetState(stopped.state, "change").attempts.length, 0);
		assert.equal(runtime.workerCalls.length, 0);
		assert.deepEqual(stopped.continuation, { id: definition.id, action: "retry", taskId: "change" });
		assert.equal(Object.hasOwn(stopped.state, "deadline"), false);
		runtime.clock += 31 * 60_000;

		const resumed = await runner.resume({ id: definition.id, action: "retry", taskId: "change" }, root);
		assert.equal(resumed.state.accepted, true);
		assert.deepEqual(runtime.workerCalls, [{ taskId: "change", kind: "initial" }]);
		assertParsed(resumed.state);
	});

	await t.test("same-worker correction", async (t) => {
		const { root, runtime, runner } = await harness(t);
		const definition = request("verify-change", [changesetTask("change", {
			judgment: { role: "judge/manual", modelClass: "frontier", criterion: "The retained change is correct." },
		})]);
		runtime.reviewVerdicts.push("NEEDS_WORK", "PASS");

		const stopped = await runner.execute(definition, root);
		assert.equal(stopped.state.status, "needs_attention");
		assert.deepEqual(stopped.continuation, { id: definition.id, action: "retry", taskId: "change" });
		const corrected = await runner.resume({ id: definition.id, action: "retry", taskId: "change" }, root);
		assert.equal(corrected.state.accepted, true);
		assert.deepEqual(runtime.workerCalls, [
			{ taskId: "change", kind: "initial" },
			{ taskId: "change", kind: "correction" },
		]);
		assert.deepEqual(runtime.reviewCalls.map(({ scope, taskId }) => ({ scope, taskId })), [
			{ scope: "task", taskId: "change" },
			{ scope: "task", taskId: "change" },
		]);
		assertParsed(corrected.state);
	});

	await t.test("finalize", async (t) => {
		const { root, runtime, runner } = await harness(t);
		const definition = request("finalize-change", [changesetTask("change")]);
		runtime.failFinalChecks = 1;

		const stopped = await runner.execute(definition, root);
		assert.equal(stopped.state.status, "needs_attention");
		assert.equal(stopped.state.final.status, "interrupted");
		assert.deepEqual(stopped.continuation, { id: definition.id, action: "finalize" });

		const finalized = await runner.resume({ id: definition.id, action: "finalize" }, root);
		assert.equal(finalized.state.accepted, true);
		assertParsed(finalized.state);
	});
});

test("text dispatch uses the injected executor and persists a valid running intent and atomic completion", async (t) => {
	let store: RecordingStore | undefined;
	let persistedAtLaunch: RunState | undefined;
	let preparedTask: string | undefined;
	const executor: EphemeralSubagentExecutor = {
		run: async ({ prepare }) => {
			const prepared = await prepare();
			preparedTask = prepared.task;
			persistedAtLaunch = structuredClone(store!.snapshots.at(-1)!);
			return {
				outcome: "success",
				exitCode: 0,
				output: "  concise text result.  ",
				outputTruncated: false,
				stderr: "",
			};
		},
	};
	const { root, runtime, runner } = await harness(t, {
		executor,
		createStore: (agentDir) => (store = new RecordingStore(agentDir)),
	});
	const definition = request("text-success", [textTask("research", "researcher/brief")]);

	const result = await runner.execute(definition, root);
	const task = textState(result.state, "research");
	if (!persistedAtLaunch) throw new Error("Expected persisted state before text executor launch.");
	const running = textState(persistedAtLaunch, "research");
	assert.match(preparedTask ?? "", /^Task: research$/m);
	assert.equal(persistedAtLaunch.status, "running");
	assert.equal(running.status, "running");
	assert.deepEqual(running.attempts, [{ number: 1, status: "running" }]);
	assert.equal(result.state.accepted, true);
	assert.equal(task.attempts[0]?.number, 1);
	assert.equal(task.attempts[0]?.status, "completed");
	assert.deepEqual(task.attempts[0]?.output, { text: "concise text result." });
	assert.deepEqual(runtime.launchCleanups, [{ role: "researcher/brief", modelClass: "fast" }]);
	const outputSnapshots = store!.snapshots.filter((snapshot) => Boolean(textState(snapshot, "research").attempts.at(-1)?.output));
	assert.ok(outputSnapshots.length > 0);
	assert.ok(outputSnapshots.every((snapshot) => {
		const saved = textState(snapshot, "research");
		return saved.status === "completed"
			&& saved.attempts.at(-1)?.status === "completed"
			&& saved.attempts.at(-1)?.output?.text === "concise text result.";
	}));
	for (const snapshot of store!.snapshots) assertParsed(snapshot);
	assertParsed(result.state);
});

test("text dispatch rejects empty, truncated, oversized, and Main-drifted output", async (t) => {
	const cases = [
		{ name: "empty", output: "   ", truncated: false },
		{ name: "truncated", output: "result", truncated: true },
		{ name: "oversized", output: "x".repeat(MAX_PERSISTED_RUNTIME_TEXT_BYTES + 1), truncated: false },
		{ name: "Main drift", output: "result", truncated: false, drift: true },
	];
	for (const plan of cases) {
		await t.test(plan.name, async (t) => {
			let runtime: FakeRuntime | undefined;
			const executor: EphemeralSubagentExecutor = {
				run: async () => {
					if (plan.drift) runtime!.main = identity("f");
					return {
						outcome: "success",
						exitCode: 0,
						output: plan.output,
						outputTruncated: plan.truncated,
						stderr: "",
					};
				},
			};
			const created = await harness(t, { executor });
			runtime = created.runtime;
			const definition = request(`text-${plan.name.toLowerCase().replace(" ", "-")}`, [textTask("research")]);

			const stopped = await created.runner.execute(definition, created.root);
			const task = textState(stopped.state, "research");
			assert.equal(stopped.state.status, "needs_attention");
			assert.equal(task.status, "needs_attention");
			assert.equal(task.attempts.at(-1)?.status, "failed");
			assert.ok(task.failure);
			assertParsed(stopped.state);
		});
	}
});

test("an interrupted text task remains failed until its explicit retry", async (t) => {
	let calls = 0;
	const executor: EphemeralSubagentExecutor = {
		run: async () => {
			calls += 1;
			if (calls === 1) throw new Error("executor interrupted");
			return {
				outcome: "success",
				exitCode: 0,
				output: "Retry result.",
				outputTruncated: false,
				stderr: "",
			};
		},
	};
	const { root, runtime, runner } = await harness(t, { executor });
	const definition = request("text-retry", [textTask("research")]);

	const stopped = await runner.execute(definition, root);
	const failed = textState(stopped.state, "research");
	assert.equal(stopped.state.status, "needs_attention");
	assert.deepEqual(stopped.continuation, { id: definition.id, action: "retry", taskId: "research" });
	assert.deepEqual(failed.attempts, [{
		number: 1,
		status: "failed",
		failure: "Task dispatch was interrupted: executor interrupted",
	}]);
	assert.equal(calls, 1);

	const retried = await runner.resume({ id: definition.id, action: "retry", taskId: "research" }, root);
	const completed = textState(retried.state, "research");
	assert.equal(retried.state.accepted, true);
	assert.equal(calls, 2);
	assert.deepEqual(completed.attempts.map(({ number, status }) => ({ number, status })), [
		{ number: 1, status: "failed" },
		{ number: 2, status: "completed" },
	]);
	assert.deepEqual(runtime.launchCleanups, [
		{ role: "researcher", modelClass: "fast" },
		{ role: "researcher", modelClass: "fast" },
	]);
	assertParsed(retried.state);
});
