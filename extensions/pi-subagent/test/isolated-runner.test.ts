import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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
	type OperationContext,
	type RunResponse,
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
import { IntegrationGit, type StageReceipt, type GitOutcome } from "../src/integration-git.ts";
import type { WorktreeInfo } from "../src/worktree.ts";

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
	integrationIdentity?: WorkspaceIdentity;
	integrationPath?: string;
	workerBarrierSize = 0;
	maxConcurrentWorkers = 0;
	failFinalChecks = 0;
	failCombinedExit = false;
	failPreliminaryChecks = 0;
	expireMainInspections = 0;
	preflightCalls = 0;
	readonly acquisitions: RoleCall[] = [];
	readonly launchCleanups: RoleCall[] = [];
	readonly workerCalls: WorkerCall[] = [];
	readonly workerContextCalls: WorkerContextCall[] = [];
	readonly allocationPlanCalls: HostAllocationKind[] = [];
	readonly worktreeAllocationCalls: string[] = [];
	readonly allocationBases: Array<{ taskId: string; base: WorkspaceIdentity; checkout?: string }> = [];
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
		if ((this.integrationPath === _input.root || _input.root.includes("subagent-integration")) && this.integrationIdentity) return this.integrationIdentity;
		if (this.expireMainInspections > 0) {
			this.expireMainInspections -= 1;
			if (context.deadline === undefined) throw new Error("Expected a finite inspection deadline.");
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
		this.allocationBases.push({ taskId: input.task.id, base: input.attempt.waveBase, checkout: input.baseRoot });
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
			const candidateCharacters = "bcdef123456789";
			return {
				outcome: "candidate",
				candidate: identity(candidateCharacters[this.candidateNumber++ % candidateCharacters.length]!, `refs/heads/${input.task.id}`),
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
		const preliminary = input.scope === "task";
		const failed = preliminary && this.failPreliminaryChecks > 0;
		if (failed) this.failPreliminaryChecks -= 1;
		if (input.scope === "task") {
			this.changesetCallOrder.push(`check:preliminary:${failed ? "fail" : "pass"}`);
		}
		return {
			results: input.checks.map((check) => ({ ...check, code: failed || (input.scope === "final" && this.failCombinedExit) ? 1 : 0, killed: false, stdout: "", stderr: "" })),
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

	async cleanupHost(input: Parameters<HostRuntime["cleanupHost"]>[0], _context: OperationContext) {
		this.cleanupCalls.push(input.kind);
		this.changesetCallOrder.push(`cleanup-host:${input.kind}`);
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
	beforeSave?: (state: RunState) => void;
	afterSave?: (state: RunState) => void;

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
			this.beforeSave?.(snapshot);
			await save();
			this.snapshots.push(snapshot);
			this.afterSave?.(snapshot);
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
	await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
	execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
	execFileSync("git", ["add", "README.md", "package.json"], { cwd: root });
	execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "fixture"], { cwd: root });
}

async function harness(
	t: test.TestContext,
	options: {
		executor?: EphemeralSubagentExecutor;
		createStore?: (agentDir: string) => FileRunStore;
		integrationGit?: IntegrationGit;
	} = {},
) {
	const directory = await mkdtemp(join(tmpdir(), "pi-subagent-runner-"));
	t.after(async () => await rm(directory, { recursive: true, force: true }));
	const root = join(directory, "workspace");
	await initializeRepository(root);
	const runtime = new FakeRuntime();
	const agentDir = join(directory, "agent");
	const store = options.createStore?.(agentDir) ?? new FileRunStore(agentDir);
	const runner = new IsolatedRunner(
		runtime,
		runtime,
		runtime,
		store,
		options.executor ?? unusedTextExecutor,
		undefined,
		undefined,
		options.integrationGit,
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

test("v4 unfinished requests block v5 admission without changing legacy state or launching workers", async (t) => {
	const { root, runtime, runner, store } = await harness(t);
	const legacyPath = store.statePath(root, "old-request");
	await mkdir(store.stateDirectory(root), { recursive: true });
	for (const status of ["pending", "running", "needs_attention"]) {
		const bytes = Buffer.from(`{\n  "version": 4, "status": "${status}", "v4Evidence": "keep me"\n}\n`);
		await writeFile(legacyPath, bytes);
		await assert.rejects(
			runner.execute(request(`new-after-${status.replaceAll("_", "-")}`, [changesetTask("change")]), root),
			new RegExp(`unfinished v4 request old-request \\(${status}\\).*compatible owner`),
		);
		assert.deepEqual(await readFile(legacyPath), bytes);
		assert.equal(runtime.workerCalls.length, 0);
		assert.equal(runtime.allocationPlanCalls.length, 0);
		await assert.rejects(store.load(root, `new-after-${status.replaceAll("_", "-")}`), { code: "ENOENT" });
	}
	await assert.rejects(store.load(root, "old-request"), /Unsupported pi-subagent state version 4/);
});

test("completed and terminal v4 state remains untouched and does not prevent fresh requests", async (t) => {
	const { root, runtime, runner, store, agentDir } = await harness(t);
	const legacyPath = store.statePath(root, "old-request");
	await mkdir(store.stateDirectory(root), { recursive: true });
	// No cross-extension scanning: another extension may have a malformed file with the same name.
	await mkdir(join(agentDir, "config", "pi-other", "state"), { recursive: true });
	await writeFile(join(agentDir, "config", "pi-other", "state", "old-request.json"), "garbage");
	for (const status of ["completed", "final_failed", "superseded", "aborted"]) {
		const bytes = Buffer.from(`{ "version": 4, "status": "${status}", "v4Evidence": "keep me" }\n`);
		await writeFile(legacyPath, bytes);
		await runner.execute(request(`new-after-${status.replaceAll("_", "-")}`, [changesetTask("change")]), root);
		assert.deepEqual(await readFile(legacyPath), bytes);
	}
	assert.equal(runtime.workerCalls.length, 4);
});

test("malformed or unreadable v4 state fails closed without changing bytes", async (t) => {
	const { root, runtime, runner, store } = await harness(t);
	const legacyPath = store.statePath(root, "old-request");
	await mkdir(store.stateDirectory(root), { recursive: true });
	for (const bytes of [Buffer.from('{"version":4,"status":"unknown"}\n'), Buffer.from('{"version":4,')]) {
		await writeFile(legacyPath, bytes);
		await assert.rejects(runner.execute(request("new-request", [changesetTask("change")]), root),
			/(malformed|cannot read state) .*old-request.*compatible owner/);
		assert.deepEqual(await readFile(legacyPath), bytes);
		await assert.rejects(store.load(root, "new-request"), { code: "ENOENT" });
	}
	await rm(legacyPath);
	const target = join(store.stateDirectory(root), "retained.txt");
	const bytes = Buffer.from('{"version":4,"status":"running"}\n');
	await writeFile(target, bytes);
	await symlink(target, legacyPath);
	await assert.rejects(runner.execute(request("new-request", [changesetTask("change")]), root),
		/cannot read state old-request.*compatible owner/);
	assert.deepEqual(await readFile(target), bytes);
	await assert.rejects(store.load(root, "new-request"), { code: "ENOENT" });
	assert.deepEqual(runtime.workerCalls, []);
});

test("inventory lists healthy requests beside preserved invalid state without reconciling resources", async (t) => {
	const { root, runner, runtime, store } = await harness(t);
	let release!: () => void;
	const paused = new Promise<void>((resolve) => { release = resolve; });
	runtime.workerPause = async (call) => { if (call.kind === "initial") await paused; };
	const execution = runner.execute(request("inventory-good", [changesetTask("change")]), root);
	await waitUntil(() => runtime.workerCalls.length === 1);
	const badPath = store.statePath(root, "inventory-bad");
	const bytes = Buffer.from("{malformed");
	await writeFile(badPath, bytes);
	const before = runtimeCallCounts(runtime);
	const listed = await runner.listRequests(root);
	assert.deepEqual(listed.invalidIds, ["inventory-bad"]);
	assert.deepEqual(listed.requests.map(({ id }) => id), ["inventory-good"]);
	assert.equal(listed.requests[0]!.tasks[0]!.kind, "changeset");
	assert.deepEqual(runtimeCallDelta(runtime, before), Object.fromEntries(Object.keys(before).map((key) => [key, 0])));
	assert.deepEqual(await readFile(badPath), bytes);
	release();
	await execution;
});

test("queued follow-ups reuse the same worker before automatic readiness seals the candidate", async (t) => {
	const { root, runtime, runner } = await harness(t);
	let releaseInitial!: () => void;
	const initialPaused = new Promise<void>((resolve) => { releaseInitial = resolve; });
	runtime.workerPause = async (call) => {
		if (call.kind === "initial") await initialPaused;
	};
	const definition = request("automatic-followups", [changesetTask("change", {
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
		"Queued follow-up for automatic-followups/change.",
	);
	assert.equal(
		runner.queueFollowup(root, definition.id, "change", "Polish the revision one more time."),
		"Queued follow-up for automatic-followups/change.",
	);
	assert.equal(runner.canFollowup(root, definition.id, "change"), true);
	assert.deepEqual(runner.drainFollowups(root, definition.id, "change"), [
		"Revise the first candidate without restarting the task.", "Polish the revision one more time.",
	]);
	assert.deepEqual(runner.drainFollowups(root, definition.id, "change"), []);
	runner.queueFollowup(root, definition.id, "change", "Replacement revision.");
	runner.queueFollowup(root, definition.id, "change", "Polish the revision one more time.");
	releaseInitial();

	const result = await execution;
	const task = changesetState(result.state, "change");
	assert.equal(result.state.status, "needs_attention");
	assert.deepEqual(runtime.workerCalls, [
		{ taskId: "change", kind: "initial" },
		{ taskId: "change", kind: "followup" },
		{ taskId: "change", kind: "followup" },
	]);
	assert.deepEqual(runtime.followupInstructions, [
		"Replacement revision.",
		"Polish the revision one more time.",
	]);
	assert.deepEqual(task.attempts[0]?.prompts.map(({ kind, instruction }) => ({ kind, instruction })), [
		{ kind: "initial", instruction: undefined },
		{ kind: "followup", instruction: "Replacement revision." },
		{ kind: "followup", instruction: "Polish the revision one more time." },
	]);
	assert.equal(task.attempts[0]?.readiness?.candidate.head, task.attempts[0]?.prompts[2]?.candidate?.head);
	assert.equal(runtime.terminationCalls.length, 0);
	assert.equal(runner.canFollowup(root, definition.id, "change"), false);
	assert.throws(() => runner.drainFollowups(root, definition.id, "change"), /not an active unsealed changeset/);
	assert.throws(
		() => runner.queueFollowup(root, definition.id, "change", "Too late."),
		/not an active unsealed changeset/,
	);
	assertParsed(result.state);
});

test("drain after worker claim withdraws only the remaining task instructions", async (t) => {
	const { root, runtime, runner } = await harness(t);
	let releaseInitial!: () => void;
	let releaseClaimed!: () => void;
	let claimed!: () => void;
	const initial = new Promise<void>((resolve) => { releaseInitial = resolve; });
	const paused = new Promise<void>((resolve) => { releaseClaimed = resolve; });
	const started = new Promise<void>((resolve) => { claimed = resolve; });
	runtime.workerPause = async (call) => {
		if (call.kind === "initial") await initial;
		if (call.kind === "followup") { claimed(); await paused; }
	};
	const definition = request("claimed-followup", [changesetTask("change")]);
	const execution = runner.execute(definition, root);
	await waitUntil(() => runtime.workerCalls.length === 1);
	runner.queueFollowup(root, definition.id, "change", "Already claimed.");
	runner.queueFollowup(root, definition.id, "change", "Still pending.");
	releaseInitial();
	await started;
	assert.deepEqual(runner.drainFollowups(root, definition.id, "change"), ["Still pending."]);
	assert.deepEqual(runtime.followupInstructions, ["Already claimed."]);
	releaseClaimed();
	await execution;
	assert.deepEqual(runtime.followupInstructions, ["Already claimed."]);
});

test("a follow-up admitted during final preliminary-evidence persistence is rechecked before sealing", async (t) => {
	let store!: RecordingStore;
	const { root, runtime, runner } = await harness(t, {
		createStore: (agentDir) => (store = new RecordingStore(agentDir)),
	});
	const definition = request("save-boundary-followup", [changesetTask("change")]);
	let queued = false;
	store.afterSave = (state) => {
		const task = changesetState(state, "change");
		const attempt = task.attempts[0];
		if (queued || task.status !== "working" || !attempt?.preliminaryChecks?.passed || attempt.readiness) return;
		queued = true;
		runner.queueFollowup(root, definition.id, "change", "Revision admitted while checked evidence is saving.");
	};

	const result = await runner.execute(definition, root);
	const attempt = changesetState(result.state, "change").attempts[0]!;
	assert.equal(queued, true);
	assert.deepEqual(runtime.workerCalls, [
		{ taskId: "change", kind: "initial" },
		{ taskId: "change", kind: "followup" },
	]);
	assert.deepEqual(runtime.followupInstructions, ["Revision admitted while checked evidence is saving."]);
	assert.equal(runtime.checkCalls.filter(({ scope }) => scope === "task").length, 2);
	assert.deepEqual(attempt.readiness?.candidate, attempt.prompts[1]?.candidate);
	assert.equal(result.state.status, "needs_attention");
	assertParsed(result.state);
});

test("failed readiness persistence returns attention without integrating or terminating the worker", async (t) => {
	let store!: RecordingStore;
	const { root, runtime, runner } = await harness(t, {
		createStore: (agentDir) => (store = new RecordingStore(agentDir)),
	});
	let failed = false;
	store.beforeSave = (state) => {
		const attempt = changesetState(state, "change").attempts[0];
		if (failed || !attempt?.readiness) return;
		failed = true;
		throw new Error("simulated readiness persistence failure");
	};

	const result = await runner.execute(request("readiness-save-failure", [changesetTask("change")]), root);
	const task = changesetState(result.state, "change");
	assert.equal(failed, true);
	assert.equal(result.state.status, "needs_attention");
	assert.equal(task.status, "needs_attention");
	assert.match(task.failure ?? "", /simulated readiness persistence failure/);
	assert.ok(task.attempts[0]?.readiness);
	assert.deepEqual(runtime.terminationCalls, []);
	assert.deepEqual(result.continuation, { id: "readiness-save-failure", action: "verify", taskId: "change" });
	assertParsed(result.state);

	const retained = await store.load(root, "readiness-save-failure");
	delete changesetState(retained.state, "change").attempts[0]!.readiness;
	await retained.save();
	const recovered = await runner.resume(result.continuation!, root);
	assert.equal(recovered.state.status, "needs_attention");
	assert.deepEqual(runtime.workerCalls, [{ taskId: "change", kind: "initial" }]);
	assertParsed(recovered.state);
});

test("the active follow-up queue remains bounded", async (t) => {
	let releaseWorker!: () => void;
	const workerPaused = new Promise<void>((resolve) => { releaseWorker = resolve; });
	const { root, runtime, runner } = await harness(t);
	runtime.workerPause = async (call) => {
		if (call.kind === "initial") await workerPaused;
	};
	const definition = request("bounded-followups", [changesetTask("change")]);
	const execution = runner.execute(definition, root);
	await waitUntil(() => runtime.workerCalls.length === 1);
	for (let index = 0; index < 16; index += 1) {
		runner.queueFollowup(root, definition.id, "change", `Queued revision ${index + 1}.`);
	}
	assert.throws(
		() => runner.queueFollowup(root, definition.id, "change", "One revision too many."),
		/may queue at most 16 follow-ups/,
	);
	releaseWorker();

	const result = await execution;
	assert.equal(result.state.status, "needs_attention");
	assert.equal(runtime.followupInstructions.length, 16);
	assert.equal(runtime.checkCalls.filter(({ scope }) => scope === "task").length, 17);
	assertParsed(result.state);
});

test("abort during agent startup waits for durable ownership and terminates that agent", async (t) => {
	const { root, runtime, runner, store } = await harness(t);
	let allocationStarted!: () => void;
	let releaseAllocation!: () => void;
	let abortQueued!: () => void;
	const started = new Promise<void>((resolve) => { allocationStarted = resolve; });
	const released = new Promise<void>((resolve) => { releaseAllocation = resolve; });
	const queued = new Promise<void>((resolve) => { abortQueued = resolve; });
	const allocateHost = runtime.allocateHost.bind(runtime);
	runtime.allocateHost = async (input, context) => {
		const result = await allocateHost(input, context);
		if (input.intent.kind === "agent") {
			allocationStarted();
			await released;
		}
		return result;
	};
	// Order lock requests explicitly so the race does not depend on filesystem timing.
	const withLock = store.withLock.bind(store);
	let pending: Promise<unknown> = Promise.resolve();
	store.withLock = (root, operation, options) => {
		const result = pending.then(() => withLock(root, operation, options));
		pending = result.then(() => undefined, () => undefined);
		if (options?.purpose === "abort") abortQueued();
		return result;
	};
	const definition = request("abort-agent-startup", [changesetTask("change")]);
	const execution = runner.execute(definition, root);
	await started;
	const abortRunner = new IsolatedRunner(runtime, runtime, runtime, store, unusedTextExecutor);
	const aborting = abortRunner.abort(definition.id, root);
	await queued;
	releaseAllocation();
	const aborted = await aborting;
	const result = await execution;
	const attempt = changesetState(aborted.state, "change").attempts[0]!;
	const agent = attempt.allocations.find((allocation) => allocation.kind === "agent");
	assert.equal(agent?.status, "owned");
	assert.equal(attempt.termination?.status, "terminated");
	assert.deepEqual(runtime.terminationCalls, [{ workerId: "change-agent", candidate: attempt.waveBase }]);
	assert.deepEqual(runtime.workerCalls, []);
	assert.equal(aborted.state.status, "aborted");
	assert.deepEqual(result.state, aborted.state);
	assertParsed(aborted.state);
});

test("a productive lease admits read-only status and abort during a paused worker but blocks execute and resume", async (t) => {
	let releaseWorker!: () => void;
	const workerPaused = new Promise<void>((resolve) => { releaseWorker = resolve; });
	const { root, runtime, runner, agentDir } = await harness(t);
	runtime.workerPause = async () => await workerPaused;
	const otherStore = new FileRunStore(agentDir);
	const otherRunner = new IsolatedRunner(runtime, runtime, runtime, otherStore, unusedTextExecutor);
	const definition = request("concurrent-abort", [changesetTask("change")]);
	const execution = runner.execute(definition, root);

	await waitUntil(() => runtime.workerCalls.length === 1);
	const persistedBeforeStatus = structuredClone((await otherStore.load(root, definition.id)).state);
	const reported = await otherRunner.status(definition.id, root);
	const reportedTask = changesetState(reported.state, "change");
	assert.equal(reported.state.status, "running");
	assert.equal(reportedTask.status, "working");
	assert.equal(reportedTask.attempts[0]?.prompts[0]?.status, "submitting");
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
	releaseWorker();
	const completedExecution = await execution;
	const abortedAttempt = changesetState(aborted.state, "change").attempts[0]!;
	const agent = abortedAttempt.allocations.find((allocation) => allocation.kind === "agent");
	if (!agent?.agentName) throw new Error("Expected an exact retained worker fixture.");
	assert.equal(aborted.state.status, "aborted");
	assert.deepEqual(completedExecution.state, aborted.state);
	assert.deepEqual(runtime.terminationCalls, [{ workerId: agent.agentName, candidate: abortedAttempt.prompts[0]!.preCandidate }]);
	assert.equal(abortedAttempt.termination?.status, "terminated");
	assert.throws(
		() => runner.queueFollowup(root, definition.id, "change", "Do not revive the aborted worker."),
		/sealed|not an active unsealed changeset/,
	);
	assertParsed(aborted.state);
});

test("parallel wave completions cannot overwrite a concurrent abort", async (t) => {
	let releaseWorkers!: () => void;
	const workersPaused = new Promise<void>((resolve) => { releaseWorkers = resolve; });
	const { root, runtime, runner, agentDir } = await harness(t);
	runtime.workerPause = async () => await workersPaused;
	const definition = request("parallel-abort", [changesetTask("first"), changesetTask("second")]);
	const execution = runner.execute(definition, root);
	await waitUntil(() => runtime.workerCalls.length === 2);

	const abortRunner = new IsolatedRunner(
		runtime,
		runtime,
		runtime,
		new FileRunStore(agentDir),
		unusedTextExecutor,
	);
	const aborted = await abortRunner.abort(definition.id, root);
	releaseWorkers();
	const result = await execution;

	assert.equal(aborted.state.status, "aborted");
	assert.deepEqual(result.state, aborted.state);
	assert.equal(runtime.terminationCalls.length, 2);
	assert.ok(aborted.state.tasks.every((task) => task.kind !== "changeset"
		|| task.attempts[0]?.termination?.status === "terminated"));
	assertParsed(aborted.state);
});

test("paused worker results adopt a concurrent durable abort before surfacing cancellation", async (t) => {
	let releaseWorker!: () => void;
	const workerPaused = new Promise<void>((resolve) => { releaseWorker = resolve; });
	const controller = new AbortController();
	const { root, runtime, runner, agentDir } = await harness(t);
	runtime.workerPause = async () => await workerPaused;
	const definition = request("paused-state-change", [changesetTask("change")]);
	const execution = runner.execute(definition, root, controller.signal);
	await waitUntil(() => runtime.workerCalls.length === 1);

	let locked!: () => void;
	const lifecycleLocked = new Promise<void>((resolve) => { locked = resolve; });
	const concurrentStore = new FileRunStore(agentDir);
	const mutation = concurrentStore.withLock(root, async () => {
		locked();
		controller.abort(new Error("operator interrupted worker execution"));
		releaseWorker();
		await waitUntil(() => runtime.workerCalls.length === 1);
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
	assert.equal(changesetState(result.state, "change").status, "working");
	assertParsed(result.state);
});

test("interrupting paused worker execution retains the exact worker", async (t) => {
	let releaseWorker!: () => void;
	const workerPaused = new Promise<void>((resolve) => { releaseWorker = resolve; });
	const { root, runtime, runner } = await harness(t);
	runtime.workerPause = async () => await workerPaused;
	const controller = new AbortController();
	const definition = request("worker-interrupt", [changesetTask("change")]);
	const execution = runner.execute(definition, root, controller.signal);

	await waitUntil(() => runtime.workerCalls.length === 1);
	controller.abort(new Error("operator interrupted worker execution"));
	releaseWorker();
	const result = await execution;
	const task = changesetState(result.state, "change");

	assert.equal(result.state.status, "needs_attention");
	assert.equal(task.status, "needs_attention");
	assert.match(task.failure ?? "", /operator interrupted worker execution/);
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

	assert.equal(result.state.status, "needs_attention");
	assert.deepEqual(result.state.waves.map(({ taskIds }) => taskIds), [["first", "second"]]);
	assert.equal(runtime.maxConcurrentWorkers, 2);
	assert.equal(first.preliminaryChecks?.passed, true);
	assert.equal(first.preliminaryReview?.verdict, "PASS");
	assert.equal(result.state.integration.candidates.length, 2);
	assert.equal(changesetState(result.state, "after").status, "pending");
	assert.deepEqual(runtime.terminationCalls, []);
	assert.equal(result.state.final.checks, undefined);
	assert.deepEqual(sortedCalls(runtime.launchCleanups), sortedCalls(runtime.acquisitions));
	assertParsed(result.state);
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
	assert.equal(apply.status, "ready_to_integrate");
	assert.equal(result.state.status, "needs_attention");
	assert.equal(result.state.accepted, false);
	assert.equal(result.state.final.checks, undefined);
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

	assert.equal(result.state.version, 5);
	assert.equal(result.state.accepted, false);
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
		"review:preliminary:change",
	]);
	assert.equal(attempt.preliminaryChecks?.passed, true);
	assert.deepEqual(attempt.readiness?.candidate, attempt.prompts[1]?.candidate);
	assert.ok((attempt.readiness?.at ?? 0) > (attempt.prompts[1]?.at ?? Number.MAX_SAFE_INTEGER));
	assert.equal(attempt.preliminaryReview?.passed, true);
	assertParsed(result.state);
});

test("a blocked diagnostic is normalized before same-worker correction", async (t) => {
	const { root, runtime, runner } = await harness(t);
	runtime.workerResults.push({ outcome: "blocked", diagnostic: "diagnostic\n" });

	const result = await runner.execute(request("normalized-correction", [changesetTask("change")]), root);
	const attempt = changesetState(result.state, "change").attempts[0]!;

	assert.equal(result.state.status, "needs_attention");
	assert.deepEqual(runtime.workerCalls, [
		{ taskId: "change", kind: "initial" },
		{ taskId: "change", kind: "correction" },
	]);
	assert.deepEqual(runtime.correctionFailures, ["diagnostic"]);
	assert.equal(attempt.prompts[0]?.failure, "diagnostic");
	assertParsed(result.state);
});

test("a follow-up queued during a failing follow-up is honored", async (t) => {
	for (const failure of ["blocked", "check"] as const) {
		await t.test(failure, async (t) => {
			let releaseInitial!: () => void;
			let followupStarted!: () => void;
			let releaseFollowup!: () => void;
			const initialPaused = new Promise<void>((resolve) => { releaseInitial = resolve; });
			const started = new Promise<void>((resolve) => { followupStarted = resolve; });
			const followupPaused = new Promise<void>((resolve) => { releaseFollowup = resolve; });
			let pausedFollowup = false;
			const { root, runtime, runner } = await harness(t);
			runtime.workerPause = async (call) => {
				if (call.kind === "initial") await initialPaused;
				if (call.kind !== "followup" || pausedFollowup) return;
				pausedFollowup = true;
				followupStarted();
				await followupPaused;
			};
			const definition = request(`queued-after-${failure}`, [changesetTask("change")]);
			const execution = runner.execute(definition, root);
			await waitUntil(() => runtime.workerCalls.length === 1);
			runner.queueFollowup(root, definition.id, "change", "First follow-up that will fail.");
			releaseInitial();
			await started;
			if (failure === "blocked") runtime.workerResults.push({ outcome: "blocked", diagnostic: "follow-up blocked" });
			else runtime.failPreliminaryChecks = 1;
			runner.queueFollowup(root, definition.id, "change", "Second follow-up must still run.");
			releaseFollowup();

			const result = await execution;
			const attempt = changesetState(result.state, "change").attempts[0]!;
			assert.equal(result.state.status, "needs_attention");
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
			assert.equal(attempt.termination, undefined);
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

test("abort terminates exact ambiguous workers without replay", async (t) => {
	const { root, runtime, runner } = await harness(t);
	const definition = request("abort-active", [changesetTask("first"), changesetTask("second")]);
	runtime.workerFailures.push(new Error("first transport failed"), new Error("second transport failed"));
	const stopped = await runner.execute(definition, root);
	assert.equal(stopped.state.integration.candidates.length, 0);
	const workers = stopped.state.tasks.map((task) => {
		const attempt = changesetState(stopped.state, task.taskId).attempts[0]!;
		const workerId = attempt.allocations.find((allocation) => allocation.kind === "agent")?.agentName;
		const candidate = attempt.prompts[0]?.preCandidate;
		if (!workerId || !candidate) throw new Error("Expected an exact ambiguous worker fixture.");
		return { workerId, candidate };
	});
	const workerCallsBeforeAbort = structuredClone(runtime.workerCalls);
	const aborted = await runner.abort(definition.id, root);
	assert.equal(aborted.state.status, "aborted");
	assert.deepEqual([...runtime.terminationCalls].sort((left, right) => left.workerId.localeCompare(right.workerId)),
		workers.sort((left, right) => left.workerId.localeCompare(right.workerId)));
	assert.deepEqual(runtime.workerCalls, workerCallsBeforeAbort);
	assertParsed(aborted.state);
});

test("recovery refuses a live productive lease without changing running state", async (t) => {
	const { root, runtime, runner, store, agentDir } = await harness(t);
	let release!: () => void;
	const paused = new Promise<void>((resolve) => { release = resolve; });
	runtime.workerPause = async () => await paused;
	const id = "live-recovery";
	const execution = runner.execute(request(id, [changesetTask("change")]), root);
	try {
		await waitUntil(() => runtime.workerCalls.length === 1);
		const before = await readFile(store.statePath(root, id));
		const other = new IsolatedRunner(runtime, runtime, runtime, new FileRunStore(agentDir), unusedTextExecutor);
		const result = await other.recoverRepository(root);
		assert.equal(result.leaseBusy, true);
		assert.equal(result.requests[0]?.state.status, "running");
		assert.deepEqual(await readFile(store.statePath(root, id)), before);
		assert.equal(runtime.workerCalls.length, 1);
	} finally {
		release();
		await execution;
	}
});

test("recovery classifies ambiguous workers once, preserves malformed files and retained candidates", async (t) => {
	const { root, runtime, runner, store } = await harness(t);
	const interrupted = request("orphaned-worker", [changesetTask("change")]);
	runtime.workerFailures.push(new Error("worker result unavailable"));
	await runner.execute(interrupted, root);
	const handle = await store.load(root, interrupted.id);
	const task = changesetState(handle.state, "change");
	task.status = "working";
	task.failure = undefined;
	handle.state.status = "running";
	task.attempts[0]!.prompts[0]!.status = "submitting";
	task.attempts[0]!.prompts[0]!.failure = undefined;
	await handle.save();
	const retained = request("saved-candidate", [changesetTask("change")]);
	await runner.execute(retained, root);
	const candidateBefore = await readFile(store.statePath(root, retained.id));
	const badPath = store.statePath(root, "bad-state");
	const badBytes = Buffer.from("{malformed");
	await writeFile(badPath, badBytes);
	const calls = runtimeCallCounts(runtime);
	const recovered = await runner.recoverRepository(root);
	assert.equal(recovered.leaseBusy, false);
	assert.deepEqual(recovered.invalidIds, ["bad-state"]);
	assert.deepEqual(recovered.requests.map(({ state }) => state.request.id), ["orphaned-worker", "saved-candidate"]);
	const attempt = changesetState(recovered.requests[0]!.state, "change").attempts[0]!;
	assert.equal(attempt.prompts[0]!.status, "ambiguous");
	assert.equal(recovered.requests[0]!.state.status, "needs_attention");
	assert.equal(recovered.requests[1]!.state.integration.candidates.length, 1);
	assert.deepEqual(await readFile(store.statePath(root, retained.id)), candidateBefore);
	assert.deepEqual(await readFile(badPath), badBytes);
	const saved = await readFile(store.statePath(root, interrupted.id));
	const again = await runner.recoverRepository(root);
	assert.deepEqual(await readFile(store.statePath(root, interrupted.id)), saved);
	assert.equal(again.requests[0]!.state.status, "needs_attention");
	assert.deepEqual(runtimeCallDelta(runtime, calls), {
		...Object.fromEntries(Object.keys(calls).map((key) => [key, 0])),
		mainInspections: 4,
	});
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
			assert.equal(reported.state.version, 5);
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
		assert.equal(resumed.state.accepted, false);
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
		assert.equal(corrected.state.accepted, false);
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

class StagingGit extends IntegrationGit {
	override async inspectMainAdvance(_root: string, from: WorkspaceIdentity, to: WorkspaceIdentity): Promise<void> {
		if (from.branch !== to.branch || from.head === to.head || to.index !== to.tree) throw new Error("Main refresh requires a clean descendant.");
	}
	readonly merged: string[] = [];
	promotions = 0;
	cleanupBlocked = false;
	releaseBlocked = false;
	readonly releases: string[] = [];
	promoteResult?: GitOutcome<WorkspaceIdentity>;
	promoteMain?: (tip: WorkspaceIdentity) => void;
	combinedTip?: WorkspaceIdentity;
	override async inspectCombined(_root: string, _integration: WorktreeInfo, _base: WorkspaceIdentity,
		stages: readonly StageReceipt[]): Promise<WorkspaceIdentity> {
		return this.combinedTip ?? stages.at(-1)!.tip;
	}
	override async inspectWorker(): Promise<void> {}
	override async inspectCorrection(_root: string, _integration: WorktreeInfo, _base: WorkspaceIdentity,
		stages: readonly StageReceipt[], from: WorkspaceIdentity, to: WorkspaceIdentity): Promise<void> {
		assert.deepEqual(from, stages.at(-1)!.tip);
		assert.notEqual(to.head, from.head);
	}
	override async promote(input: Parameters<IntegrationGit["promote"]>[0]): Promise<GitOutcome<WorkspaceIdentity>> {
		this.promotions += 1;
		if (this.promoteResult) return this.promoteResult;
		const promoted = { ...(input.correction?.to ?? input.stages.at(-1)!.tip), branch: input.base.branch };
		this.promoteMain?.(promoted);
		return { outcome: "ready", value: promoted };
	}
	override async reconcilePromotion(_root: string, _integration: WorktreeInfo, base: WorkspaceIdentity,
		stages: readonly StageReceipt[]): Promise<GitOutcome<WorkspaceIdentity>> {
		return this.promoteResult?.outcome === "unknown" ? { outcome: "unknown", failure: "Main still at base; no replay." }
			: { outcome: "ready", value: { ...stages.at(-1)!.tip, branch: base.branch } };
	}
	override async cleanup(): Promise<GitOutcome<"removed">> {
		return this.cleanupBlocked ? { outcome: "blocked", failure: "Exact checkout is dirty; inspect the retained worktree." }
			: { outcome: "ready", value: "removed" };
	}
	override async release(_root: string, info: WorktreeInfo, _tip: WorkspaceIdentity,
		kind: "worktree" | "branch"): Promise<GitOutcome<"removed">> {
		this.releases.push(`${info.branch}:${kind}`);
		return this.releaseBlocked ? { outcome: "blocked", failure: "Owned checkout is dirty." }
			: { outcome: "ready", value: "removed" };
	}
	resolved = false;
	allocationUnknown = false;
	beforeMerge?: () => Promise<void> | void;
	override async allocate(root: string, _childId: string, base: WorkspaceIdentity,
		onPrepared: (info: WorktreeInfo) => Promise<void>): Promise<GitOutcome<WorktreeInfo>> {
		const suffix = _childId.endsWith("-integration-1") ? "" : "-2";
		const info: WorktreeInfo = {
			path: join(root, ".worktrees", `subagent-integration${suffix}`),
			cwd: join(root, ".worktrees", `subagent-integration${suffix}`),
			branch: `pi-subagent/subagent-integration${suffix}`, repoRoot: root, baseCommit: base.head,
		};
		await onPrepared(info);
		await mkdir(info.path, { recursive: true });
		await writeFile(join(info.path, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
		return this.allocationUnknown ? { outcome: "unknown", failure: "Worktree add outcome unproved." }
			: { outcome: "ready", value: info };
	}
	override async stage(_root: string, _integration: WorktreeInfo, _base: WorkspaceIdentity,
		stages: readonly StageReceipt[], _worker: WorktreeInfo, candidate: WorkspaceIdentity): Promise<GitOutcome<StageReceipt>> {
		await this.beforeMerge?.();
		this.merged.push(candidate.head);
		if (stages.length) return { outcome: "conflict", failure: "Resolve overlapping edits in the integration worktree." };
		const previous = identity("a", `refs/heads/${_integration.branch}`);
		return { outcome: "ready", value: { previous, worker: candidate, tip: identity("d", previous.branch) } };
	}
	override async reconcileStage(_root: string, _integration: WorktreeInfo, _base: WorkspaceIdentity,
		stages: readonly StageReceipt[], _worker: WorktreeInfo, candidate: WorkspaceIdentity): Promise<GitOutcome<StageReceipt | "not_started">> {
		if (this.allocationUnknown) return { outcome: "ready", value: "not_started" };
		if (!this.resolved) return { outcome: "conflict", failure: "Merge remains unresolved in the owned worktree." };
		return { outcome: "ready", value: {
			previous: stages.at(-1)!.tip, worker: candidate,
			tip: identity("e", "refs/heads/pi-subagent/subagent-integration"),
		} };
	}
}

test("Main can stage a checked worker while its sibling is still working", async (t) => {
	const git = new StagingGit();
	const store = { current: undefined as RecordingStore | undefined };
	const { root, runtime, runner, agentDir } = await harness(t, {
		integrationGit: git,
		createStore: (agentDir) => store.current = new RecordingStore(agentDir),
	});
	let releaseSecond!: () => void;
	const secondPaused = new Promise<void>((resolve) => { releaseSecond = resolve; });
	runtime.workerPause = async (call) => { if (call.taskId === "second") await secondPaused; };
	const definition = request("stream-stage", [changesetTask("first"), changesetTask("second")]);
	const running = runner.execute(definition, root);
	try {
		await waitUntil(() => runtime.workerCalls.some((call) => call.taskId === "second")
			&& store.current?.snapshots.some((snapshot) => snapshot.integration.candidates.some((candidate) => candidate.taskId === "first")) === true);
		const ready = (await runner.status(definition.id, root)).state;
		assert.equal(ready.status, "running");
		assert.equal(changesetState(ready, "second").status, "working");
		const first = ready.integration.candidates[0]!;
		const action = { id: definition.id, action: "stage" as const, generation: 1,
			taskId: first.taskId, attempt: first.attempt, candidate: first.tip, expectedTip: ready.main };
		await assert.rejects(runner.stage({ ...action, action: "reject" }, root), /Wait for active workers/);
		const external = new IsolatedRunner(runtime, runtime, runtime, new FileRunStore(agentDir), unusedTextExecutor,
			undefined, undefined, git);
		await assert.rejects(external.stage(action, root), /productive request is active/);
		const staged = await runner.stage(action, root);
		assert.equal(staged.state.integration.generations[0]?.stages[0]?.status, "staged");
		assert.equal(changesetState(staged.state, "second").status, "working");
	} finally {
		releaseSecond();
		await running;
	}
	const settled = (await runner.status(definition.id, root)).state;
	assert.equal(settled.integration.candidates.length, 2);
	assert.equal(settled.integration.generations[0]?.stages[0]?.taskId, "first");
	assertParsed(settled);
});

test("the productive lease stays held when a sibling finishes during staging", async (t) => {
	const git = new StagingGit();
	const store = { current: undefined as RecordingStore | undefined };
	const { root, runtime, runner } = await harness(t, {
		integrationGit: git, createStore: (agentDir) => store.current = new RecordingStore(agentDir),
	});
	let releaseSecond!: () => void;
	let releaseMerge!: () => void;
	const secondPaused = new Promise<void>((resolve) => { releaseSecond = resolve; });
	const mergePaused = new Promise<void>((resolve) => { releaseMerge = resolve; });
	let merging = false;
	git.beforeMerge = async () => { merging = true; await mergePaused; };
	runtime.workerPause = async (call) => { if (call.taskId === "second") await secondPaused; };
	const definition = request("stage-during-settle", [changesetTask("first"), changesetTask("second")]);
	let settled = false;
	const running = runner.execute(definition, root).then((result) => { settled = true; return result; });
	let stage: Promise<RunResponse> | undefined;
	try {
		await waitUntil(() => runtime.workerCalls.some((call) => call.taskId === "second")
			&& store.current?.snapshots.some((snapshot) => snapshot.integration.candidates.some((item) => item.taskId === "first")) === true);
		const ready = (await runner.status(definition.id, root)).state;
		const first = ready.integration.candidates.find((item) => item.taskId === "first")!;
		const action = { id: definition.id, action: "stage" as const, generation: 1,
			taskId: first.taskId, attempt: first.attempt, candidate: first.tip, expectedTip: ready.main };
		stage = runner.stage(action, root);
		await waitUntil(() => merging);
		await assert.rejects(runner.stage(action, root), /Another stage or resolution is active/);
		releaseSecond();
		await waitUntil(() => store.current?.snapshots.some((snapshot) => snapshot.status === "needs_attention"
			&& snapshot.integration.candidates.some((item) => item.taskId === "second")) === true);
		assert.equal(settled, false, "the wave must not release its lease while staging is in flight");
		releaseMerge();
		await stage;
		const done = await running;
		assert.equal(done.state.integration.candidates.length, 2);
		assert.equal(done.state.integration.generations[0]?.stages[0]?.status, "staged");
		assertParsed(done.state);
	} finally {
		releaseSecond();
		releaseMerge();
		await Promise.allSettled([stage, running]);
	}
});

test("Main selects two retained candidates in order; conflict and resolution never mutate Main or replay a stage", async (t) => {
	const git = new StagingGit();
	const store = { current: undefined as RecordingStore | undefined };
	const { root, runner, runtime } = await harness(t, {
		integrationGit: git,
		createStore: (agentDir) => store.current = new RecordingStore(agentDir),
	});
	const definition = request("manual-stage", [changesetTask("first"), changesetTask("second")]);
	const ready = await runner.execute(definition, root);
	assert.equal(ready.state.status, "needs_attention");
	assert.equal(ready.state.integration.candidates.length, 2);
	assert.deepEqual(runtime.terminationCalls, []);
	assert.equal(runtime.main.head, identity("a").head);
	assertParsed(ready.state);
	const [first, second] = ready.state.integration.candidates;
	const stageAction = (taskId: string, attempt: number, candidate: WorkspaceIdentity, expectedTip: WorkspaceIdentity) => ({
		id: definition.id, action: "stage" as const, generation: 1, taskId, attempt, candidate, expectedTip,
	});
	const firstAction = stageAction("first", first!.attempt, first!.tip, ready.state.main);
	git.beforeMerge = () => assert.equal(store.current!.snapshots.at(-1)?.integration.generations[0]?.stages[git.merged.length]?.status, "staging");
	const staged = await runner.stage(firstAction, root);
	assert.equal(staged.state.integration.generations[0]?.stages[0]?.status, "staged");
	const firstTip = staged.state.integration.generations[0]!.combinedTip!;
	const snapshotsBeforeStaleAction = store.current!.snapshots.length;
	await assert.rejects(runner.stage(firstAction, root), /stale combined tip|repeated candidate/);
	assert.equal(store.current!.snapshots.length, snapshotsBeforeStaleAction);
	const secondAction = stageAction("second", second!.attempt, second!.tip, firstTip);
	const conflicted = await runner.stage(secondAction, root);
	assert.equal(conflicted.state.integration.generations[0]?.status, "conflict");
	assert.equal(conflicted.state.integration.generations[0]?.worktree?.baseCommit, ready.state.main.head);
	assert.equal(conflicted.state.status, "needs_attention");
	assert.equal(runtime.main.head, ready.state.main.head);
	assert.deepEqual(git.merged, [first!.tip.head, second!.tip.head]);
	await assert.rejects(runner.stage(secondAction, root), /unresolved/);
	await assert.rejects(runner.resume({ id: definition.id, action: "finalize" }, root), /require subagent_stage/);
	await assert.rejects(runner.abort(definition.id, root), /must be explicitly rejected and released/);
	const resolveAction = { ...secondAction, action: "resolve" as const };
	const pending = await runner.stage(resolveAction, root);
	assert.equal(pending.state.integration.generations[0]?.status, "conflict");
	git.resolved = true;
	const resolved = await runner.stage(resolveAction, root);
	assert.equal(resolved.state.integration.generations[0]?.stages[1]?.status, "staged");
	assert.equal(runtime.main.head, ready.state.main.head);
	assert.deepEqual(git.merged, [first!.tip.head, second!.tip.head]);
	assertParsed(resolved.state);
	await assert.rejects(runner.stage(resolveAction, root), /no exact pending stage intent/);
	for (const snapshot of store.current!.snapshots) assertParsed(snapshot);
});

async function stagedForPromotion(t: test.TestContext, id: string) {
	const git = new StagingGit();
	const { runner, root, runtime } = await harness(t, { integrationGit: git });
	const ready = await runner.execute(request(id, [changesetTask("change")]), root);
	const candidate = ready.state.integration.candidates[0]!;
	const staged = await runner.stage({ id, action: "stage", generation: 1, taskId: "change",
		attempt: candidate.attempt, candidate: candidate.tip, expectedTip: ready.state.main }, root);
	const expectedTip = staged.state.integration.generations[0]!.combinedTip!;
	return { runner, root, runtime, git, expectedTip,
		action: { id, generation: 1, expectedTip } };
}

test("revision supersedes transitive text and changeset work; explicit advance rebuilds from the new stage", async (t) => {
	let stageNumber = 0;
	const git = new class extends StagingGit {
		override async allocate(root: string, childId: string, base: WorkspaceIdentity,
			onPrepared: (info: WorktreeInfo) => Promise<void>, signal?: AbortSignal) {
			return await IntegrationGit.prototype.allocate.call(this, root, childId, base, onPrepared, signal ?? new AbortController().signal);
		}
		override async stage(root: string, integration: WorktreeInfo, base: WorkspaceIdentity,
			_stages: readonly StageReceipt[], _worker: WorktreeInfo, candidate: WorkspaceIdentity): Promise<GitOutcome<StageReceipt>> {
			await writeFile(join(integration.path, "README.md"), `staged content ${++stageNumber}\n`);
			execFileSync("git", ["add", "README.md"], { cwd: integration.path });
			execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "stage"], { cwd: integration.path });
			const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: integration.path, encoding: "utf8" }).trim();
			const tree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: integration.path, encoding: "utf8" }).trim();
			return { outcome: "ready", value: { previous: { ...base, branch: `refs/heads/${integration.branch}` },
				worker: candidate, tip: { branch: `refs/heads/${integration.branch}`, head, tree, index: tree } } };
		}
	}();
	const executor: EphemeralSubagentExecutor = { run: async ({ prepare }) => {
		const prepared = await prepare();
		return { outcome: "success", exitCode: 0, outputTruncated: false, stderr: "",
			output: await (await import("node:fs/promises")).readFile(join(prepared.cwd, "README.md"), "utf8") };
	} };
	const { runner, root, runtime } = await harness(t, { integrationGit: git, executor });
	const checked = new (await import("../src/git-runtime.ts")).CheckedGitRuntime();
	runtime.main = await checked.inspectMain({ root }, { signal: new AbortController().signal });
	const id = "staged-text-dependent";
	const ready = await runner.execute(request(id, [{ ...changesetTask("second"), contextFrom: ["report"] },
		{ ...textTask("report"), dependsOn: ["first"] }, changesetTask("first")]), root);
	const first = ready.state.integration.candidates[0]!;
	const staged = await runner.stage({ id, action: "stage", generation: 1, taskId: "first", attempt: first.attempt,
		candidate: first.tip, expectedTip: ready.state.main }, root);
	const tip = staged.state.integration.generations[0]!.combinedTip!;
	runtime.integrationIdentity = tip;
	runtime.integrationPath = staged.state.integration.generations[0]!.worktree!.path;
	const result = await runner.integrate({ id, generation: 1, action: "advance", expectedTip: tip }, root);
	assert.equal(textState(result.state, "report").attempts[0]?.output?.text, "staged content 1", JSON.stringify(textState(result.state, "report")));
	const oldDependent = result.state.integration.candidates.find((candidate) => candidate.taskId === "second")!;
	const revised = await runner.stage({ id, action: "revise", generation: 1, taskId: "first", attempt: first.attempt,
		candidate: first.tip, expectedTip: tip, instruction: "Change predecessor." }, root);
	assert.equal(textState(revised.state, "report").status, "pending");
	assert.equal(textState(revised.state, "report").attempts[0]?.status, "superseded");
	assert.equal(textState(revised.state, "report").attempts[0]?.output, undefined);
	assert.equal(changesetState(revised.state, "second").attempts[0]?.superseded, true);
	assert.equal(revised.state.integration.candidates.find((candidate) => candidate.taskId === "second")?.decision, "rejected");
	assert.equal(revised.state.integration.generations[0]?.status, "superseded");
	assert.deepEqual(runtime.terminationCalls, []);
	await assert.rejects(runner.integrate({ id, generation: 1, action: "advance", expectedTip: tip }, root), /stale generation/);
	await assert.rejects(runner.stage({ id, action: "stage", generation: 2, taskId: "second", attempt: 1,
		candidate: oldDependent.tip, expectedTip: ready.state.main }, root), /stale or unowned candidate/);
	const successor = revised.state.integration.candidates.at(-1)!;
	const restaged = await runner.stage({ id, action: "stage", generation: 2, taskId: "first", attempt: successor.attempt,
		candidate: successor.tip, expectedTip: ready.state.main }, root);
	const freshTip = restaged.state.integration.generations[1]!.combinedTip!;
	runtime.integrationIdentity = freshTip;
	runtime.integrationPath = restaged.state.integration.generations[1]!.worktree!.path;
	const rebuilt = await runner.integrate({ id, generation: 2, action: "advance", expectedTip: freshTip }, root);
	assert.equal(textState(rebuilt.state, "report").attempts[1]?.output?.text, "staged content 2");
	assert.equal(changesetState(rebuilt.state, "second").attempts[1]?.waveBase.head, freshTip.head);
	assert.equal(runtime.allocationBases.at(-1)?.checkout, runtime.integrationPath);
	const beforeLimit = await runner.status(id, root);
	await assert.rejects(runner.stage({ id, action: "reject", generation: 2, taskId: "first", attempt: successor.attempt,
		candidate: successor.tip, expectedTip: freshTip }, root), /exhausted its bounded fresh attempts/);
	const afterLimit = await runner.status(id, root);
	assert.deepEqual(afterLimit.state.integration, beforeLimit.state.integration);
	assert.equal(runtime.main.head, ready.state.main.head);
	assert.equal(await (await import("node:fs/promises")).readFile(join(root, "README.md"), "utf8"), "fixture\n");
	assertParsed(rebuilt.state);
});

test("Main advances a changeset dependent from its exact staged snapshot and retains its candidate", async (t) => {
	const git = new StagingGit();
	const { runner, root, runtime } = await harness(t, { integrationGit: git });
	const id = "staged-dependent";
	const dependent = { ...changesetTask("second"), dependsOn: ["first"] };
	const ready = await runner.execute(request(id, [changesetTask("first"), dependent]), root);
	assert.deepEqual(runtime.worktreeAllocationCalls, ["first"]);
	const first = ready.state.integration.candidates[0]!;
	const staged = await runner.stage({ id, action: "stage", generation: 1, taskId: "first",
		attempt: first.attempt, candidate: first.tip, expectedTip: ready.state.main }, root);
	const tip = staged.state.integration.generations[0]!.combinedTip!;
	await assert.rejects(runner.integrate({ id, action: "advance", generation: 1, expectedTip: ready.state.main }, root), /stale generation or combined tip/);
	const advanced = await runner.integrate({ id, action: "advance", generation: 1, expectedTip: tip }, root);
	assert.deepEqual(runtime.worktreeAllocationCalls, ["first", "second"]);
	assert.deepEqual(runtime.allocationBases[1], {
		taskId: "second", base: tip, checkout: advanced.state.integration.generations[0]!.worktree!.path,
	});
	assert.equal(advanced.state.integration.candidates[1]?.taskId, "second");
	assert.equal(advanced.state.integration.candidates[1]?.base.head, tip.head);
	assert.equal(runtime.main.head, ready.state.main.head);
	const forged = structuredClone(advanced.state);
	forged.waves.at(-1)!.base = ready.state.main;
	assert.throws(() => parseRunState(forged), /exact staged dependency snapshot/);
	await assert.rejects(runner.stage({ id, action: "stage", generation: 1, taskId: "second", attempt: 1,
		candidate: advanced.state.integration.candidates[1]!.tip, expectedTip: ready.state.main }, root), /stale combined tip/);
	const oldDependent = advanced.state.integration.candidates[1]!;
	const conflict = await runner.stage({ id, action: "stage", generation: 1, taskId: "second", attempt: 1,
		candidate: oldDependent.tip, expectedTip: tip }, root);
	assert.equal(conflict.state.integration.generations[0]?.status, "conflict");
	git.resolved = true;
	const stagedDependent = await runner.stage({ id, action: "resolve", generation: 1, taskId: "second", attempt: 1,
		candidate: oldDependent.tip, expectedTip: tip }, root);
	const combined = stagedDependent.state.integration.generations[0]!.combinedTip!;
	const rejected = await runner.stage({ id, action: "reject", generation: 1, taskId: "first", attempt: 1,
		candidate: first.tip, expectedTip: combined }, root);
	assert.equal(rejected.state.integration.generations[0]?.combinedTip, undefined);
	await assert.rejects(runner.stage({ id, action: "stage", generation: 2, taskId: "second", attempt: 1,
		candidate: oldDependent.tip, expectedTip: ready.state.main }, root), /stale or unowned candidate/);
	assert.equal(changesetState(rejected.state, "second").status, "pending");
	assert.equal(changesetState(rejected.state, "second").attempts[0]?.superseded, true);
	assert.equal(rejected.state.integration.candidates[1]?.decision, "rejected");
	assert.equal(runtime.terminationCalls.length, 1);
	assert.equal(changesetState(rejected.state, "first").status, "rejected");
	assertParsed(rejected.state);
});

test("failed combined root full-suite check leaves Main unchanged and forbids promotion", async (t) => {
	const { runner, root, runtime, git, action } = await stagedForPromotion(t, "failed-combination");
	runtime.failCombinedExit = true;
	const checked = await runner.integrate({ ...action, action: "validate" }, root);
	assert.equal(checked.state.integration.generations[0]?.status, "validation_failed");
	assert.equal(checked.state.integration.generations[0]?.checks?.results[0]?.command, "pnpm");
	assert.equal(runtime.main.head, identity("a").head);
	assert.equal(git.promotions, 0);
	await assert.rejects(runner.integrate({ ...action, action: "promote" }, root), /requires exact successful/);
	await assert.rejects(runner.integrate({ ...action, action: "validate" }, root), /prior validation attempt/);
	assertParsed(checked.state);
});

test("changed combined tip and dirty Main invalidate validation before running any suite", async (t) => {
	const { runner, root, runtime, git, action } = await stagedForPromotion(t, "drifted-combination");
	git.combinedTip = identity("f", action.expectedTip.branch);
	const changed = await runner.integrate({ ...action, action: "validate" }, root);
	assert.equal(changed.state.integration.generations[0]?.status, "validation_failed");
	assert.equal(runtime.checkCalls.some((call) => call.scope === "final"), false);
	assert.equal(runtime.main.head, identity("a").head);
	assertParsed(changed.state);
});

test("dirty Main after passing combined checks prevents promotion without consuming an intent", async (t) => {
	const { runner, root, runtime, git, action } = await stagedForPromotion(t, "dirty-promotion");
	const validated = await runner.integrate({ ...action, action: "validate" }, root);
	assert.equal(validated.state.integration.generations[0]?.status, "ready", validated.state.integration.generations[0]?.failure ?? "unknown");
	assert.deepEqual(validated.state.integration.generations[0]?.checks?.results.map(({ command }) => command), ["pnpm", "check-final"]);
	runtime.main = { ...runtime.main, index: oid("b") };
	await assert.rejects(runner.integrate({ ...action, action: "promote" }, root), /Main changed or became dirty/);
	assert.equal(git.promotions, 0);
	assertParsed((await runner.status(action.id, root)).state);
});

test("interrupted promotion is reconciled read-only, never replayed", async (t) => {
	const { runner, root, runtime, git, action } = await stagedForPromotion(t, "interrupted-promotion");
	await runner.integrate({ ...action, action: "validate" }, root);
	git.promoteResult = { outcome: "unknown", failure: "Lost response" };
	const uncertain = await runner.integrate({ ...action, action: "promote" }, root);
	assert.equal(uncertain.state.integration.generations[0]?.status, "promotion_unknown");
	assert.equal(git.promotions, 1);
	assert.deepEqual(runtime.terminationCalls, []);
	await runner.integrate({ ...action, action: "reconcile" }, root);
	assert.equal(git.promotions, 1);
	assert.equal(runtime.main.head, identity("a").head);
	await assert.rejects(runner.integrate({ ...action, action: "promote" }, root), /requires exact successful/);
});

test("exact checked tip promotes once, retains worker until proven promotion, then cleans owned resources", async (t) => {
	const { runner, root, runtime, git, action } = await stagedForPromotion(t, "checked-promotion");
	git.promoteMain = (main) => {
		assert.deepEqual(runtime.terminationCalls, []);
		assert.deepEqual(runtime.cleanupCalls, []);
		runtime.main = main;
	};
	const validated = await runner.integrate({ ...action, action: "validate" }, root);
	assert.equal(validated.state.integration.generations[0]?.status, "ready", validated.state.integration.generations[0]?.failure ?? "unknown");
	assert.deepEqual(runtime.terminationCalls, []);
	const done = await runner.integrate({ ...action, action: "promote" }, root);
	assert.equal(done.state.status, "completed");
	assert.equal(done.state.accepted, true);
	assert.equal(done.state.integration.candidates[0]?.worker, "released");
	assert.equal(runtime.terminationCalls.length, 1);
	assert.equal(git.promotions, 1);
	assertParsed(done.state);
	await assert.rejects(runner.integrate({ ...action, action: "promote" }, root), /stale generation|requires exact successful/);
});

test("an uncertain rejected worker is reconciled by exact identity without repeating termination", async (t) => {
	const { root, runner, runtime, store } = await harness(t);
	const id = "reject-uncertain";
	const ready = await runner.execute(request(id, [changesetTask("change")]), root);
	const candidate = ready.state.integration.candidates[0]!;
	const action = { id, generation: 1, action: "reject" as const, taskId: "change", attempt: candidate.attempt,
		candidate: candidate.tip, expectedTip: ready.state.main };
	runtime.terminationResults.push({ outcome: "unknown", failure: "Lost Herdr response" });
	const uncertain = await runner.stage(action, root);
	assert.equal(changesetState(uncertain.state, "change").status, "needs_attention");
	assert.equal(changesetState(uncertain.state, "change").attempts[0]?.termination?.status, "unknown");
	assert.equal(uncertain.state.integration.candidates[0]?.worker, "retained");
	assert.equal(uncertain.continuation, undefined, "resume cannot verify a rejected candidate");
	const handle = await store.load(root, id);
	changesetState(handle.state, "change").attempts[0]!.termination!.status = "terminating";
	delete changesetState(handle.state, "change").attempts[0]!.termination!.failure;
	await handle.save(); // Also covers a process lost after persisting termination intent.
	runtime.terminationReconciliations.push({ outcome: "terminated" });
	const reconciled = await runner.stage(action, root);
	assert.equal(changesetState(reconciled.state, "change").status, "rejected");
	assert.equal(runtime.terminationCalls.length, 1);
	assert.deepEqual(runtime.terminationReconciliationCalls[0]?.candidate, candidate.tip);
	assertParsed(reconciled.state);
});

test("a resolved conflict in a superseded generation stays recorded after selecting only the other candidate", async (t) => {
	const git = new StagingGit();
	const { root, runner, runtime } = await harness(t, { integrationGit: git });
	const id = "resolved-then-rejected";
	const ready = await runner.execute(request(id, [changesetTask("first"), changesetTask("second")]), root);
	const [first, second] = ready.state.integration.candidates;
	const choose = (generation: number, action: "stage" | "resolve" | "reject", candidate: typeof first, expectedTip: WorkspaceIdentity) => ({
		id, generation, action, taskId: candidate!.taskId, attempt: candidate!.attempt, candidate: candidate!.tip, expectedTip,
	});
	const firstStage = await runner.stage(choose(1, "stage", first, ready.state.main), root);
	const firstTip = firstStage.state.integration.generations[0]!.combinedTip!;
	await runner.stage(choose(1, "stage", second, firstTip), root);
	git.resolved = true;
	const resolved = await runner.stage(choose(1, "resolve", second, firstTip), root);
	const oldTip = resolved.state.integration.generations[0]!.combinedTip!;
	const rejected = await runner.stage(choose(1, "reject", second, oldTip), root);
	assert.equal(rejected.state.integration.generations[0]?.supersededFrom, "staging");
	assert.deepEqual(rejected.state.integration.generations[0]?.stages.map((stage) => stage.status), ["staged", "staged"]);
	assert.equal(rejected.state.integration.generations[0]?.stages[1]?.tip?.head, oldTip.head);
	const replay = await runner.stage(choose(2, "stage", first, ready.state.main), root);
	const tip = replay.state.integration.generations[1]!.combinedTip!;
	git.promoteMain = (main) => { runtime.main = main; };
	await runner.integrate({ id, generation: 2, action: "validate", expectedTip: tip }, root);
	const done = await runner.integrate({ id, generation: 2, action: "promote", expectedTip: tip }, root);
	assert.equal(done.state.status, "completed");
	assert.equal(done.state.integration.generations[0]?.worktree?.path, resolved.state.integration.generations[0]?.worktree?.path);
	assert.equal(done.state.integration.generations[0]?.stages[1]?.tip?.head, oldTip.head);
	assert.equal(done.state.integration.candidates[1]?.worker, "retained");
	assertParsed(done.state);
});

test("promotion remains accepted with dirty retained owned resources and cleanup can be retried exactly", async (t) => {
	const { runner, root, runtime, git, action } = await stagedForPromotion(t, "dirty-cleanup");
	git.promoteMain = (main) => { runtime.main = main; };
	git.cleanupBlocked = true;
	await runner.integrate({ ...action, action: "validate" }, root);
	const promoted = await runner.integrate({ ...action, action: "promote" }, root);
	assert.equal(promoted.state.status, "completed");
	assert.equal(promoted.state.integration.candidates[0]?.worker, "release_pending");
	assert.equal(promoted.state.tasks[0]?.status, "completed");
	assert.equal(changesetState(promoted.state, "change").attempts[0]?.cleanup[2]?.status, "running");
	assert.match(changesetState(promoted.state, "change").attempts[0]?.cleanup[2]?.failure ?? "", /dirty/);
	assertParsed(promoted.state);
	git.cleanupBlocked = false;
	const cleaned = await runner.integrate({ ...action, action: "cleanup" }, root);
	assert.equal(cleaned.state.integration.candidates[0]?.worker, "released");
	assert.equal(cleaned.state.accepted, true);
	assertParsed(cleaned.state);
});

test("rejected staged candidate freezes validation and requires explicit replay from the recorded base", async (t) => {
	const git = new StagingGit();
	const { root, runner, runtime } = await harness(t, { integrationGit: git });
	const id = "arbitrate-stage";
	const ready = await runner.execute(request(id, [changesetTask("first"), changesetTask("second")]), root);
	const [first, second] = ready.state.integration.candidates;
	const stage = (generation: number, candidate: typeof first, expectedTip: WorkspaceIdentity) => ({
		id, generation, action: "stage" as const, taskId: candidate!.taskId, attempt: candidate!.attempt,
		candidate: candidate!.tip, expectedTip,
	});
	const staged = await runner.stage(stage(1, first, ready.state.main), root);
	const firstTip = staged.state.integration.generations[0]!.combinedTip!;
	const rejected = await runner.stage({ ...stage(1, first, firstTip), action: "reject" }, root);
	assert.equal(rejected.state.integration.generations[0]?.status, "superseded");
	assert.equal(rejected.state.integration.generations[0]?.combinedTip, undefined);
	assert.equal(rejected.state.integration.candidates[0]?.decision, "rejected");
	assert.equal(runtime.main.head, ready.state.main.head);
	await assert.rejects(runner.stage(stage(1, second, firstTip), root), /stale generation/);
	await assert.rejects(runner.stage(stage(2, first, ready.state.main), root), /stale or unowned candidate/);
	const replay = await runner.stage(stage(2, second, ready.state.main), root);
	assert.equal(replay.state.integration.generations[1]?.status, "staging");
	assert.equal(replay.state.integration.generations[1]?.worktree?.baseCommit, ready.state.main.head);
	assert.equal(replay.state.integration.generations[1]?.stages[0]?.status, "staged");
	assert.deepEqual(git.merged, [first!.tip.head, second!.tip.head]);
	assertParsed(replay.state);
	git.promoteMain = (main) => { runtime.main = main; };
	const tip = replay.state.integration.generations[1]!.combinedTip!;
	await runner.integrate({ id, generation: 2, action: "validate", expectedTip: tip }, root);
	const promoted = await runner.integrate({ id, generation: 2, action: "promote", expectedTip: tip }, root);
	assert.equal(promoted.state.status, "completed");
	assert.equal(promoted.state.accepted, true);
	assert.equal(changesetState(promoted.state, "first").status, "rejected");
	assert.equal(changesetState(promoted.state, "first").attempts[0]?.termination?.status, "terminated");
	assert.equal(promoted.state.integration.candidates[0]?.worker, "retained");
	assert.equal(promoted.state.integration.generations[0]?.status, "superseded");
	assert.equal(promoted.state.integration.generations[0]?.worktree?.path, staged.state.integration.generations[0]?.worktree?.path);
	assert.equal(promoted.state.integration.generations[0]?.cleanup, undefined);
	assert.equal((await runner.listRequests(root)).requests[0]?.status, "completed · retained");
	assertParsed(promoted.state);
	const releaseCandidate = { id, generation: 2, action: "release" as const,
		taskId: "first", attempt: first!.attempt, expectedTip: first!.tip };
	await assert.rejects(runner.integrate(releaseCandidate, root), /retained staged generation/);
	const releaseOld = { id, generation: 1, action: "release" as const, expectedTip: firstTip };
	git.releaseBlocked = true;
	const blocked = await runner.integrate(releaseOld, root);
	assert.equal(blocked.state.integration.generations[0]?.cleanup?.[0]?.status, "running");
	assert.equal(blocked.state.integration.candidates[0]?.worker, "retained");
	assert.equal((await runner.listRequests(root)).requests[0]?.status, "completed · retained");
	git.releaseBlocked = false;
	const cleanedOld = await runner.integrate(releaseOld, root);
	assert.deepEqual(cleanedOld.state.integration.generations[0]?.cleanup?.map((step) => step.status), ["completed", "completed"]);
	const cleanedCandidate = await runner.integrate(releaseCandidate, root);
	assert.equal(cleanedCandidate.state.integration.candidates[0]?.worker, "released");
	assert.deepEqual(changesetState(cleanedCandidate.state, "first").attempts[0]?.cleanup.map((step) => step.status),
		["completed", "completed", "completed", "completed"]);
	assert.equal(cleanedCandidate.state.accepted, true);
	assert.equal((await runner.listRequests(root)).requests[0]?.status, "completed");
	assertParsed(cleanedCandidate.state);
});

test("explicit rejection and release allow abort without discarding a retained worker", async (t) => {
	const git = new StagingGit();
	const { root, runner } = await harness(t, { integrationGit: git });
	const id = "reject-and-release";
	const ready = await runner.execute(request(id, [changesetTask("change")]), root);
	const candidate = ready.state.integration.candidates[0]!;
	const rejected = await runner.stage({ id, action: "reject", generation: 1, taskId: "change",
		attempt: candidate.attempt, candidate: candidate.tip, expectedTip: ready.state.main }, root);
	assert.equal(rejected.state.tasks[0]?.status, "rejected");
	await assert.rejects(runner.abort(id, root), /explicitly rejected and released/);
	const released = await runner.integrate({ id, action: "release", generation: 1,
		taskId: "change", attempt: candidate.attempt, expectedTip: candidate.tip }, root);
	assert.equal(released.state.integration.candidates[0]?.worker, "released");
	const aborted = await runner.abort(id, root);
	assert.equal(aborted.state.status, "aborted");
	assertParsed(aborted.state);
});

test("post-seal same-worker revision invalidates old stage and retains a newly checked candidate", async (t) => {
	const git = new StagingGit();
	const { root, runner, runtime } = await harness(t, { integrationGit: git });
	const id = "revise-stage";
	const ready = await runner.execute(request(id, [changesetTask("change")]), root);
	const old = ready.state.integration.candidates[0]!;
	const staged = await runner.stage({ id, generation: 1, action: "stage", taskId: old.taskId,
		attempt: old.attempt, candidate: old.tip, expectedTip: ready.state.main }, root);
	const revised = await runner.stage({ id, generation: 1, action: "revise", taskId: old.taskId,
		attempt: old.attempt, candidate: old.tip, expectedTip: staged.state.integration.generations[0]!.combinedTip!,
		instruction: "Fix the isolated regression." }, root);
	assert.equal(revised.state.integration.generations[0]?.status, "superseded");
	assert.equal(revised.state.integration.candidates[0]?.decision, "rejected");
	assert.equal(revised.state.integration.candidates.length, 2);
	assert.notEqual(revised.state.integration.candidates[1]?.tip.head, old.tip.head);
	assert.deepEqual(runtime.workerCalls.map((call) => call.kind), ["initial", "correction"]);
	assert.equal(runtime.main.head, ready.state.main.head);
	const latest = revised.state.integration.candidates[1]!;
	const replay = await runner.stage({ id, generation: 2, action: "stage", taskId: latest.taskId,
		attempt: latest.attempt, candidate: latest.tip, expectedTip: ready.state.main }, root);
	assert.equal(replay.state.integration.generations[1]?.stages[0]?.status, "staged");
	await assert.rejects(runner.stage({ id, generation: 2, action: "reject", taskId: latest.taskId,
		attempt: latest.attempt, candidate: latest.tip, expectedTip: replay.state.integration.generations[1]!.combinedTip! }, root),
		/Retained integration worktree limit/);
	git.promoteMain = (main) => { runtime.main = main; };
	const tip = replay.state.integration.generations[1]!.combinedTip!;
	const checked = await runner.integrate({ id, generation: 2, action: "validate", expectedTip: tip }, root);
	assert.equal(checked.state.integration.generations[1]?.status, "ready");
	const promoted = await runner.integrate({ id, generation: 2, action: "promote", expectedTip: tip }, root);
	assert.equal(promoted.state.integration.generations[1]?.status, "promoted");
	assert.equal(promoted.state.integration.candidates[0]?.worker, "released", "same-attempt old tip shared the proved-cleaned worker checkout");
	assert.equal(promoted.state.status, "completed", "old generation remains retained without blocking the accepted selection");
	assert.equal(promoted.state.accepted, true);
	assert.equal(promoted.state.integration.generations[0]?.worktree?.path, staged.state.integration.generations[0]?.worktree?.path);
	assert.equal(promoted.state.integration.generations[0]?.cleanup, undefined);
	assert.equal((await runner.listRequests(root)).requests[0]?.status, "completed · retained");
	assertParsed(promoted.state);
	const released = await runner.integrate({ id, action: "release", generation: 1,
		expectedTip: staged.state.integration.generations[0]!.stages[0]!.tip! }, root);
	assert.deepEqual(released.state.integration.generations[0]?.cleanup?.map((step) => step.status), ["completed", "completed"]);
	assert.equal((await runner.listRequests(root)).requests[0]?.status, "completed");
});

test("one exact Main correction after failed combination invalidates failed evidence and rechecks the new tip", async (t) => {
	const { runner, root, runtime, git, action } = await stagedForPromotion(t, "correct-combination");
	runtime.failCombinedExit = true;
	const failed = await runner.integrate({ ...action, action: "validate" }, root);
	assert.equal(failed.state.integration.generations[0]?.checks?.passed, false);
	runtime.integrationIdentity = identity("f", action.expectedTip.branch);
	const corrected = await runner.integrate({ ...action, action: "correct" }, root);
	const newTip = runtime.integrationIdentity;
	assert.deepEqual(corrected.state.integration.generations[0]?.correction, { from: action.expectedTip, to: newTip });
	assert.equal(corrected.state.integration.generations[0]?.checks, undefined);
	assert.equal(runtime.main.head, identity("a").head);
	await assert.rejects(runner.integrate({ ...action, action: "validate" }, root), /stale generation or combined tip/);
	runtime.failCombinedExit = false;
	const rechecked = await runner.integrate({ ...action, action: "validate", expectedTip: newTip }, root);
	assert.equal(rechecked.state.integration.generations[0]?.status, "ready");
	assert.equal(runtime.checkCalls.filter((call) => call.scope === "final").length, 2);
	assert.equal(git.promotions, 0);
	assertParsed(rechecked.state);
});

test("corrected combined tip promotes only with a dependent from its exact staged snapshot", async (t) => {
	const git = new StagingGit();
	const { runner, root, runtime } = await harness(t, { integrationGit: git });
	const id = "corrected-dependent";
	const ready = await runner.execute(request(id, [changesetTask("first"),
		{ ...changesetTask("second"), dependsOn: ["first"] }]), root);
	const first = ready.state.integration.candidates[0]!;
	const staged = await runner.stage({ id, action: "stage", generation: 1, taskId: "first",
		attempt: first.attempt, candidate: first.tip, expectedTip: ready.state.main }, root);
	const snapshot = staged.state.integration.generations[0]!.combinedTip!;
	const advanced = await runner.integrate({ id, action: "advance", generation: 1, expectedTip: snapshot }, root);
	const second = advanced.state.integration.candidates[1]!;
	assert.deepEqual(changesetState(advanced.state, "second").attempts[0]?.waveBase, snapshot);
	await runner.stage({ id, action: "stage", generation: 1, taskId: "second", attempt: second.attempt,
		candidate: second.tip, expectedTip: snapshot }, root);
	git.resolved = true;
	const stagedDependent = await runner.stage({ id, action: "resolve", generation: 1, taskId: "second",
		attempt: second.attempt, candidate: second.tip, expectedTip: snapshot }, root);
	const combined = stagedDependent.state.integration.generations[0]!.combinedTip!;
	const action = { id, generation: 1, expectedTip: combined };
	runtime.failCombinedExit = true;
	const failed = await runner.integrate({ ...action, action: "validate" }, root);
	assert.equal(failed.state.integration.generations[0]?.status, "validation_failed");
	runtime.integrationIdentity = identity("f", combined.branch);
	const corrected = await runner.integrate({ ...action, action: "correct" }, root);
	const correctedTip = corrected.state.integration.generations[0]!.combinedTip!;
	runtime.failCombinedExit = false;
	const rechecked = await runner.integrate({ ...action, action: "validate", expectedTip: correctedTip }, root);
	assert.equal(rechecked.state.integration.generations[0]?.status, "ready");
	git.promoteMain = (main) => { runtime.main = main; };
	const promoted = await runner.integrate({ ...action, action: "promote", expectedTip: correctedTip }, root);
	assert.equal(promoted.state.status, "completed");
	assert.equal(promoted.state.accepted, true);
	assert.equal(git.promotions, 1);
	assertParsed(promoted.state);
});

test("uncertain integration allocation retains intent and refuses mutation replay", async (t) => {
	const git = new StagingGit();
	git.allocationUnknown = true;
	const { root, runner } = await harness(t, { integrationGit: git });
	const ready = await runner.execute(request("uncertain-stage", [changesetTask("change")]), root);
	const candidate = ready.state.integration.candidates[0]!;
	const action = { id: ready.state.request.id, action: "stage" as const, generation: 1,
		taskId: candidate.taskId, attempt: candidate.attempt, candidate: candidate.tip, expectedTip: ready.state.main };
	const uncertain = await runner.stage(action, root);
	assert.equal(uncertain.state.integration.generations[0]?.stages[0]?.status, "pending");
	assert.equal(uncertain.state.integration.generations[0]?.worktree?.baseCommit, ready.state.main.head);
	assert.deepEqual(git.merged, []);
	await assert.rejects(runner.stage(action, root), /unresolved/);
	assert.deepEqual(git.merged, []);
	const integrationBase = uncertain.state.integration.generations[0]!.integrationBase;
	git.combinedTip = integrationBase;
	const reconciled = await runner.stage({ ...action, action: "resolve", expectedTip: integrationBase }, root);
	assert.equal(reconciled.state.integration.generations[0]?.stages[0]?.status, "staged");
	assert.deepEqual(git.merged, [candidate.tip.head]);
	assertParsed((await runner.status(action.id, root)).state);
});

test("uncertain initial integration allocation refuses changed checkout before merging", async (t) => {
	const git = new StagingGit();
	git.allocationUnknown = true;
	const { root, runner } = await harness(t, { integrationGit: git });
	const ready = await runner.execute(request("uncertain-stage-changed", [changesetTask("change")]), root);
	const candidate = ready.state.integration.candidates[0]!;
	const action = { id: ready.state.request.id, action: "stage" as const, generation: 1,
		taskId: candidate.taskId, attempt: candidate.attempt, candidate: candidate.tip, expectedTip: ready.state.main };
	const uncertain = await runner.stage(action, root);
	const integrationBase = uncertain.state.integration.generations[0]!.integrationBase;
	git.combinedTip = identity("b", integrationBase.branch);
	await assert.rejects(runner.stage({ ...action, action: "resolve", expectedTip: integrationBase }, root), /clean recorded base/);
	assert.deepEqual(git.merged, []);
	git.combinedTip = integrationBase;
	const proven = await runner.stage({ ...action, action: "resolve", expectedTip: integrationBase }, root);
	assert.equal(proven.state.integration.generations[0]?.stages[0]?.status, "staged");
	assert.deepEqual(git.merged, [candidate.tip.head]);
	await assert.rejects(runner.stage({ ...action, expectedTip: integrationBase }, root), /stale|repeated/);
	assert.deepEqual(git.merged, [candidate.tip.head]);
});

test("Main explicitly refreshes a validated generation and restages the unchanged worker without reusing validation", async (t) => {
	const git = new StagingGit();
	const store = { current: undefined as RecordingStore | undefined };
	const { root, runner, runtime } = await harness(t, { integrationGit: git,
		createStore: (agentDir) => store.current = new RecordingStore(agentDir) });
	const id = "refresh-validated";
	const ready = await runner.execute(request(id, [changesetTask("change")] ), root);
	const candidate = ready.state.integration.candidates[0]!;
	const choose = (generation: number, expectedTip: WorkspaceIdentity) => ({ id, action: "stage" as const,
		generation, taskId: candidate.taskId, attempt: candidate.attempt, candidate: candidate.tip, expectedTip });
	const staged = await runner.stage(choose(1, ready.state.main), root);
	const oldTip = staged.state.integration.generations[0]!.combinedTip!;
	await runner.integrate({ id, generation: 1, action: "validate", expectedTip: oldTip }, root);
	const advanced = identity("b");
	runtime.main = advanced;
	const action = { id, generation: 2, action: "refresh" as const, expectedTip: oldTip,
		expectedMain: ready.state.main, newMain: advanced };
	await assert.rejects(runner.integrate({ ...action, expectedMain: advanced }, root), /stale/);
	const refreshed = await runner.integrate(action, root);
	assert.equal(refreshed.state.integration.generations[0]?.status, "superseded");
	assert.equal(refreshed.state.integration.generations[0]?.checks, undefined);
	assert.equal(refreshed.state.integration.generations[1]?.worktree?.baseCommit, advanced.head);
	assert.deepEqual(refreshed.state.integration.generations[1]?.order, []);
	assert.equal(refreshed.state.integration.refresh?.status, "ready");
	assert.deepEqual(refreshed.state.main, advanced);
	assertParsed(refreshed.state);
	await assert.rejects(runner.integrate(action, root), /stale/);
	await assert.rejects(runner.stage(choose(1, ready.state.main), root), /stale generation/);
	const replay = await runner.stage(choose(2, refreshed.state.integration.generations[1]!.integrationBase), root);
	assert.equal(replay.state.integration.generations[1]?.stages[0]?.status, "staged");
	assert.equal(replay.state.integration.generations[1]?.checks, undefined);
	assert.equal(replay.state.integration.candidates[0]?.tip.head, candidate.tip.head);
	assert.equal(runtime.main.head, advanced.head);
	for (const snapshot of store.current!.snapshots) assertParsed(snapshot);
});

test("refresh with ambiguous owned worktree creation retains recovery evidence and never restages", async (t) => {
	const git = new StagingGit();
	const { root, runner, runtime } = await harness(t, { integrationGit: git });
	const id = "refresh-unknown";
	const ready = await runner.execute(request(id, [changesetTask("change")]), root);
	const candidate = ready.state.integration.candidates[0]!;
	runtime.main = identity("b");
	git.allocationUnknown = true;
	const action = { id, action: "refresh" as const, generation: 1, expectedMain: ready.state.main,
		newMain: runtime.main, expectedTip: ready.state.main };
	const unknown = await runner.integrate(action, root);
	assert.equal(unknown.state.integration.refresh?.status, "unknown");
	assert.equal(unknown.state.integration.generations[0]?.stages.length, 0);
	assertParsed(unknown.state);
	await assert.rejects(runner.integrate(action, root), /stale/);
	await assert.rejects(runner.stage({ id, action: "stage", generation: 1,
		taskId: candidate.taskId, attempt: candidate.attempt, candidate: candidate.tip, expectedTip: runtime.main }, root), /uncertain/);
});

test("Main refresh invalidates candidates launched from an old staged snapshot and refuses Main drift", async (t) => {
	const git = new StagingGit();
	const { root, runner, runtime } = await harness(t, { integrationGit: git });
	const id = "refresh-dependent";
	const ready = await runner.execute(request(id, [changesetTask("first"),
		{ ...changesetTask("dependent"), dependsOn: ["first"] }]), root);
	const first = ready.state.integration.candidates[0]!;
	const staged = await runner.stage({ id, generation: 1, action: "stage", taskId: first.taskId,
		attempt: first.attempt, candidate: first.tip, expectedTip: ready.state.main }, root);
	const oldTip = staged.state.integration.generations[0]!.combinedTip!;
	const advanced = await runner.integrate({ id, generation: 1, action: "advance", expectedTip: oldTip }, root);
	const dependent = advanced.state.integration.candidates[1]!;
	const next = identity("b");
	const action = { id, action: "refresh" as const, generation: 2, expectedMain: ready.state.main,
		newMain: next, expectedTip: oldTip };
	await assert.rejects(runner.integrate(action, root), /exact new clean Main/);
	assert.equal((await runner.status(id, root)).state.integration.generations[0]?.status, "staging");
	runtime.main = next;
	const refreshed = await runner.integrate(action, root);
	assert.equal(refreshed.state.integration.generations[0]?.status, "superseded");
	assert.equal(changesetState(refreshed.state, "dependent").status, "pending");
	assert.equal(changesetState(refreshed.state, "dependent").attempts[0]?.superseded, true);
	assert.equal(refreshed.state.integration.candidates[1]?.decision, "rejected");
	assertParsed(refreshed.state);
	await assert.rejects(runner.stage({ id, action: "stage", generation: 2, taskId: dependent.taskId,
		attempt: dependent.attempt, candidate: dependent.tip,
		expectedTip: refreshed.state.integration.generations[1]!.integrationBase }, root), /stale or unowned candidate/);
});

test("two bounded clean Main advances before staging retain both allocations and the original candidate", async (t) => {
	const git = new StagingGit();
	const { root, runner, runtime } = await harness(t, { integrationGit: git });
	const id = "refresh-twice";
	const ready = await runner.execute(request(id, [changesetTask("change")]), root);
	runtime.main = identity("b");
	const first = await runner.integrate({ id, generation: 1, action: "refresh", expectedTip: ready.state.main,
		expectedMain: ready.state.main, newMain: runtime.main }, root);
	const base = first.state.integration.generations[0]!.integrationBase;
	runtime.main = identity("c");
	const second = await runner.integrate({ id, generation: 2, action: "refresh", expectedTip: base,
		expectedMain: first.state.main, newMain: runtime.main }, root);
	assert.equal(second.state.integration.generations[0]?.status, "superseded");
	assert.equal(second.state.integration.generations[1]?.status, "staging");
	assertParsed(second.state);
	const candidate = ready.state.integration.candidates[0]!;
	const replay = await runner.stage({ id, generation: 2, action: "stage", taskId: candidate.taskId,
		attempt: candidate.attempt, candidate: candidate.tip,
		expectedTip: second.state.integration.generations[1]!.integrationBase }, root);
	assert.equal(replay.state.integration.generations[1]?.stages[0]?.status, "staged");
	assertParsed(replay.state);
});

test("a proven promotion drift can refresh without replaying the failed promotion", async (t) => {
	const { runner, root, runtime, git, action } = await stagedForPromotion(t, "refresh-after-drift");
	await runner.integrate({ ...action, action: "validate" }, root);
	git.promoteResult = { outcome: "drift", failure: "Main advanced before guarded promotion." };
	const originalPromote = git.promote.bind(git);
	git.promote = async (input) => { runtime.main = identity("b"); return await originalPromote(input); };
	const failed = await runner.integrate({ ...action, action: "promote" }, root);
	assert.equal(failed.state.integration.generations[0]?.promotion?.outcome, "drift");
	const refreshed = await runner.integrate({ id: action.id, generation: 2, action: "refresh",
		expectedTip: action.expectedTip, expectedMain: failed.state.integration.generations[0]!.expectedMain,
		newMain: runtime.main }, root);
	assert.equal(refreshed.state.integration.generations[0]?.supersededPromotion?.outcome, "drift");
	assert.equal(refreshed.state.integration.generations[0]?.checks, undefined);
	assert.equal(refreshed.state.integration.generations[1]?.status, "staging");
	assert.equal(git.promotions, 1);
	assertParsed(refreshed.state);
});

test("Main refreshes after prior rejection already froze its integration generation", async (t) => {
	const git = new StagingGit();
	const { root, runner, runtime } = await harness(t, { integrationGit: git });
	const id = "refresh-after-rejection";
	const ready = await runner.execute(request(id, [changesetTask("first"), changesetTask("second")]), root);
	const first = ready.state.integration.candidates[0]!;
	const second = ready.state.integration.candidates[1]!;
	const staged = await runner.stage({ id, action: "stage", generation: 1, taskId: first.taskId,
		attempt: first.attempt, candidate: first.tip, expectedTip: ready.state.main }, root);
	const tip = staged.state.integration.generations[0]!.combinedTip!;
	const rejected = await runner.stage({ id, action: "reject", generation: 1, taskId: first.taskId,
		attempt: first.attempt, candidate: first.tip, expectedTip: tip }, root);
	assert.equal(rejected.state.integration.generations[0]?.status, "superseded");
	runtime.main = identity("b");
	const refreshed = await runner.integrate({ id, action: "refresh", generation: 2,
		expectedTip: ready.state.main, expectedMain: ready.state.main, newMain: runtime.main }, root);
	assert.equal(refreshed.state.integration.generations[1]?.status, "staging");
	assertParsed(refreshed.state);
	const result = await runner.stage({ id, action: "stage", generation: 2, taskId: second.taskId,
		attempt: second.attempt, candidate: second.tip,
		expectedTip: refreshed.state.integration.generations[1]!.integrationBase }, root);
	assert.equal(result.state.integration.generations[1]?.stages[0]?.status, "staged");
});
