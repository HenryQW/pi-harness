import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { acknowledgeRequiredGate, reconcileRequiredGateProcess, recordedGateEvidence, requiredGateProcessPath, runCommand, type CommandRunner } from "./command.ts";
import { findManagedSubagentTab, managedSubagentWorkspaceId, retireManagedSubagentTab } from "@henryqw/pi-subagent";
import { amendRequiredGateCommand, isRetryableFinalGate, retryableFinalGate, type GateCommandAmendmentRequest } from "./final-gate.ts";
import { resolveFinalRepair } from "./final-repair.ts";
import { resolveGitTopLevel } from "./git.ts";
import { assertRunBoundary, startLocalRun } from "./intake.ts";
import type { ProjectConfig, RequiredGateEvidence, RunState, RunTaskState, WorkerEnvelope } from "./model.ts";
import { abortRun, cleanupRun, initializeOrchestration, parseWorkerEnvelope, preflightRunEnvelope, resumeRun, type OrchestrationOptions } from "./orchestration.ts";
import { preflightPrHealthEnvelope, runPrHealth } from "./pr-health.ts";
import { WorkerEnvelopeRejectedError, writeWorkerReceipt } from "./review-ticket.ts";
import { recordGateExecution } from "./review.ts";
import { claimActiveRun, hasAcceptedWorkerEvent, readActiveRun, readActiveRunId, readRunState, releaseActiveRun, replaceTask, type Uuid, writeRunState } from "./state.ts";
import { nonEmptyString } from "./validate.ts";
import { workerHost, workerHostOptions, type RoleLaunchResolver } from "./worker.ts";

export interface CoreLifecycleOptions {
	runner?: CommandRunner;
	uuid?: Uuid;
	now?: () => string;
	mainPane?: () => string | undefined;
	delay?: (milliseconds: number) => Promise<void>;
	resolveLaunch?: RoleLaunchResolver;
}

export interface CoreLifecycle {
	start(mainWorktree: string, mainPane?: string): Promise<RunState>;
	status(mainWorktree: string, runId?: string): Promise<RunState | undefined>;
	resume(mainWorktree: string, envelope?: unknown): Promise<RunState>;
	retryGate(mainWorktree: string, reason: string, expectedEvidence: RequiredGateEvidence): Promise<RunState>;
	resolve(mainWorktree: string, issueId: string, resolution: string, amendment?: GateCommandAmendmentRequest): Promise<RunState>;
	abort(mainWorktree: string, reason?: string): Promise<RunState>;
	health(mainWorktree: string, runId: string, envelope?: unknown): Promise<RunState>;
}

// ponytail: same-process serialization; add a cross-process lock only if callers span processes.
const lifecycleMutationTails = new Map<string, Promise<void>>();

