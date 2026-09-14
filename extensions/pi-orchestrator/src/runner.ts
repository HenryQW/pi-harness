import { realpathSync } from "node:fs";
import type { EphemeralSubagentExecutor } from "@henryqw/pi-subagent";
import {
	checkBatchPasses,
	CLEANUP_KINDS,
	isCleanCommitted,
	MAX_PERSISTED_RUNTIME_TEXT_BYTES,
	MAX_POSSIBLE_RESOURCES,
	parseExecuteRequest,
	parseResumeRequest,
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
	type HostAllocationIntent,
	type HostAllocationPlan,
	type ModelClass,
	type PromptRecord,
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
import { FileRunStore, type RunStateHandle } from "./store.ts";

const TRUNCATION_MARKER = "\n[truncated]";
const TEXT_TASK_PROMPT_MAX_BYTES = 64 * 1024;
export const CLEANUP_SAFETY_BUDGET_MS = 30_000;
export const TERMINATION_SAFETY_BUDGET_MS = 15_000;
export const STATUS_INSPECTION_BUDGET_MS = 5_000;
const ALLOCATION_KINDS: readonly AllocationKind[] = ["worktree", "workspace", "worker_tab", "agent"];

export interface OperationContext {
	readonly signal: AbortSignal;
	readonly timeoutMs: number;
	readonly deadline: number;
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
	| { outcome: "ready"; base: WorkspaceIdentity; candidate: WorkspaceIdentity }
	| { outcome: "blocked" | "drift"; failure: string };

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
 * the same request abort signal and a timeout capped by the persisted deadline.
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
		readonly goal: ExecuteRequest["goal"];
		kind: HostAllocationKind;
		task: TaskRequest;
		attempt: TaskAttempt;
	}, context: OperationContext): Promise<HostAllocationPlan>;
	allocateHost(input: {
		intent: HostAllocationIntent;
		task: TaskRequest;
		attempt: TaskAttempt;
		/** Invoked only after pane, lease, and startability checks at the final agent-start boundary. */
		acquireLaunch?: () => Promise<TransientLaunchHandle<VerifiedLaunch>>;
	}, context: OperationContext): Promise<HostAllocationResult>;
	reconcileHostAllocation(input: { intent: HostAllocationIntent; task: TaskRequest; attempt: TaskAttempt }, context: OperationContext): Promise<AllocationReconciliation<HostAllocationKind>>;
	runWorker(input: {
		readonly goal: ExecuteRequest["goal"];
		task: TaskRequest;
		attempt: TaskAttempt;
		workerId: string;
		kind: "initial" | "correction";
		preCandidate: WorkspaceIdentity;
		failure?: string;
	}, context: OperationContext): Promise<WorkerResult>;
	terminateWorker(input: {
		task: TaskRequest;
		attempt: TaskAttempt;
		workerId: string;
		candidate: WorkspaceIdentity;
	}, context: OperationContext): Promise<{ outcome: "terminated" } | { outcome: "unknown"; failure: string }>;
	cleanupHost(input: {
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
		onto: WorkspaceIdentity;
	}, context: OperationContext): Promise<RebaseResult>;
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

export interface OrchestratorRuntime extends CoordinatorRuntime, HostRuntime {}

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
		super("The productive request deadline is exhausted.");
		this.name = "DeadlineExpired";
	}
}

class DeadlineScope {
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
	const prompt = attempt.prompts.length === 1 ? attempt.prompts[0] : undefined;
	if (prompt?.kind !== "initial" || prompt.status !== "settled" || attempt.termination) return false;
	if (!attempt.candidate) {
		return !attempt.preliminaryChecks && Boolean(prompt.failure?.trim());
	}
	const checks = attempt.preliminaryChecks;
	return Boolean(checks
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
	return state.tasks.filter((task) => {
		if (task.status !== "pending") return false;
		const request = taskRequest(state, task.taskId);
		return [...request.dependsOn, ...request.contextFrom]
			.every((source) => taskState(state, source).status === "completed");
	});
}

function isDeadline(error: unknown, scope: DeadlineScope): boolean {
	return error instanceof DeadlineExpired || scope.signal.reason instanceof DeadlineExpired;
}

export class OrchestratorRunner {
	private readonly runtime: OrchestratorRuntime;
	private readonly gitRuntime: GitRuntime & TaskCandidateInspector;
	private readonly store: FileRunStore;
	private readonly textExecutor: EphemeralSubagentExecutor;

	constructor(
		runtime: OrchestratorRuntime,
		gitRuntime: GitRuntime & TaskCandidateInspector,
		store = new FileRunStore(),
		textExecutor: EphemeralSubagentExecutor,
	) {
		this.runtime = runtime;
		this.gitRuntime = gitRuntime;
		this.store = store;
		this.textExecutor = textExecutor;
	}

