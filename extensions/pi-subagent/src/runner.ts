import { realpathSync } from "node:fs";
import type { EphemeralSubagentExecutor } from "./ephemeral.ts";
import { createChildWorktree, finalizeChildWorktree } from "./worktree.ts";
import {
	checkBatchPasses,
	CLEANUP_KINDS,
	isCleanCommitted,
	MAX_PERSISTED_RUNTIME_TEXT_BYTES,
	MAX_POSSIBLE_RESOURCES,
	parseExecuteRequest,
	parseResumeRequest,
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
	return [...request.dependsOn, ...request.contextFrom]
		.every((source) => taskState(state, source).status === "completed");
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
		&& !checks.passed
		&& exactCommandResults(checks.results, request.checks)
		&& checks.results.some((result) => result.code !== 0 || result.killed)
		&& sameIdentity(checks.candidate, attempt.candidate)
		&& sameIdentity(checks.identityAfter, attempt.candidate));
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
	) {
		this.coordinatorRuntime = coordinatorRuntime;
		this.hostRuntime = hostRuntime;
		this.gitRuntime = gitRuntime;
		this.store = store;
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
				final: { status: "pending" },
				accepted: false,
				createdAt,
				updatedAt: createdAt,
			};
			const handle = await this.store.withLock(root, async () => await this.store.create(state), {
				productiveRunLease: lifecycle.lease,
			});
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
			const cleanupTask = "taskId" in request ? taskState(state, request.taskId) : undefined;
			const cleanupAttempt = cleanupTask?.kind === "changeset" ? cleanupTask.attempts.at(-1) : undefined;
			const cleanupOnly = request.action === "verify" && cleanupTask?.kind === "changeset"
				&& cleanupAttempt?.integration?.status === "integrated";

			const scope: RuntimeScope = cleanupOnly
				? new DeadlineScope(this.coordinatorRuntime.now() + CLEANUP_SAFETY_BUDGET_MS, () => this.coordinatorRuntime.now(), outerSignal)
				: new ProductiveScope(Math.min(state.policy.childMaxMs, current.childMaxMs), () => this.coordinatorRuntime.now(), outerSignal);
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
				if (request.action === "verify") {
					const attempt = latestAttempt(task);
					if (attempt.integration?.status === "integrated") {
						return await this.verifyCleanupOnly(handle, task, attempt, scope);
					}
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

	async abort(id: string, root: string, outerSignal?: AbortSignal): Promise<RunResponse> {
		root = realpathSync.native(root);
		return await this.store.withLock(root, async (lifecycle) => {
			const handle = await this.store.load(root, id);
			const state = handle.state;
			if (terminal(state)) return this.response(state);
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
				const ready = readyPendingTasks(state).filter((task) => !forceTextTaskId || task.taskId === forceTextTaskId);
				if (!ready.length) throw new Error("No dependency wave is ready.");
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
				const wave: WaveState = {
					number: state.waves.length + 1,
					base: state.main,
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
				wave.status = "integrating";
				await this.saveProductive(handle);
				const readyTaskIds = new Set(ready.map((task) => task.taskId));
				for (const request of state.request.tasks) {
					if (request.kind !== "changeset" || !readyTaskIds.has(request.id)) continue;
					const task = changesetTaskState(state, request.id);
					if (!await this.integrateTask(handle, task, scope)) {
						for (const retained of ready) {
							if (retained.kind === "changeset" && retained.status === "ready_to_integrate") {
								this.attention(retained, "Earlier same-wave integration stopped; verify the retained ready candidate to continue.");
							}
						}
						wave.status = "needs_attention";
						state.status = "needs_attention";
						return this.response(state);
					}
				}
				wave.status = "completed";
				await this.saveProductive(handle);
				forceTextTaskId = undefined;
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
			const isolated = await createChildWorktree(
				state.root,
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
		attempt.status = "completed";
		attempt.failure = undefined;
		attempt.output = { text: output };
		task.status = "completed";
		task.failure = undefined;
		await this.saveProductive(handle);
	}

	private correctionAllowed(state: RunState, request: ChangesetTaskRequest, attempt: TaskAttempt): boolean {
		const effectiveMaximum = Math.min(state.policy.maxCorrections, this.currentPolicy().maxCorrections);
		return state.correctionCount < effectiveMaximum && correctionEligible(request, attempt);
	}

	private async driveWorkerSafely(
		handle: RunStateHandle,
		task: ChangesetTaskState,
		scope: RuntimeScope,
		initialKind: "initial" | "correction" | "followup",
		initialInstruction?: string,
	): Promise<void> {
		const control = this.ensureFollowupControl(handle, task);
		try {
			await this.driveWorker(handle, task, scope, initialKind, control, initialInstruction);
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
			if (kind === "correction" && !this.correctionAllowed(state, request, attempt)) {
				this.attention(task, "The same-agent correction is unavailable or already used.");
				await this.saveProductive(handle);
				return;
			}
			if (kind !== "initial") {
				attempt.readiness = undefined;
				attempt.preliminaryChecks = undefined;
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
	): Promise<CheckBatchEvidence> {
		const attempt = taskId ? latestAttempt(changesetTaskState(handle.state, taskId)) : undefined;
		const result = await this.callProductive(handle, scope, async (context) => await this.gitRuntime.runChecks({
			root: handle.state.root,
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
	): Promise<ReviewEvidence> {
		const attempt = taskId ? latestAttempt(changesetTaskState(handle.state, taskId)) : undefined;
		const result = await this.callProductive(handle, scope, async (context) => await this.gitRuntime.review({
			root: handle.state.root,
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

	private async integrateTask(handle: RunStateHandle, task: ChangesetTaskState, scope: RuntimeScope): Promise<boolean> {
		const state = handle.state;
		const request = changesetTaskRequest(state, task.taskId);
		const attempt = latestAttempt(task);
		if (attempt.integration?.status === "integrated") {
			return await this.finalizeIntegratedTask(handle, task, attempt, scope);
		}
		if (!attempt.readiness || !attempt.candidate || !attempt.candidateBase
			|| !sameIdentity(attempt.readiness.candidate, attempt.candidate)
			|| !sameIdentity(attempt.readiness.base, attempt.candidateBase)
			|| !checkBatchPasses(attempt.preliminaryChecks, request.checks, attempt.candidate)
			|| !allocationByKind(attempt, "agent")?.agentName || attempt.termination) {
			this.attention(task, "Task integration requires exact durable readiness of a checked live worker candidate.");
			return false;
		}
		task.status = "integrating";
		await this.saveProductive(handle);
		try {
			if (!await this.reconcilePendingRebase(handle, task, attempt, scope)) return false;
			for (;;) {
				const latest = latestTransitionAfter(attempt, attempt.readiness!.at);
				if (latest?.status === "unknown") {
					this.attention(task, "The latest rebase transition is unknown and cannot be continued automatically.");
					return false;
				}
				let actualMain = runtimeIdentity(
					await this.callProductive(handle, scope, async (context) => await this.gitRuntime.inspectMain({ root: state.root }, context)),
					"Pre-rebase Main identity",
				);
				if (!latest && !sameIdentity(actualMain, state.main)) {
					this.attention(task, "Main drifted before integration.");
					return false;
				}
				if (latest && !sameIdentity(actualMain, latest.onto)) state.main = actualMain;
				const current = latest?.status === "rebased" && latest.to
					? { sourceBase: latest.onto, candidate: latest.to }
					: { sourceBase: attempt.readiness.base, candidate: attempt.readiness.candidate };
				if (!latest || latest.status === "rebasing" || !sameIdentity(latest.onto, actualMain)) {
					const transition: RebaseTransition = latest?.status === "rebasing"
						? latest
						: {
							kind: "rebase",
							status: "rebasing",
							sourceBase: current.sourceBase,
							from: current.candidate,
							onto: actualMain,
							at: nextAttemptEventAt(attempt, this.coordinatorRuntime.now()),
						};
					if (transition !== latest) attempt.transitions.push(transition);
					await this.saveProductive(handle);
					const rebasedOutcome = await this.withLifecycleLock(handle, async () => {
						const rebased = await scope.call(async (context) => await this.gitRuntime.rebase({
							root: state.root,
							task: request,
							attempt,
							candidate: transition.from,
							sourceBase: transition.sourceBase,
							onto: transition.onto,
						}, context));
						if (rebased.outcome === "blocked") {
							transition.status = "unknown";
							transition.failure = boundedRuntimeText(rebased.failure, "Rebase failure");
							this.attention(task, transition.failure);
							await handle.save();
							return "blocked" as const;
						}
						const rebasedBase = runtimeIdentity(rebased.base, "Rebase base identity");
						const rebasedCandidate = runtimeIdentity(rebased.candidate, "Rebase candidate identity");
						if (!sameIdentity(rebasedBase, transition.onto) || !isCleanCommitted(rebasedCandidate)) {
							transition.status = "unknown";
							transition.failure = "Rebase did not return its exact recorded base and a clean committed candidate.";
							this.attention(task, transition.failure);
							await handle.save();
							return "blocked" as const;
						}
						transition.status = "rebased";
						transition.to = rebasedCandidate;
						transition.failure = undefined;
						attempt.integrationBase = rebasedBase;
						attempt.integrationCandidate = rebasedCandidate;
						await handle.save();
						return rebased.outcome;
					});
					if (rebasedOutcome === "blocked") return false;
					if (rebasedOutcome === "drift") continue;
					actualMain = runtimeIdentity(
						await this.callProductive(handle, scope, async (context) => await this.gitRuntime.inspectMain({ root: state.root }, context)),
						"Post-rebase Main identity",
					);
					if (!sameIdentity(actualMain, transition.onto)) {
						state.main = actualMain;
						continue;
					}
				}
				const stable = latestTransitionAfter(attempt, attempt.readiness!.at);
				if (!stable?.to || stable.status !== "rebased") throw new Error("Stable integration candidate is missing.");
				attempt.integrationBase = stable.onto;
				attempt.integrationCandidate = stable.to;
				break;
			}

			const integrationBase = attempt.integrationBase!;
			const integrationCandidate = attempt.integrationCandidate!;
			let checks = attempt.authoritativeChecks;
			if (!checkBatchPasses(checks, request.checks, integrationCandidate)) {
				checks = await this.runCheckBatch(handle, request.checks, integrationCandidate, "authoritative", scope, task.taskId);
				attempt.authoritativeChecks = checks;
				await this.saveProductive(handle);
			}
			if (!checkBatchPasses(checks, request.checks, integrationCandidate)) {
				return await this.handleAuthoritativeFailure(
					handle, task, attempt, scope,
					"Authoritative checks did not pass on the exact integration candidate.",
				);
			}
			let review = attempt.authoritativeReview;
			if (request.judgment && !reviewEvidencePasses(
				review, "authoritative", request.judgment.criterion, integrationBase, integrationCandidate,
			)) {
				review = await this.runReview(
					handle,
					request.judgment.criterion,
					integrationBase,
					integrationCandidate,
					request.judgment.role,
					request.judgment.modelClass,
					"authoritative",
					scope,
					task.taskId,
				);
				attempt.authoritativeReview = review;
				await this.saveProductive(handle);
			}
			if (request.judgment && !reviewEvidencePasses(
				review, "authoritative", request.judgment.criterion, integrationBase, integrationCandidate,
			)) {
				return await this.handleAuthoritativeFailure(
					handle, task, attempt, scope,
					"Authoritative Judgment did not return exact PASS on the integration candidate.",
				);
			}
			const integrated = await this.withLifecycleLock(handle, async (): Promise<boolean> => {
				attempt.integration = { status: "integrating", expectedMain: integrationBase, candidate: integrationCandidate };
				await handle.save();
				let result: IntegrationResult;
				try {
					result = await scope.call(async (context) => await this.gitRuntime.integrate({
						root: state.root,
						task: request,
						attempt,
						expectedMain: integrationBase,
						candidate: integrationCandidate,
						checks: checks!,
						...(review ? { review } : {}),
					}, context));
				} catch (error) {
					attempt.integration = {
						status: "unknown", expectedMain: integrationBase, candidate: integrationCandidate,
						failure: bounded(`Integration result is unknown: ${errorText(error)}`),
					};
					this.attention(task, attempt.integration.failure!);
					await handle.save();
					return false;
				}
				if (result.outcome !== "integrated") {
					const failure = boundedRuntimeText(result.failure, "Integration failure");
					attempt.integration = {
						status: result.outcome === "unknown" ? "unknown" : "failed",
						expectedMain: integrationBase,
						candidate: integrationCandidate,
						failure,
					};
					this.attention(task, failure);
					await handle.save();
					return false;
				}
				result.main = runtimeIdentity(result.main, "Integrated Main identity");
				if (result.main.branch !== integrationBase.branch
					|| result.main.head !== integrationCandidate.head
					|| !isCleanCommitted(result.main)) {
					attempt.integration = {
						status: "unknown", expectedMain: integrationBase, candidate: integrationCandidate, mainAfter: result.main,
						failure: "Integration returned an unexpected Main identity.",
					};
					this.attention(task, attempt.integration.failure!);
					await handle.save();
					return false;
				}
				attempt.integration = {
					status: "integrated", expectedMain: integrationBase, candidate: integrationCandidate, mainAfter: result.main,
				};
				state.main = result.main;
				await handle.save();
				return true;
			});
			if (!integrated) return false;
			return await this.finalizeIntegratedTask(handle, task, attempt, scope);
		} catch (error) {
			this.rethrowStopped(error);
			this.attention(task, isDeadline(error, scope)
				? "The operation safety deadline expired before integration completed."
				: `Integration was interrupted: ${errorText(error)}`);
			return false;
		} finally {
			await this.saveProductive(handle);
		}
	}

	private async handleAuthoritativeFailure(
		handle: RunStateHandle,
		task: ChangesetTaskState,
		attempt: TaskAttempt,
		_scope: RuntimeScope,
		failure: string,
	): Promise<boolean> {
		this.prepareCorrectionAfterAuthoritativeFailure(attempt);
		this.attention(task, failure);
		await this.saveProductive(handle);
		return false;
	}

	private prepareCorrectionAfterAuthoritativeFailure(attempt: TaskAttempt): void {
		if (attempt.integrationBase && attempt.integrationCandidate) {
			attempt.candidateBase = attempt.integrationBase;
			attempt.candidate = attempt.integrationCandidate;
		}
		attempt.readiness = undefined;
		attempt.preliminaryChecks = undefined;
		attempt.integrationBase = undefined;
		attempt.integrationCandidate = undefined;
		attempt.authoritativeChecks = undefined;
		attempt.authoritativeReview = undefined;
		attempt.integration = undefined;
	}

	private async reconcilePendingRebase(
		handle: RunStateHandle,
		task: ChangesetTaskState,
		attempt: TaskAttempt,
		scope: RuntimeScope,
	): Promise<boolean> {
		const transition = attempt.readiness
			? latestTransitionAfter(attempt, attempt.readiness!.at)
			: undefined;
		if (!transition || transition.status === "rebased") return true;
		if (transition.status === "unknown") {
			this.attention(task, "The saved rebase transition is unknown and cannot be adopted automatically.");
			return false;
		}
		return await this.withLifecycleLock(handle, async () => {
			const result = await scope.call(async (context) => await this.gitRuntime.reconcileRebase({
				root: handle.state.root,
				task: changesetTaskRequest(handle.state, task.taskId),
				attempt,
				transition,
			}, context));
			if (result.outcome === "not_started") return true;
			if (result.outcome === "unknown") {
				transition.status = "unknown";
				transition.failure = boundedRuntimeText(result.failure, "Rebase reconciliation failure");
				this.attention(task, transition.failure);
				await handle.save();
				return false;
			}
			const candidate = runtimeIdentity(result.candidate, "Reconciled rebase candidate");
			if (!isCleanCommitted(candidate)) {
				transition.status = "unknown";
				transition.failure = "Reconciled rebase candidate is not clean and committed.";
				this.attention(task, transition.failure);
				await handle.save();
				return false;
			}
			transition.status = "rebased";
			transition.to = candidate;
			transition.failure = undefined;
			attempt.integrationBase = transition.onto;
			attempt.integrationCandidate = candidate;
			await handle.save();
			return true;
		});
	}

	private async finalizeIntegratedTask(
		handle: RunStateHandle,
		task: ChangesetTaskState,
		attempt: TaskAttempt,
		scope: RuntimeScope,
	): Promise<boolean> {
		const candidate = attempt.integrationCandidate;
		const integration = attempt.integration;
		const readyTransition = attempt.readiness
			? latestTransitionAfter(attempt, attempt.readiness.at)
			: undefined;
		if (integration?.status !== "integrated" || !attempt.readiness || !candidate || !attempt.integrationBase || !integration.mainAfter
			|| readyTransition?.status !== "rebased" || !readyTransition.to
			|| !sameIdentity(readyTransition.onto, attempt.integrationBase)
			|| !sameIdentity(readyTransition.to, candidate)
			|| !sameIdentity(integration.expectedMain, attempt.integrationBase)
			|| !sameIdentity(integration.candidate, candidate)
			|| integration.mainAfter.branch !== integration.expectedMain.branch
			|| integration.mainAfter.head !== candidate.head
			|| !isCleanCommitted(integration.mainAfter)) {
			this.attention(task, "Resource finalization requires exact durable integration evidence.");
			return false;
		}
		const ownedWorkerId = allocationByKind(attempt, "agent")?.agentName;
		if (attempt.termination?.status === "terminated"
			&& (!ownedWorkerId || attempt.termination.workerId !== ownedWorkerId
				|| !sameIdentity(attempt.termination.candidate, candidate))) {
			this.attention(task, "Recorded worker termination does not match the exact integrated worker and candidate.");
			return false;
		}
		if (attempt.termination?.status !== "terminated") {
			if (attempt.termination) {
				const reconciled = await this.callProductive(handle, scope, async (context) => await this.hostRuntime.reconcileWorkerTermination({
					task: changesetTaskRequest(handle.state, task.taskId),
					attempt,
					workerId: attempt.termination!.workerId,
					candidate,
				}, context));
				if (reconciled.outcome === "unknown") {
					attempt.termination.status = "unknown";
					attempt.termination.failure = boundedRuntimeText(reconciled.failure, "Worker termination reconciliation failure");
					this.attention(task, `Worker termination is unproved: ${attempt.termination.failure}`);
					await this.saveProductive(handle);
					return false;
				}
				if (reconciled.outcome === "terminated") {
					attempt.termination = {
						status: "terminated", workerId: attempt.termination.workerId, candidate,
						at: this.coordinatorRuntime.now(),
					};
					await this.saveProductive(handle);
				}
			}
			if (attempt.termination?.status !== "terminated"
				&& !await this.terminateWithSafety(handle, task, attempt, candidate, scope.signal)) return false;
		}
		task.status = "cleanup";
		await this.saveProductive(handle);
		if (!await this.runCleanup(handle, task, attempt, scope)) return false;
		task.status = "completed";
		task.failure = undefined;
		await this.saveProductive(handle);
		return true;
	}

	private async runCleanup(handle: RunStateHandle, task: ChangesetTaskState, attempt: TaskAttempt, scope: RuntimeScope): Promise<boolean> {
		if (attempt.termination?.status !== "terminated") {
			this.attention(task, "Cleanup is blocked until exact worker termination is durably recorded.");
			return false;
		}
		for (const step of attempt.cleanup) {
			if (step.status === "completed") continue;
			step.status = "running";
			step.failure = undefined;
			await this.saveProductive(handle);
			try {
				const request = changesetTaskRequest(handle.state, task.taskId);
				let result: unknown;
				if (step.kind === "worktree" || step.kind === "branch") {
					const kind: GitCleanupKind = step.kind;
					result = await this.callProductive(handle, scope, async (context) => await this.gitRuntime.cleanupGit({
						root: handle.state.root, kind, task: request, attempt,
					}, context));
				} else {
					const kind: HostCleanupKind = step.kind;
					result = await this.callProductive(handle, scope, async (context) => await this.hostRuntime.cleanupHost({
					requestId: handle.state.request.id, kind, task: request, attempt,
				}, context));
				}
				const reported = result as { outcome?: unknown; failure?: unknown } | null;
				if (reported?.outcome !== "completed" && reported?.outcome !== "absent") {
					step.status = "pending";
					step.failure = typeof reported?.failure === "string" && reported.failure.trim()
						? bounded(reported.failure)
						: "Cleanup did not return an explicit completed or absent outcome.";
					this.attention(task, `Cleanup ${step.kind} failed closed: ${step.failure}`);
					return false;
				}
				step.status = "completed";
				await this.saveProductive(handle);
			} catch (error) {
				this.rethrowStopped(error);
				step.status = "pending";
				step.failure = errorText(error);
				this.attention(task, `Cleanup ${step.kind} was interrupted: ${step.failure}`);
				return false;
			}
		}
		return true;
	}

	private async verifyCleanupOnly(
		handle: RunStateHandle,
		task: ChangesetTaskState,
		attempt: TaskAttempt,
		scope: RuntimeScope,
	): Promise<RunResponse> {
		handle.state.status = "running";
		if (await this.finalizeIntegratedTask(handle, task, attempt, scope)) {
			for (const next of readyPendingTasks(handle.state)) {
				this.attention(next, `Integrated-resource verification completed; resume retry for ${next.taskId} to continue dependency scheduling.`);
			}
			handle.state.status = handle.state.tasks.some((candidate) => candidate.status === "needs_attention")
				? "needs_attention"
				: "pending";
		} else {
			handle.state.status = "needs_attention";
		}
		await this.saveProductive(handle);
		return this.response(handle.state);
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
			if (!await this.integrateTask(handle, task, scope)) {
				handle.state.status = "needs_attention";
				return this.response(handle.state);
			}
			return await this.run(handle, scope, undefined);
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
		if (!await this.integrateTask(handle, task, scope)) {
			handle.state.status = "needs_attention";
			return this.response(handle.state);
		}
		return await this.run(handle, scope, undefined);
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
		if (current.status === "ready_to_integrate" && !await this.integrateTask(handle, current, scope)) {
			handle.state.status = "needs_attention";
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
			} else if (attention?.kind === "changeset") {
				const attempt = attention.attempts.at(-1);
				if (attempt && this.correctionAllowed(state, changesetTaskRequest(state, attention.taskId), attempt)) {
					continuation = { id: state.request.id, action: "retry", taskId: attention.taskId };
				} else if (attempt?.integration?.status === "integrated"
					|| attempt?.readiness
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
				`Tasks: ${completed}/${state.tasks.length} completed. Accepted: ${state.accepted}.`,
				...(main?.status === "current" ? ["Main: current at the recorded exact identity."] : []),
				...(main?.status === "drifted" ? [
					`Main: drifted from ${main.expected.branch}@${main.expected.head} to ${main.actual.branch}@${main.actual.head}.`,
				] : []),
				...(main?.status === "unavailable" ? [`Main: ${main.failure}`] : []),
				...(attention?.failure ? [`Needs attention (${attention.taskId}): ${attention.failure}`] : []),
				...(state.final.failure ? [`Final: ${state.final.failure}`] : []),
				...(continuation ? [`Continuation: ${JSON.stringify(continuation)}`] : []),
			].join("\n")),
			state,
			...(main ? { main } : {}),
			...(continuation ? { continuation } : {}),
		};
	}
}
