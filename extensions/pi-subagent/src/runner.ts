import { readFileSync, realpathSync } from "node:fs";
import type { EphemeralSubagentExecutor } from "./ephemeral.ts";
import { createChildWorktree, finalizeChildWorktree, type WorktreeInfo } from "./worktree.ts";
import { IntegrationGit, type StageReceipt } from "./integration-git.ts";
import {
	checkBatchPasses,
	CLEANUP_KINDS,
	isCleanCommitted,
	MAX_PERSISTED_RUNTIME_TEXT_BYTES,
	MAX_POSSIBLE_RESOURCES,
	parseExecuteRequest,
	parseIntegrationAction,
	integrationGenerationPasses,
	type IntegrationGeneration,
	parseResumeRequest,
	parseStageRequest,
	reviewEvidencePasses,
	sameIdentity,
	RUN_STATE_VERSION,
	type AllocationIntent,
	type AllocationKind,
	type CheckBatchEvidence,
	type CheckCommand,
	type ChangesetTaskRequest,
	type ChangesetTaskState,
	type CleanupKind,
	type CommandEvidence,
	type ExecuteRequest,
	type ExecutionPolicySnapshot,
	type HostAllocationIntent,
	type HostAllocationPlan,
	type ModelClass,
	type PromptRecord,
	type RebaseTransition,
	type ReviewEvidence,
	type ResumeRequest,
	type RunState,
	type TaskAttempt,
	type TaskRequest,
	type TaskState,
	type TextTaskState,
	type WaveState,
	type WorktreeAllocationIntent,
	type WorktreeAllocationPlan,
	type WorkspaceIdentity,
} from "./schema.ts";
import { FileRunStore, type ProductiveRunLease, type RunStateHandle } from "./store.ts";

const TRUNCATION_MARKER = "\n[truncated]";
const TEXT_TASK_PROMPT_MAX_BYTES = 64 * 1024;
const CHANGESET_TASK_PROMPT_MAX_BYTES = 96 * 1024;
const MAX_WORKER_PROMPTS = 32;
const MAX_QUEUED_FOLLOWUPS = 16;
export const CLEANUP_SAFETY_BUDGET_MS = 30_000;
export const TERMINATION_SAFETY_BUDGET_MS = 15_000;
export const STATUS_INSPECTION_BUDGET_MS = 5_000;
const ALLOCATION_KINDS: readonly AllocationKind[] = ["worktree", "workspace", "worker_tab", "agent"];
const FULL_SUITE: CheckCommand = { command: "pnpm", args: ["test"] };
const MAX_RETAINED_INTEGRATION_GENERATIONS = 2;

function requireRootSuite(root: string): string {
	let manifest: unknown;
	try { manifest = JSON.parse(readFileSync(`${root}/package.json`, "utf8")); }
	catch { throw new Error("Canonical root package.json with a test script is required for isolated changesets."); }
	if (!manifest || typeof manifest !== "object" || !('scripts' in manifest)
		|| !manifest.scripts || typeof manifest.scripts !== "object"
		|| !('test' in manifest.scripts) || typeof manifest.scripts.test !== "string"
		|| !manifest.scripts.test.trim()) throw new Error("Canonical root test script is missing.");
	return manifest.scripts.test;
}

export interface OperationContext {
	readonly signal: AbortSignal;
	readonly timeoutMs?: number;
	readonly deadline?: number;
}

export interface CommandResult extends CheckCommand {
	code: number;
	killed?: boolean;
	stdout: string;
	stderr: string;
}

type AllocationFailureResult<Kind extends AllocationKind> =
	| { kind: Kind; outcome: "absent"; failure: string }
	| { kind: Kind; outcome: "unknown"; failure: string; possibleResources?: string[] };

export type WorktreeAllocationResult =
	| { kind: "worktree"; outcome: "owned" }
	| AllocationFailureResult<"worktree">;
export type WorkspaceAllocationResult =
	| { kind: "workspace"; outcome: "owned"; workspaceId: string; rootTabId: string; rootPaneId: string }
	| AllocationFailureResult<"workspace">;
export type WorkerTabAllocationResult =
	| { kind: "worker_tab"; outcome: "owned"; tabId: string; paneId: string }
	| AllocationFailureResult<"worker_tab">;
export type AgentAllocationResult =
	| { kind: "agent"; outcome: "owned" }
	| AllocationFailureResult<"agent">;
export type HostAllocationResult = WorkspaceAllocationResult | WorkerTabAllocationResult | AgentAllocationResult;
export type AllocationResult = WorktreeAllocationResult | HostAllocationResult;

export type AllocationReconciliation<Kind extends AllocationKind = AllocationKind> =
	| { kind: Kind; outcome: "absent" }
	| { kind: Kind; outcome: "possible"; failure: string; possibleResources?: string[] };

export type WorkerResult =
	| { outcome: "candidate"; candidate: WorkspaceIdentity; diagnostic?: string }
	| { outcome: "blocked" | "not_prompted"; diagnostic: string }
	| { outcome: "unknown" | "interrupted"; diagnostic: string };

export interface CheckRunResult {
	results: CommandResult[];
	identityAfter: WorkspaceIdentity;
}

export interface ReviewResult {
	verdict: string;
	identityAfter: WorkspaceIdentity;
}

export type RebaseResult =
	| { outcome: "ready" | "drift"; base: WorkspaceIdentity; candidate: WorkspaceIdentity; failure?: string }
	| { outcome: "blocked"; failure: string };

export type RebaseReconciliation =
	| { outcome: "not_started" }
	| { outcome: "rebased"; candidate: WorkspaceIdentity }
	| { outcome: "unknown"; failure: string };

export type IntegrationResult =
	| { outcome: "integrated"; main: WorkspaceIdentity }
	| { outcome: "failed" | "drift" | "unknown"; failure: string };

/** A just-in-time launch whose argv contains only an ephemeral Role prompt path. */
export interface VerifiedLaunch {
	readonly role: string;
	readonly modelClass: ModelClass;
	readonly model: string;
	readonly thinkingLevel: string;
	readonly args: readonly string[];
	readonly env: Readonly<Record<string, string>>;
	readonly tools: readonly string[];
}

export interface TransientLaunchHandle<Launch extends VerifiedLaunch = VerifiedLaunch> {
	readonly launch: Launch;
	cleanup(): Promise<void>;
}

/** Run one launch action and surface cleanup failure, including after action failure or abort. */
export async function withTransientLaunch<Launch extends VerifiedLaunch, Result>(
	handle: TransientLaunchHandle<Launch>,
	operation: (launch: Launch) => Promise<Result>,
): Promise<Result> {
	let failed = false;
	let operationError: unknown;
	try {
		return await operation(handle.launch);
	} catch (error) {
		failed = true;
		operationError = error;
		throw error;
	} finally {
		try {
			await handle.cleanup();
		} catch (cleanupError) {
			if (failed) {
				throw new AggregateError(
					[operationError, cleanupError],
					"Transient Role launch failed and its prompt cleanup also failed.",
				);
			}
			throw cleanupError;
		}
	}
}

/**
 * Productive hooks may inspect or change implementation state. Every call receives
 * the same request abort signal. Individual I/O operations keep their own caps.
 */
export interface CoordinatorRuntime {
	now(): number;
	randomToken(): string;
	preflight(input: { request: ExecuteRequest; cwd: string }, context: OperationContext): Promise<{
		root: string;
		main: WorkspaceIdentity;
	}>;
	acquireLaunch(role: string, modelClass: ModelClass, context: OperationContext): Promise<TransientLaunchHandle<VerifiedLaunch>>;
}

export type HostAllocationKind = Exclude<AllocationKind, "worktree">;
export type HostCleanupKind = Extract<CleanupKind, "worker_tab" | "workspace">;
export type GitCleanupKind = Extract<CleanupKind, "worktree" | "branch">;

export interface HostRuntime {
	planHostAllocation(input: {
		readonly requestId: ExecuteRequest["id"];
		readonly goal: ExecuteRequest["goal"];
		kind: HostAllocationKind;
		task: TaskRequest;
		attempt: TaskAttempt;
	}, context: OperationContext): Promise<HostAllocationPlan>;
	allocateHost(input: {
		requestId: ExecuteRequest["id"];
		intent: HostAllocationIntent;
		task: TaskRequest;
		attempt: TaskAttempt;
		/** Invoked only after pane, lease, and startability checks at the final agent-start boundary. */
		acquireLaunch?: () => Promise<TransientLaunchHandle<VerifiedLaunch>>;
	}, context: OperationContext): Promise<HostAllocationResult>;
	reconcileHostAllocation(input: { requestId: ExecuteRequest["id"]; intent: HostAllocationIntent; task: TaskRequest; attempt: TaskAttempt }, context: OperationContext): Promise<AllocationReconciliation<HostAllocationKind>>;
	runWorker(input: {
		readonly goal: ExecuteRequest["goal"];
		readonly contexts: readonly TextTaskContext[];
		task: TaskRequest;
		attempt: TaskAttempt;
		workerId: string;
		kind: "initial" | "correction" | "followup";
		preCandidate: WorkspaceIdentity;
		failure?: string;
		instruction?: string;
	}, context: OperationContext): Promise<WorkerResult>;
	terminateWorker(input: {
		task: TaskRequest;
		attempt: TaskAttempt;
		workerId: string;
		candidate: WorkspaceIdentity;
	}, context: OperationContext): Promise<{ outcome: "terminated" } | { outcome: "unknown"; failure: string }>;
	reconcileWorkerTermination(input: {
		task: TaskRequest;
		attempt: TaskAttempt;
		workerId: string;
		candidate: WorkspaceIdentity;
	}, context: OperationContext): Promise<
		{ outcome: "terminated" | "active" } | { outcome: "unknown"; failure: string }
	>;
	cleanupHost(input: {
		requestId: ExecuteRequest["id"];
		kind: HostCleanupKind;
		task: TaskRequest;
		attempt: TaskAttempt;
	}, context: OperationContext): Promise<{ outcome: "completed" | "absent" } | { outcome: "blocked"; failure: string }>;
}

export interface TaskCandidateInspector {
	inspectTaskCandidate(input: { root: string; task: TaskRequest; attempt: TaskAttempt }, context: OperationContext): Promise<WorkspaceIdentity>;
}

export interface InFlightTaskCandidateInspection {
	candidate: WorkspaceIdentity;
	clean: boolean;
	valid: boolean;
}

export interface InFlightTaskCandidateInspector {
	inspectInFlightTaskCandidate(
		input: { root: string; task: TaskRequest; attempt: TaskAttempt },
		context: OperationContext,
	): Promise<InFlightTaskCandidateInspection>;
}

export interface GitRuntime {
	inspectMain(input: { root: string }, context: OperationContext): Promise<WorkspaceIdentity>;
	allocateWorktree(input: {
		root: string;
		baseRoot?: string;
		intent: WorktreeAllocationIntent;
		task: TaskRequest;
		attempt: TaskAttempt;
		onPrepared(worktree: WorktreeAllocationPlan): Promise<void>;
	}, context: OperationContext): Promise<WorktreeAllocationResult>;
	reconcileWorktreeAllocation(input: {
		root: string;
		intent: WorktreeAllocationIntent;
		task: TaskRequest;
		attempt: TaskAttempt;
	}, context: OperationContext): Promise<AllocationReconciliation<"worktree">>;
	runChecks(input: {
		root: string;
		scope: "task" | "final";
		taskId?: string;
		attempt?: TaskAttempt;
		checks: CheckCommand[];
		candidate: WorkspaceIdentity;
	}, context: OperationContext): Promise<CheckRunResult>;
	review(input: {
		root: string;
		scope: "task" | "final";
		phase: ReviewEvidence["phase"];
		taskId?: string;
		attempt?: TaskAttempt;
		criterion: string;
		base: WorkspaceIdentity;
		tip: WorkspaceIdentity;
		acquireLaunch(): Promise<TransientLaunchHandle<VerifiedLaunch>>;
	}, context: OperationContext): Promise<ReviewResult>;
	inspectRetainedTask(input: { root: string; task: TaskRequest; attempt: TaskAttempt }, context: OperationContext): Promise<WorkspaceIdentity>;
	rebase(input: {
		root: string;
		task: TaskRequest;
		attempt: TaskAttempt;
		candidate: WorkspaceIdentity;
		sourceBase: WorkspaceIdentity;
		onto: WorkspaceIdentity;
	}, context: OperationContext): Promise<RebaseResult>;
	reconcileRebase(input: {
		root: string;
		task: TaskRequest;
		attempt: TaskAttempt;
		transition: RebaseTransition;
	}, context: OperationContext): Promise<RebaseReconciliation>;
	integrate(input: {
		root: string;
		task: TaskRequest;
		attempt: TaskAttempt;
		expectedMain: WorkspaceIdentity;
		candidate: WorkspaceIdentity;
		checks: CheckBatchEvidence;
		review?: ReviewEvidence;
	}, context: OperationContext): Promise<IntegrationResult>;
	cleanupGit(input: {
		root: string;
		kind: GitCleanupKind;
		task: TaskRequest;
		attempt: TaskAttempt;
	}, context: OperationContext): Promise<{ outcome: "completed" | "absent" } | { outcome: "blocked"; failure: string }>;
}

export type MainStatus =
	| { status: "current" | "drifted"; expected: WorkspaceIdentity; actual: WorkspaceIdentity }
	| { status: "unavailable"; expected: WorkspaceIdentity; failure: string };

export interface RunResponse {
	text: string;
	state: RunState;
	main?: MainStatus;
	continuation?: ResumeRequest;
}

class DeadlineExpired extends Error {
	constructor() {
		super("The safety operation deadline is exhausted.");
		this.name = "DeadlineExpired";
	}
}

class DurableRunStopped extends Error {
	readonly state: RunState;

	constructor(state: RunState) {
		super(`Pi Subagent request ${state.request.id} became terminal (${state.status}).`);
		this.name = "DurableRunStopped";
		this.state = state;
	}
}

type ProductiveLifecycle = {
	readonly lease: ProductiveRunLease;
	stopped: boolean;
};

interface RuntimeScope {
	readonly signal: AbortSignal;
	call<T>(operation: (context: OperationContext) => Promise<T>): Promise<T>;
}

class ProductiveScope implements RuntimeScope {
	readonly signal: AbortSignal;

	constructor(_timeoutMs: number, _now: () => number, outerSignal?: AbortSignal) {
		this.signal = outerSignal ?? new AbortController().signal;
	}

	async call<T>(operation: (context: OperationContext) => Promise<T>): Promise<T> {
		this.signal.throwIfAborted();
		const result = await operation({ signal: this.signal });
		this.signal.throwIfAborted();
		return result;
	}

}

class DeadlineScope implements RuntimeScope {
	readonly deadline: number;
	readonly signal: AbortSignal;
	private readonly now: () => number;
	private readonly controller = new AbortController();
	private readonly timer: NodeJS.Timeout;

	constructor(deadline: number, now: () => number, outerSignal?: AbortSignal) {
		this.deadline = deadline;
		this.now = now;
		this.signal = outerSignal ? AbortSignal.any([this.controller.signal, outerSignal]) : this.controller.signal;
		const remaining = Math.max(0, deadline - now());
		this.timer = setTimeout(() => this.controller.abort(new DeadlineExpired()), remaining);
		this.timer.unref();
	}

	async call<T>(operation: (context: OperationContext) => Promise<T>): Promise<T> {
		this.throwIfExpired();
		const result = await operation({ signal: this.signal, timeoutMs: this.remaining(), deadline: this.deadline });
		this.throwIfExpired();
		return result;
	}

	close(): void {
		clearTimeout(this.timer);
	}

	private remaining(): number {
		return Math.max(0, this.deadline - this.now());
	}

	private throwIfExpired(): void {
		if (this.remaining() <= 0) throw new DeadlineExpired();
		this.signal.throwIfAborted();
	}
}

type QueuedFollowup = { kind: "followup"; instruction: string };

class FollowupControl {
	private readonly queue: QueuedFollowup[] = [];
	private readonly validateFollowup: (instruction: string) => void;
	private sealed = false;

	constructor(validateFollowup: (instruction: string) => void) {
		this.validateFollowup = validateFollowup;
	}

	get pendingFollowups(): number {
		return this.queue.length;
	}

	followup(instruction: string): void {
		if (this.sealed) throw new Error("This task candidate is already sealed for integration.");
		if (this.queue.length >= MAX_QUEUED_FOLLOWUPS) throw new Error(`A task may queue at most ${MAX_QUEUED_FOLLOWUPS} follow-ups.`);
		this.validateFollowup(instruction);
		this.queue.push({ kind: "followup", instruction });
	}

	takeQueuedFollowup(): QueuedFollowup | undefined {
		if (this.sealed) throw new Error("This task candidate is already sealed for integration.");
		return this.queue.shift();
	}