export function createCoreLifecycle(options: CoreLifecycleOptions = {}): CoreLifecycle {
	const runner = options.runner ?? runCommand;
	const uuid = options.uuid ?? randomUUID;
	const orchestration: OrchestrationOptions = {
		runner,
		uuid,
		now: options.now,
		delay: options.delay,
		resolveLaunch: options.resolveLaunch ?? (() => { throw new Error("Auto DAG launch resolver is unavailable"); }),
	};
	return {
		async start(mainWorktree, mainPane) {
			return await withLifecycleMutation(mainWorktree, runner, async (root) => {
				const pane = nonEmptyString(mainPane ?? options.mainPane?.(), "main Herdr pane");
				const workspaceId = await managedSubagentWorkspaceId(root, pane, { execute: runner });
				const state = await startLocalRun({
					mainWorktree: root,
					runner,
					uuid,
					now: options.now,
					mainPane: pane,
					workspaceId,
				});
				return await completeSuccessfulRun(await blockOnFailure(state, uuid, async () => await initializeOrchestration(state, pane, orchestration)), orchestration);
			});
		},

		async status(mainWorktree, runId) {
			const root = await resolveGitTopLevel(mainWorktree, runner);
			return runId ? readRunState(root, runId) : readActiveRun(root);
		},

		async resume(mainWorktree, envelope) {
			return await withLifecycleMutation(mainWorktree, runner, async (root) => {
				let state = await readActiveRun(root);
				let workerEnvelope: WorkerEnvelope | undefined;
				if (state.phase !== "aborted" && envelope !== undefined) {
					await blockOnFailure(state, uuid, async () => {
						workerEnvelope = parseWorkerEnvelope(parseEnvelope(envelope));
						return state;
					});
					if (state.health && hasAcceptedWorkerEvent(state, workerEnvelope!)
						&& state.graph.issues.some((issue) => issue.id === workerEnvelope!.issue_id)) {
						const { receiptPath } = await preflightRunEnvelope(state, workerEnvelope!, orchestration);
						await writeWorkerReceipt(receiptPath, { event_id: workerEnvelope!.event_id, status: "accepted" }, uuid);
						return state.health.status === "completed"
							? await releaseCompletedHealth(state, uuid, orchestration)
							: state;
					}
					await blockOnFailure(state, uuid, async () => {
						if (state.health) await preflightPrHealthEnvelope(state, workerEnvelope!, orchestration);
						else await preflightRunEnvelope(state, workerEnvelope!, orchestration);
						return state;
					});
				}
				state = await reconcileGate(state, orchestration);
				if (state.phase !== "aborted" && state.health) {
					if (state.health.status === "completed" && !workerEnvelope) {
						return await releaseCompletedHealth(state, uuid, orchestration);
					}
					return await continueRetainedHealth(state, workerEnvelope, orchestration);
				}
				const next = state.phase === "aborted"
					? await resumeRun(state, undefined, orchestration)
					: await blockOnFailure(state, uuid, async () => await resumeRun(state, workerEnvelope, orchestration));
				if (next.phase === "aborted" && !next.cleanup_blocks?.length) {
					await releaseActiveRun(next.main_worktree, next.run_id);
				}
				return await completeSuccessfulRun(next, orchestration);
			});
		},

		async retryGate(mainWorktree, reason, expectedEvidence) {
			return await withLifecycleMutation(mainWorktree, runner, async (root) => {
				let state = await readActiveRun(root);
				state = await reconcileGate(state, orchestration);
				await guardBoundary(state, runner, uuid);
				const { issue, evidence } = retryableFinalGate(state);
				if (!isDeepStrictEqual(evidence, expectedEvidence)) {
					throw new Error("Final Check Required Gate evidence changed during infrastructure retry approval");
				}
				const invalidation = {
					invalidated_at: options.now?.() ?? new Date().toISOString(),
					reason: nonEmptyString(reason, "infrastructure retry reason"),
					evidence,
				};
				const current = clearFailedGateEvidence(state.tasks[issue.id]);
				const {
					block_reason: _taskBlockReason,
					blocked_role: _blockedRole,
					activity_started_at: _activityStartedAt,
					resolution_pending: _resolutionPending,
					...pending
				} = current;
				const { block_reason: _runBlockReason, ...unblocked } = state;
				const next = replaceTask({ ...unblocked, phase: "execution" }, issue.id, {
					...pending,
					status: "pending",
					required_gate_invalidations: [...(current.required_gate_invalidations ?? []), invalidation],
				});
				await writeRunState(state.main_worktree, next, uuid);
				return await completeSuccessfulRun(
					await blockOnFailure(next, uuid, async () => await resumeRun(next, undefined, orchestration)),
					orchestration,
				);
			});
		},

		async resolve(mainWorktree, issueId, resolution, amendment) {
			return await withLifecycleMutation(mainWorktree, runner, async (root) => {
				let state = await readActiveRun(root);
				state = await reconcileGate(state, orchestration);
				if (state.phase === "aborted" || state.phase === "completed") {
					throw new Error(`Cannot resolve a ${state.phase} run`);
				}
				const config = await guardBoundary(state, runner, uuid);
				const id = nonEmptyString(issueId, "resolution issue_id");
				if (!state.tasks[id]) throw new Error(`Run does not contain Local Issue: ${id}`);
				if (!amendment && id === "final-check" && isRetryableFinalGate(state)) {
					throw new Error("Infrastructure-invalid Final Check must use auto_dag_retry_gate");
				}
				if (amendment) {
					state = amendRequiredGateCommand(
						state,
						id,
						resolution,
						amendment,
						options.now?.() ?? new Date().toISOString(),
					);
				}
				const prResolved = amendment ? undefined : await resolveFinalRepair(state, id, resolution, config, orchestration);
				if (prResolved) return await completeSuccessfulRun(prResolved, orchestration);
				let current = state.tasks[id];
				const reviewerBlocked = current.status === "blocked" && current.blocked_role === "reviewer";
				const reviewRound = current.review_rounds ?? 0;
				if (reviewerBlocked && reviewRound >= config.max_review_rounds) {
					const reason = `Review rounds exceed configured maximum of ${config.max_review_rounds}`;
					const next = replaceTask({
						...state,
						phase: "blocked",
						block_reason: `Local Issue ${id} blocked: ${reason}`,
						resolutions: { ...state.resolutions, [id]: nonEmptyString(resolution, "resolution") },
					}, id, { ...current, block_reason: reason });
					await writeRunState(state.main_worktree, next, uuid);
					return next;
				}
				if (["starting", "implementing", "reviewing", "repairing", "repair_reviewing"].includes(current.status)) {
					current = await retireActiveTaskWorker(state, current, orchestration);
				}
				current = clearFailedGateEvidence(current);
				const { block_reason: _taskBlockReason, blocked_role, activity_started_at: _activityStartedAt, ...resolvedTask } = current;
				const resolved: RunTaskState = current.status === "blocked"
					? {
						...resolvedTask,
						status: blocked_role === "reviewer" ? "reviewing" : current.worktree ? "implementing" : "pending",
						...((blocked_role || current.worktree) ? { activity_started_at: options.now?.() ?? new Date().toISOString() } : {}),
						...(reviewerBlocked ? { review_rounds: reviewRound + 1 } : {}),
						...(blocked_role === "implementer" ? { attempts: current.attempts + 1 } : {}),
						resolution_pending: true,
					}
					: ["starting", "implementing", "reviewing", "repairing", "repair_reviewing"].includes(current.status)
						? { ...current, resolution_pending: true }
						: current;
				const updated = replaceTask({
					...state,
					resolutions: { ...state.resolutions, [id]: nonEmptyString(resolution, "resolution") },
				}, id, resolved);
				const unresolved = Boolean(updated.cleanup_blocks?.length) || Object.values(updated.tasks).some((candidate) => candidate.status === "blocked");
				const base: RunState = { ...updated, phase: unresolved ? "blocked" : "execution" };
				const { block_reason: _runBlockReason, ...unblocked } = base;
				const next = unresolved ? base : unblocked;
				await writeRunState(state.main_worktree, next, uuid);
				return await completeSuccessfulRun(await blockOnFailure(next, uuid, async () => await resumeRun(next, undefined, orchestration)), orchestration);
			});
		},

		async abort(mainWorktree, reason) {
			return await withLifecycleMutation(mainWorktree, runner, async (root) => {
				let state = await readActiveRun(root);
				state = await reconcileGate(state, orchestration);
				const next: RunState = {
					...state,
					phase: "aborted",
					...(reason?.trim() ? { abort_reason: reason.trim() } : {}),
				};
				await writeRunState(state.main_worktree, next, uuid);
				const cleaned = await abortRun(next, orchestration);
				if (cleaned.cleanup_blocks?.length) return cleaned;
				await releaseActiveRun(cleaned.main_worktree, cleaned.run_id);
				return cleaned;
			});
		},

		async health(mainWorktree, runId, envelope) {
			return await withLifecycleMutation(mainWorktree, runner, async (root) => {
				const id = nonEmptyString(runId, "health run_id");
				const active = await readActiveRunId(root);
				if (active && active !== id) throw new Error(`Cannot run PR health for retained run ${id} while active run ${active} exists`);
				let state = await readRunState(root, id);
				if (!state) throw new Error(`No pi-auto-dag run found: ${runId}`);
				const cleanupPending = state.phase === "blocked" && Boolean(state.cleanup_blocks?.length);
				if (!state.pr || (state.phase !== "completed" && !cleanupPending && !(state.phase === "blocked" && state.health))) {
					throw new Error("PR health requires a completed retained run with an integration PR");
				}
				let workerEnvelope: WorkerEnvelope | undefined;
				if (envelope !== undefined) {
					const preflightState = state;
					await blockOnFailure(preflightState, uuid, async () => {
						workerEnvelope = parseWorkerEnvelope(parseEnvelope(envelope));
						await preflightPrHealthEnvelope(preflightState, workerEnvelope, orchestration);
						return preflightState;
					});
				}
				if (active === id) state = await reconcileGate(state, orchestration);
				if (active === id && state.health?.status === "completed" && !workerEnvelope) {
					return await releaseCompletedHealth(state, uuid, orchestration);
				}
				await claimActiveRun(root, id);
				return await continueRetainedHealth(
					state,
					workerEnvelope,
					orchestration,
				);
			});
		},
	};
}

