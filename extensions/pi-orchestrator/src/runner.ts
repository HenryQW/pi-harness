import { realpathSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import {
	checkBatchPasses,
	CLEANUP_KINDS,
	isCleanCommitted,
	launchKey,
	parseExecuteRequest,
	parseResumeRequest,
	sameIdentity,
	validateLaunchRecords,
	RUN_STATE_VERSION,
	type AllocationIntent,
	type AllocationKind,
	type CheckBatchEvidence,
	type CheckCommand,
	type CleanupKind,
	type CommandEvidence,
	type ExecuteRequest,
	type LaunchRecord,
	type PromptRecord,
	type ReviewEvidence,
	type ResumeRequest,
	type RunState,
	type TaskAttempt,
	type TaskRequest,
	type TaskState,
	type WaveState,
	type WorkspaceIdentity,
} from "./schema.ts";
import { FileRunStore, type RunStateHandle } from "./store.ts";

const EVIDENCE_MAX_BYTES = 8 * 1024;
export const CLEANUP_SAFETY_BUDGET_MS = 30_000;
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

export type AllocationResult =
	| { outcome: "owned"; resourceId: string }
	| { outcome: "absent"; failure: string }
	| { outcome: "unknown"; failure: string; possibleResources?: string[] };

export type AllocationReconciliation =
	| { outcome: "absent" }
	| { outcome: "possible"; failure: string; possibleResources?: string[] };

export type WorkerResult =
	| { outcome: "candidate"; candidate: WorkspaceIdentity; diagnostic?: string }
	| { outcome: "blocked"; diagnostic: string }
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

/**
 * Productive hooks may inspect or change implementation state. Every call receives
 * the same request abort signal and a timeout capped by the persisted deadline.
 */
export interface OrchestratorRuntime {
	now(): number;
	randomToken(): string;
	preflight(input: { request: ExecuteRequest; root: string }, context: OperationContext): Promise<{
		main: WorkspaceIdentity;
		launchRecords: LaunchRecord[];
	}>;
	recoverLaunchRecords(input: { request: ExecuteRequest; records: Record<string, LaunchRecord> }, context: OperationContext): Promise<LaunchRecord[]>;
	inspectMain(input: { root: string }, context: OperationContext): Promise<WorkspaceIdentity>;
	planAllocation(input: {
		kind: AllocationKind;
		task: TaskRequest;
		attempt: TaskAttempt;
		owned: Partial<Record<AllocationKind, string>>;
	}, context: OperationContext): Promise<string>;
	allocate(input: { intent: AllocationIntent; task: TaskRequest; attempt: TaskAttempt }, context: OperationContext): Promise<AllocationResult>;
	reconcileAllocation(input: { intent: AllocationIntent; task: TaskRequest; attempt: TaskAttempt }, context: OperationContext): Promise<AllocationReconciliation>;
	runWorker(input: {
		task: TaskRequest;
		attempt: TaskAttempt;
		workerId: string;
		launch: LaunchRecord;
		kind: "initial" | "correction";
		preCandidate: WorkspaceIdentity;
		failure?: string;
	}, context: OperationContext): Promise<WorkerResult>;
	runChecks(input: {
		scope: "task" | "final";
		taskId?: string;
		checks: CheckCommand[];
		candidate: WorkspaceIdentity;
	}, context: OperationContext): Promise<CheckRunResult>;
	review(input: {
		scope: "task" | "final";
		taskId?: string;
		criterion: string;
		base: WorkspaceIdentity;
		tip: WorkspaceIdentity;
		launch: LaunchRecord;
	}, context: OperationContext): Promise<ReviewResult>;
	terminateWorker(input: {
		task: TaskRequest;
		attempt: TaskAttempt;
		workerId: string;
		candidate: WorkspaceIdentity;
	}, context: OperationContext): Promise<{ outcome: "terminated" } | { outcome: "unknown"; failure: string }>;
	inspectRetainedTask(input: { task: TaskRequest; attempt: TaskAttempt }, context: OperationContext): Promise<WorkspaceIdentity>;
	rebase(input: {
		task: TaskRequest;
		attempt: TaskAttempt;
		candidate: WorkspaceIdentity;
		onto: WorkspaceIdentity;
	}, context: OperationContext): Promise<RebaseResult>;
	integrate(input: {
		task: TaskRequest;
		attempt: TaskAttempt;
		expectedMain: WorkspaceIdentity;
		candidate: WorkspaceIdentity;
		checks: CheckBatchEvidence;
		review?: ReviewEvidence;
	}, context: OperationContext): Promise<IntegrationResult>;
}

/** Cleanup hooks can only reconcile exact, already-recorded resources. */
export interface CleanupRuntime {
	cleanup(input: {
		kind: CleanupKind;
		task: TaskRequest;
		attempt: TaskAttempt;
	}, context: OperationContext): Promise<{ outcome: "completed" | "absent" } | { outcome: "blocked"; failure: string }>;
}

export interface RunResponse {
	text: string;
	state: RunState;
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

function bounded(value: string, maxBytes = EVIDENCE_MAX_BYTES): string {
	if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
	let end = Math.min(value.length, maxBytes);
	while (end > 0 && Buffer.byteLength(value.slice(0, end), "utf8") > maxBytes) end -= 1;
	return `${value.slice(0, end)}\n[truncated]`;
}

function errorText(error: unknown): string {
	return bounded(error instanceof Error ? error.message : String(error));
}

function taskRequest(state: RunState, id: string): TaskRequest {
	const task = state.request.tasks.find((candidate) => candidate.id === id);
	if (!task) throw new Error(`Unknown task ID: ${id}.`);
	return task;
}

function taskState(state: RunState, id: string): TaskState {
	const task = state.tasks.find((candidate) => candidate.taskId === id);
	if (!task) throw new Error(`Unknown task ID: ${id}.`);
	return task;
}

function latestAttempt(task: TaskState): TaskAttempt {
	const attempt = task.attempts.at(-1);
	if (!attempt) throw new Error(`Task ${task.taskId} has no recorded attempt.`);
	return attempt;
}

function allocationByKind(attempt: TaskAttempt, kind: AllocationKind): AllocationIntent | undefined {
	return [...attempt.allocations].reverse().find((intent) => intent.kind === kind && intent.status === "owned");
}

function ownedAllocations(attempt: TaskAttempt): Partial<Record<AllocationKind, string>> {
	return Object.fromEntries(ALLOCATION_KINDS.flatMap((kind) => {
		const intent = allocationByKind(attempt, kind);
		return intent?.resourceId ? [[kind, intent.resourceId]] : [];
	})) as Partial<Record<AllocationKind, string>>;
}

function exactCommandResults(results: readonly CommandResult[], checks: readonly CheckCommand[]): boolean {
	return results.length === checks.length && results.every((result, index) => {
		const check = checks[index]!;
		return result.command === check.command
			&& result.args.length === check.args.length
			&& result.args.every((arg, argIndex) => arg === check.args[argIndex]);
	});
}

function correctionEligible(request: TaskRequest, attempt: TaskAttempt): boolean {
	const prompt = attempt.prompts.length === 1 ? attempt.prompts[0] : undefined;
	if (prompt?.kind !== "initial" || prompt.status !== "settled" || attempt.termination || attempt.preliminaryReview) return false;
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

function readyPendingTasks(state: RunState): TaskState[] {
	return state.tasks.filter((task) => task.status === "pending"
		&& taskRequest(state, task.taskId).dependsOn.every((dependency) => taskState(state, dependency).status === "completed"));
}

function isDeadline(error: unknown, scope: DeadlineScope): boolean {
	return error instanceof DeadlineExpired || scope.signal.reason instanceof DeadlineExpired;
}

export class OrchestratorRunner {
	private readonly runtime: OrchestratorRuntime;
	private readonly cleanupRuntime: CleanupRuntime;
	private readonly store: FileRunStore;

	constructor(runtime: OrchestratorRuntime, cleanupRuntime: CleanupRuntime, store = new FileRunStore()) {
		this.runtime = runtime;
		this.cleanupRuntime = cleanupRuntime;
		this.store = store;
	}

	async execute(value: unknown, root: string, outerSignal?: AbortSignal): Promise<RunResponse> {
		const startedAt = this.runtime.now();
		const request = parseExecuteRequest(value);
		root = realpathSync.native(root);
		const deadline = startedAt + request.budgetMs;
		const scope = new DeadlineScope(deadline, () => this.runtime.now(), outerSignal);
		try {
			return await this.store.withLock(root, async () => {
				await this.store.assertAvailable(root, request.id);
				const prepared = await scope.call(async (context) => await this.runtime.preflight({ request, root }, context));
				if (!isCleanCommitted(prepared.main)) throw new Error("Preflight Main identity must be clean and committed.");
				const launchRecords = validateLaunchRecords(request, prepared.launchRecords);
				const state: RunState = {
					version: RUN_STATE_VERSION,
					request,
					root,
					requestStartMain: prepared.main,
					main: prepared.main,
					deadlineStartedAt: startedAt,
					deadline,
					launchRecords,
					status: "pending",
					tasks: request.tasks.map((task) => ({
						taskId: task.id,
						status: "pending",
						implementerLaunchKey: launchKey("implementer", task.modelClass),
						...(task.judgment ? { judgmentLaunchKey: launchKey("reviewer", task.judgment.modelClass) } : {}),
						attempts: [],
					})),
					waves: [],
					final: { status: "pending" },
					accepted: false,
					createdAt: startedAt,
					updatedAt: this.runtime.now(),
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
			if (terminal(state)) throw new Error(`Pi Orchestrator request ${request.id} is terminal (${state.status}); create a new request.`);

			if (request.action === "verify") {
				const task = taskState(state, request.taskId);
				const attempt = latestAttempt(task);
				if (attempt.integration?.status === "integrated") {
					return await this.verifyCleanupOnly(handle, task, attempt, outerSignal);
				}
			}

			const deadlineStartedAt = this.runtime.now();
			state.deadlineStartedAt = deadlineStartedAt;
			state.deadline = deadlineStartedAt + state.request.budgetMs;
			state.updatedAt = deadlineStartedAt;
			await handle.save();
			const scope = new DeadlineScope(state.deadline, () => this.runtime.now(), outerSignal);
			try {
				await this.requireRecoveredLaunches(state, scope);
				if (request.action === "finalize") return await this.finalize(handle, scope);
				const task = taskState(state, request.taskId);
				if (task.status !== "needs_attention") throw new Error(`Task ${task.taskId} is not waiting for deliberate attention.`);
				if (request.action === "retry") return await this.retry(handle, task, scope);
				return await this.verifyRetainedTask(handle, task, scope);
			} finally {
				scope.close();
			}
		});
	}

	async status(id: string, root: string): Promise<RunResponse> {
		root = realpathSync.native(root);
		return await this.store.withLock(root, async () => {
			const handle = await this.store.load(root, id);
			if (this.recoverInterrupted(handle.state)) await handle.save();
			return this.response(handle.state);
		});
	}

	private async requireRecoveredLaunches(state: RunState, scope: DeadlineScope): Promise<void> {
		const records = await scope.call(async (context) => await this.runtime.recoverLaunchRecords({
			request: state.request,
			records: state.launchRecords,
		}, context));
		const recovered = validateLaunchRecords(state.request, records);
		if (!isDeepStrictEqual(recovered, state.launchRecords)) {
			throw new Error("Recorded Role/model launch resources drifted; no productive action was started.");
		}
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
					actualMain = await scope.call(async (context) => await this.runtime.inspectMain({ root: state.root }, context));
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
					task.status = "allocating";
					task.attempts.push({
						number: task.attempts.length + 1,
						waveNumber: wave.number,
						waveBase: wave.base,
						correlationToken: this.runtime.randomToken(),
						allocationGeneration: 1,
						allocations: [],
						prompts: [],
						cleanup: CLEANUP_KINDS.map((kind) => ({ kind, status: "pending" })),
					});
				}
				await handle.save();
				await Promise.all(ready.map(async (task) => await this.dispatchTask(handle, task, scope)));
				if (ready.some((task) => task.status !== "ready_to_integrate")) {
					wave.status = "needs_attention";
					state.status = "needs_attention";
					return this.response(state);
				}
				wave.status = "integrating";
				await handle.save();
				for (const task of ready) {
					if (!await this.integrateTask(handle, task, scope)) {
						for (const retained of ready) {
							if (retained.status === "ready_to_integrate"
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
				state.final.failure = isDeadline(error, scope) ? "The productive request deadline expired." : `Final gate was interrupted: ${errorText(error)}`;
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
		const state = handle.state;
		const request = taskRequest(state, task.taskId);
		const attempt = latestAttempt(task);
		try {
			for (const kind of ALLOCATION_KINDS) {
				if (allocationByKind(attempt, kind)) continue;
				const details = await scope.call(async (context) => await this.runtime.planAllocation({
					kind,
					task: request,
					attempt,
					owned: ownedAllocations(attempt),
				}, context));
				const intent: AllocationIntent = {
					kind,
					generation: attempt.allocationGeneration,
					token: attempt.correlationToken,
					details,
					status: "allocating",
				};
				attempt.allocations.push(intent);
				await handle.save();
				let result: AllocationResult;
				try {
					result = await scope.call(async (context) => await this.runtime.allocate({ intent, task: request, attempt }, context));
				} catch (error) {
					intent.status = "unknown";
					intent.failure = `Allocation result is unknown: ${errorText(error)}`;
					this.attention(task, intent.failure);
					await handle.save();
					return;
				}
				if (result.outcome !== "owned") {
					intent.status = result.outcome;
					intent.failure = bounded(result.failure);
					if (result.outcome === "unknown" && result.possibleResources?.length) {
						intent.possibleResources = result.possibleResources.map((item) => bounded(item));
					}
					this.attention(task, intent.failure);
					await handle.save();
					return;
				}
				if (!result.resourceId.trim()) throw new Error(`${kind} allocation returned an empty resource ID.`);
				intent.status = "owned";
				intent.resourceId = result.resourceId;
				await handle.save();
			}
			task.status = "working";
			await handle.save();
			await this.driveWorker(handle, task, scope, "initial");
		} catch (error) {
			this.attention(task, isDeadline(error, scope) ? "The productive request deadline expired during allocation." : `Task dispatch was interrupted: ${errorText(error)}`);
			await handle.save();
		}
	}

	private async driveWorker(
		handle: RunStateHandle,
		task: TaskState,
		scope: DeadlineScope,
		initialKind: "initial" | "correction",
	): Promise<void> {
		const state = handle.state;
		const request = taskRequest(state, task.taskId);
		const attempt = latestAttempt(task);
		const workerId = allocationByKind(attempt, "agent")?.resourceId;
		if (!workerId) throw new Error("Worker launch has no durably recorded agent ID.");
		let kind = initialKind;
		let failure = task.failure;
		for (;;) {
			if (kind === "correction" && !correctionEligible(request, attempt)) {
				this.attention(task, "The same-agent correction is unavailable or already used.");
				return;
			}
			const preCandidate = attempt.candidate ?? attempt.waveBase;
			const prompt: PromptRecord = { kind, status: "submitting", preCandidate, at: this.runtime.now() };
			attempt.prompts.push(prompt);
			task.failure = undefined;
			await handle.save();
			let worker: WorkerResult;
			try {
				worker = await scope.call(async (context) => await this.runtime.runWorker({
					task: request,
					attempt,
					workerId,
					launch: state.launchRecords[task.implementerLaunchKey]!,
					kind,
					preCandidate,
					...(failure ? { failure } : {}),
				}, context));
			} catch (error) {
				prompt.status = "ambiguous";
				prompt.failure = `Prompt result is ambiguous and will not be replayed: ${errorText(error)}`;
				this.attention(task, prompt.failure);
				return;
			}
			if (worker.outcome === "unknown" || worker.outcome === "interrupted") {
				prompt.status = "ambiguous";
				prompt.failure = bounded(worker.diagnostic);
				this.attention(task, `${worker.outcome} worker result will not be replayed: ${prompt.failure}`);
				return;
			}
			prompt.status = "settled";
			if (worker.outcome === "blocked") {
				failure = bounded(worker.diagnostic);
				prompt.failure = failure;
				await handle.save();
			} else {
				if (worker.outcome !== "candidate") throw new Error("Unexpected worker result.");
				if (!isCleanCommitted(worker.candidate) || worker.candidate.head === preCandidate.head) {
					this.attention(task, "Settled worker did not produce a new clean committed candidate.");
					await this.terminateSettledWorker(handle, task, workerId, worker.candidate, scope);
					return;
				}
				prompt.candidate = worker.candidate;
				attempt.candidate = worker.candidate;
				const checks = await this.runCheckBatch(request.checks, worker.candidate, "preliminary", scope, task.taskId);
				attempt.preliminaryChecks = checks;
				await handle.save();
				if (!checks.passed) {
					failure = sameIdentity(checks.identityAfter, worker.candidate)
						? "A declared task check failed on the recorded candidate."
						: "A declared task check changed the recorded candidate.";
				} else if (request.judgment) {
					let review: ReviewEvidence;
					try {
						review = await this.runReview(
							handle,
							request.judgment.criterion,
							attempt.waveBase,
							worker.candidate,
							task.judgmentLaunchKey!,
							"preliminary",
							scope,
							task.taskId,
						);
					} catch (error) {
						this.attention(task, `Preliminary review was ambiguous and cannot trigger correction: ${errorText(error)}`);
						await this.terminateSettledWorker(handle, task, workerId, worker.candidate, scope);
						return;
					}
					attempt.preliminaryReview = review;
					await handle.save();
					if (!review.passed) {
						this.attention(task, sameIdentity(review.identityAfter, worker.candidate)
							? "Preliminary Reviewer did not return exact PASS; correction requires deliberate verification."
							: "Preliminary Reviewer changed the recorded candidate; correction is forbidden.");
						await this.terminateSettledWorker(handle, task, workerId, worker.candidate, scope);
						return;
					}
					failure = undefined;
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
		task: TaskState,
		workerId: string,
		candidate: WorkspaceIdentity,
		scope: DeadlineScope,
	): Promise<boolean> {
		const attempt = latestAttempt(task);
		attempt.termination = { status: "terminating", workerId, candidate };
		await handle.save();
		try {
			const result = await scope.call(async (context) => await this.runtime.terminateWorker({
				task: taskRequest(handle.state, task.taskId), attempt, workerId, candidate,
			}, context));
			if (result.outcome !== "terminated") {
				attempt.termination = { status: "unknown", workerId, candidate, failure: bounded(result.failure) };
				this.attention(task, `Worker termination is unproved: ${bounded(result.failure)}`);
				return false;
			}
			attempt.termination = { status: "terminated", workerId, candidate, at: this.runtime.now() };
			return true;
		} catch (error) {
			attempt.termination = { status: "unknown", workerId, candidate, failure: errorText(error) };
			this.attention(task, `Worker termination is unproved: ${errorText(error)}`);
			return false;
		} finally {
			await handle.save();
		}
	}

	private async runCheckBatch(
		checks: CheckCommand[],
		candidate: WorkspaceIdentity,
		phase: CheckBatchEvidence["phase"],
		scope: DeadlineScope,
		taskId?: string,
	): Promise<CheckBatchEvidence> {
		const result = await scope.call(async (context) => await this.runtime.runChecks({
			scope: phase === "final" ? "final" : "task",
			...(taskId ? { taskId } : {}),
			checks,
			candidate,
		}, context));
		const exact = exactCommandResults(result.results, checks);
		const evidence: CheckBatchEvidence = {
			phase,
			candidate,
			identityAfter: result.identityAfter,
			results: result.results.map((item): CommandEvidence => ({
				command: item.command,
				args: [...item.args],
				code: item.code,
				killed: item.killed ?? false,
				stdout: bounded(item.stdout),
				stderr: bounded(item.stderr),
			})),
			passed: exact
				&& sameIdentity(result.identityAfter, candidate)
				&& result.results.every((item) => item.code === 0 && !item.killed),
			at: this.runtime.now(),
		};
		return evidence;
	}

	private async runReview(
		handle: RunStateHandle,
		criterion: string,
		base: WorkspaceIdentity,
		tip: WorkspaceIdentity,
		recordKey: string,
		phase: ReviewEvidence["phase"],
		scope: DeadlineScope,
		taskId?: string,
	): Promise<ReviewEvidence> {
		const result = await scope.call(async (context) => await this.runtime.review({
			scope: phase === "final" ? "final" : "task",
			...(taskId ? { taskId } : {}),
			criterion,
			base,
			tip,
			launch: handle.state.launchRecords[recordKey]!,
		}, context));
		const evidence: ReviewEvidence = {
			phase,
			launchKey: recordKey,
			criterion,
			base,
			tip,
			identityAfter: result.identityAfter,
			verdict: bounded(result.verdict),
			passed: result.verdict.trim() === "PASS" && sameIdentity(result.identityAfter, tip),
			at: this.runtime.now(),
		};
		return evidence;
	}

	private async integrateTask(handle: RunStateHandle, task: TaskState, scope: DeadlineScope): Promise<boolean> {
		const state = handle.state;
		const request = taskRequest(state, task.taskId);
		const attempt = latestAttempt(task);
		if (attempt.termination?.status !== "terminated" || !attempt.candidate) {
			this.attention(task, "Task cannot integrate before exact worker termination and candidate recording.");
			return false;
		}
		task.status = "integrating";
		await handle.save();
		try {
			const actualMain = await scope.call(async (context) => await this.runtime.inspectMain({ root: state.root }, context));
			if (!sameIdentity(actualMain, state.main)) {
				this.attention(task, "Main drifted before integration.");
				return false;
			}
			const rebased = await scope.call(async (context) => await this.runtime.rebase({
				task: request,
				attempt,
				candidate: attempt.candidate!,
				onto: state.main,
			}, context));
			if (rebased.outcome !== "ready") {
				this.attention(task, rebased.failure);
				return false;
			}
			if (!sameIdentity(rebased.base, state.main) || !isCleanCommitted(rebased.candidate)) {
				this.attention(task, "Rebase did not return the exact recorded integration base and a clean committed candidate.");
				return false;
			}
			attempt.integrationBase = rebased.base;
			attempt.integrationCandidate = rebased.candidate;
			const checks = await this.runCheckBatch(request.checks, rebased.candidate, "authoritative", scope, task.taskId);
			attempt.authoritativeChecks = checks;
			await handle.save();
			if (!checkBatchPasses(checks, request.checks, rebased.candidate)) {
				this.attention(task, "Authoritative checks did not pass on the exact integration candidate.");
				return false;
			}
			let review: ReviewEvidence | undefined;
			if (request.judgment) {
				review = await this.runReview(
					handle,
					request.judgment.criterion,
					rebased.base,
					rebased.candidate,
					task.judgmentLaunchKey!,
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
			attempt.integration = { status: "integrating", expectedMain: state.main, candidate: rebased.candidate };
			await handle.save();
			let integrated: IntegrationResult;
			try {
				integrated = await scope.call(async (context) => await this.runtime.integrate({
					task: request,
					attempt,
					expectedMain: state.main,
					candidate: rebased.candidate,
					checks,
					...(review ? { review } : {}),
				}, context));
			} catch (error) {
				attempt.integration = {
					status: "unknown", expectedMain: state.main, candidate: rebased.candidate,
					failure: `Integration result is unknown: ${errorText(error)}`,
				};
				this.attention(task, attempt.integration.failure!);
				return false;
			}
			if (integrated.outcome !== "integrated") {
				attempt.integration = {
					status: integrated.outcome === "unknown" ? "unknown" : "failed",
					expectedMain: state.main,
					candidate: rebased.candidate,
					failure: bounded(integrated.failure),
				};
				this.attention(task, integrated.failure);
				return false;
			}
			if (integrated.main.branch !== state.main.branch
				|| integrated.main.head !== rebased.candidate.head
				|| !isCleanCommitted(integrated.main)) {
				attempt.integration = {
					status: "unknown", expectedMain: state.main, candidate: rebased.candidate, mainAfter: integrated.main,
					failure: "Integration returned an unexpected Main identity.",
				};
				this.attention(task, attempt.integration.failure!);
				return false;
			}
			attempt.integration = {
				status: "integrated", expectedMain: state.main, candidate: rebased.candidate, mainAfter: integrated.main,
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

	private async runCleanup(handle: RunStateHandle, task: TaskState, attempt: TaskAttempt, scope: DeadlineScope): Promise<boolean> {
		for (const step of attempt.cleanup) {
			if (step.status === "completed") continue;
			step.status = "running";
			step.failure = undefined;
			await handle.save();
			try {
				const result: unknown = await scope.call(async (context) => await this.cleanupRuntime.cleanup({
					kind: step.kind,
					task: taskRequest(handle.state, task.taskId),
					attempt,
				}, context));
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
		task: TaskState,
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

	private async verifyRetainedTask(handle: RunStateHandle, task: TaskState, scope: DeadlineScope): Promise<RunResponse> {
		const attempt = latestAttempt(task);
		if (attempt.integration?.status === "unknown") throw new Error("An unknown integration result cannot be adopted or reintegrated automatically.");
		if (attempt.termination?.status !== "terminated") throw new Error("Manual verification requires exact recorded worker termination.");
		const candidate = await scope.call(async (context) => await this.runtime.inspectRetainedTask({
			task: taskRequest(handle.state, task.taskId), attempt,
		}, context));
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

	private async retry(handle: RunStateHandle, task: TaskState, scope: DeadlineScope): Promise<RunResponse> {
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
				throw new Error("An ambiguous delivered prompt is never replayed.");
			}
			if (!correctionEligible(taskRequest(handle.state, task.taskId), attempt)) {
				throw new Error("The same-agent correction is unavailable or already used.");
			}
			task.status = "working";
			await this.driveWorker(handle, task, scope, "correction");
		} else {
			for (const intent of attempt.allocations.filter((item) => item.status !== "owned")) {
				let result: AllocationReconciliation;
				try {
					result = await scope.call(async (context) => await this.runtime.reconcileAllocation({
						intent, task: taskRequest(handle.state, task.taskId), attempt,
					}, context));
				} catch (error) {
					intent.status = "unknown";
					intent.failure = `Allocation reconciliation is ambiguous: ${errorText(error)}`;
					throw new Error(intent.failure);
				}
				if (result.outcome !== "absent") {
					intent.status = "unknown";
					intent.failure = bounded(result.failure);
					intent.possibleResources = result.possibleResources?.map((item) => bounded(item));
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
		if ((task as TaskState).status === "ready_to_integrate" && !await this.integrateTask(handle, task, scope)) {
			handle.state.status = "needs_attention";
			return this.response(handle.state);
		}
		if ((task as TaskState).status !== "completed") {
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
			const actual = await scope.call(async (context) => await this.runtime.inspectMain({ root: state.root }, context));
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
			const identity = state.final.identity ?? await scope.call(async (context) => await this.runtime.inspectMain({ root: state.root }, context));
			if (!sameIdentity(identity, state.main) || !isCleanCommitted(identity)) {
				await this.markSuperseded(handle, "Main drifted before the final gate.");
				return this.response(state);
			}
			state.final.identity = identity;
			await handle.save();
			const checks = await this.runCheckBatch(state.request.finalChecks, identity, "final", scope);
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
			const afterChecks = await scope.call(async (context) => await this.runtime.inspectMain({ root: state.root }, context));
			if (!sameIdentity(afterChecks, identity)) {
				await this.markSuperseded(handle, "Main drifted after final checks.");
				return this.response(state);
			}
			if (state.request.finalJudgment) {
				const key = launchKey("reviewer", state.request.finalJudgment.modelClass);
				const review = await this.runReview(
					handle,
					state.request.finalJudgment.criterion,
					state.requestStartMain,
					identity,
					key,
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
			const afterJudgment = await scope.call(async (context) => await this.runtime.inspectMain({ root: state.root }, context));
			if (!sameIdentity(afterJudgment, identity)) {
				await this.markSuperseded(handle, "Main drifted after final judgment.");
				return this.response(state);
			}
			const beforeAcceptance = await scope.call(async (context) => await this.runtime.inspectMain({ root: state.root }, context));
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
			state.final.failure = isDeadline(error, scope) ? "The productive request deadline expired during the final gate." : `Final gate was interrupted without a definitive result: ${errorText(error)}`;
			state.status = "needs_attention";
			state.accepted = false;
			await handle.save();
			return this.response(state);
		}
	}

	private async markFinalFailed(handle: RunStateHandle, failure: string): Promise<void> {
		handle.state.final.status = "final_failed";
		handle.state.final.failure = failure;
		handle.state.status = "final_failed";
		handle.state.accepted = false;
		await handle.save();
	}

	private async markSuperseded(handle: RunStateHandle, failure: string): Promise<void> {
		handle.state.final.status = "superseded";
		handle.state.final.failure = failure;
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
					&& !correctionEligible(taskRequest(state, task.taskId), attempt)) {
					const workerId = allocationByKind(attempt, "agent")?.resourceId;
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
		task.status = "needs_attention";
		task.failure = bounded(failure);
	}

	private response(state: RunState): RunResponse {
		const completed = state.tasks.filter((task) => task.status === "completed").length;
		const attention = state.tasks.find((task) => task.status === "needs_attention");
		let continuation: ResumeRequest | undefined;
		if (!terminal(state) && completed === state.tasks.length
			&& (state.final.status === "pending" || state.final.status === "interrupted")) {
			continuation = { id: state.request.id, action: "finalize" };
		} else if (!terminal(state) && attention?.attempts.length === 0) {
			continuation = { id: state.request.id, action: "retry", taskId: attention.taskId };
		} else if (!terminal(state) && attention?.attempts.at(-1)?.integration?.status === "integrated") {
			continuation = { id: state.request.id, action: "verify", taskId: attention.taskId };
		} else if (!terminal(state)
			&& attention?.attempts.at(-1)?.termination?.status === "terminated"
			&& attention.attempts.at(-1)?.integration?.status !== "unknown") {
			continuation = { id: state.request.id, action: "verify", taskId: attention.taskId };
		}
		return {
			text: bounded([
				`Pi Orchestrator ${state.request.id}: ${state.status}.`,
				`Tasks: ${completed}/${state.tasks.length} completed. Accepted: ${state.accepted}.`,
				...(attention?.failure ? [`Needs attention (${attention.taskId}): ${attention.failure}`] : []),
				...(state.final.failure ? [`Final: ${state.final.failure}`] : []),
				...(continuation ? [`Continuation: ${JSON.stringify(continuation)}`] : []),
			].join("\n")),
			state,
			...(continuation ? { continuation } : {}),
		};
	}
}