	/** Atomically take the next admitted revision or seal the candidate. */
	takeQueuedFollowupOrSeal(): QueuedFollowup | undefined {
		const queued = this.takeQueuedFollowup();
		if (queued) return queued;
		this.sealed = true;
		return undefined;
	}

	invalidate(): void {
		this.sealed = true;
		this.queue.length = 0;
	}

	close(): void {
		this.sealed = true;
		this.queue.length = 0;
	}
}

function bounded(value: string, maxBytes = MAX_PERSISTED_RUNTIME_TEXT_BYTES): string {
	if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
	const contentBytes = maxBytes - Buffer.byteLength(TRUNCATION_MARKER, "utf8");
	let end = Math.min(value.length, contentBytes);
	while (end > 0 && Buffer.byteLength(value.slice(0, end), "utf8") > contentBytes) end -= 1;
	return `${value.slice(0, end)}${TRUNCATION_MARKER}`;
}

function boundedRuntimeText(value: unknown, field: string): string {
	if (typeof value !== "string") throw new Error(`${field} must be text.`);
	return bounded(value);
}

function boundedRuntimeDiagnostic(value: unknown, field: string): string {
	if (typeof value !== "string") throw new Error(`${field} must be text.`);
	const normalized = value.trim();
	if (!normalized || normalized.includes("\0")) throw new Error(`${field} must be non-empty text without NUL.`);
	return bounded(normalized);
}

function boundedPossibleResources(values: unknown): string[] | undefined {
	if (values === undefined) return;
	if (!Array.isArray(values)) return ["Runtime returned an invalid possible-resource list; cleanup remains blocked."];
	if (!values.length) return;
	const retained = values.slice(0, MAX_POSSIBLE_RESOURCES).map((value, index) => {
		if (typeof value !== "string") return `Runtime returned invalid possible-resource evidence at index ${index}.`;
		const item = bounded(value);
		return item.trim() && !item.includes("\0")
			? item
			: `Runtime returned invalid possible-resource evidence at index ${index}.`;
	});
	if (values.length > MAX_POSSIBLE_RESOURCES) {
		retained[MAX_POSSIBLE_RESOURCES - 1] = `${values.length - MAX_POSSIBLE_RESOURCES + 1} additional possible resources were omitted; cleanup remains blocked.`;
	}
	return retained;
}

function errorText(error: unknown): string {
	return bounded(error instanceof Error ? error.message : String(error));
}

function requireExactAllocationText(value: unknown, field: string): asserts value is string {
	if (typeof value !== "string" || !value.trim() || value.trim() !== value || value.includes("\0")
		|| Buffer.byteLength(value, "utf8") > MAX_PERSISTED_RUNTIME_TEXT_BYTES) {
		throw new Error(`${field} must be bounded exact non-empty text.`);
	}
}