	async execute(value: unknown, cwd: string, outerSignal?: AbortSignal): Promise<RunResponse> {
		const startedAt = this.runtime.now();
		const request = parseExecuteRequest(value);
		const deadline = startedAt + request.budgetMs;
		const scope = new DeadlineScope(deadline, () => this.runtime.now(), outerSignal);
		try {
			const canonicalCwd = realpathSync.native(cwd);
			const prepared = await scope.call(async (context) => await this.runtime.preflight({ request, cwd: canonicalCwd }, context));
			const root = realpathSync.native(prepared.root);
			if (root !== prepared.root) throw new Error("Preflight repository root must be canonical.");
			const preparedMain = runtimeIdentity(prepared.main, "Preflight Main identity");
			if (!isCleanCommitted(preparedMain)) throw new Error("Preflight Main identity must be clean and committed.");
			return await this.store.withLock(root, async () => {
				await this.store.assertAvailable(root, request.id);
				const createdAt = this.runtime.now();
				const state: RunState = {
					version: RUN_STATE_VERSION,
					request,
					root,
					requestStartMain: preparedMain,
					main: preparedMain,
					deadlineStartedAt: startedAt,
					deadline,
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
				const handle = await this.store.create(state);
				return await this.run(handle, scope);
			});
		} finally {
			scope.close();
		}
	}

	async resume(value: unknown, root: string, outerSignal?: AbortSignal): Promise<RunResponse> {
		const request = parseResumeRequest(value);
		root = realpathSync.native(root);
		return await this.store.withLock(root, async () => {
			const handle = await this.store.load(root, request.id);
			const state = handle.state;
			if (this.recoverInterrupted(state)) await handle.save();
			await this.terminateAmbiguousPromptWorkers(handle, outerSignal);
			if (terminal(state)) throw new Error(`Pi Orchestrator request ${request.id} is terminal (${state.status}); create a new request.`);

			if (request.action === "verify") {
				const task = changesetTaskState(state, request.taskId);
				const attempt = latestAttempt(task);
				if (attempt.integration?.status === "integrated") {
					return await this.verifyCleanupOnly(handle, task, attempt, outerSignal);
				}
			}

			const scope = new DeadlineScope(state.deadline, () => this.runtime.now(), outerSignal);
			try {
				if (request.action === "finalize") return await this.finalize(handle, scope);
				const task = changesetTaskState(state, request.taskId);
				if (task.status !== "needs_attention") throw new Error(`Task ${task.taskId} is not waiting for deliberate attention.`);
				if (request.action === "retry") return await this.retry(handle, task, scope);
				return await this.verifyRetainedTask(handle, task, scope);
			} catch (error) {
				if (request.action === "retry") {
					const task = changesetTaskState(state, request.taskId);
					const attempt = task.attempts.at(-1);
					if (attempt && !attempt.termination && allocationByKind(attempt, "agent")?.agentName) {
						this.attention(task, `Productive resume failed before correction completed: ${errorText(error)}`);
						await this.terminateWithSafety(handle, task, attempt, this.terminationCandidate(attempt));
					}
				}
				throw error;
			} finally {
				scope.close();
			}
		});
	}

	async abort(id: string, root: string, outerSignal?: AbortSignal): Promise<RunResponse> {
		root = realpathSync.native(root);
		return await this.store.withLock(root, async () => {
			const handle = await this.store.load(root, id);
			const state = handle.state;
			if (terminal(state)) return this.response(state);
			if (this.recoverInterrupted(state)) await handle.save();
			const safetyDeadline = this.runtime.now() + TERMINATION_SAFETY_BUDGET_MS;
			for (const task of state.tasks) {
				if (task.kind !== "changeset") continue;
				for (const attempt of task.attempts) {
					if (!allocationByKind(attempt, "agent")?.agentName || attempt.termination?.status === "terminated") continue;
					await this.terminateWithSafety(
						handle, task, attempt, this.terminationCandidate(attempt), outerSignal, safetyDeadline,
					);
				}
			}
			state.status = "aborted";
			state.accepted = false;
			state.updatedAt = this.runtime.now();
			await handle.save();
			return this.response(state);
		});
	}

	async status(id: string, root: string, outerSignal?: AbortSignal): Promise<RunResponse> {
		root = realpathSync.native(root);
		return await this.store.withLock(root, async () => {
			const handle = await this.store.load(root, id);
			if (this.recoverInterrupted(handle.state)) await handle.save();
			await this.terminateAmbiguousPromptWorkers(handle, outerSignal);
			const deadline = this.runtime.now() + STATUS_INSPECTION_BUDGET_MS;
			const scope = new DeadlineScope(deadline, () => this.runtime.now(), outerSignal);
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
		});
	}

	private async run(handle: RunStateHandle, scope: DeadlineScope): Promise<RunResponse> {
		const state = handle.state;
		state.status = "running";
		state.updatedAt = this.runtime.now();
		await handle.save();
		try {
			while (state.tasks.some((task) => task.status !== "completed")) {
				const attention = state.tasks.find((task) => task.status === "needs_attention");
				if (attention) {
					state.status = "needs_attention";
					return this.response(state);
				}
				const ready = readyPendingTasks(state);
				if (!ready.length) throw new Error("No dependency wave is ready.");
				let actualMain: WorkspaceIdentity;
				try {
					actualMain = await scope.call(async (context) => await this.gitRuntime.inspectMain({ root: state.root }, context));
				} catch (error) {
					const failure = isDeadline(error, scope)
						? "The productive request deadline expired before dependency-wave dispatch."
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
						correlationToken: runtimeToken(this.runtime.randomToken()),
						allocationGeneration: 1,
						allocations: [],
						prompts: [],
						cleanup: CLEANUP_KINDS.map((kind) => ({ kind, status: "pending" })),
					});
				}
				await handle.save();
				await Promise.all(ready.map(async (task) => {
					try {
						await this.dispatchTask(handle, task, scope);
					} catch (error) {
						const failure = isDeadline(error, scope)
							? "The productive request deadline expired during task dispatch."
							: `Task dispatch was interrupted: ${errorText(error)}`;
						this.attention(task, bounded(failure));
					}
				}));
				if (ready.some((task) => task.kind === "text"
					? task.status !== "completed"
					: task.status !== "ready_to_integrate")) {
					wave.status = "needs_attention";
					state.status = "needs_attention";
					return this.response(state);
				}
				wave.status = "integrating";
				await handle.save();
				const readyTaskIds = new Set(ready.map((task) => task.taskId));
				for (const request of state.request.tasks) {
					if (request.kind !== "changeset" || !readyTaskIds.has(request.id)) continue;
					const task = changesetTaskState(state, request.id);
					if (!await this.integrateTask(handle, task, scope)) {
						for (const retained of ready) {
							if (retained.kind === "changeset" && retained.status === "ready_to_integrate"
								&& latestAttempt(retained).termination?.status === "terminated") {
								this.attention(retained, "Earlier same-wave integration stopped; verify the retained candidate to continue.");
							}
						}
						wave.status = "needs_attention";
						state.status = "needs_attention";
						return this.response(state);
					}
				}
				wave.status = "completed";
				await handle.save();
			}
			return await this.runFinal(handle, scope);
		} catch (error) {
			const active = state.tasks.find((task) => !["pending", "completed", "needs_attention"].includes(task.status));
			if (active) this.attention(active, isDeadline(error, scope) ? "The productive request deadline expired." : `Execution was interrupted: ${errorText(error)}`);
			else if (state.final.status === "running") {
				state.final.status = "interrupted";
				state.final.failure = bounded(isDeadline(error, scope) ? "The productive request deadline expired." : `Final gate was interrupted: ${errorText(error)}`);
			}
			state.status = "needs_attention";
			state.accepted = false;
			return this.response(state);
		} finally {
			state.updatedAt = this.runtime.now();
			await handle.save();
		}
	}