async function withLifecycleMutation<T>(mainWorktree: string, runner: CommandRunner, action: (root: string) => Promise<T>): Promise<T> {
	const root = await resolveGitTopLevel(mainWorktree, runner);
	const previous = lifecycleMutationTails.get(root) ?? Promise.resolve();
	let release!: () => void;
	const pending = new Promise<void>((done) => { release = done; });
	const tail = previous.then(() => pending);
	lifecycleMutationTails.set(root, tail);
	await previous;
	try {
		return await action(root);
	} finally {
		release();
		if (lifecycleMutationTails.get(root) === tail) lifecycleMutationTails.delete(root);
	}
}

async function retireActiveTaskWorker(
	state: RunState,
	current: RunTaskState,
	options: OrchestrationOptions,
): Promise<RunTaskState> {
	const tabId = current.tab_id ?? (current.implementer_provisioning_id
		? (await findManagedSubagentTab(workerHost(state), current.implementer_provisioning_id, workerHostOptions(options)))?.tabId
		: undefined);
	if (tabId) await retireManagedSubagentTab(workerHost(state), tabId, workerHostOptions(options));
	const {
		tab_id: _tabId,
		implementer_pane: _implementerPane,
		reviewer_pane: _reviewerPane,
		tab_cleanup_done: _tabCleanupDone,
		...retired
	} = current;
	return retired;
}