function runtimeIdentity(value: unknown, field: string): WorkspaceIdentity {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an exact identity.`);
	const identity = value as Partial<WorkspaceIdentity>;
	requireExactAllocationText(identity.branch, `${field} branch`);
	for (const [name, oid] of Object.entries({ head: identity.head, index: identity.index, tree: identity.tree })) {
		if (typeof oid !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid)) {
			throw new Error(`${field} ${name} is not an exact object ID.`);
		}
	}
	return { branch: identity.branch, head: identity.head!, index: identity.index!, tree: identity.tree! };
}

function runtimeToken(value: unknown): string {
	if (typeof value !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(value)) {
		throw new Error("Runtime correlation token must match the strict token format.");
	}
	return value;
}

function runtimeHostAllocationPlan(plan: HostAllocationPlan, kind: Exclude<AllocationKind, "worktree">): HostAllocationPlan {
	if (!plan || typeof plan !== "object" || plan.kind !== kind) throw new Error(`${kind} allocation planning returned the wrong kind.`);
	const fields = kind === "workspace"
		? ["label", "worktreeCwd", "mainRoot", "repoKey", "herdrRepoRoot"] as const
		: kind === "worker_tab"
			? ["label", "workspaceId", "workspaceRootTabId", "workspaceRootPaneId", "worktreeCwd", "leasePath"] as const
			: ["agentName", "workspaceId", "tabId", "paneId", "worktreeCwd", "leasePath"] as const;
	const validated: Record<string, string> = {};
	for (const field of fields) {
		const value = (plan as unknown as Record<string, unknown>)[field];
		requireExactAllocationText(value, `${kind} allocation plan ${field}`);
		validated[field] = value;
	}
	return { kind, ...validated } as HostAllocationPlan;
}

function taskRequest(state: RunState, id: string): TaskRequest {
	const task = state.request.tasks.find((candidate) => candidate.id === id);
	if (!task) throw new Error(`Unknown task ID: ${id}.`);
	return task;
}

function changesetTaskRequest(state: RunState, id: string): ChangesetTaskRequest {
	const task = taskRequest(state, id);
	if (task.kind !== "changeset") throw new Error(`Task ${id} is not a changeset task.`);
	return task;
}

function taskState(state: RunState, id: string): TaskState {
	const task = state.tasks.find((candidate) => candidate.taskId === id);
	if (!task) throw new Error(`Unknown task ID: ${id}.`);
	return task;
}

function taskDependenciesCompleted(state: RunState, taskId: string): boolean {
	const request = taskRequest(state, taskId);
	const generation = state.integration.generations.at(-1);
	return request.dependsOn.every((source) => {
		const predecessor = taskState(state, source);
		return predecessor.kind === "text" ? predecessor.status === "completed"
			: generation?.status !== "superseded" && generation?.stages.some((stage) =>
				stage.taskId === source && stage.status === "staged" && predecessor.status === "ready_to_integrate") === true;
	}) && request.contextFrom.every((source) => taskState(state, source).status === "completed");
}

/** Context edges carry only prompt text, never the source checkout. */
function hasChangesetDependency(state: RunState, taskId: string): boolean {
	const request = taskRequest(state, taskId);
	return [...request.dependsOn, ...request.contextFrom].some((source) =>
		taskState(state, source).kind === "changeset" || hasChangesetDependency(state, source));
}

/** Include prompt-context consumers when an invalidated text output fed later work. */
function affectedDependents(state: RunState, taskId: string): TaskState[] {
	const affected = new Set([taskId]);
	let changed = true;
	while (changed) {
		changed = false;
		for (const definition of state.request.tasks) {
			if (!affected.has(definition.id) && [...definition.dependsOn, ...definition.contextFrom].some((source) => affected.has(source))) {
				affected.add(definition.id);
				changed = true;
			}
		}
	}
	return state.tasks.filter((task) => task.taskId !== taskId && affected.has(task.taskId) && task.attempts.length > 0);
}

/** Every changeset predecessor must be present in this exact committed snapshot. */
function stagedDependencySnapshot(state: RunState, taskId: string, tip: WorkspaceIdentity): boolean {
	const generation = state.integration.generations.at(-1);
	const request = taskRequest(state, taskId);
	return request.dependsOn.every((source) => {
		if (taskState(state, source).kind === "text") return true;
		return Boolean(generation && generation.status !== "superseded" && generation.combinedTip
			&& sameIdentity(generation.combinedTip, tip) && generation.stages.some((stage) => stage.taskId === source && stage.status === "staged"));
	});
}

function textRetryEligible(state: RunState, task: TextTaskState): boolean {
	const attempt = task.attempts.at(-1);
	return task.status === "needs_attention"
		&& attempt?.status === "failed"
		&& task.attempts.length < 2
		&& taskDependenciesCompleted(state, task.taskId);
}

function changesetTaskState(state: RunState, id: string): ChangesetTaskState {
	const task = taskState(state, id);
	if (task.kind !== "changeset") throw new Error(`Task ${id} is not a changeset task.`);
	return task;
}

function latestAttempt(task: ChangesetTaskState): TaskAttempt {
	const attempt = task.attempts.at(-1);
	if (!attempt) throw new Error(`Task ${task.taskId} has no recorded attempt.`);
	return attempt;
}

function nextAttemptEventAt(attempt: TaskAttempt, now: number): number {
	const latest = Math.max(
		0,
		...attempt.prompts.map(({ at }) => at),
		...attempt.transitions.map(({ at }) => at),
		attempt.readiness?.at ?? 0,
	);
	return Math.max(now, latest + 1);
}

function latestTransitionAfter(attempt: TaskAttempt, after: number): RebaseTransition | undefined {
	for (let index = attempt.transitions.length - 1; index >= 0; index -= 1) {
		const transition = attempt.transitions[index]!;
		if (transition.at > after) return transition;
	}
	return undefined;
}

type AllocationOfKind<Kind extends AllocationKind> = Extract<AllocationIntent, { kind: Kind }>;

function allocationByKind<Kind extends AllocationKind>(attempt: TaskAttempt, kind: Kind): AllocationOfKind<Kind> | undefined {
	return [...attempt.allocations].reverse().find(
		(intent): intent is AllocationOfKind<Kind> => intent.kind === kind && intent.status === "owned",
	);
}

function applyOwnedAllocationResult(intent: AllocationIntent, result: AllocationResult): void {
	if (result.kind !== intent.kind) throw new Error(`${intent.kind} allocation returned the wrong result kind.`);
	if (result.outcome !== "owned") throw new Error(`${intent.kind} allocation did not return an owned result.`);
	if (intent.kind === "worktree" && result.kind === "worktree") {
		if (!intent.worktree) throw new Error("Worktree allocation returned without exact persisted plan fields.");
	} else if (intent.kind === "workspace" && result.kind === "workspace") {
		for (const [field, value] of Object.entries({
			workspaceId: result.workspaceId, rootTabId: result.rootTabId, rootPaneId: result.rootPaneId,
		})) requireExactAllocationText(value, `Workspace allocation ${field}`);
		intent.workspaceId = result.workspaceId;
		intent.rootTabId = result.rootTabId;
		intent.rootPaneId = result.rootPaneId;
	} else if (intent.kind === "worker_tab" && result.kind === "worker_tab") {
		requireExactAllocationText(result.tabId, "Worker-tab allocation tabId");
		requireExactAllocationText(result.paneId, "Worker-tab allocation paneId");
		intent.tabId = result.tabId;
		intent.paneId = result.paneId;
	} else if (intent.kind !== "agent" || result.kind !== "agent") {
		throw new Error(`${intent.kind} allocation result could not be matched to its persisted plan.`);
	}
	intent.status = "owned";
}

function exactCommandResults(results: readonly CommandResult[], checks: readonly CheckCommand[]): boolean {
	return results.length === checks.length && results.every((result, index) => {
		const check = checks[index]!;
		return result.command === check.command
			&& result.args.length === check.args.length
			&& result.args.every((arg, argIndex) => arg === check.args[argIndex]);
	});
}

function correctionEligible(request: ChangesetTaskRequest, attempt: TaskAttempt): boolean {
	const initial = attempt.prompts[0];
	if (initial?.kind !== "initial" || attempt.prompts.some((prompt) => prompt.kind === "correction" || prompt.status === "ambiguous")
		|| attempt.termination) return false;
	const latestPrompt = attempt.prompts.at(-1)!;
	if (latestPrompt.status !== "settled") return false;
	const latestTransition = attempt.transitions.at(-1);
	if (!attempt.readiness && latestTransition?.status === "rebased" && latestTransition.to
		&& attempt.candidate && attempt.candidateBase
		&& sameIdentity(attempt.candidate, latestTransition.to)
		&& sameIdentity(attempt.candidateBase, latestTransition.onto)
		&& !attempt.preliminaryChecks && !attempt.authoritativeChecks && !attempt.authoritativeReview && !attempt.integration) {
		return true;
	}
	if (!attempt.candidate) {
		return attempt.prompts.length === 1 && !attempt.preliminaryChecks && Boolean(initial.failure?.trim());
	}
	const checks = attempt.preliminaryChecks;
	return attempt.prompts.length === 1 && Boolean(checks
		&& checks.phase === "preliminary"
		&& exactCommandResults(checks.results, request.checks)
		&& sameIdentity(checks.candidate, attempt.candidate)
		&& sameIdentity(checks.identityAfter, attempt.candidate)
		&& (!checks.passed && checks.results.some((result) => result.code !== 0 || result.killed)
			|| checks.passed && request.judgment && attempt.preliminaryReview?.phase === "preliminary"
				&& !attempt.preliminaryReview.passed && attempt.preliminaryReview.verdict !== "PASS"
				&& attempt.preliminaryReview.criterion === request.judgment.criterion
				&& sameIdentity(attempt.preliminaryReview.base, attempt.candidateBase!)
				&& sameIdentity(attempt.preliminaryReview.tip, attempt.candidate)
				&& sameIdentity(attempt.preliminaryReview.identityAfter, attempt.candidate)));
}

function terminal(state: RunState): boolean {
	return state.status === "completed" || state.status === "final_failed" || state.status === "superseded" || state.status === "aborted";
}

export type TextTaskContext = { taskId: string; text: string };

/** Build one bounded changeset assignment. Call this before acquiring its Role launch. */
export function buildChangesetTaskPrompt(input: {
	readonly goal: ExecuteRequest["goal"];
	readonly contexts: readonly TextTaskContext[];
	task: ChangesetTaskRequest;
	kind: "initial" | "correction" | "followup";
	worktreeCwd: string;
	failure?: string;
	instruction?: string;
}): string {
	if (input.kind === "correction"
		&& (typeof input.failure !== "string" || !input.failure.trim() || input.failure.trim() !== input.failure || input.failure.includes("\0"))) {
		throw new Error("correction failure must be a non-empty exact string.");
	}
	if (input.kind === "followup"
		&& (typeof input.instruction !== "string" || !input.instruction.trim() || input.instruction.trim() !== input.instruction
			|| input.instruction.includes("\0") || input.instruction.length > 32_000)) {
		throw new Error("follow-up instruction must be non-empty exact text of at most 32000 characters.");
	}
	const checks = input.task.checks.map((check) => JSON.stringify({ command: check.command, args: check.args })).join("\n");
	const upstreamTaskData = input.contexts.length
		? ["", "Upstream task data:", formatTextTaskContexts(input.contexts, CHANGESET_TASK_PROMPT_MAX_BYTES)]
		: [];
	const text = input.kind === "followup" ? [
		`Task: ${input.task.id}`,
		`Worktree: ${input.worktreeCwd}`,
		"",
		"Follow-up:",
		input.instruction!,
		"",
		"Required checks (direct command/argv):",
		checks,
		"",
		"Continue the same task in the exact worktree above. Commit the complete revision and leave that worktree clean.",
	].join("\n") : [
		`Task: ${input.task.id}`,
		"Goal:",
		input.goal,
		`Worktree: ${input.worktreeCwd}`,
		`Integrated dependencies: ${input.task.dependsOn.length ? input.task.dependsOn.join(", ") : "none"}`,
		"",
		"Requirements:",
		input.task.requirements,
		"",
		"Deliverable:",
		input.task.deliverable,
		...upstreamTaskData,
		"",
		"Required checks (direct command/argv):",
		checks,
		...(input.kind === "correction" ? ["", "Correction failure:", input.failure!] : []),
		"",
		"Work only in the exact worktree above. Commit the complete result and leave that worktree clean.",
	].join("\n");
	if (Buffer.byteLength(text, "utf8") > CHANGESET_TASK_PROMPT_MAX_BYTES) {
		throw new Error(`Worker assignment exceeds ${CHANGESET_TASK_PROMPT_MAX_BYTES} bytes.`);
	}
	return text;
}

/** Resolve completed text outputs in the consumer's declared context order. */
export function resolveTextTaskContexts(
	state: { readonly tasks: readonly TaskState[] },
	task: Pick<TaskRequest, "id" | "contextFrom">,
): TextTaskContext[] {
	return task.contextFrom.map((taskId) => {
		const source = state.tasks.find((candidate) => candidate.taskId === taskId);
		if (!source) throw new Error(`Context source ${taskId} for task ${task.id} is absent.`);
		if (source.kind !== "text") throw new Error(`Context source ${taskId} for task ${task.id} is not a text task.`);
		const attempt = source.attempts.at(-1);
		if (source.status !== "completed" || attempt?.status !== "completed") {
			throw new Error(`Context source ${taskId} for task ${task.id} is incomplete.`);
		}
		if (!attempt.output) throw new Error(`Context source ${taskId} for task ${task.id} is missing output.`);
		return { taskId, text: attempt.output.text };
	});
}

/** Format complete context blocks or fail; prompt data is never truncated. */
export function formatTextTaskContexts(contexts: readonly TextTaskContext[], maxBytes: number): string {
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
		throw new Error("Text task context byte cap must be a non-negative safe integer.");
	}
	const text = contexts.map(({ taskId, text: output }) => `Context from task ${taskId}:\n${output}`).join("\n\n");
	if (Buffer.byteLength(text, "utf8") > maxBytes) {
		throw new Error(`Text task context exceeds ${maxBytes} UTF-8 bytes.`);
	}
	return text;
}

/** Build a bounded text-task assignment with upstream output marked as task data. */
export function buildTextTaskPrompt(
	goal: ExecuteRequest["goal"],
	task: Pick<TaskRequest, "id" | "requirements" | "deliverable">,
	contexts: readonly TextTaskContext[],
): string {
	const assignment = [
		`Task: ${task.id}`,
		"Goal:",
		goal,
		"",
		"Requirements:",
		task.requirements,
		"",
		"Deliverable:",
		task.deliverable,
	].join("\n");
	const prefix = contexts.length ? `${assignment}\n\nTask data:\n` : assignment;
	const remainingBytes = TEXT_TASK_PROMPT_MAX_BYTES - Buffer.byteLength(prefix, "utf8");
	if (remainingBytes < 0) throw new Error(`Text task prompt exceeds ${TEXT_TASK_PROMPT_MAX_BYTES} UTF-8 bytes.`);
	return `${prefix}${formatTextTaskContexts(contexts, remainingBytes)}`;
}

export function readyPendingTasks(state: RunState): TaskState[] {
	return state.tasks.filter((task) => task.status === "pending" && taskDependenciesCompleted(state, task.taskId));
}

function isDeadline(error: unknown, scope: RuntimeScope): boolean {
	return error instanceof DeadlineExpired || scope.signal.reason instanceof DeadlineExpired;
}

export class IsolatedRunner {
	private readonly coordinatorRuntime: CoordinatorRuntime;
	private readonly hostRuntime: HostRuntime;
	private readonly gitRuntime: GitRuntime & TaskCandidateInspector;
	private readonly store: FileRunStore;
	private readonly integrationGit: IntegrationGit;
	private readonly textExecutor: EphemeralSubagentExecutor;
	private readonly currentPolicy: () => ExecutionPolicySnapshot;
	private readonly productiveLifecycles = new Map<string, ProductiveLifecycle>();
	private readonly followupControls = new Map<string, { task: ChangesetTaskState; control: FollowupControl }>();

	constructor(
		coordinatorRuntime: CoordinatorRuntime,
		hostRuntime: HostRuntime,
		gitRuntime: GitRuntime & TaskCandidateInspector,
		store = new FileRunStore(),
		textExecutor: EphemeralSubagentExecutor,
		policy: ExecutionPolicySnapshot = {
			maxSubagents: 5, maxTurns: 50, childIdleMs: 600_000, childMaxMs: 1_800_000,
			maxCorrections: 1,
		},
		currentPolicy: () => ExecutionPolicySnapshot = () => policy,
		integrationGit = new IntegrationGit(),
	) {
		this.coordinatorRuntime = coordinatorRuntime;
		this.hostRuntime = hostRuntime;
		this.gitRuntime = gitRuntime;
		this.store = store;
		this.integrationGit = integrationGit;
		this.textExecutor = textExecutor;
		this.currentPolicy = currentPolicy;
	}

	queueFollowup(root: string, requestId: string, taskId: string, instruction: string): string {
		if (typeof instruction !== "string" || !instruction.trim() || instruction.trim() !== instruction
			|| instruction.includes("\0") || instruction.length > 32_000) {
			throw new Error("Follow-up instruction must be non-empty exact text of at most 32000 characters.");
		}
		const active = this.activeControl(realpathSync.native(root), requestId, taskId);
		if (!active || active.task.status !== "working") {
			throw new Error(`Task ${taskId} is not an active unsealed changeset.`);
		}
		if (latestAttempt(active.task).prompts.length + active.control.pendingFollowups >= MAX_WORKER_PROMPTS) {
			throw new Error(`A task may submit at most ${MAX_WORKER_PROMPTS} worker prompts.`);
		}
		active.control.followup(instruction);
		return `Queued follow-up for ${requestId}/${taskId}.`;
	}

	private async withProductiveRun<T>(
		root: string,
		operation: (lifecycle: ProductiveLifecycle) => Promise<T>,
	): Promise<T> {
		return await this.store.withProductiveRunLease(root, async (lease) => {
			if (this.productiveLifecycles.has(root)) {
				throw new Error("Another Pi Subagent productive request is active in this runner.");
			}
			const lifecycle: ProductiveLifecycle = { lease, stopped: false };
			this.productiveLifecycles.set(root, lifecycle);
			try {
				return await operation(lifecycle);
			} finally {
				this.productiveLifecycles.delete(root);
			}
		});
	}

	private async withLifecycleLock<T>(handle: RunStateHandle, operation: () => Promise<T>): Promise<T> {
		const lifecycle = this.productiveLifecycles.get(handle.state.root);
		if (!lifecycle) throw new Error("Productive lifecycle ownership is unavailable.");
		if (lifecycle.stopped) throw new DurableRunStopped(handle.state);
		return await this.store.withLock(handle.state.root, async () => {
			const durable = (await this.store.load(handle.state.root, handle.state.request.id)).state;
			if (terminal(durable)
				&& (!terminal(handle.state) || durable.status !== handle.state.status || durable.status === "aborted")) {
				lifecycle.stopped = true;
				handle.state = durable;
				throw new DurableRunStopped(durable);
			}
			return await operation();
		}, { productiveRunLease: lifecycle.lease });
	}

	private async saveProductive(handle: RunStateHandle): Promise<void> {
		const lifecycle = this.productiveLifecycles.get(handle.state.root);
		if (!lifecycle) {
			await handle.save();
			return;
		}
		if (lifecycle.stopped) return;
		await this.withLifecycleLock(handle, async () => await handle.save());
	}

	private async callProductive<T>(
		handle: RunStateHandle,
		scope: RuntimeScope,
		operation: (context: OperationContext) => Promise<T>,
	): Promise<T> {
		await this.withLifecycleLock(handle, async () => {});
		let result: T;
		try {
			result = await scope.call(operation);
		} catch (error) {
			await this.withLifecycleLock(handle, async () => {});
			throw error;
		}
		await this.withLifecycleLock(handle, async () => {});
		return result;
	}

	private rethrowStopped(error: unknown): void {
		if (error instanceof DurableRunStopped) throw error;
	}

	async execute(value: unknown, cwd: string, outerSignal?: AbortSignal): Promise<RunResponse> {
		const request = parseExecuteRequest(value);
		const policy = Object.freeze({ ...this.currentPolicy() });
		const scope = new ProductiveScope(policy.childMaxMs, () => this.coordinatorRuntime.now(), outerSignal);
		const canonicalCwd = realpathSync.native(cwd);
		const prepared = await scope.call(async (context) => await this.coordinatorRuntime.preflight({ request, cwd: canonicalCwd }, context));
		const root = realpathSync.native(prepared.root);
		if (root !== prepared.root) throw new Error("Preflight repository root must be canonical.");
		if (request.tasks.some((task) => task.kind === "changeset")) {
			requireRootSuite(root);
			if (!request.finalChecks.some((check) => check.command === FULL_SUITE.command
				&& check.args.length === 1 && check.args[0] === FULL_SUITE.args[0])) {
				request.finalChecks = [FULL_SUITE, ...request.finalChecks];
			}
		}
		const preparedMain = runtimeIdentity(prepared.main, "Preflight Main identity");
		if (!isCleanCommitted(preparedMain)) throw new Error("Preflight Main identity must be clean and committed.");
		if (this.hasAnyActiveControl(root)) {
			throw new Error("Another Pi Subagent request has active changeset work in this repository.");
		}
		return await this.withProductiveRun(root, async (lifecycle) => {
			const createdAt = this.coordinatorRuntime.now();
			const state: RunState = {
				version: RUN_STATE_VERSION,
				request,
				policy,
				correctionCount: 0,
				root,
				requestStartMain: preparedMain,
				main: preparedMain,
				status: "pending",
				tasks: request.tasks.map((task): TaskState => task.kind === "changeset"
					? {
						taskId: task.id,
						kind: "changeset",
						status: "pending",
						attempts: [],
					}
					: {
						taskId: task.id,
						kind: "text",
						status: "pending",
						attempts: [],
					}),
				waves: [],
				integration: { candidates: [], generations: [] },
				final: { status: "pending" },
				accepted: false,
				createdAt,
				updatedAt: createdAt,
			};
			const handle = await this.store.withLock(root, async () => {
				await this.store.assertLegacyAdmissionSafe(root);
				return await this.store.create(state);
			}, { productiveRunLease: lifecycle.lease });
			return await this.run(handle, scope, undefined);
		});
	}

	async resume(value: unknown, root: string, outerSignal?: AbortSignal): Promise<RunResponse> {
		const request = parseResumeRequest(value);
		root = realpathSync.native(root);
		if (this.hasActiveControl(root, request.id)) {
			throw new Error(`Pi Subagent request ${request.id} is still active; use follow-up, status, or abort.`);
		}
		if (this.hasAnyActiveControl(root)) {
			throw new Error("Another Pi Subagent request has active changeset work in this repository.");
		}
		return await this.withProductiveRun(root, async (lifecycle) => {
			const handle = await this.store.withLock(root, async () => {
				const loaded = await this.store.load(root, request.id);
				const state = loaded.state;
				if (this.recoverInterrupted(state)) await loaded.save();
				if (terminal(state)) throw new Error(`Pi Subagent request ${request.id} is terminal (${state.status}); create a new request.`);
				if (state.integration.candidates.length) throw new Error("Retained candidates require subagent_stage; resume cannot stage or finalize them.");
				state.recovery = {
					kind: "resume",
					action: request.action,
					...("taskId" in request ? { taskId: request.taskId } : {}),
				};
				state.updatedAt = this.coordinatorRuntime.now();
				await loaded.save();
				return loaded;
			}, { productiveRunLease: lifecycle.lease });
			const state = handle.state;
			const current = this.currentPolicy();
			const scope: RuntimeScope = new ProductiveScope(Math.min(state.policy.childMaxMs, current.childMaxMs), () => this.coordinatorRuntime.now(), outerSignal);
			try {
				if (request.action === "finalize") return await this.finalize(handle, scope);
				const task = taskState(state, request.taskId);
				if (task.kind === "text") {
					if (task.status !== "needs_attention") throw new Error(`Task ${task.taskId} is not waiting for deliberate attention.`);
					if (request.action === "verify") throw new Error(`Text task ${task.taskId} cannot be verified.`);
					if (!textRetryEligible(state, task)) {
						const attempt = task.attempts.at(-1);
						if (attempt?.status !== "failed" || task.attempts.length >= 2) {
							throw new Error(`Text task ${task.taskId} retry requires a failed latest attempt and fewer than two attempts.`);
						}
						throw new Error(`Text task ${task.taskId} dependencies are not completed.`);
					}
					task.status = "pending";
					task.failure = undefined;
					return await this.run(handle, scope, task.taskId);
				}
				if (task.status !== "needs_attention") throw new Error(`Task ${task.taskId} is not waiting for deliberate attention.`);
				if (request.action === "retry") return await this.retry(handle, task, scope);
				return await this.verifyRetainedTask(handle, task, scope);
			} catch (error) {
				if (error instanceof DurableRunStopped) return this.response(handle.state);
				throw error;
			} finally {
				if (scope instanceof DeadlineScope) scope.close();
				this.closeRequestControls(root, request.id);
				if (!lifecycle.stopped) {
					delete state.recovery;
					state.updatedAt = this.coordinatorRuntime.now();
					await this.saveProductive(handle);
				}
			}
		});
	}

	/** Main selects an exact retained candidate; only the owned integration checkout is writable. */
	async stage(value: unknown, root: string, outerSignal?: AbortSignal): Promise<RunResponse> {
		const action = parseStageRequest(value);
		root = realpathSync.native(root);
		return await this.withProductiveRun(root, async (lifecycle) => {
			const handle = await this.store.withLock(root, async () => await this.store.load(root, action.id), { productiveRunLease: lifecycle.lease });
			const state = handle.state;
			if (terminal(state) || state.status !== "needs_attention" || (state.integration.refresh && state.integration.refresh.status !== "ready")) {
				throw new Error("Request is not waiting for Main staging or refresh allocation remains uncertain.");
			}
			const candidate = state.integration.candidates.find((item) => item.taskId === action.taskId && item.attempt === action.attempt
				&& sameIdentity(item.tip, action.candidate));
			const task = changesetTaskState(state, action.taskId);
			const attempt = task.attempts[action.attempt - 1];
			const worker = attempt?.allocations.find((item): item is WorktreeAllocationIntent => item.kind === "worktree" && item.status === "owned")?.worktree;
			if (action.action === "reject" && candidate?.decision === "rejected" && task.status === "needs_attention"
				&& (attempt?.termination?.status === "unknown" || attempt?.termination?.status === "terminating")
				&& candidate.worker === "retained") {
				const generation = state.integration.generations.at(-1);
				if (action.generation !== (generation?.status === "superseded" ? generation.number + 1 : generation?.number ?? 1)) {
					throw new Error("Rejection recovery has a stale generation.");
				}
				const expected = generation && generation.status !== "superseded"
					? generation.combinedTip ?? generation.stages.at(-1)?.tip ?? generation.integrationBase : state.main;
				if (!sameIdentity(action.expectedTip, expected)) throw new Error("Rejection recovery has a stale integration tip.");
				const scope = new ProductiveScope(Math.min(state.policy.childMaxMs, this.currentPolicy().childMaxMs),
					() => this.coordinatorRuntime.now(), outerSignal);
				const termination = attempt.termination;
				const result = await scope.call((context) => this.hostRuntime.reconcileWorkerTermination({
					task: changesetTaskRequest(state, task.taskId), attempt, workerId: termination.workerId,
					candidate: termination.candidate,
				}, context));
				if (result.outcome === "terminated") {
					attempt.termination = { status: "terminated", workerId: termination.workerId,
						candidate: termination.candidate, at: this.coordinatorRuntime.now() };
					task.status = "rejected";
					delete task.failure;
				} else task.failure = bounded(`Exact worker ${termination.workerId} termination remains unproved; inspect the retained agent and retry rejection recovery.`);
				await this.saveProductive(handle);
				return this.response(state);
			}
			if (!candidate || candidate.worker !== "retained" || candidate.decision || task.status !== "ready_to_integrate" || !worker
				|| !sameIdentity(attempt!.readiness!.candidate, action.candidate)) {
				throw new Error("Stage action refers to a stale or unowned candidate.");
			}
			const scope = new ProductiveScope(Math.min(state.policy.childMaxMs, this.currentPolicy().childMaxMs),
				() => this.coordinatorRuntime.now(), outerSignal);
			const generations = state.integration.generations;
			let generation = generations.at(-1);
			const nextNumber = generation?.status === "superseded" ? generation.number + 1 : generation?.number ?? 1;
			if (action.generation !== nextNumber || (generation && !["staging", "conflict", "validation_failed", "ready", "superseded"].includes(generation.status))) {
				throw new Error("Stage action has a stale generation.");
			}
			if (action.action === "revise" || action.action === "reject") {
				if (action.action === "revise" && (!action.instruction?.trim() || action.instruction !== action.instruction.trim() || action.instruction.includes("\0"))) {
					throw new Error("Revision requires an exact nonempty instruction.");
				}
				if (action.action === "reject" && action.instruction !== undefined) throw new Error("Rejection cannot prompt a worker.");
				const tip = generation && generation.status !== "superseded"
					? generation.combinedTip ?? generation.stages.at(-1)?.tip ?? generation.stages.at(-1)?.onto ?? generation.integrationBase
					: state.main;
				if (!sameIdentity(action.expectedTip, tip)) throw new Error("Arbitration has a stale combined tip.");
				const affected = affectedDependents(state, action.taskId);
				if (affected.some((dependent) => dependent.attempts.length >= 2)) {
					throw new Error("A dependent has exhausted its bounded fresh attempts; arbitration cannot invalidate it safely.");
				}
				if (generation && generation.status !== "superseded" && generation.stages.some((stage) => stage.taskId === action.taskId)
					&& generations.filter((item) => item.worktree).length >= MAX_RETAINED_INTEGRATION_GENERATIONS) {
					throw new Error("Retained integration worktree limit is exhausted; reconcile the owned checkouts before another rebuild.");
				}
				if (affected.some((dependent) => dependent.kind === "changeset" && (
					dependent.attempts.at(-1)!.prompts.some((prompt) => prompt.status === "submitting" || prompt.status === "ambiguous")
					|| dependent.attempts.at(-1)!.allocations.some((allocation) => allocation.status === "allocating" || allocation.status === "unknown")
					|| dependent.attempts.at(-1)!.termination))) {
					throw new Error("A dependent has uncertain or released worker resources; reconcile before arbitration.");
				}
				if (generation && generation.status !== "superseded" && generation.stages.some((stage) => stage.status === "pending" || stage.status === "staging")) {
					throw new Error("Uncertain stage must be reconciled before superseding its generation.");
				}
				if (generation?.status === "superseded" && affected.length) {
					throw new Error("Dependent attempts belong to a superseded generation; choose a fresh staged candidate.");
				}
				if (generation && generation.status !== "superseded" && affected.some((dependent) =>
					dependent.kind === "changeset" && !dependent.attempts.every((item) =>
						item.waveBase.head === state.main.head || generation!.stages.some((stage) => stage.status === "staged"
							&& stage.tip && sameIdentity(stage.tip, item.waveBase))))) {
					throw new Error("A dependent lacks a proven staged source snapshot.");
				}
				if (action.action === "revise") {
					if (!this.correctionAllowed(state, changesetTaskRequest(state, task.taskId), attempt!, true)) {
						throw new Error("Same-worker revision is unavailable; a fresh attempt in this request is not supported.");
					}
					await scope.call((context) => this.integrationGit.inspectWorker(root, worker as WorktreeInfo, candidate.tip, context.signal));
				}
				const main = await scope.call((context) => this.gitRuntime.inspectMain({ root }, context));
				if (!sameIdentity(main, state.main)) throw new Error("Main drifted before arbitration.");
				if (generation && generation.status !== "superseded" && generation.stages.some((stage) => stage.taskId === action.taskId)) {
					if (generation.stages.some((stage) => stage.status === "staging" || stage.status === "pending")) {
						throw new Error("Uncertain stage must be reconciled before superseding its generation.");
					}
					if (!["staging", "conflict", "validation_failed", "ready"].includes(generation.status)) throw new Error("Cannot supersede an unresolved promotion or validation.");
					generation.supersededFrom = generation.status as "staging" | "conflict" | "validation_failed" | "ready";
					generation.status = "superseded";
					generation.failure = `Main ${action.action === "reject" ? "rejected" : "revised"} ${action.taskId}; retained generation is read-only.`;
					delete generation.combinedTip;
					delete generation.checks;
					delete generation.review;
					delete generation.correction;
				}
				candidate.decision = "rejected";
				for (const dependent of affected) {
					if (dependent.kind === "text") {
						const last = dependent.attempts.at(-1)!;
						last.status = "superseded";
						delete last.output;
						delete last.failure;
					} else {
						dependent.attempts.at(-1)!.superseded = true;
						for (const old of state.integration.candidates.filter((item) => item.taskId === dependent.taskId && !item.decision)) {
							old.decision = "rejected";
						}
					}
					dependent.status = "pending";
					delete dependent.failure;
				}
				task.status = "needs_attention";
				task.failure = action.action === "revise" ? action.instruction : "Main rejected this candidate; owned resources remain recorded.";
				await this.saveProductive(handle); // Freeze before touching the exact worker.
				if (action.action === "reject" && allocationByKind(attempt!, "agent")) {
					if (await this.terminateWithSafety(handle, task, attempt!, action.candidate, scope.signal)) task.status = "rejected";
					await this.saveProductive(handle);
				}
				if (action.action === "revise") {
					task.status = "working";
					await this.driveWorkerSafely(handle, task, scope, "correction", undefined, true);
					if (changesetTaskState(state, task.taskId).status === "ready_to_integrate") this.retainCandidate(state, task);
					state.status = "needs_attention";
					await this.saveProductive(handle);
				}
				return this.response(state);
			}
			if (action.instruction !== undefined) throw new Error("Stage/resolve cannot prompt a worker.");
			if (generation?.status === "superseded") generation = undefined;
			if (generation && generation.status !== "staging" && generation.status !== "conflict") throw new Error("Stage action has a stale generation.");
			const previousStage = generation?.stages.at(-1);
			const expected = previousStage?.status === "staged"
				? previousStage.tip! : previousStage?.onto ?? generation?.integrationBase;
			if (action.action === "stage" && generation?.stages.some((stage) => stage.status !== "staged")) {
				throw new Error("A previous stage is unresolved; inspect and resolve it first.");
			}
			if (action.action === "resolve") {
				const pending = generation?.stages.at(-1);
				if (!pending || !["staging", "conflict"].includes(pending.status)
					|| pending.taskId !== action.taskId || pending.attempt !== action.attempt
					|| !sameIdentity(pending.source, action.candidate)
					|| !sameIdentity(pending.onto, action.expectedTip)) throw new Error("Resolve action has no exact pending stage intent.");
			} else if (!sameIdentity(action.expectedTip, expected ?? state.main)
				|| generation?.stages.some((stage) => stage.taskId === action.taskId)) {
				throw new Error("Stage action has a stale combined tip or repeated candidate.");
			}
			if (!isCleanCommitted(action.expectedTip) || action.expectedTip.head !== (expected?.head ?? state.main.head)) {
				throw new Error("Stage action has an invalid integration tip.");
			}
			if (action.action === "stage" && !stagedDependencySnapshot(state, action.taskId, action.expectedTip)) {
				throw new Error("Candidate dependencies are not staged on this exact snapshot.");
			}
			if (action.action === "stage" && !sameIdentity(attempt!.waveBase, state.main)
				&& !(state.integration.refresh?.status === "ready"
					&& (sameIdentity(attempt!.waveBase, state.requestStartMain)
						|| generations.some((item) => sameIdentity(item.expectedMain, attempt!.waveBase)))
					&& !generations.some((item) => item.stages.some((stage) => stage.tip && sameIdentity(stage.tip, attempt!.waveBase))))
				&& !generation?.stages.some((stage) => stage.status === "staged" && stage.tip && sameIdentity(stage.tip, attempt!.waveBase))) {
				throw new Error("Dependent candidate was launched from a superseded or unstaged snapshot.");
			}
			const actualMain = await scope.call((context) => this.gitRuntime.inspectMain({ root }, context));
			if (!sameIdentity(actualMain, state.main)) throw new Error("Main changed or became dirty; staging is blocked.");
			if (!generation) {
				if (action.action !== "stage") throw new Error("No integration generation exists to resolve.");
				if (generations.filter((item) => item.worktree).length >= MAX_RETAINED_INTEGRATION_GENERATIONS) {
					throw new Error("Retained integration worktree limit is exhausted; no new generation may be allocated.");
				}
				const result = await scope.call((context) => this.integrationGit.allocate(root,
					`${action.id}-integration-${action.generation}`, state.main, async (worktree) => {
						const integrationBase = { ...state.main, branch: `refs/heads/${worktree.branch}` };
						generation = {
							number: action.generation, status: "staging", expectedMain: state.main,
							integrationBase,
							order: [action.taskId], stages: [{ taskId: action.taskId, attempt: action.attempt,
								source: action.candidate, onto: integrationBase, status: "pending" }],
							worktree,
						};
						generations.push(generation);
						await this.saveProductive(handle); // Before worktree add.
					}, context.signal));
				if (result.outcome !== "ready") {
					if (!generations.at(-1)) throw new Error("Integration allocation did not persist an owned worktree plan.");
					return this.response(state);
				}
			}
			generation = generations.at(-1);
			if (!generation?.worktree) throw new Error("Integration worktree allocation has no durable ownership record.");
			const worktree = generation.worktree;
			const previousStages = generation.stages.filter((stage) => stage.status === "staged");
			const receipts: StageReceipt[] = previousStages.map((stage) => ({ previous: stage.onto, worker: stage.source, tip: stage.tip! }));
			let stage = generation.stages.at(-1);
			if (action.action === "stage") {
				if (!stage || stage.status === "staged") {
					stage = { taskId: action.taskId, attempt: action.attempt, source: action.candidate,
						onto: action.expectedTip, status: "staging" };
					delete generation.combinedTip;
					generation.order.push(action.taskId);
					generation.stages.push(stage);
				} else {
					stage!.status = "staging";
				}
				await this.saveProductive(handle); // Exact candidate and previous tip before merge.
			}
			const outcome = await scope.call((context) => action.action === "stage"
				? this.integrationGit.stage(root, worktree, state.main, receipts, worker as WorktreeInfo, candidate.tip, context.signal)
				: this.integrationGit.reconcileStage(root, worktree, state.main, receipts, worker as WorktreeInfo, candidate.tip, context.signal));
			if (outcome.outcome === "ready" && outcome.value !== "not_started") {
				stage!.status = "staged";
				stage!.tip = outcome.value.tip;
				delete stage!.failure;
				generation.combinedTip = outcome.value.tip;
				generation.status = "staging";
				delete generation.failure;
			} else if (outcome.outcome === "conflict") {
				stage!.status = "conflict";
				stage!.failure = bounded(outcome.failure);
				generation.status = "conflict";
				generation.failure = stage!.failure;
			} else {
				stage!.failure = bounded(outcome.outcome === "ready"
					? "Merge has not started; intent retained. No automatic retry."
					: outcome.failure);
			}
			// Unproved outcomes keep the intent; never replay a merge automatically.
			await this.saveProductive(handle);
			return this.response(state);
		});
	}

	private stageReceipts(generation: IntegrationGeneration): StageReceipt[] {
		return generation.stages.map((stage) => ({ previous: stage.onto, worker: stage.source, tip: stage.tip! }));
	}

	/** Only Main can validate/promote the exact selected, clean combined tip. */
	async integrate(value: unknown, root: string, outerSignal?: AbortSignal): Promise<RunResponse> {
		const action = parseIntegrationAction(value);
		root = realpathSync.native(root);
		return await this.withProductiveRun(root, async (lifecycle) => {
			const handle = await this.store.withLock(root, async () => await this.store.load(root, action.id), { productiveRunLease: lifecycle.lease });
			const state = handle.state;
			const request = parseExecuteRequest(state.request);
			const generation = state.integration.generations.at(-1);
			if (action.action === "refresh") {
				if (terminal(state) || state.status !== "needs_attention" || state.integration.refresh?.status === "pending"
					|| state.integration.refresh?.status === "unknown" || !sameIdentity(state.main, action.expectedMain)
					|| action.generation !== state.integration.generations.length + 1
					|| (generation && (generation.status === "superseded" ? !sameIdentity(action.expectedTip, state.main)
						: !sameIdentity(action.expectedTip, generation.combinedTip
							?? generation.stages.at(-1)?.onto ?? generation.integrationBase)
							|| (!["staging", "conflict", "validation_failed", "ready"].includes(generation.status)
								&& !(generation.status === "promotion_failed" && generation.promotion?.outcome === "drift"))
							|| generation.stages.some((stage) => stage.status === "pending" || stage.status === "staging")))
					|| (!generation && !sameIdentity(action.expectedTip, state.main))) {
					throw new Error("Refresh has a stale Main, generation, or unresolved integration intent.");
				}
				if (!state.integration.candidates.some((candidate) => !candidate.decision && candidate.worker === "retained")) {
					throw new Error("Refresh requires at least one retained immutable candidate.");
				}
				if (state.integration.generations.filter((item) => item.worktree).length >= MAX_RETAINED_INTEGRATION_GENERATIONS) {
					throw new Error("Retained integration worktree limit is exhausted.");
				}
				const scope = new ProductiveScope(Math.min(state.policy.childMaxMs, this.currentPolicy().childMaxMs),
					() => this.coordinatorRuntime.now(), outerSignal);
				const actualMain = await scope.call((context) => this.gitRuntime.inspectMain({ root }, context));
				if (!isCleanCommitted(action.newMain) || !sameIdentity(actualMain, action.newMain)) {
					throw new Error("Refresh requires the exact new clean Main identity.");
				}
				await scope.call((context) => this.integrationGit.inspectMainAdvance(root, action.expectedMain, action.newMain, context.signal));
				// Old dependent snapshots cannot be replayed on a new Main tip. Retain their resources and
				// invalidate their readiness before admitting any new stages or dependent launches.
				const stale = new Set<TaskState>();
				for (const stage of generation?.stages ?? []) {
					for (const dependent of affectedDependents(state, stage.taskId)) {
						if (dependent.attempts.length && dependent.status !== "pending") stale.add(dependent);
					}
				}
				if ([...stale].some((task) => task.attempts.length >= 2 || task.status === "working"
					|| task.kind === "changeset" && (task.attempts.at(-1)!.termination
						|| task.attempts.at(-1)!.prompts.some((item) => item.status === "submitting" || item.status === "ambiguous")
						|| task.attempts.at(-1)!.allocations.some((item) => item.status === "allocating" || item.status === "unknown")))) {
					throw new Error("A dependent has unproved resources or exhausted fresh attempts; refresh is blocked.");
				}
				if (generation && generation.status !== "superseded") {
					if (generation.status === "promotion_failed") {
						generation.supersededPromotion = generation.promotion;
						delete generation.promotion;
					}
					generation.supersededFrom = generation.status as "staging" | "conflict" | "validation_failed" | "ready" | "promotion_failed";
					generation.status = "superseded";
					generation.failure = "Main advanced; retained generation is read-only. Restage immutable candidates in a new generation.";
					delete generation.combinedTip;
					delete generation.checks;
					delete generation.review;
					if (!generation.supersededPromotion) delete generation.correction;
				}
				for (const task of stale) {
					if (task.kind === "text") {
						const last = task.attempts.at(-1)!;
						last.status = "superseded";
						delete last.output;
						delete last.failure;
					} else {
						task.attempts.at(-1)!.superseded = true;
						for (const candidate of state.integration.candidates.filter((item) => item.taskId === task.taskId && !item.decision)) candidate.decision = "rejected";
					}
					task.status = "pending";
					delete task.failure;
				}
				state.main = action.newMain;
				state.integration.refresh = { from: action.expectedMain, to: action.newMain, generation: action.generation, status: "pending" };
				await this.saveProductive(handle); // Durable supersession and refresh intent before worktree creation.
				let result: Awaited<ReturnType<IntegrationGit["allocate"]>>;
				try {
					result = await scope.call((context) => this.integrationGit.allocate(root,
						`${action.id}-integration-${action.generation}`, action.newMain, async (worktree) => {
							state.integration.generations.push({ number: action.generation, status: "staging", expectedMain: action.newMain,
								integrationBase: { ...action.newMain, branch: `refs/heads/${worktree.branch}` },
								order: [], stages: [], worktree });
							state.integration.refresh = { from: action.expectedMain, to: action.newMain, generation: action.generation,
								status: "unknown", failure: "Integration allocation has not been proved; retain the recorded checkout." };
							await this.saveProductive(handle);
						}, context.signal));
				} catch (error) {
					// A prepared checkout remains recorded; no repeated allocation from this intent.
					state.integration.refresh!.failure = bounded(`Integration allocation uncertain: ${errorText(error)}`);
					await this.saveProductive(handle);
					return this.response(state);
				}
				if (result.outcome === "ready" && state.integration.generations.at(-1)?.number === action.generation) {
					state.integration.refresh = { from: action.expectedMain, to: action.newMain, generation: action.generation, status: "ready" };
				} else {
					state.integration.refresh!.failure = bounded(result.outcome === "ready" ? "Allocation lacks a recorded checkout." : result.failure);
				}
				await this.saveProductive(handle);
				return this.response(state);
			}
			if (!generation || generation.number !== action.generation || !generation.worktree
				|| !generation.combinedTip || !sameIdentity(generation.combinedTip, action.expectedTip)
				|| (terminal(state) && !(state.status === "completed" && action.action === "cleanup"))
				|| (state.status !== "needs_attention" && !(state.status === "completed" && action.action === "cleanup"))) throw new Error("Integration action has a stale generation or combined tip.");
			const scope = new ProductiveScope(Math.min(state.policy.childMaxMs, this.currentPolicy().childMaxMs),
				() => this.coordinatorRuntime.now(), outerSignal);
			const receipts = this.stageReceipts(generation);
			if (action.action === "advance") {
				if (generation.status !== "staging" || generation.stages.some((stage) => stage.status !== "staged")
					|| generation.correction || !isCleanCommitted(action.expectedTip)) {
					throw new Error("Advance requires an exact clean staged snapshot before validation or correction.");
				}
				const ready = readyPendingTasks(state).filter((task) => hasChangesetDependency(state, task.taskId)
					&& stagedDependencySnapshot(state, task.taskId, action.expectedTip));
				if (!ready.length) throw new Error("No dependent task is ready on this staged snapshot.");
				await this.requireExactIntegration(handle, generation, receipts, scope);
				return await this.run(handle, scope, undefined, action.expectedTip);
			}
			if (action.action === "cleanup") {
				if (generation.status !== "promoted") throw new Error("Cleanup requires proven exact promotion.");
				await this.cleanupPromoted(handle, generation, receipts, scope);
				return this.response(state);
			}
			if (action.action === "reconcile") {
				if (generation.status === "validating") {
					delete generation.checks;
					delete generation.review;
					generation.status = "validation_failed";
					generation.failure = "Interrupted validation has no definitive exact full-suite result; Main must rebuild and recheck.";
					await this.saveProductive(handle);
					return this.response(state);
				}
				if (!generation.promotion || !["promoting", "unknown"].includes(generation.promotion.status)) {
					throw new Error("No interrupted promotion intent to reconcile.");
				}
				const result = await scope.call((context) => this.integrationGit.reconcilePromotion(root, generation.worktree!,
					generation.expectedMain, receipts, context.signal, generation.correction));
				if (result.outcome === "ready") {
					generation.promotion.status = "promoted";
					generation.promotion.mainAfter = result.value;
					delete generation.promotion.failure;
					generation.status = "promoted";
					state.main = result.value;
				} else {
					generation.promotion.status = "unknown";
					generation.promotion.failure = bounded(result.failure);
					generation.status = "promotion_unknown";
				}
				await this.saveProductive(handle);
				if (result.outcome === "ready") await this.cleanupPromoted(handle, generation, receipts, scope);
				return this.response(state);
			}
			if (action.action === "correct") {
				if (generation.status !== "validation_failed" || generation.correction || !generation.checks
					|| (generation.checks.passed && generation.review?.passed !== false)) {
					throw new Error("Correction requires a definitive failed combined check or review and no prior correction.");
				}
				const from = generation.combinedTip;
				const to = await scope.call((context) => this.gitRuntime.inspectMain({ root: generation.worktree!.path }, context));
				await scope.call((context) => this.integrationGit.inspectCorrection(root, generation.worktree!,
					generation.expectedMain, receipts, from, to, context.signal));
				generation.correction = { from, to };
				generation.combinedTip = to;
				delete generation.checks;
				delete generation.review;
				delete generation.failure;
				generation.status = "staging";
				await this.saveProductive(handle);
				return this.response(state);
			}
			if (action.action === "validate") {
				if (generation.status !== "staging" || !receipts.length
					|| generation.stages.some((stage) => stage.status !== "staged")) throw new Error("Validation requires fully committed explicit stages and no prior validation attempt.");
				generation.status = "validating";
				await this.saveProductive(handle); // Record the exact validation intent before running checks.
				try {
					if (!request.finalChecks.some((check) => check.command === FULL_SUITE.command
						&& check.args.length === 1 && check.args[0] === FULL_SUITE.args[0])) throw new Error("Canonical full-suite command was not recorded at admission.");
					if (requireRootSuite(generation.worktree.path) !== requireRootSuite(root)) {
						throw new Error("Combined tip changed the admitted canonical root test script.");
					}
					await this.requireExactIntegration(handle, generation, receipts, scope);
					const checks = await this.runCheckBatch(handle, request.finalChecks, action.expectedTip,
						"final", scope, undefined, generation.worktree.path);
					generation.checks = checks;
					await this.saveProductive(handle);
					if (!checkBatchPasses(checks, request.finalChecks, action.expectedTip)) throw new Error("Combined full-suite check failed or changed the integration tip.");
					await this.requireExactIntegration(handle, generation, receipts, scope);
					if (request.finalJudgment) {
						const judgment = request.finalJudgment;
						generation.review = await this.runReview(handle, judgment.criterion, generation.expectedMain,
							action.expectedTip, judgment.role, judgment.modelClass, "final", scope, undefined, generation.worktree.path);
						await this.saveProductive(handle);
						if (!reviewEvidencePasses(generation.review, "final", judgment.criterion, generation.expectedMain, action.expectedTip)) {
							throw new Error("Combined judgment failed or changed the integration tip.");
						}
					}
					await this.requireExactIntegration(handle, generation, receipts, scope);
					if (!integrationGenerationPasses(generation, request)) throw new Error("Combined validation is incomplete.");
					generation.status = "ready";
				} catch (error) {
					if (integrationGenerationPasses(generation, request)) {
						delete generation.checks;
						delete generation.review; // Drift invalidates otherwise passing evidence.
					}
					generation.status = "validation_failed";
					generation.failure = bounded(`Combined validation requires Main attention: ${errorText(error)}`);
				}
				await this.saveProductive(handle);
				return this.response(state);
			}
			if (generation.status !== "ready" || !integrationGenerationPasses(generation, request)) {
				throw new Error("Promotion requires exact successful combined validation.");
			}
			for (const definition of request.tasks.filter((task) => hasChangesetDependency(state, task.id))) {
				const dependent = taskState(state, definition.id);
				const launch = [...state.waves].reverse().find((wave) => wave.taskIds.includes(definition.id));
				const stageIndex = generation.stages.findIndex((stage) => stage.taskId === definition.id);
				const attempt = dependent.kind === "changeset" ? dependent.attempts.at(-1) : undefined;
				if (!launch || !dependent.attempts.length || (definition.kind === "text" && dependent.status !== "completed")
					|| (definition.kind === "changeset" && (stageIndex < 0 || !attempt
						|| generation.stages[stageIndex]!.status !== "staged" || generation.stages[stageIndex]!.attempt !== dependent.attempts.length
						|| attempt.waveNumber !== launch.number || !sameIdentity(attempt.waveBase, launch.base)))) {
					throw new Error(`Dependent ${definition.id} lacks a fresh stage from the selected integration snapshot.`);
				}
				if (!(stageIndex < 0 ? generation.stages : generation.stages.slice(0, stageIndex)).some((stage) =>
					stage.status === "staged" && sameIdentity(stage.tip!, launch.base))) {
					throw new Error(`Dependent ${definition.id} ran on a superseded snapshot.`);
				}
			}
			await this.requireExactIntegration(handle, generation, receipts, scope);
			generation.promotion = { status: "promoting", expectedMain: generation.expectedMain, tip: action.expectedTip };
			generation.status = "promoting";
			await this.saveProductive(handle); // Intent before any Main mutation.
			let outcome: Awaited<ReturnType<IntegrationGit["promote"]>>;
			try {
				outcome = await scope.call((context) => this.integrationGit.promote({
					root, integration: generation.worktree!, base: generation.expectedMain, stages: receipts,
					checks: generation.checks!, commands: request.finalChecks,
					review: generation.review, criterion: request.finalJudgment?.criterion, correction: generation.correction,
				}, context.signal));
			} catch (error) { outcome = { outcome: "unknown", failure: `Interrupted promotion: ${errorText(error)}` }; }
			if (outcome.outcome === "ready") {
				generation.promotion.status = "promoted";
				generation.promotion.mainAfter = outcome.value;
				generation.status = "promoted";
				state.main = outcome.value;
			} else {
				generation.promotion.status = outcome.outcome === "unknown" ? "unknown" : "failed";
				generation.promotion.failure = bounded(outcome.failure);
				if (outcome.outcome === "drift") generation.promotion.outcome = "drift";
				generation.status = outcome.outcome === "unknown" ? "promotion_unknown" : "promotion_failed";
			}
			await this.saveProductive(handle);
			if (outcome.outcome === "ready") await this.cleanupPromoted(handle, generation, receipts, scope);
			return this.response(state);
		});
	}

	private async cleanupPromoted(handle: RunStateHandle, generation: IntegrationGeneration,
		receipts: StageReceipt[], scope: RuntimeScope): Promise<void> {
		const state = handle.state;
		const promoted = generation.promotion?.mainAfter;
		if (generation.status !== "promoted" || !promoted || !generation.worktree) throw new Error("Cleanup requires exact proven promotion.");
		// Promotion proves selection independently of worker or checkout cleanup.
		for (const stage of generation.stages) changesetTaskState(state, stage.taskId).status = "completed";
		await this.saveProductive(handle);
		try {
			const main = await this.callProductive(handle, scope, (context) => this.gitRuntime.inspectMain({ root: state.root }, context));
			if (!sameIdentity(main, promoted)) throw new Error("Main changed or became dirty after promotion; cleanup is blocked.");
			for (const stage of generation.stages) {
				const task = changesetTaskState(state, stage.taskId);
				const attempt = task.attempts[stage.attempt - 1]!;
				const candidate = state.integration.candidates.find((item) => item.taskId === stage.taskId && item.attempt === stage.attempt
					&& sameIdentity(item.tip, stage.source))!;
				const worker = allocationByKind(attempt, "worktree")?.worktree;
				if (!worker) throw new Error("Promoted worker lacks a proven checkout.");
				candidate.worker = "release_pending";
				await this.saveProductive(handle);
				if (attempt.termination?.status !== "terminated") {
					if (attempt.termination) {
						const result = await this.callProductive(handle, scope, (context) => this.hostRuntime.reconcileWorkerTermination({
							task: changesetTaskRequest(state, task.taskId), attempt,
							workerId: attempt.termination!.workerId, candidate: stage.source,
						}, context));
						if (result.outcome !== "terminated") throw new Error("Worker termination cannot be proved; never replay termination.");
						attempt.termination = { status: "terminated", workerId: attempt.termination.workerId,
							candidate: stage.source, at: this.coordinatorRuntime.now() };
						await this.saveProductive(handle);
					} else if (!await this.terminateWithSafety(handle, task, attempt, stage.source, scope.signal)) {
						throw new Error("Worker termination was not proved.");
					}
				}
				for (const kind of CLEANUP_KINDS) {
					const step = attempt.cleanup.find((item) => item.kind === kind)!;
					if (step.status === "completed") continue;
					step.status = "running";
					await this.saveProductive(handle);
					if (kind === "worker_tab" || kind === "workspace") {
						const result = await this.callProductive(handle, scope, (context) => this.hostRuntime.cleanupHost({
							requestId: state.request.id, kind, task: changesetTaskRequest(state, task.taskId), attempt,
						}, context));
						if (result.outcome === "blocked") throw new Error(result.failure);
					} else {
						const result = await this.callProductive(handle, scope, (context) => this.integrationGit.cleanup(state.root,
							generation.worktree!, worker as WorktreeInfo, generation.expectedMain, receipts,
							promoted, kind, context.signal, generation.correction));
						if (result.outcome !== "ready") throw new Error(result.failure);
					}
					step.status = "completed";
					delete step.failure;
					await this.saveProductive(handle);
				}
				candidate.worker = "released";
				// Same-attempt revisions share this exact worker checkout; release historical
				// rejected tips only after the physical checkout has been proved removed.
				for (const old of state.integration.candidates.filter((item) => item.decision === "rejected"
					&& item.taskId === stage.taskId && item.attempt === stage.attempt)) old.worker = "released";
				await this.saveProductive(handle);
			}
			generation.cleanup ??= [{ kind: "worktree", status: "pending" }, { kind: "branch", status: "pending" }];
			await this.saveProductive(handle);
			for (const kind of ["worktree", "branch"] as const) {
				const step = generation.cleanup.find((item) => item.kind === kind)!;
				if (step.status === "completed") continue;
				step.status = "running";
				await this.saveProductive(handle);
				const result = await this.callProductive(handle, scope, (context) => this.integrationGit.cleanup(state.root,
					generation.worktree!, generation.worktree!, generation.expectedMain, receipts,
					promoted, kind, context.signal, generation.correction));
				if (result.outcome !== "ready") throw new Error(result.failure);
				step.status = "completed";
				delete step.failure;
				await this.saveProductive(handle);
			}
		} catch (error) {
			generation.failure = undefined; // Promotion remains proven; cleanup evidence stays inspectable.
			const pending = generation.cleanup?.find((step) => step.status === "running")
				?? generation.stages.flatMap((stage) => changesetTaskState(state, stage.taskId).attempts[stage.attempt - 1]!.cleanup)
					.find((step) => step.status === "running");
			if (pending) pending.failure = bounded(`Cleanup requires attention: ${errorText(error)}`);
			await this.saveProductive(handle);
		}
		if (state.tasks.every((task) => task.status === "completed" || task.status === "rejected")
			&& state.integration.candidates.every((candidate) => candidate.decision || generation.stages.some((stage) =>
				stage.taskId === candidate.taskId && stage.attempt === candidate.attempt && sameIdentity(stage.source, candidate.tip)))) {
			state.final = { status: "passed", identity: promoted, checks: generation.checks,
				...(generation.review ? { review: generation.review } : {}) };
			state.status = "completed";
			state.accepted = true;
			state.acceptedAt = this.coordinatorRuntime.now();
			await this.saveProductive(handle);
		}
	}

	private async requireExactIntegration(handle: RunStateHandle, generation: IntegrationGeneration,
		receipts: StageReceipt[], scope: RuntimeScope): Promise<void> {
		const root = handle.state.root;
		const worktree = generation.worktree!;
		const tip = generation.correction
			? await this.callProductive(handle, scope, async (context) => {
				await this.integrationGit.inspectCorrection(root, worktree, generation.expectedMain, receipts,
					generation.correction!.from, generation.correction!.to, context.signal);
				return generation.correction!.to;
			})
			: await this.callProductive(handle, scope, (context) => this.integrationGit.inspectCombined(root,
				worktree, generation.expectedMain, receipts, context.signal));
		if (!sameIdentity(tip, generation.combinedTip!) || !isCleanCommitted(tip)) throw new Error("Combined tip changed or became dirty.");
		for (const stage of generation.stages) {
			const task = changesetTaskState(handle.state, stage.taskId);
			const worker = task.attempts[stage.attempt - 1]?.allocations.find((item): item is WorktreeAllocationIntent =>
				item.kind === "worktree" && item.status === "owned")?.worktree;
			if (!worker) throw new Error("Selected worker has no owned worktree.");
			await this.callProductive(handle, scope, (context) => this.integrationGit.inspectWorker(root, worker as WorktreeInfo,
				stage.source, context.signal));
		}
		const main = await this.callProductive(handle, scope, (context) => this.gitRuntime.inspectMain({ root }, context));
		if (!sameIdentity(main, generation.expectedMain)) throw new Error("Main changed or became dirty before promotion.");
	}

	async abort(id: string, root: string, outerSignal?: AbortSignal): Promise<RunResponse> {
		root = realpathSync.native(root);
		return await this.store.withLock(root, async (lifecycle) => {
			const handle = await this.store.load(root, id);
			const state = handle.state;
			if (terminal(state)) return this.response(state);
			if (state.integration.candidates.length || state.integration.generations.length) {
				throw new Error("Retained candidates and integration worktrees cannot be aborted before explicit rejection/cleanup is implemented.");
			}
			const activeControls = this.activeControls(root, id);
			for (const { control } of activeControls) control.invalidate();
			if (!activeControls.length
				&& !lifecycle.productiveRunLeaseActive
				&& this.recoverInterrupted(state)) {
				await handle.save();
			}
			const safetyDeadline = this.coordinatorRuntime.now() + TERMINATION_SAFETY_BUDGET_MS;
			for (const task of state.tasks) {
				if (task.kind !== "changeset") continue;
				for (const attempt of task.attempts) {
					if (!allocationByKind(attempt, "agent")?.agentName || attempt.termination?.status === "terminated") continue;
					await this.terminateWithSafety(
						handle, task, attempt, this.terminationCandidate(attempt), outerSignal, safetyDeadline, true,
					);
				}
			}
			state.status = "aborted";
			delete state.recovery;
			state.accepted = false;
			state.updatedAt = this.coordinatorRuntime.now();
			await handle.save();
			return this.response(state);
		}, { purpose: "abort" });
	}

	async status(id: string, root: string, outerSignal?: AbortSignal): Promise<RunResponse> {
		root = realpathSync.native(root);
		return await this.store.withLock(root, async () => {
			const handle = await this.store.load(root, id);
			const deadline = this.coordinatorRuntime.now() + STATUS_INSPECTION_BUDGET_MS;
			const scope = new DeadlineScope(deadline, () => this.coordinatorRuntime.now(), outerSignal);
			try {
				let main: MainStatus;
				try {
					const actual = await scope.call(async (context) => await this.gitRuntime.inspectMain({ root: handle.state.root }, context));
					main = {
						status: sameIdentity(actual, handle.state.main) ? "current" : "drifted",
						expected: handle.state.main,
						actual,
					};
				} catch (error) {
					main = {
						status: "unavailable",
						expected: handle.state.main,
						failure: `Read-only Main inspection failed: ${errorText(error)}`,
					};
				}
				return this.response(handle.state, main);
			} finally {
				scope.close();
			}
		}, { purpose: "status" });
	}

	private async run(
		handle: RunStateHandle,
		scope: RuntimeScope,
		forceTextTaskId: string | undefined,
		stagedSnapshot?: WorkspaceIdentity,
	): Promise<RunResponse> {
		const state = handle.state;
		let saveOnExit = true;
		state.status = "running";
		state.updatedAt = this.coordinatorRuntime.now();
		try {
			while (state.tasks.some((task) => task.status !== "completed")) {
				const attention = forceTextTaskId ? undefined : state.tasks.find((task) => task.status === "needs_attention");
				if (attention) {
					state.status = "needs_attention";
					return this.response(state);
				}
				const ready = readyPendingTasks(state).filter((task) => (!forceTextTaskId || task.taskId === forceTextTaskId)
					&& (!stagedSnapshot || (hasChangesetDependency(state, task.taskId)
						&& stagedDependencySnapshot(state, task.taskId, stagedSnapshot))));
				if (!ready.length) {
					if (!stagedSnapshot && !state.integration.candidates.length) throw new Error("No dependency wave is ready.");
					state.status = "needs_attention";
					return this.response(state);
				}
				let actualMain: WorkspaceIdentity;
				try {
					actualMain = await this.callProductive(handle, scope, async (context) => await this.gitRuntime.inspectMain({ root: state.root }, context));
				} catch (error) {
					this.rethrowStopped(error);
					const failure = isDeadline(error, scope)
						? "The operation safety deadline expired before dependency-wave dispatch."
						: `Main inspection failed before dependency-wave dispatch: ${errorText(error)}`;
					for (const task of ready) this.attention(task, failure);
					state.status = "needs_attention";
					return this.response(state);
				}
				if (!sameIdentity(actualMain, state.main)) {
					for (const task of ready) this.attention(task, "Main drifted before dependency-wave dispatch.");
					state.status = "needs_attention";
					return this.response(state);
				}
				if (stagedSnapshot) {
					const generation = state.integration.generations.at(-1)!;
					await this.requireExactIntegration(handle, generation, this.stageReceipts(generation), scope);
				}
				const wave: WaveState = {
					number: state.waves.length + 1,
					base: stagedSnapshot ?? state.main,
					taskIds: ready.map((task) => task.taskId),
					status: "dispatching",
				};
				state.waves.push(wave);
				for (const task of ready) {
					if (task.kind === "text") {
						task.status = "running";
						task.attempts.push({ number: task.attempts.length + 1, status: "running" });
						continue;
					}
					task.status = "allocating";
					task.attempts.push({
						number: task.attempts.length + 1,
						waveNumber: wave.number,
						waveBase: wave.base,
						correlationToken: runtimeToken(this.coordinatorRuntime.randomToken()),
						allocationGeneration: 1,
						allocations: [],
						prompts: [],
						transitions: [],
						cleanup: CLEANUP_KINDS.map((kind) => ({ kind, status: "pending" })),
					});
				}
				await this.saveProductive(handle);
				const dispatched = await Promise.allSettled(ready.map(async (task) => {
					try {
						await this.dispatchTask(handle, task, scope);
					} catch (error) {
						this.rethrowStopped(error);
						const failure = isDeadline(error, scope)
							? "The operation safety deadline expired during task dispatch."
							: `Task dispatch was interrupted: ${errorText(error)}`;
						this.attention(task, bounded(failure));
					}
				}));
				const stopped = dispatched.find((result): result is PromiseRejectedResult =>
					result.status === "rejected" && result.reason instanceof DurableRunStopped);
				if (stopped) throw stopped.reason;
				const rejected = dispatched.find((result): result is PromiseRejectedResult => result.status === "rejected");
				if (rejected) throw rejected.reason;
				if (ready.some((task) => task.kind === "text"
					? task.status !== "completed"
					: task.status !== "ready_to_integrate")) {
					wave.status = "needs_attention";
					state.status = "needs_attention";
					return this.response(state);
				}
				if (ready.every((task) => task.kind === "text")) {
					wave.status = "completed";
					await this.saveProductive(handle);
					forceTextTaskId = undefined;
					continue;
				}
				for (const task of ready) if (task.kind === "changeset") this.retainCandidate(state, task);
				wave.status = "needs_attention";
				state.status = "needs_attention";
				await this.saveProductive(handle);
				return this.response(state);
			}
			return await this.runFinal(handle, scope);
		} catch (error) {
			if (error instanceof DurableRunStopped) {
				saveOnExit = false;
				return this.response(handle.state);
			}
			const activeTasks = state.tasks.filter((task) => !["pending", "completed", "needs_attention"].includes(task.status));
			if (activeTasks.length) {
				const failure = isDeadline(error, scope) ? "The operation safety deadline expired." : `Execution was interrupted: ${errorText(error)}`;
				for (const active of activeTasks) this.attention(active, failure);
			} else if (state.final.status === "running") {
				state.final.status = "interrupted";
				state.final.failure = bounded(isDeadline(error, scope) ? "The operation safety deadline expired." : `Final gate was interrupted: ${errorText(error)}`);
			}
			state.status = "needs_attention";
			state.accepted = false;
			return this.response(state);
		} finally {
			this.closeRequestControls(state.root, state.request.id);
			if (saveOnExit) {
				state.updatedAt = this.coordinatorRuntime.now();
				await this.saveProductive(handle);
			}
		}
	}

	private async dispatchTask(handle: RunStateHandle, task: TaskState, scope: RuntimeScope): Promise<void> {
		if (task.kind === "text") return await this.dispatchTextTask(handle, task, scope);
		const state = handle.state;
		const request = changesetTaskRequest(state, task.taskId);
		const attempt = latestAttempt(task);
		try {
			for (const kind of ALLOCATION_KINDS) {
				if (allocationByKind(attempt, kind)) continue;
				let intent: AllocationIntent;
				if (kind === "worktree") {
					intent = {
						kind,
						generation: attempt.allocationGeneration,
						token: attempt.correlationToken,
						status: "allocating",
					};
				} else {
					const plan = runtimeHostAllocationPlan(await this.callProductive(handle, scope, async (context) => await this.hostRuntime.planHostAllocation({
						requestId: state.request.id,
						goal: state.request.goal,
						kind,
						task: request,
						attempt,
					}, context)), kind);
					intent = {
						...plan,
						generation: attempt.allocationGeneration,
						token: attempt.correlationToken,
						status: "allocating",
					};
				}
				attempt.allocations.push(intent);
				await this.saveProductive(handle);
				let result: AllocationResult;
				try {
					if (intent.kind === "worktree") {
						result = await this.callProductive(handle, scope, async (context) => await this.gitRuntime.allocateWorktree({
							root: state.root,
							...(attempt.waveBase.head !== state.main.head ? { baseRoot: state.integration.generations.at(-1)?.worktree?.path } : {}),
							intent,
							task: request,
							attempt,
							onPrepared: async (worktree) => {
								const prepared = worktree as unknown as Record<string, unknown>;
								for (const field of ["path", "cwd", "branch", "repoRoot"] as const) {
									requireExactAllocationText(prepared[field], `Prepared worktree ${field}`);
								}
								if (typeof prepared.baseCommit !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(prepared.baseCommit)
									|| prepared.baseCommit !== attempt.waveBase.head || prepared.path !== prepared.cwd) {
									throw new Error("Prepared worktree does not match the exact recorded wave plan.");
								}
								const exact = prepared as Record<"path" | "cwd" | "branch" | "repoRoot" | "baseCommit", string>;
								intent.worktree = {
									path: exact.path,
									cwd: exact.cwd,
									branch: exact.branch,
									repoRoot: exact.repoRoot,
									baseCommit: exact.baseCommit,
								};
								await this.saveProductive(handle);
							},
						}, context));
					} else {
						const allocate = async (context: OperationContext) => await this.hostRuntime.allocateHost({
							requestId: state.request.id,
							intent,
							task: request,
							attempt,
							...(intent.kind === "agent" ? { acquireLaunch: async () => {
								buildChangesetTaskPrompt({
									goal: state.request.goal,
									contexts: resolveTextTaskContexts(state, request),
									task: request,
									kind: "initial",
									worktreeCwd: intent.worktreeCwd,
								});
								const launch = await this.coordinatorRuntime.acquireLaunch(request.role, request.modelClass, context);
								if (launch.launch.role !== request.role || launch.launch.modelClass !== request.modelClass) {
									await withTransientLaunch(launch, async () => {
										throw new Error("Task launch acquisition returned the wrong Role or model class.");
									});
								}
								return launch;
							} } : {}),
						}, context);
						result = intent.kind === "agent"
							? await this.withLifecycleLock(handle, async () => {
								const allocated = await scope.call(allocate);
								if (allocated.kind !== intent.kind) throw new Error("Agent allocation returned the wrong result kind.");
								if (allocated.outcome === "owned") {
									applyOwnedAllocationResult(intent, allocated);
									await handle.save();
								}
								return allocated;
							})
							: await this.callProductive(handle, scope, allocate);
					}
				} catch (error) {
					this.rethrowStopped(error);
					intent.status = "unknown";
					intent.failure = bounded(`Allocation result is unknown: ${errorText(error)}`);
					this.attention(task, intent.failure);
					await this.saveProductive(handle);
					return;
				}
				if (result.kind !== intent.kind) {
					throw new Error(`${intent.kind} allocation returned the wrong result kind.`);
				}
				if (result.outcome !== "owned") {
					const failure = boundedRuntimeText(result.failure, `${intent.kind} allocation failure`);
					const possibleResources = result.outcome === "unknown" ? boundedPossibleResources(result.possibleResources) : undefined;
					intent.status = result.outcome;
					intent.failure = failure;
					if (result.outcome === "unknown") intent.possibleResources = possibleResources;
					this.attention(task, intent.failure);
					await this.saveProductive(handle);
					return;
				}
				if (intent.kind !== "agent") {
					applyOwnedAllocationResult(intent, result);
					await this.saveProductive(handle);
				}
			}
			task.status = "working";
			await this.saveProductive(handle);
			await this.driveWorkerSafely(handle, task, scope, "initial");
		} catch (error) {
			this.rethrowStopped(error);
			this.attention(task, isDeadline(error, scope) ? "The operation safety deadline expired during allocation." : `Task allocation was interrupted: ${errorText(error)}`);
			await this.saveProductive(handle);
		}
	}

	private async dispatchTextTask(
		handle: RunStateHandle,
		task: TextTaskState,
		scope: RuntimeScope,
	): Promise<void> {
		const state = handle.state;
		const request = taskRequest(state, task.taskId);
		if (request.kind !== "text") throw new Error(`Task ${task.taskId} is not a text task.`);
		const attempt = task.attempts.at(-1);
		if (!attempt || attempt.status !== "running") throw new Error(`Text task ${task.taskId} has no running attempt.`);
		const prompt = buildTextTaskPrompt(state.request.goal, request, resolveTextTaskContexts(state, request));
		const result = await this.callProductive(handle, scope, async (context) => {
			const wave = state.waves.at(-1);
			if (!wave?.taskIds.includes(task.taskId)) throw new Error("Text task lacks a recorded launch wave.");
			const baseRoot = wave.base.head === state.main.head ? state.root : state.integration.generations.at(-1)?.worktree?.path;
			if (!baseRoot) throw new Error("Staged dependency checkout is unavailable.");
			if (!sameIdentity(await this.gitRuntime.inspectMain({ root: baseRoot }, context), wave.base)) {
				throw new Error("Staged dependency snapshot drifted before text launch.");
			}
			const isolated = await createChildWorktree(
				baseRoot,
				`${state.request.id}-${task.taskId}-text-${attempt.number}`,
				undefined,
				context.signal,
			);
			if (!isolated) throw new Error("Explicit isolated text work requires a Git checkout with a committed HEAD; it never falls back to Main.");
			let result;
			try {
				const launchHandle = await this.coordinatorRuntime.acquireLaunch(request.role, request.modelClass, context);
				if (launchHandle.launch.role !== request.role || launchHandle.launch.modelClass !== request.modelClass) {
					await withTransientLaunch(launchHandle, async () => {
						throw new Error("Text task launch acquisition returned the wrong Role or model class.");
					});
				}
				result = await withTransientLaunch(launchHandle, async (verifiedLaunch) => {
					const launch = { args: [...verifiedLaunch.args], env: { ...verifiedLaunch.env } };
					return await this.textExecutor.run({
						signal: context.signal,
						prepare: async () => ({ launch, task: prompt, cwd: isolated.cwd }),
					});
				});
			} finally {
				const cleanup = await finalizeChildWorktree(isolated);
				if (cleanup.outcome !== "pruned") {
					throw new Error(`Isolated text task changed its checkout; work was retained at ${cleanup.path} on ${cleanup.branch}.`);
				}
			}
			return result!;
		});
		if (result.outcome !== "success" || result.exitCode !== 0) {
			throw new Error("Text task executor did not complete successfully.");
		}
		if (result.outputTruncated !== false) throw new Error("Text task executor output was truncated.");
		const output = result.output.trim();
		if (!output) throw new Error("Text task executor returned empty output.");
		if (Buffer.byteLength(output, "utf8") > MAX_PERSISTED_RUNTIME_TEXT_BYTES) {
			throw new Error(`Text task executor output exceeds ${MAX_PERSISTED_RUNTIME_TEXT_BYTES} UTF-8 bytes.`);
		}
		const actualMain = await this.callProductive(handle, scope, async (context) => await this.gitRuntime.inspectMain({ root: state.root }, context));
		if (!sameIdentity(actualMain, state.main)) throw new Error("Main drifted during text task execution.");
		const wave = state.waves.at(-1)!;
		if (wave.base.head !== state.main.head) {
			const generation = state.integration.generations.at(-1);
			if (!generation?.worktree || generation.status === "superseded" || !sameIdentity(generation.combinedTip!, wave.base)) {
				throw new Error("Staged dependency snapshot was superseded during text task execution.");
			}
			await this.requireExactIntegration(handle, generation, this.stageReceipts(generation), scope);
		}
		attempt.status = "completed";
		attempt.failure = undefined;
		attempt.output = { text: output };
		task.status = "completed";
		task.failure = undefined;
		await this.saveProductive(handle);
	}

	private correctionAllowed(state: RunState, request: ChangesetTaskRequest, attempt: TaskAttempt, postSeal = false): boolean {
		const effectiveMaximum = Math.min(state.policy.maxCorrections, this.currentPolicy().maxCorrections);
		return state.correctionCount < effectiveMaximum && (correctionEligible(request, attempt) || Boolean(postSeal
			&& attempt.readiness && attempt.prompts.at(-1)?.status === "settled" && !attempt.termination
			&& attempt.prompts.length < MAX_WORKER_PROMPTS
			&& !attempt.prompts.some((prompt) => prompt.kind === "correction" || prompt.status === "ambiguous")
			&& attempt.candidate && sameIdentity(attempt.readiness.candidate, attempt.candidate)
			&& checkBatchPasses(attempt.preliminaryChecks, request.checks, attempt.candidate)));
	}

	private async driveWorkerSafely(
		handle: RunStateHandle,
		task: ChangesetTaskState,
		scope: RuntimeScope,
		initialKind: "initial" | "correction" | "followup",
		initialInstruction?: string,
		postSeal = false,
	): Promise<void> {
		const control = this.ensureFollowupControl(handle, task);
		try {
			await this.driveWorker(handle, task, scope, initialKind, control, initialInstruction, postSeal);
		} catch (error) {
			this.rethrowStopped(error);
			this.attention(task, isDeadline(error, scope)
				? "The child operation safety deadline expired during worker execution."
				: `Worker execution was interrupted: ${errorText(error)}`);
			await this.saveProductive(handle);
		} finally {
			this.closeFollowupControl(handle.state.root, handle.state.request.id, task.taskId, control);
		}
	}

	private async driveWorker(
		handle: RunStateHandle,
		task: ChangesetTaskState,
		scope: RuntimeScope,
		initialKind: "initial" | "correction" | "followup",
		control: FollowupControl,
		initialInstruction?: string,
		postSeal = false,
	): Promise<void> {
		const state = handle.state;
		const request = changesetTaskRequest(state, task.taskId);
		const attempt = latestAttempt(task);
		const workerId = allocationByKind(attempt, "agent")?.agentName;
		if (!workerId) throw new Error("Worker launch has no durably recorded agent ID.");
		let kind: "initial" | "correction" | "followup" = initialKind;
		let failure = task.failure;
		let instruction = initialInstruction;
		for (;;) {
			if (kind === "followup" && instruction === undefined) {
				throw new Error("Follow-up worker execution requires an exact queued instruction.");
			}
			if (kind === "correction" && !this.correctionAllowed(state, request, attempt, postSeal)) {
				this.attention(task, "The same-agent correction is unavailable or already used.");
				await this.saveProductive(handle);
				return;
			}
			if (kind !== "initial") {
				attempt.readiness = undefined;
				attempt.preliminaryChecks = undefined;
				attempt.preliminaryReview = undefined;
				attempt.integrationBase = undefined;
				attempt.integrationCandidate = undefined;
				attempt.authoritativeChecks = undefined;
				attempt.authoritativeReview = undefined;
				attempt.integration = undefined;
			}
			let preCandidate: WorkspaceIdentity;
			try {
				preCandidate = runtimeIdentity(await this.callProductive(handle, scope, async (context) => await this.gitRuntime.inspectTaskCandidate({
					root: state.root,
					task: request,
					attempt,
				}, context)), "Pre-prompt candidate identity");
			} catch (error) {
				this.rethrowStopped(error);
				this.attention(task, `Pre-prompt candidate identity is unavailable: ${errorText(error)}`);
				await this.saveProductive(handle);
				return;
			}
			const worktree = allocationByKind(attempt, "worktree");
			if (!worktree?.worktree
				|| preCandidate.branch !== `refs/heads/${worktree.worktree.branch}`
				|| !isCleanCommitted(preCandidate)
				|| (kind === "initial" && preCandidate.head !== attempt.waveBase.head)) {
				this.attention(task, "Pre-prompt task candidate inspection returned an invalid owned worktree identity.");
				await this.saveProductive(handle);
				return;
			}
			const retainedCandidate = kind === "initial"
				? undefined
				: attempt.candidate ?? attempt.prompts.at(-1)?.candidate ?? attempt.prompts.at(-1)?.preCandidate;
			if (retainedCandidate && !sameIdentity(preCandidate, retainedCandidate)) {
				this.attention(task, "The same-agent correction worktree identity drifted before prompting.");
				await this.saveProductive(handle);
				return;
			}
			if (attempt.prompts.length >= MAX_WORKER_PROMPTS) {
				this.attention(task, `A task may submit at most ${MAX_WORKER_PROMPTS} worker prompts.`);
				await this.saveProductive(handle);
				return;
			}
			const prompt: PromptRecord = {
				kind,
				status: "submitting",
				preCandidate,
				...(kind === "followup" ? { instruction } : {}),
				at: nextAttemptEventAt(attempt, this.coordinatorRuntime.now()),
			};
			attempt.prompts.push(prompt);
			if (kind === "correction") state.correctionCount += 1;
			task.failure = undefined;
			await this.saveProductive(handle);
			let worker: WorkerResult;
			try {
				worker = await this.callProductive(handle, scope, async (context) => await this.hostRuntime.runWorker({
					goal: state.request.goal,
					contexts: resolveTextTaskContexts(state, request),
					task: request,
					attempt,
					workerId,
					kind,
					preCandidate,
					...(failure ? { failure } : {}),
					...(instruction ? { instruction } : {}),
				}, context));
			} catch (error) {
				this.rethrowStopped(error);
				prompt.status = "ambiguous";
				prompt.failure = bounded(`Prompt result is ambiguous and will not be replayed: ${errorText(error)}`);
				this.attention(task, prompt.failure);
				await this.saveProductive(handle);
				return;
			}
			if (worker.outcome === "unknown" || worker.outcome === "interrupted") {
				prompt.status = "ambiguous";
				prompt.failure = boundedRuntimeDiagnostic(worker.diagnostic, `${worker.outcome} worker diagnostic`);
				this.attention(task, `${worker.outcome} worker result will not be replayed: ${prompt.failure}`);
				await this.saveProductive(handle);
				return;
			}
			if (worker.outcome === "not_prompted") {
				prompt.status = "not_sent";
				prompt.failure = boundedRuntimeDiagnostic(worker.diagnostic, "not-prompted worker diagnostic");
				this.attention(task, `Worker prompt was not submitted: ${prompt.failure}`);
				await this.saveProductive(handle);
				return;
			}
			prompt.status = "settled";
			if (worker.outcome === "blocked") {
				failure = boundedRuntimeDiagnostic(worker.diagnostic, "blocked worker diagnostic");
				prompt.failure = failure;
				await this.saveProductive(handle);
			} else {
				if (worker.outcome !== "candidate") throw new Error("Unexpected worker result.");
				worker.candidate = runtimeIdentity(worker.candidate, "Settled worker candidate identity");
				if (!isCleanCommitted(worker.candidate) || worker.candidate.head === preCandidate.head) {
					this.attention(task, "Settled worker did not produce a new clean committed candidate.");
					await this.saveProductive(handle);
					return;
				}
				prompt.candidate = worker.candidate;
				attempt.candidate = worker.candidate;
				attempt.candidateBase ??= attempt.waveBase;
				const checks = await this.runCheckBatch(handle, request.checks, worker.candidate, "preliminary", scope, task.taskId);
				attempt.preliminaryChecks = checks;
				await this.saveProductive(handle);
				if (!checks.passed) {
					failure = sameIdentity(checks.identityAfter, worker.candidate)
						? "A declared task check failed on the recorded candidate."
						: "A declared task check changed the recorded candidate.";
				} else {
					failure = undefined;
				}
				if (!failure) {
					const queuedFollowup = control.takeQueuedFollowupOrSeal();
					if (queuedFollowup) {
						kind = "followup";
						instruction = queuedFollowup.instruction;
						task.status = "working";
						continue;
					}
					const workerId = allocationByKind(attempt, "agent")?.agentName;
					if (!workerId || attempt.termination || !attempt.candidate || !attempt.candidateBase
						|| !checkBatchPasses(attempt.preliminaryChecks, request.checks, attempt.candidate)) {
						throw new Error("Readiness requires an exact live owned worker and passing candidate lineage.");
					}
					if (request.judgment) {
						attempt.preliminaryReview = await this.runReview(handle, request.judgment.criterion,
							attempt.candidateBase, attempt.candidate, request.judgment.role,
							request.judgment.modelClass, "preliminary", scope, task.taskId);
						await this.saveProductive(handle);
						if (!attempt.preliminaryReview.passed) {
							this.attention(task, "Preliminary Judgment did not return exact PASS on the worker candidate.");
							return;
						}
					}
					attempt.readiness = {
						candidate: attempt.candidate,
						base: attempt.candidateBase,
						at: nextAttemptEventAt(attempt, this.coordinatorRuntime.now()),
					};
					task.status = "ready_to_integrate";
					task.failure = undefined;
					await this.saveProductive(handle);
					return;
				}
			}

			if (this.correctionAllowed(state, request, attempt)) {
				kind = "correction";
				instruction = undefined;
				continue;
			}
			const queuedFollowup = control.takeQueuedFollowup();
			if (queuedFollowup) {
				kind = "followup";
				instruction = queuedFollowup.instruction;
				task.status = "working";
				continue;
			}
			this.attention(task, failure ?? "Task candidate needs attention after its correction window closed.");
			await this.saveProductive(handle);
			return;
		}
	}



	private terminationCandidate(attempt: TaskAttempt): WorkspaceIdentity {
		return attempt.integrationCandidate
			?? attempt.candidate
			?? attempt.prompts.at(-1)?.candidate
			?? attempt.prompts.at(-1)?.preCandidate
			?? attempt.waveBase;
	}

	private async terminateWithSafety(
		handle: RunStateHandle,
		task: ChangesetTaskState,
		attempt: TaskAttempt,
		candidate: WorkspaceIdentity,
		outerSignal?: AbortSignal,
		safetyDeadline = this.coordinatorRuntime.now() + TERMINATION_SAFETY_BUDGET_MS,
		lifecycleLocked = false,
	): Promise<boolean> {
		if (!lifecycleLocked && this.productiveLifecycles.has(handle.state.root)) {
			return await this.withLifecycleLock(handle, async () =>
				await this.terminateWithSafety(handle, task, attempt, candidate, outerSignal, safetyDeadline, true));
		}
		const save = async () => lifecycleLocked ? await handle.save() : await this.saveProductive(handle);
		const workerId = allocationByKind(attempt, "agent")?.agentName;
		if (!workerId) throw new Error("Safety termination requires an exact durably owned agent ID.");
		attempt.termination = { status: "terminating", workerId, candidate };
		await save();
		const safety = new DeadlineScope(safetyDeadline, () => this.coordinatorRuntime.now(), outerSignal);
		try {
			const result = await safety.call(async (context) => await this.hostRuntime.terminateWorker({
				task: changesetTaskRequest(handle.state, task.taskId), attempt, workerId, candidate,
			}, context));
			if (result.outcome !== "terminated") {
				const failure = boundedRuntimeText(result.failure, "Worker termination failure");
				attempt.termination = { status: "unknown", workerId, candidate, failure };
				this.attention(task, `Worker termination is unproved: ${failure}`);
				return false;
			}
			attempt.termination = { status: "terminated", workerId, candidate, at: this.coordinatorRuntime.now() };
			return true;
		} catch (error) {
			this.rethrowStopped(error);
			attempt.termination = { status: "unknown", workerId, candidate, failure: errorText(error) };
			this.attention(task, `Worker termination is unproved: ${errorText(error)}`);
			return false;
		} finally {
			safety.close();
			await save();
		}
	}


	private async runCheckBatch(
		handle: RunStateHandle,
		checks: CheckCommand[],
		candidate: WorkspaceIdentity,
		phase: CheckBatchEvidence["phase"],
		scope: RuntimeScope,
		taskId?: string,
		root = handle.state.root,
	): Promise<CheckBatchEvidence> {
		const attempt = taskId ? latestAttempt(changesetTaskState(handle.state, taskId)) : undefined;
		const result = await this.callProductive(handle, scope, async (context) => await this.gitRuntime.runChecks({
			root,
			scope: phase === "final" ? "final" : "task",
			...(taskId ? { taskId, attempt } : {}),
			checks,
			candidate,
		}, context));
		const identityAfter = runtimeIdentity(result.identityAfter, "Post-check identity");
		if (!exactCommandResults(result.results, checks)) {
			throw new Error("Check runtime did not return one result with the exact command and argv for every declared check.");
		}
		if (result.results.some((item) => !Number.isSafeInteger(item.code)
			|| (item.killed !== undefined && typeof item.killed !== "boolean")
			|| typeof item.stdout !== "string" || typeof item.stderr !== "string")) {
			throw new Error("Check runtime returned malformed result evidence.");
		}
		const commandsPassed = result.results.every((item) => item.code === 0 && !item.killed);
		const identityMatches = sameIdentity(identityAfter, candidate);
		const passed = identityMatches && commandsPassed;
		let diagnosticIndex = passed ? -1 : result.results.findIndex((item) => item.code !== 0 || item.killed);
		if (diagnosticIndex < 0 && commandsPassed && !identityMatches) diagnosticIndex = result.results.length - 1;
		const evidence: CheckBatchEvidence = {
			phase,
			candidate,
			identityAfter,
			results: result.results.map((item, index): CommandEvidence => ({
				command: item.command,
				args: [...item.args],
				code: item.code,
				killed: item.killed ?? false,
				stdout: index === diagnosticIndex ? bounded(item.stdout) : "",
				stderr: index === diagnosticIndex ? bounded(item.stderr) : "",
			})),
			passed,
			at: this.coordinatorRuntime.now(),
		};
		return evidence;
	}

	private async runReview(
		handle: RunStateHandle,
		criterion: string,
		base: WorkspaceIdentity,
		tip: WorkspaceIdentity,
		role: string,
		modelClass: ModelClass,
		phase: ReviewEvidence["phase"],
		scope: RuntimeScope,
		taskId?: string,
		root = handle.state.root,
	): Promise<ReviewEvidence> {
		const attempt = taskId ? latestAttempt(changesetTaskState(handle.state, taskId)) : undefined;
		const result = await this.callProductive(handle, scope, async (context) => await this.gitRuntime.review({
			root,
			scope: phase === "final" ? "final" : "task",
			phase,
			...(taskId ? { taskId, attempt } : {}),
			criterion,
			base,
			tip,
			acquireLaunch: async () => {
				const launch = await this.coordinatorRuntime.acquireLaunch(role, modelClass, context);
				if (launch.launch.role !== role || launch.launch.modelClass !== modelClass) {
					await withTransientLaunch(launch, async () => {
						throw new Error("Judgment launch acquisition returned the wrong Role or model class.");
					});
				}
				return launch;
			},
		}, context));
		const identityAfter = runtimeIdentity(result.identityAfter, "Post-review identity");
		const verdict = boundedRuntimeText(result.verdict, "Judgment verdict");
		const evidence: ReviewEvidence = {
			phase,
			criterion,
			base,
			tip,
			identityAfter,
			verdict,
			passed: verdict === "PASS" && sameIdentity(identityAfter, tip),
			at: this.coordinatorRuntime.now(),
		};
		return evidence;
	}

	private retainCandidate(state: RunState, task: ChangesetTaskState): void {
		const attempt = latestAttempt(task);
		const request = changesetTaskRequest(state, task.taskId);
		if (!attempt.readiness || !attempt.candidate || !attempt.candidateBase || !attempt.preliminaryChecks
			|| !sameIdentity(attempt.readiness.candidate, attempt.candidate)
			|| !sameIdentity(attempt.readiness.base, attempt.candidateBase)
			|| !checkBatchPasses(attempt.preliminaryChecks, request.checks, attempt.candidate)
			|| (request.judgment && !reviewEvidencePasses(attempt.preliminaryReview, "preliminary",
				request.judgment.criterion, attempt.candidateBase, attempt.candidate))
			|| !allocationByKind(attempt, "agent")?.agentName || attempt.termination) {
			throw new Error(`Task ${task.taskId} has no exact ready live candidate.`);
		}
		if (state.integration.candidates.some((candidate) => candidate.taskId === task.taskId && !candidate.decision)) {
			throw new Error(`Candidate ${task.taskId} is already retained; revision needs a new integration generation.`);
		}
		state.integration.candidates.push({
			taskId: task.taskId, attempt: attempt.number, base: attempt.candidateBase,
			tip: attempt.candidate, checks: attempt.preliminaryChecks,
			...(request.judgment ? { review: attempt.preliminaryReview } : {}), worker: "retained",
		});
	}

	private async verifyRetainedTask(
		handle: RunStateHandle,
		task: ChangesetTaskState,
		scope: RuntimeScope,
	): Promise<RunResponse> {
		const attempt = latestAttempt(task);
		if (attempt.integration?.status === "unknown") throw new Error("An unknown integration result cannot be adopted or reintegrated automatically.");
		if (attempt.prompts.some((prompt) => prompt.status === "ambiguous")) {
			throw new Error("An ambiguous delivered prompt is retained for inspection or explicit abort and is never replayed.");
		}
		const candidate = runtimeIdentity(await this.callProductive(handle, scope, async (context) => await this.gitRuntime.inspectRetainedTask({
			root: handle.state.root, task: changesetTaskRequest(handle.state, task.taskId), attempt,
		}, context)), "Retained task candidate identity");
		if (!isCleanCommitted(candidate)) throw new Error("Retained task candidate is not clean and committed.");
		if (attempt.readiness) {
			const expected = latestTransitionAfter(attempt, attempt.readiness!.at)?.to
				?? attempt.readiness.candidate;
			if (!sameIdentity(candidate, expected)) throw new Error("Ready retained task candidate drifted from its exact lineage.");
			task.status = "ready_to_integrate";
			task.failure = undefined;
			await this.saveProductive(handle);
			this.retainCandidate(handle.state, task);
			handle.state.status = "needs_attention";
			await this.saveProductive(handle);
			return this.response(handle.state);
		}
		const request = changesetTaskRequest(handle.state, task.taskId);
		if (!attempt.candidate || !attempt.candidateBase || !sameIdentity(candidate, attempt.candidate)
			|| !checkBatchPasses(attempt.preliminaryChecks, request.checks, candidate)) {
			throw new Error("Retained task work lacks exact passing preliminary candidate evidence.");
		}
		attempt.readiness = {
			candidate: attempt.candidate,
			base: attempt.candidateBase,
			at: nextAttemptEventAt(attempt, this.coordinatorRuntime.now()),
		};
		task.status = "ready_to_integrate";
		task.failure = undefined;
		await this.saveProductive(handle);
		this.retainCandidate(handle.state, task);
		handle.state.status = "needs_attention";
		await this.saveProductive(handle);
		return this.response(handle.state);
	}

	private async retry(
		handle: RunStateHandle,
		task: ChangesetTaskState,
		scope: RuntimeScope,
	): Promise<RunResponse> {
		const attempt = task.attempts.at(-1);
		if (!attempt) {
			for (const pending of handle.state.tasks) {
				if (pending.status === "needs_attention" && pending.attempts.length === 0) {
					pending.status = "pending";
					pending.failure = undefined;
				}
			}
			await this.saveProductive(handle);
			return await this.run(handle, scope, undefined);
		}
		if (attempt.integration?.status === "unknown") throw new Error("An unknown integration result cannot be retried or adopted automatically.");
		if (attempt.prompts.length) {
			if (attempt.prompts.some((prompt) => prompt.status === "ambiguous")) {
				throw new Error("An ambiguous delivered prompt is never replayed.");
			}
			if (!this.correctionAllowed(handle.state, changesetTaskRequest(handle.state, task.taskId), attempt)) {
				throw new Error("The same-agent correction is unavailable or already used.");
			}
			task.status = "working";
			await this.driveWorkerSafely(handle, task, scope, "correction");
		} else {
			if (attempt.termination || allocationByKind(attempt, "agent")) {
				throw new Error("A promptless attempt with a terminated or potentially active saved agent cannot be retried productively.");
			}
			for (const intent of attempt.allocations.filter((item) => item.status !== "owned")) {
				let result: AllocationReconciliation;
				try {
					const request = changesetTaskRequest(handle.state, task.taskId);
					result = intent.kind === "worktree"
						? await this.callProductive(handle, scope, async (context) => await this.gitRuntime.reconcileWorktreeAllocation({
							root: handle.state.root, intent, task: request, attempt,
						}, context))
						: await this.callProductive(handle, scope, async (context) => await this.hostRuntime.reconcileHostAllocation({
							requestId: handle.state.request.id, intent, task: request, attempt,
						}, context));
				} catch (error) {
					this.rethrowStopped(error);
					intent.status = "unknown";
					intent.failure = bounded(`Allocation reconciliation is ambiguous: ${errorText(error)}`);
					throw new Error(intent.failure);
				}
				if (result.outcome !== "absent") {
					const failure = boundedRuntimeText(result.failure, "Allocation reconciliation failure");
					const possibleResources = boundedPossibleResources(result.possibleResources);
					intent.status = "unknown";
					intent.failure = failure;
					intent.possibleResources = possibleResources;
					await this.saveProductive(handle);
					throw new Error("A possible prior allocation blocks retry; it was not adopted or closed.");
				}
				intent.status = "absent";
				intent.failure = undefined;
				intent.possibleResources = undefined;
			}
			if (attempt.allocationGeneration >= 2) throw new Error("The one reconciled unprompted fresh launch was already used.");
			attempt.allocationGeneration += 1;
			task.status = "allocating";
			task.failure = undefined;
			await this.saveProductive(handle);
			await this.dispatchTask(handle, task, scope);
		}
		const current = changesetTaskState(handle.state, task.taskId);
		if (current.status === "ready_to_integrate") {
			this.retainCandidate(handle.state, current);
			handle.state.status = "needs_attention";
			await this.saveProductive(handle);
			return this.response(handle.state);
		}
		if (current.status !== "completed") {
			handle.state.status = "needs_attention";
			await this.saveProductive(handle);
			return this.response(handle.state);
		}
		return await this.run(handle, scope, undefined);
	}

	private async finalize(handle: RunStateHandle, scope: RuntimeScope): Promise<RunResponse> {
		const state = handle.state;
		if (state.tasks.some((task) => task.status !== "completed")) throw new Error("Finalization requires every task to be completed.");
		if (state.final.status !== "pending" && state.final.status !== "interrupted") {
			throw new Error(`Final gate is ${state.final.status} and cannot be finalized.`);
		}
		if (state.final.identity) {
			const actual = await this.callProductive(handle, scope, async (context) => await this.gitRuntime.inspectMain({ root: state.root }, context));
			if (!sameIdentity(actual, state.final.identity)) {
				await this.markSuperseded(handle, "Main drifted from the recorded final-gate identity.");
				return this.response(state);
			}
		}
		return await this.runFinal(handle, scope);
	}

	private async runFinal(handle: RunStateHandle, scope: RuntimeScope): Promise<RunResponse> {
		const state = handle.state;
		state.status = "running";
		state.final.status = "running";
		state.final.failure = undefined;
		state.accepted = false;
		await this.saveProductive(handle);
		try {
			const identity = state.final.identity ?? runtimeIdentity(
				await this.callProductive(handle, scope, async (context) => await this.gitRuntime.inspectMain({ root: state.root }, context)),
				"Final Main identity",
			);
			if (!sameIdentity(identity, state.main) || !isCleanCommitted(identity)) {
				await this.markSuperseded(handle, "Main drifted before the final gate.");
				return this.response(state);
			}
			state.final.identity = identity;
			await this.saveProductive(handle);
			const finalChecks = state.request.finalChecks ?? [];
			const checks = await this.runCheckBatch(handle, finalChecks, identity, "final", scope);
			state.final.checks = checks;
			await this.saveProductive(handle);
			if (!sameIdentity(checks.identityAfter, identity)) {
				await this.markSuperseded(handle, "Final checks changed Main.");
				return this.response(state);
			}
			if (!checkBatchPasses(checks, finalChecks, identity)) {
				await this.markFinalFailed(handle, "A definitive final check failed.");
				return this.response(state);
			}
			const afterChecks = await this.callProductive(handle, scope, async (context) => await this.gitRuntime.inspectMain({ root: state.root }, context));
			if (!sameIdentity(afterChecks, identity)) {
				await this.markSuperseded(handle, "Main drifted after final checks.");
				return this.response(state);
			}
			if (state.request.finalJudgment) {
				const review = await this.runReview(
					handle,
					state.request.finalJudgment.criterion,
					state.requestStartMain,
					identity,
					state.request.finalJudgment.role,
					state.request.finalJudgment.modelClass,
					"final",
					scope,
				);
				state.final.review = review;
				await this.saveProductive(handle);
				if (!sameIdentity(review.identityAfter, identity)) {
					await this.markSuperseded(handle, "Final Judgment changed Main.");
					return this.response(state);
				}
				if (!review.passed) {
					await this.markFinalFailed(handle, "The definitive final judgment was not exact PASS.");
					return this.response(state);
				}
			}
			const afterJudgment = await this.callProductive(handle, scope, async (context) => await this.gitRuntime.inspectMain({ root: state.root }, context));
			if (!sameIdentity(afterJudgment, identity)) {
				await this.markSuperseded(handle, "Main drifted after final judgment.");
				return this.response(state);
			}
			const beforeCompletion = await this.callProductive(handle, scope, async (context) => await this.gitRuntime.inspectMain({ root: state.root }, context));
			if (!sameIdentity(beforeCompletion, identity)) {
				await this.markSuperseded(handle, "Main drifted before final completion.");
				return this.response(state);
			}
			state.main = identity;
			state.final.status = "passed";
			state.status = "completed";
			state.accepted = true;
			state.acceptedAt = this.coordinatorRuntime.now();
			state.updatedAt = this.coordinatorRuntime.now();
			await this.saveProductive(handle);
			return this.response(state);
		} catch (error) {
			this.rethrowStopped(error);
			state.final.status = "interrupted";
			state.final.failure = bounded(isDeadline(error, scope) ? "The operation safety deadline expired during the final gate." : `Final gate was interrupted without a definitive result: ${errorText(error)}`);
			state.status = "needs_attention";
			state.accepted = false;
			await this.saveProductive(handle);
			return this.response(state);
		}
	}

	private async markFinalFailed(handle: RunStateHandle, failure: string): Promise<void> {
		handle.state.final.status = "final_failed";
		handle.state.final.failure = bounded(failure);
		handle.state.status = "final_failed";
		handle.state.accepted = false;
		await this.saveProductive(handle);
	}

	private async markSuperseded(handle: RunStateHandle, failure: string): Promise<void> {
		handle.state.final.status = "superseded";
		handle.state.final.failure = bounded(failure);
		handle.state.status = "superseded";
		handle.state.accepted = false;
		await this.saveProductive(handle);
	}

	private recoverInterrupted(state: RunState): boolean {
		if (state.status === "pending") {
			const ready = readyPendingTasks(state).filter((task) => task.attempts.length === 0);
			if (!ready.length) return false;
			for (const task of ready) {
				this.attention(task, `Dependency scheduling is pending before ${task.taskId} started; resume retry to continue.`);
			}
			state.status = "needs_attention";
			state.accepted = false;
			state.updatedAt = this.coordinatorRuntime.now();
			return true;
		}
		if (state.status !== "running") return false;
		for (const task of state.tasks) {
			if (["pending", "completed", "needs_attention"].includes(task.status)) continue;
			if (task.kind !== "changeset") {
				this.attention(task, "Execution was interrupted at an ambiguous boundary and will not replay automatically.");
				continue;
			}
			const attempt = task.attempts.at(-1);
			if (attempt) {
				for (const intent of attempt.allocations) {
					if (intent.status === "allocating") {
						intent.status = "unknown";
						intent.failure = "Allocation was interrupted after intent persistence; no result was adopted.";
					}
				}
				for (const prompt of attempt.prompts) {
					if (prompt.status === "submitting") {
						prompt.status = "ambiguous";
						prompt.failure = "Prompt delivery was interrupted and will not be replayed.";
					}
				}
				if (attempt.termination?.status === "terminating") {
					attempt.termination.status = "unknown";
					attempt.termination.failure = "Worker termination was interrupted and remains unproved.";
				}
				if (attempt.integration?.status === "integrating") {
					attempt.integration.status = "unknown";
					attempt.integration.failure = "Integration was interrupted after intent persistence and was not adopted.";
				}
				for (const step of attempt.cleanup) if (step.status === "running") step.status = "pending";
			}
			this.attention(task, state.recovery?.taskId === task.taskId
				? "Deliberate recovery was interrupted; exact saved evidence and resources were retained."
				: "Execution was interrupted at an ambiguous boundary and will not replay automatically.");
		}
		if (!state.tasks.some((task) => task.status === "needs_attention")) {
			for (const task of readyPendingTasks(state)) {
				this.attention(task, `Dependency scheduling was interrupted before ${task.taskId} started; resume retry to continue.`);
			}
		}
		if (state.final.status === "running") {
			state.final.status = "interrupted";
			state.final.failure = "Final verification was interrupted without a definitive result.";
		}
		delete state.recovery;
		state.status = "needs_attention";
		state.accepted = false;
		state.updatedAt = this.coordinatorRuntime.now();
		return true;
	}

	private ensureFollowupControl(handle: RunStateHandle, task: ChangesetTaskState): FollowupControl {
		const key = this.controlKey(handle.state.root, handle.state.request.id, task.taskId);
		const existing = this.followupControls.get(key);
		if (existing) {
			if (existing.task !== task) throw new Error(`Task ${task.taskId} follow-up control has stale state ownership.`);
			return existing.control;
		}
		const control = new FollowupControl((instruction) => {
			const attempt = latestAttempt(task);
			const agent = allocationByKind(attempt, "agent");
			if (!agent) throw new Error("Worker launch has no durably recorded agent allocation.");
			buildChangesetTaskPrompt({
				goal: handle.state.request.goal,
				contexts: [],
				task: changesetTaskRequest(handle.state, task.taskId),
				kind: "followup",
				instruction,
				worktreeCwd: agent.worktreeCwd,
			});
		});
		this.followupControls.set(key, { task, control });
		return control;
	}

	private controlKey(root: string, requestId: string, taskId: string): string {
		return `${root}\0${requestId}\0${taskId}`;
	}

	private activeControl(
		root: string,
		requestId: string,
		taskId: string,
	): { task: ChangesetTaskState; control: FollowupControl } | undefined {
		return this.followupControls.get(this.controlKey(root, requestId, taskId));
	}

	private activeControls(
		root: string,
		requestId: string,
	): Array<{ task: ChangesetTaskState; control: FollowupControl }> {
		const prefix = `${root}\0${requestId}\0`;
		return [...this.followupControls.entries()]
			.filter(([key]) => key.startsWith(prefix))
			.map(([, active]) => active);
	}

	private hasActiveControl(root: string, requestId: string): boolean {
		return this.activeControls(root, requestId).length > 0;
	}

	private hasAnyActiveControl(root: string): boolean {
		const prefix = `${root}\0`;
		return [...this.followupControls.keys()].some((key) => key.startsWith(prefix));
	}

	private closeFollowupControl(
		root: string,
		requestId: string,
		taskId: string,
		control: FollowupControl,
	): void {
		const key = this.controlKey(root, requestId, taskId);
		control.close();
		if (this.followupControls.get(key)?.control === control) this.followupControls.delete(key);
	}

	private closeRequestControls(root: string, requestId: string): void {
		for (const { task, control } of this.activeControls(root, requestId)) {
			this.closeFollowupControl(root, requestId, task.taskId, control);
		}
	}

	private attention(task: TaskState, failure: string): void {
		const boundedFailure = bounded(failure);
		if (task.kind === "text") {
			const attempt = task.attempts.at(-1);
			if (attempt?.status === "running") {
				attempt.status = "failed";
				attempt.failure = boundedFailure;
			} else {
				if (task.attempts.length >= 2) throw new Error(`Text task ${task.taskId} cannot record another failed attempt.`);
				task.attempts.push({ number: task.attempts.length + 1, status: "failed", failure: boundedFailure });
			}
		}
		task.status = "needs_attention";
		task.failure = boundedFailure;
	}

	private response(state: RunState, main?: MainStatus): RunResponse {
		const completed = state.tasks.filter((task) => task.status === "completed").length;
		const rejected = state.tasks.filter((task) => task.status === "rejected").length;
		const resumable = !terminal(state);
		let continuation: ResumeRequest | undefined;
		if (resumable) {
			const attention = state.tasks.find((task) => task.status === "needs_attention");
			if (completed === state.tasks.length
				&& (state.final.status === "pending" || state.final.status === "interrupted")) {
				continuation = { id: state.request.id, action: "finalize" };
			} else if (attention?.kind === "text" && textRetryEligible(state, attention)) {
				continuation = { id: state.request.id, action: "retry", taskId: attention.taskId };
			} else if (attention?.kind === "changeset" && attention.attempts.length === 0) {
				continuation = { id: state.request.id, action: "retry", taskId: attention.taskId };
			} else if (attention?.kind === "changeset" && !attention.attempts.at(-1)?.termination) {
				const attempt = attention.attempts.at(-1);
				if (attempt && this.correctionAllowed(state, changesetTaskRequest(state, attention.taskId), attempt)) {
					continuation = { id: state.request.id, action: "retry", taskId: attention.taskId };
				} else if (attempt?.integration?.status === "integrated"
					|| (attempt?.readiness && !state.integration.candidates.length)
					|| (attempt?.candidate && attempt.candidateBase
						&& checkBatchPasses(attempt.preliminaryChecks, changesetTaskRequest(state, attention.taskId).checks, attempt.candidate))) {
					continuation = { id: state.request.id, action: "verify", taskId: attention.taskId };
				}
			}
		}
		const attention = continuation && "taskId" in continuation
			? taskState(state, continuation.taskId)
			: state.tasks.find((task) => task.status === "needs_attention");
		return {
			text: bounded([
				`Pi Subagent ${state.request.id}: ${state.status}.`,
				`Tasks: ${completed}/${state.tasks.length} completed, ${rejected} rejected. Accepted: ${state.accepted}.`,
				...(main?.status === "current" ? ["Main: current at the recorded exact identity."] : []),
				...(main?.status === "drifted" ? [
					`Main: drifted from ${main.expected.branch}@${main.expected.head} to ${main.actual.branch}@${main.actual.head}.`,
				] : []),
				...(main?.status === "unavailable" ? [`Main: ${main.failure}`] : []),
				...(attention?.failure ? [`Needs attention (${attention.taskId}): ${attention.failure}`] : []),
				...(state.integration.candidates.length && state.integration.generations.at(-1)?.status !== "promoted" ? [
					`Candidates: ${state.integration.candidates.map((item) => `${item.taskId}#${item.attempt}@${item.tip.head}${item.decision ? " (rejected)" : ""}`).join(", ")}. Use subagent_stage with exact status identities; Main remains unchanged.`,
				] : []),
				...(state.integration.generations.at(-1) ? [
					`Integration generation ${state.integration.generations.at(-1)!.number}: ${state.integration.generations.at(-1)!.status}; worktree: ${state.integration.generations.at(-1)!.worktree?.path ?? "allocation not proven"}; stage: ${state.integration.generations.at(-1)!.stages.at(-1)?.status ?? "none"}.`,
					...(state.integration.generations.at(-1)!.status === "staging" && readyPendingTasks(state).some((task) =>
						state.integration.generations.at(-1)!.combinedTip && hasChangesetDependency(state, task.taskId)
						&& stagedDependencySnapshot(state, task.taskId, state.integration.generations.at(-1)!.combinedTip!))
						? ["Main may call subagent_integrate advance with this generation and its exact staged combinedTip to launch ready dependents."] : []),
					...(state.integration.generations.at(-1)!.failure ? [`Integration: ${state.integration.generations.at(-1)!.failure}`] : []),
				...(state.integration.generations.at(-1)!.promotion?.failure ? [`Promotion: ${state.integration.generations.at(-1)!.promotion!.failure}`] : []),
				...(state.integration.generations.at(-1)!.checks?.passed === false ? ["Combined checks failed; Main was not changed."] : []),
				...(state.integration.generations.at(-1)!.status === "promoted" ? ["Promotion proven; worker cleanup is pending or completed. Use subagent_integrate cleanup with the exact tip if interrupted."] : []),
				] : []),
				...(state.integration.generations.some((item) => item.status === "superseded" && item.worktree) ? [
					`Superseded integration worktrees remain owned (see generation paths/status); inspect and reconcile these exact resources manually. They are not counted as selected or cleaned.`,
				] : []),
				...(state.integration.candidates.some((item) => item.decision === "rejected" && item.worker === "retained") ? [
					"Rejected candidate resources remain retained; inspect task attempt identities and cleanup steps in subagent_status before manual recovery.",
				] : []),
				...(state.final.failure ? [`Final: ${state.final.failure}`] : []),
				...(continuation ? [`Continuation: ${JSON.stringify(continuation)}`] : []),
			].join("\n")),
			state,
			...(main ? { main } : {}),
			...(continuation ? { continuation } : {}),
		};
	}
}