	private async dispatchTask(handle: RunStateHandle, task: TaskState, scope: DeadlineScope): Promise<void> {
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
					const plan = runtimeHostAllocationPlan(await scope.call(async (context) => await this.runtime.planHostAllocation({
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
				await handle.save();
				let result: AllocationResult;
				try {
					if (intent.kind === "worktree") {
						result = await scope.call(async (context) => await this.gitRuntime.allocateWorktree({
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
								await handle.save();
							},
						}, context));
					} else {
						result = await scope.call(async (context) => await this.runtime.allocateHost({
							intent,
							task: request,
							attempt,
							...(intent.kind === "agent" ? { acquireLaunch: async () => {
								const launch = await this.runtime.acquireLaunch(request.role, request.modelClass, context);
								if (launch.launch.role !== request.role || launch.launch.modelClass !== request.modelClass) {
									await withTransientLaunch(launch, async () => {
										throw new Error("Task launch acquisition returned the wrong Role or model class.");
									});
								}
								return launch;
							} } : {}),
						}, context));
					}
				} catch (error) {
					intent.status = "unknown";
					intent.failure = bounded(`Allocation result is unknown: ${errorText(error)}`);
					this.attention(task, intent.failure);
					await handle.save();
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
					await handle.save();
					return;
				}
				applyOwnedAllocationResult(intent, result);
				await handle.save();
			}
			task.status = "working";
			await handle.save();
			await this.driveWorkerSafely(handle, task, scope, "initial");
		} catch (error) {
			this.attention(task, isDeadline(error, scope) ? "The productive request deadline expired during allocation." : `Task allocation was interrupted: ${errorText(error)}`);
			const attempt = task.attempts.at(-1);
			if (attempt && !attempt.termination && allocationByKind(attempt, "agent")?.agentName) {
				await this.terminateWithSafety(handle, task, attempt, this.terminationCandidate(attempt));
			} else {
				await handle.save();
			}
		}
	}

	private async dispatchTextTask(
		handle: RunStateHandle,
		task: TextTaskState,
		scope: DeadlineScope,
	): Promise<void> {
		const state = handle.state;
		const request = taskRequest(state, task.taskId);
		if (request.kind !== "text") throw new Error(`Task ${task.taskId} is not a text task.`);
		const attempt = task.attempts.at(-1);
		if (!attempt || attempt.status !== "running") throw new Error(`Text task ${task.taskId} has no running attempt.`);
		const prompt = buildTextTaskPrompt(state.request.goal, request, resolveTextTaskContexts(state, request));
		const result = await scope.call(async (context) => {
			const handle = await this.runtime.acquireLaunch(request.role, request.modelClass, context);
			if (handle.launch.role !== request.role || handle.launch.modelClass !== request.modelClass) {
				await withTransientLaunch(handle, async () => {
					throw new Error("Text task launch acquisition returned the wrong Role or model class.");
				});
			}
			return await withTransientLaunch(handle, async (verifiedLaunch) => {
				const launch = { args: [...verifiedLaunch.args], env: { ...verifiedLaunch.env } };
				return await this.textExecutor.run({
					signal: context.signal,
					prepare: async () => ({ launch, task: prompt, cwd: state.root }),
				});
			});
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
		const actualMain = await scope.call(async (context) => await this.gitRuntime.inspectMain({ root: state.root }, context));
		if (!sameIdentity(actualMain, state.main)) throw new Error("Main drifted during text task execution.");
		attempt.status = "completed";
		attempt.failure = undefined;
		attempt.output = { text: output };
		task.status = "completed";
		task.failure = undefined;
		await handle.save();
	}

	private async driveWorkerSafely(
		handle: RunStateHandle,
		task: ChangesetTaskState,
		scope: DeadlineScope,
		initialKind: "initial" | "correction",
	): Promise<void> {
		try {
			await this.driveWorker(handle, task, scope, initialKind);
		} catch (error) {
			this.attention(task, isDeadline(error, scope)
				? "The productive request deadline expired during worker execution."
				: `Worker execution was interrupted: ${errorText(error)}`);
			const attempt = latestAttempt(task);
			if (!attempt.termination && allocationByKind(attempt, "agent")?.agentName) {
				await this.terminateWithSafety(handle, task, attempt, this.terminationCandidate(attempt));
			} else {
				await handle.save();
			}
		}
	}

	private async driveWorker(
		handle: RunStateHandle,
		task: ChangesetTaskState,
		scope: DeadlineScope,
		initialKind: "initial" | "correction",
	): Promise<void> {
		const state = handle.state;
		const request = changesetTaskRequest(state, task.taskId);
		const attempt = latestAttempt(task);
		const workerId = allocationByKind(attempt, "agent")?.agentName;
		if (!workerId) throw new Error("Worker launch has no durably recorded agent ID.");
		let kind = initialKind;
		let failure = task.failure;
		for (;;) {
			if (kind === "correction" && !correctionEligible(request, attempt)) {
				this.attention(task, "The same-agent correction is unavailable or already used.");
				await this.terminateWithSafety(handle, task, attempt, this.terminationCandidate(attempt));
				return;
			}
			let preCandidate: WorkspaceIdentity;
			try {
				preCandidate = runtimeIdentity(await scope.call(async (context) => await this.gitRuntime.inspectTaskCandidate({
					root: state.root,
					task: request,
					attempt,
				}, context)), "Pre-prompt candidate identity");
			} catch (error) {
				this.attention(task, `Pre-prompt candidate identity is unavailable: ${errorText(error)}`);
				await this.terminateWithSafety(handle, task, attempt, this.terminationCandidate(attempt));
				return;
			}
			const worktree = allocationByKind(attempt, "worktree");
			if (!worktree?.worktree
				|| preCandidate.branch !== `refs/heads/${worktree.worktree.branch}`
				|| !isCleanCommitted(preCandidate)
				|| (kind === "initial" && preCandidate.head !== attempt.waveBase.head)) {
				this.attention(task, "Pre-prompt task candidate inspection returned an invalid owned worktree identity.");
				await this.terminateWithSafety(handle, task, attempt, preCandidate);
				return;
			}
			const retainedCandidate = kind === "correction"
				? attempt.candidate ?? attempt.prompts[0]?.candidate ?? attempt.prompts[0]?.preCandidate
				: undefined;
			if (retainedCandidate && !sameIdentity(preCandidate, retainedCandidate)) {
				this.attention(task, "The same-agent correction worktree identity drifted before prompting.");
				await this.terminateWithSafety(handle, task, attempt, preCandidate);
				return;
			}
			const prompt: PromptRecord = { kind, status: "submitting", preCandidate, at: this.runtime.now() };
			attempt.prompts.push(prompt);
			task.failure = undefined;
			await handle.save();
			let worker: WorkerResult;
			try {
				worker = await scope.call(async (context) => await this.runtime.runWorker({
					goal: state.request.goal,
					task: request,
					attempt,
					workerId,
					kind,
					preCandidate,
					...(failure ? { failure } : {}),
				}, context));
			} catch (error) {
				prompt.status = "ambiguous";
				prompt.failure = bounded(`Prompt result is ambiguous and will not be replayed: ${errorText(error)}`);
				this.attention(task, prompt.failure);
				await this.terminateWithSafety(handle, task, attempt, preCandidate);
				return;
			}
			if (worker.outcome === "unknown" || worker.outcome === "interrupted") {
				prompt.status = "ambiguous";
				prompt.failure = boundedRuntimeText(worker.diagnostic, `${worker.outcome} worker diagnostic`);
				this.attention(task, `${worker.outcome} worker result will not be replayed: ${prompt.failure}`);
				await this.terminateWithSafety(handle, task, attempt, preCandidate);
				return;
			}
			if (worker.outcome === "not_prompted") {
				prompt.status = "not_sent";
				prompt.failure = boundedRuntimeText(worker.diagnostic, "not-prompted worker diagnostic");
				this.attention(task, `Worker prompt was not submitted: ${prompt.failure}`);
				await this.terminateWithSafety(handle, task, attempt, preCandidate);
				return;
			}
			prompt.status = "settled";
			if (worker.outcome === "blocked") {
				failure = boundedRuntimeText(worker.diagnostic, "blocked worker diagnostic");
				prompt.failure = failure;
				await handle.save();
			} else {
				if (worker.outcome !== "candidate") throw new Error("Unexpected worker result.");
				worker.candidate = runtimeIdentity(worker.candidate, "Settled worker candidate identity");
				if (!isCleanCommitted(worker.candidate) || worker.candidate.head === preCandidate.head) {
					this.attention(task, "Settled worker did not produce a new clean committed candidate.");
					await this.terminateSettledWorker(handle, task, workerId, worker.candidate, scope);
					return;
				}
				prompt.candidate = worker.candidate;
				attempt.candidate = worker.candidate;
				const checks = await this.runCheckBatch(handle, request.checks, worker.candidate, "preliminary", scope, task.taskId);
				attempt.preliminaryChecks = checks;
				await handle.save();
				if (!checks.passed) {
					failure = sameIdentity(checks.identityAfter, worker.candidate)
						? "A declared task check failed on the recorded candidate."
						: "A declared task check changed the recorded candidate.";
				} else {
					failure = undefined;
				}
				if (!failure) {
					if (await this.terminateSettledWorker(handle, task, workerId, worker.candidate, scope)) {
						task.status = "ready_to_integrate";
						task.failure = undefined;
					}
					return;
				}
			}

			if (!correctionEligible(request, attempt)) {
				this.attention(task, failure ?? "Task candidate needs attention after its correction window closed.");
				await this.terminateSettledWorker(handle, task, workerId, attempt.candidate ?? preCandidate, scope);
				return;
			}
			kind = "correction";
		}
	}

	private async terminateSettledWorker(
		handle: RunStateHandle,
		task: ChangesetTaskState,
		workerId: string,
		candidate: WorkspaceIdentity,
		_scope: DeadlineScope,
	): Promise<boolean> {
		const attempt = latestAttempt(task);
		if (allocationByKind(attempt, "agent")?.agentName !== workerId) {
			throw new Error("Worker termination requires the exact durably owned agent ID.");
		}
		return await this.terminateWithSafety(handle, task, attempt, candidate);
	}

	private terminationCandidate(attempt: TaskAttempt): WorkspaceIdentity {
		return attempt.candidate
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
		safetyDeadline = this.runtime.now() + TERMINATION_SAFETY_BUDGET_MS,
	): Promise<boolean> {
		const workerId = allocationByKind(attempt, "agent")?.agentName;
		if (!workerId) throw new Error("Safety termination requires an exact durably owned agent ID.");
		attempt.termination = { status: "terminating", workerId, candidate };
		await handle.save();
		const safety = new DeadlineScope(safetyDeadline, () => this.runtime.now(), outerSignal);
		try {
			const result = await safety.call(async (context) => await this.runtime.terminateWorker({
				task: changesetTaskRequest(handle.state, task.taskId), attempt, workerId, candidate,
			}, context));
			if (result.outcome !== "terminated") {
				const failure = boundedRuntimeText(result.failure, "Worker termination failure");
				attempt.termination = { status: "unknown", workerId, candidate, failure };
				this.attention(task, `Worker termination is unproved: ${failure}`);
				return false;
			}
			attempt.termination = { status: "terminated", workerId, candidate, at: this.runtime.now() };
			return true;
		} catch (error) {
			attempt.termination = { status: "unknown", workerId, candidate, failure: errorText(error) };
			this.attention(task, `Worker termination is unproved: ${errorText(error)}`);
			return false;
		} finally {
			safety.close();
			await handle.save();
		}
	}

	private async terminateAmbiguousPromptWorkers(handle: RunStateHandle, outerSignal?: AbortSignal): Promise<void> {
		const safetyDeadline = this.runtime.now() + TERMINATION_SAFETY_BUDGET_MS;
		for (const task of handle.state.tasks) {
			if (task.kind !== "changeset") continue;
			for (const attempt of task.attempts) {
				if (!attempt.prompts.some((prompt) => prompt.status === "ambiguous")
					|| !allocationByKind(attempt, "agent")?.agentName
					|| attempt.termination?.status === "terminated") continue;
				await this.terminateWithSafety(
					handle, task, attempt, this.terminationCandidate(attempt), outerSignal, safetyDeadline,
				);
			}
		}
	}

	private async runCheckBatch(
		handle: RunStateHandle,
		checks: CheckCommand[],
		candidate: WorkspaceIdentity,
		phase: CheckBatchEvidence["phase"],
		scope: DeadlineScope,
		taskId?: string,
	): Promise<CheckBatchEvidence> {
		const attempt = taskId ? latestAttempt(changesetTaskState(handle.state, taskId)) : undefined;
		const result = await scope.call(async (context) => await this.gitRuntime.runChecks({
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
			at: this.runtime.now(),
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
		scope: DeadlineScope,
		taskId?: string,
	): Promise<ReviewEvidence> {
		const attempt = taskId ? latestAttempt(changesetTaskState(handle.state, taskId)) : undefined;
		const result = await scope.call(async (context) => await this.gitRuntime.review({
			root: handle.state.root,
			scope: phase === "final" ? "final" : "task",
			phase,
			...(taskId ? { taskId, attempt } : {}),
			criterion,
			base,
			tip,
			acquireLaunch: async () => {
				const launch = await this.runtime.acquireLaunch(role, modelClass, context);
				if (launch.launch.role !== role || launch.launch.modelClass !== modelClass) {
					await withTransientLaunch(launch, async () => {
						throw new Error("Judgment launch acquisition returned the wrong Role or model class.");
					});
				}
				return launch;
			},
		}, context));
		const identityAfter = runtimeIdentity(result.identityAfter, "Post-review identity");
		const verdict = boundedRuntimeText(result.verdict, "Reviewer verdict");
		const evidence: ReviewEvidence = {
			phase,
			criterion,
			base,
			tip,
			identityAfter,
			verdict,
			passed: verdict === "PASS" && sameIdentity(identityAfter, tip),
			at: this.runtime.now(),
		};
		return evidence;
	}

	private async integrateTask(handle: RunStateHandle, task: ChangesetTaskState, scope: DeadlineScope): Promise<boolean> {
		const state = handle.state;
		const request = changesetTaskRequest(state, task.taskId);
		const attempt = latestAttempt(task);
		if (attempt.termination?.status !== "terminated" || !attempt.candidate) {
			this.attention(task, "Task cannot integrate before exact worker termination and candidate recording.");
			return false;
		}
		task.status = "integrating";
		await handle.save();
		try {
			const actualMain = await scope.call(async (context) => await this.gitRuntime.inspectMain({ root: state.root }, context));
			if (!sameIdentity(actualMain, state.main)) {
				this.attention(task, "Main drifted before integration.");
				return false;
			}
			const rebased = await scope.call(async (context) => await this.gitRuntime.rebase({
				root: state.root,
				task: request,
				attempt,
				candidate: attempt.candidate!,
				onto: state.main,
			}, context));
			if (rebased.outcome !== "ready") {
				this.attention(task, boundedRuntimeText(rebased.failure, "Rebase failure"));
				return false;
			}
			const rebasedBase = runtimeIdentity(rebased.base, "Rebase base identity");
			const rebasedCandidate = runtimeIdentity(rebased.candidate, "Rebase candidate identity");
			if (!sameIdentity(rebasedBase, state.main) || !isCleanCommitted(rebasedCandidate)) {
				this.attention(task, "Rebase did not return the exact recorded integration base and a clean committed candidate.");
				return false;
			}
			attempt.integrationBase = rebasedBase;
			attempt.integrationCandidate = rebasedCandidate;
			const checks = await this.runCheckBatch(handle, request.checks, rebasedCandidate, "authoritative", scope, task.taskId);
			attempt.authoritativeChecks = checks;
			await handle.save();
			if (!checkBatchPasses(checks, request.checks, rebasedCandidate)) {
				this.attention(task, "Authoritative checks did not pass on the exact integration candidate.");
				return false;
			}
			let review: ReviewEvidence | undefined;
			if (request.judgment) {
				review = await this.runReview(
					handle,
					request.judgment.criterion,
					rebasedBase,
					rebasedCandidate,
					request.judgment.role,
					request.judgment.modelClass,
					"authoritative",
					scope,
					task.taskId,
				);
				attempt.authoritativeReview = review;
				await handle.save();
				if (!review.passed) {
					this.attention(task, "Authoritative Reviewer did not return exact PASS on the integration candidate.");
					return false;
				}
			}
			attempt.integration = { status: "integrating", expectedMain: state.main, candidate: rebasedCandidate };
			await handle.save();
			let integrated: IntegrationResult;
			try {
				integrated = await scope.call(async (context) => await this.gitRuntime.integrate({
					root: state.root,
					task: request,
					attempt,
					expectedMain: state.main,
					candidate: rebasedCandidate,
					checks,
					...(review ? { review } : {}),
				}, context));
			} catch (error) {
				attempt.integration = {
					status: "unknown", expectedMain: state.main, candidate: rebasedCandidate,
					failure: bounded(`Integration result is unknown: ${errorText(error)}`),
				};
				this.attention(task, attempt.integration.failure!);
				return false;
			}
			if (integrated.outcome !== "integrated") {
				const failure = boundedRuntimeText(integrated.failure, "Integration failure");
				attempt.integration = {
					status: integrated.outcome === "unknown" ? "unknown" : "failed",
					expectedMain: state.main,
					candidate: rebasedCandidate,
					failure,
				};
				this.attention(task, failure);
				return false;
			}
			integrated.main = runtimeIdentity(integrated.main, "Integrated Main identity");
			if (integrated.main.branch !== state.main.branch
				|| integrated.main.head !== rebasedCandidate.head
				|| !isCleanCommitted(integrated.main)) {
				attempt.integration = {
					status: "unknown", expectedMain: state.main, candidate: rebasedCandidate, mainAfter: integrated.main,
					failure: "Integration returned an unexpected Main identity.",
				};
				this.attention(task, attempt.integration.failure!);
				return false;
			}
			attempt.integration = {
				status: "integrated", expectedMain: state.main, candidate: rebasedCandidate, mainAfter: integrated.main,
			};
			state.main = integrated.main;
			task.status = "cleanup";
			await handle.save();
			if (!await this.runCleanup(handle, task, attempt, scope)) return false;
			task.status = "completed";
			task.failure = undefined;
			await handle.save();
			return true;
		} catch (error) {
			this.attention(task, isDeadline(error, scope) ? "The productive request deadline expired before integration completed." : `Integration was interrupted: ${errorText(error)}`);
			return false;
		} finally {
			await handle.save();
		}
	}

	private async runCleanup(handle: RunStateHandle, task: ChangesetTaskState, attempt: TaskAttempt, scope: DeadlineScope): Promise<boolean> {
		for (const step of attempt.cleanup) {
			if (step.status === "completed") continue;
			step.status = "running";
			step.failure = undefined;
			await handle.save();
			try {
				const request = changesetTaskRequest(handle.state, task.taskId);
				let result: unknown;
				if (step.kind === "worktree" || step.kind === "branch") {
					const kind: GitCleanupKind = step.kind;
					result = await scope.call(async (context) => await this.gitRuntime.cleanupGit({
						root: handle.state.root, kind, task: request, attempt,
					}, context));
				} else {
					const kind: HostCleanupKind = step.kind;
					result = await scope.call(async (context) => await this.runtime.cleanupHost({ kind, task: request, attempt }, context));
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
				await handle.save();
			} catch (error) {
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
		outerSignal?: AbortSignal,
	): Promise<RunResponse> {
		const state = handle.state;
		const deadline = this.runtime.now() + CLEANUP_SAFETY_BUDGET_MS;
		state.recovery = { kind: "cleanup_only", taskId: task.taskId, deadline };
		state.status = "running";
		task.status = "cleanup";
		state.updatedAt = this.runtime.now();
		await handle.save();
		const scope = new DeadlineScope(deadline, () => this.runtime.now(), outerSignal);
		try {
			if (await this.runCleanup(handle, task, attempt, scope)) {
				task.status = "completed";
				task.failure = undefined;
				for (const next of readyPendingTasks(state)) {
					this.attention(next, `Cleanup-only verification completed; resume retry for ${next.taskId} to continue dependency scheduling.`);
				}
				state.status = state.tasks.some((candidate) => candidate.status === "needs_attention") ? "needs_attention" : "pending";
			} else {
				state.status = "needs_attention";
			}
			return this.response(state);
		} finally {
			scope.close();
			state.recovery = undefined;
			state.updatedAt = this.runtime.now();
			await handle.save();
		}
	}

	private async verifyRetainedTask(handle: RunStateHandle, task: ChangesetTaskState, scope: DeadlineScope): Promise<RunResponse> {
		const attempt = latestAttempt(task);
		if (attempt.integration?.status === "unknown") throw new Error("An unknown integration result cannot be adopted or reintegrated automatically.");
		if (attempt.termination?.status !== "terminated") throw new Error("Manual verification requires exact recorded worker termination.");
		const candidate = runtimeIdentity(await scope.call(async (context) => await this.gitRuntime.inspectRetainedTask({
			root: handle.state.root, task: changesetTaskRequest(handle.state, task.taskId), attempt,
		}, context)), "Retained task candidate identity");
		if (!isCleanCommitted(candidate)) throw new Error("Retained task candidate is not clean and committed.");
		if (candidate.head === attempt.waveBase.head) throw new Error("Retained task candidate must differ from its wave base.");
		attempt.candidate = candidate;
		task.status = "ready_to_integrate";
		task.failure = undefined;
		await handle.save();
		if (!await this.integrateTask(handle, task, scope)) {
			handle.state.status = "needs_attention";
			return this.response(handle.state);
		}
		return await this.run(handle, scope);
	}

	private async retry(handle: RunStateHandle, task: ChangesetTaskState, scope: DeadlineScope): Promise<RunResponse> {
		const attempt = task.attempts.at(-1);
		if (!attempt) {
			for (const pending of handle.state.tasks) {
				if (pending.status === "needs_attention" && pending.attempts.length === 0) {
					pending.status = "pending";
					pending.failure = undefined;
				}
			}
			await handle.save();
			return await this.run(handle, scope);
		}
		if (attempt.integration?.status === "unknown") throw new Error("An unknown integration result cannot be retried or adopted automatically.");
		if (attempt.prompts.length) {
			if (attempt.prompts.some((prompt) => prompt.status === "ambiguous")) {
				if (attempt.termination?.status !== "terminated" && allocationByKind(attempt, "agent")?.agentName) {
					await this.terminateWithSafety(handle, task, attempt, this.terminationCandidate(attempt));
				}
				throw new Error("An ambiguous delivered prompt is never replayed.");
			}
			if (!correctionEligible(changesetTaskRequest(handle.state, task.taskId), attempt)) {
				if (attempt.termination?.status !== "terminated" && allocationByKind(attempt, "agent")?.agentName) {
					await this.terminateWithSafety(handle, task, attempt, this.terminationCandidate(attempt));
				}
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
						? await scope.call(async (context) => await this.gitRuntime.reconcileWorktreeAllocation({
							root: handle.state.root, intent, task: request, attempt,
						}, context))
						: await scope.call(async (context) => await this.runtime.reconcileHostAllocation({
							intent, task: request, attempt,
						}, context));
				} catch (error) {
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
					await handle.save();
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
			await handle.save();
			await this.dispatchTask(handle, task, scope);
		}
		const current = changesetTaskState(handle.state, task.taskId);
		if (current.status === "ready_to_integrate" && !await this.integrateTask(handle, current, scope)) {
			handle.state.status = "needs_attention";
			return this.response(handle.state);
		}
		if (current.status !== "completed") {
			handle.state.status = "needs_attention";
			await handle.save();
			return this.response(handle.state);
		}
		return await this.run(handle, scope);
	}

	private async finalize(handle: RunStateHandle, scope: DeadlineScope): Promise<RunResponse> {
		const state = handle.state;
		if (state.tasks.some((task) => task.status !== "completed")) throw new Error("Finalization requires every task to be completed.");
		if (state.final.status !== "pending" && state.final.status !== "interrupted") {
			throw new Error(`Final gate is ${state.final.status} and cannot be finalized.`);
		}
		if (state.final.identity) {
			const actual = await scope.call(async (context) => await this.gitRuntime.inspectMain({ root: state.root }, context));
			if (!sameIdentity(actual, state.final.identity)) {
				await this.markSuperseded(handle, "Main drifted from the recorded final-gate identity.");
				return this.response(state);
			}
		}
		return await this.runFinal(handle, scope);
	}

	private async runFinal(handle: RunStateHandle, scope: DeadlineScope): Promise<RunResponse> {
		const state = handle.state;
		state.status = "running";
		state.final.status = "running";
		state.final.failure = undefined;
		state.accepted = false;
		await handle.save();
		try {
			const identity = state.final.identity ?? runtimeIdentity(
				await scope.call(async (context) => await this.gitRuntime.inspectMain({ root: state.root }, context)),
				"Final Main identity",
			);
			if (!sameIdentity(identity, state.main) || !isCleanCommitted(identity)) {
				await this.markSuperseded(handle, "Main drifted before the final gate.");
				return this.response(state);
			}
			state.final.identity = identity;
			await handle.save();
			const checks = await this.runCheckBatch(handle, state.request.finalChecks, identity, "final", scope);
			state.final.checks = checks;
			await handle.save();
			if (!sameIdentity(checks.identityAfter, identity)) {
				await this.markSuperseded(handle, "Final checks changed Main.");
				return this.response(state);
			}
			if (!checkBatchPasses(checks, state.request.finalChecks, identity)) {
				await this.markFinalFailed(handle, "A definitive final check failed.");
				return this.response(state);
			}
			const afterChecks = await scope.call(async (context) => await this.gitRuntime.inspectMain({ root: state.root }, context));
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
				await handle.save();
				if (!sameIdentity(review.identityAfter, identity)) {
					await this.markSuperseded(handle, "Final Reviewer changed Main.");
					return this.response(state);
				}
				if (!review.passed) {
					await this.markFinalFailed(handle, "The definitive final judgment was not exact PASS.");
					return this.response(state);
				}
			}
			const afterJudgment = await scope.call(async (context) => await this.gitRuntime.inspectMain({ root: state.root }, context));
			if (!sameIdentity(afterJudgment, identity)) {
				await this.markSuperseded(handle, "Main drifted after final judgment.");
				return this.response(state);
			}
			const beforeAcceptance = await scope.call(async (context) => await this.gitRuntime.inspectMain({ root: state.root }, context));
			if (!sameIdentity(beforeAcceptance, identity)) {
				await this.markSuperseded(handle, "Main drifted before final acceptance.");
				return this.response(state);
			}
			state.main = identity;
			state.final.status = "passed";
			state.status = "completed";
			state.accepted = true;
			state.acceptedAt = this.runtime.now();
			state.updatedAt = this.runtime.now();
			await handle.save();
			return this.response(state);
		} catch (error) {
			state.final.status = "interrupted";
			state.final.failure = bounded(isDeadline(error, scope) ? "The productive request deadline expired during the final gate." : `Final gate was interrupted without a definitive result: ${errorText(error)}`);
			state.status = "needs_attention";
			state.accepted = false;
			await handle.save();
			return this.response(state);
		}
	}

	private async markFinalFailed(handle: RunStateHandle, failure: string): Promise<void> {
		handle.state.final.status = "final_failed";
		handle.state.final.failure = bounded(failure);
		handle.state.status = "final_failed";
		handle.state.accepted = false;
		await handle.save();
	}

	private async markSuperseded(handle: RunStateHandle, failure: string): Promise<void> {
		handle.state.final.status = "superseded";
		handle.state.final.failure = bounded(failure);
		handle.state.status = "superseded";
		handle.state.accepted = false;
		await handle.save();
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
			state.updatedAt = this.runtime.now();
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
				if (!attempt.termination && attempt.candidate
					&& !correctionEligible(changesetTaskRequest(state, task.taskId), attempt)) {
					const workerId = allocationByKind(attempt, "agent")?.agentName;
					if (workerId) {
						attempt.termination = {
							status: "unknown",
							workerId,
							candidate: attempt.candidate,
							failure: "Worker termination was not durably proved before interruption.",
						};
					}
				}
				for (const step of attempt.cleanup) if (step.status === "running") step.status = "pending";
			}
			this.attention(task, state.recovery?.taskId === task.taskId
				? "Cleanup-only verification was interrupted; only exact saved-resource cleanup may resume."
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
		state.recovery = undefined;
		state.status = "needs_attention";
		state.accepted = false;
		state.updatedAt = this.runtime.now();
		return true;
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
		const cleanupAttention = state.tasks.find((task): task is ChangesetTaskState => task.kind === "changeset"
			&& task.status === "needs_attention"
			&& task.attempts.at(-1)?.integration?.status === "integrated");
		let continuation: ResumeRequest | undefined;
		if (resumable && cleanupAttention) {
			continuation = { id: state.request.id, action: "verify", taskId: cleanupAttention.taskId };
		} else if (resumable && this.runtime.now() < state.deadline && (!main || main.status === "current")) {
			const attention = state.tasks.find((task) => task.status === "needs_attention");
			if (completed === state.tasks.length
				&& (state.final.status === "pending" || state.final.status === "interrupted")) {
				continuation = { id: state.request.id, action: "finalize" };
			} else if (attention?.kind === "changeset" && attention.attempts.length === 0) {
				continuation = { id: state.request.id, action: "retry", taskId: attention.taskId };
			} else if (attention?.kind === "changeset"
				&& attention.attempts.at(-1)?.termination?.status === "terminated"
				&& attention.attempts.at(-1)?.integration?.status !== "unknown") {
				continuation = { id: state.request.id, action: "verify", taskId: attention.taskId };
			}
		}
		const attention = continuation && "taskId" in continuation
			? taskState(state, continuation.taskId)
			: state.tasks.find((task) => task.status === "needs_attention");
		return {
			text: bounded([
				`Pi Orchestrator ${state.request.id}: ${state.status}.`,
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