function clearFailedGateEvidence(current: RunTaskState): RunTaskState {
	if (current.review_exit_code === undefined || current.review_exit_code === 0) return current;
	const {
		review_command: _command,
		review_commit: _commit,
		review_exit_code: _exitCode,
		review_stdout: _stdout,
		review_stderr: _stderr,
		...cleared
	} = current;
	return cleared;
}

async function reconcileGate(state: RunState, options: OrchestrationOptions): Promise<RunState> {
	const path = requiredGateProcessPath(state.main_worktree, state.run_id);
	const execution = await reconcileRequiredGateProcess(options.runner, path, options.delay);
	if (!execution?.handoff) return state;
	const target = execution.handoff.target;
	const owner = target.kind === "task" ? state.tasks[target.issue_id] : state.health;
	if (!owner) throw new Error(`Completed required gate target is missing: ${target.kind} ${target.issue_id}`);
	const evidence = recordedGateEvidence(owner, execution.commit);
	if (evidence) {
		if (evidence.command !== execution.command || evidence.exit_code !== execution.exit_code) {
			throw new Error("Completed required gate handoff conflicts with saved evidence");
		}
		await acknowledgeRequiredGate(path, execution);
		return state;
	}
	return await recordGateExecution(state, target, execution, options.uuid);
}

async function guardBoundary(
	state: RunState,
	runner: CommandRunner,
	uuid: Uuid,
): Promise<ProjectConfig> {
	try {
		return await assertRunBoundary(state, runner);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		await writeRunState(state.main_worktree, { ...state, phase: "blocked", block_reason: message }, uuid);
		throw error;
	}
}

async function continueRetainedHealth(
	state: RunState,
	envelope: WorkerEnvelope | undefined,
	orchestration: OrchestrationOptions,
): Promise<RunState> {
	if (state.phase === "completed" || state.cleanup_blocks?.length) {
		state = await retryCompletedRunCleanup(state, orchestration.uuid, orchestration);
		if (state.cleanup_blocks?.length) return state;
	}
	if (state.phase === "blocked") {
		const { block_reason: _blockReason, ...unblocked } = state;
		state = { ...unblocked, phase: "completed" };
		await writeRunState(state.main_worktree, state, orchestration.uuid);
	}
	state = await runPrHealth(state, envelope, orchestration);
	return state.health?.status === "completed" ? await releaseCompletedHealth(state, orchestration.uuid, orchestration) : state;
}

async function releaseCompletedHealth(state: RunState, uuid: Uuid, orchestration: OrchestrationOptions): Promise<RunState> {
	state = await retryCompletedRunCleanup(state, uuid, orchestration);
	if (state.phase !== "completed" || state.cleanup_blocks?.length) return state;
	await releaseActiveRun(state.main_worktree, state.run_id);
	return state;
}

async function blockOnFailure(state: RunState, uuid: Uuid, action: () => Promise<RunState>): Promise<RunState> {
	try {
		return await action();
	} catch (error) {
		if (error instanceof WorkerEnvelopeRejectedError) throw error;
		const message = error instanceof Error ? error.message : String(error);
		const latest = await readRunState(state.main_worktree, state.run_id) ?? state;
		const next = { ...latest, phase: "blocked" as const, block_reason: message };
		await writeRunState(state.main_worktree, next, uuid);
		throw error;
	}
}

async function completeSuccessfulRun(state: RunState, orchestration: OrchestrationOptions): Promise<RunState> {
	if (state.phase !== "completed") return state;
	const cleaned = await retryCompletedRunCleanup(state, orchestration.uuid, orchestration);
	if (cleaned.phase !== "completed" || cleaned.cleanup_blocks?.length) return cleaned;
	if (await readActiveRunId(cleaned.main_worktree) === cleaned.run_id) {
		await releaseActiveRun(cleaned.main_worktree, cleaned.run_id);
	}
	return cleaned;
}

/** A completed run stays retained until its ordinary task cleanup has finished. */
async function retryCompletedRunCleanup(state: RunState, uuid: Uuid, orchestration: OrchestrationOptions): Promise<RunState> {
	if (state.phase !== "completed" && !state.cleanup_blocks?.length) return state;
	state = await cleanupRun(state, orchestration);
	if (state.cleanup_blocks?.length || state.phase !== "execution") return state;
	const { block_reason: _blockReason, ...unblocked } = state;
	state = { ...unblocked, phase: "completed" };
	await writeRunState(state.main_worktree, state, uuid);
	return state;
}

function parseEnvelope(value: unknown): unknown {
	if (typeof value !== "string") return value;
	try {
		return JSON.parse(value);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Worker envelope is not valid JSON: ${message}`);
	}
}
