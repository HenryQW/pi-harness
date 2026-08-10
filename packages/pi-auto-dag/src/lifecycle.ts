import { randomUUID } from "node:crypto";
import { reconcileRequiredGateProcess, requiredGateProcessPath, runCommand, type CommandRunner } from "./command.ts";
import { resolveFinalRepair } from "./final-repair.ts";
import { resolveGitTopLevel } from "./git.ts";
import { assertRunBoundary, startLocalRun } from "./intake.ts";
import type { ProjectConfig, RunState, RunTaskState } from "./model.ts";
import { abortRun, cleanupRun, initializeOrchestration, parseWorkerEnvelope, resumeRun, type OrchestrationOptions } from "./orchestration.ts";
import { runPrHealth } from "./pr-health.ts";
import { claimActiveRun, readActiveRun, readActiveRunId, readRunState, releaseActiveRun, replaceTask, type Uuid, writeRunState } from "./state.ts";
import { nonEmptyString } from "./validate.ts";
import { workerWorkspaceId } from "./worker-host.ts";

export interface CoreLifecycleOptions {
	runner?: CommandRunner;
	uuid?: Uuid;
	now?: () => string;
	mainPane?: () => string | undefined;
	delay?: (milliseconds: number) => Promise<void>;
}

export interface CoreLifecycle {
	start(mainWorktree: string, mainPane?: string): Promise<RunState>;
	status(mainWorktree: string, runId?: string): Promise<RunState | undefined>;
	resume(mainWorktree: string, envelope?: unknown): Promise<RunState>;
	resolve(mainWorktree: string, issueId: string, resolution: string): Promise<RunState>;
	abort(mainWorktree: string, reason?: string): Promise<RunState>;
	health(mainWorktree: string, runId: string, envelope?: unknown): Promise<RunState>;
}

// ponytail: same-process serialization; add a cross-process lock only if callers span processes.
const lifecycleMutationTails = new Map<string, Promise<void>>();

export function createCoreLifecycle(options: CoreLifecycleOptions = {}): CoreLifecycle {
	const runner = options.runner ?? runCommand;
	const uuid = options.uuid ?? randomUUID;
	const orchestration: OrchestrationOptions = { runner, uuid, now: options.now, delay: options.delay };
	return {
		async start(mainWorktree, mainPane) {
			return await withLifecycleMutation(mainWorktree, runner, async (root) => {
				const pane = nonEmptyString(mainPane ?? options.mainPane?.(), "main Herdr pane");
				const workspaceId = await workerWorkspaceId(root, pane, { runner });
				const state = await startLocalRun({ mainWorktree: root, runner, uuid, now: options.now, mainPane: pane, workspaceId });
				return await completeSuccessfulRun(await blockOnFailure(state, uuid, async () => await initializeOrchestration(state, pane, orchestration)), orchestration);
			});
		},

		async status(mainWorktree, runId) {
			const root = await resolveGitTopLevel(mainWorktree, runner);
			return runId ? readRunState(root, runId) : readActiveRun(root);
		},

		async resume(mainWorktree, envelope) {
			return await withLifecycleMutation(mainWorktree, runner, async (root) => {
				const state = await readActiveRun(root);
				await reconcileGate(state, orchestration);
				if (state.phase !== "aborted" && state.health) {
					if (state.health.status === "completed") {
						return await releaseCompletedHealth(state, uuid, orchestration);
					}
					return await continueRetainedHealth(state, envelope, orchestration);
				}
				const next = state.phase === "aborted"
					? await resumeRun(state, undefined, orchestration)
					: await blockOnFailure(state, uuid, async () => await resumeRun(state, parseEnvelope(envelope), orchestration));
				if (next.phase === "aborted" && !next.cleanup_blocks?.length) {
					await releaseActiveRun(next.main_worktree, next.run_id);
				}
				return await completeSuccessfulRun(next, orchestration);
			});
		},

		async resolve(mainWorktree, issueId, resolution) {
			return await withLifecycleMutation(mainWorktree, runner, async (root) => {
				const state = await readActiveRun(root);
				await reconcileGate(state, orchestration);
				if (state.phase === "aborted" || state.phase === "completed") {
					throw new Error(`Cannot resolve a ${state.phase} run`);
				}
				const config = await guardBoundary(state, runner, uuid);
				const id = nonEmptyString(issueId, "resolution issue_id");
				if (!state.tasks[id]) throw new Error(`Run does not contain Local Issue: ${id}`);
				const prResolved = await resolveFinalRepair(state, id, resolution, config, orchestration);
				if (prResolved) return await completeSuccessfulRun(prResolved, orchestration);
				const current = state.tasks[id];
				const { block_reason: _taskBlockReason, blocked_role, activity_started_at: _activityStartedAt, ...resolvedTask } = current;
				const reviewerBlocked = current.status === "blocked" && blocked_role === "reviewer";
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
				const resolved: RunTaskState = current.status === "blocked"
					? {
						...resolvedTask,
						status: blocked_role === "reviewer" ? "reviewing" : current.worktree ? "implementing" : "pending",
						...((blocked_role || current.worktree) ? { activity_started_at: options.now?.() ?? new Date().toISOString() } : {}),
						...(reviewerBlocked ? { review_rounds: reviewRound + 1 } : {}),
						resolution_pending: true,
					}
					: ["starting", "implementing", "reviewing"].includes(current.status)
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
				const state = await readActiveRun(root);
				await reconcileGate(state, orchestration);
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
				const state = await readRunState(root, id);
				if (!state) throw new Error(`No pi-auto-dag run found: ${runId}`);
				if (active === id) await reconcileGate(state, orchestration);
				if (active === id && state.health?.status === "completed") {
					return await releaseCompletedHealth(state, uuid, orchestration);
				}
				const cleanupPending = state.phase === "blocked" && Boolean(state.cleanup_blocks?.length);
				if (!state.pr || (state.phase !== "completed" && !cleanupPending && !(state.phase === "blocked" && state.health))) {
					throw new Error("PR health requires a completed retained run with an integration PR");
				}
				await claimActiveRun(root, id);
				return await continueRetainedHealth(
					state,
					envelope,
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

async function reconcileGate(state: RunState, options: OrchestrationOptions): Promise<void> {
	await reconcileRequiredGateProcess(
		options.runner,
		requiredGateProcessPath(state.main_worktree, state.run_id),
		options.delay,
	);
}

async function guardBoundary(state: RunState, runner: CommandRunner, uuid: Uuid): Promise<ProjectConfig> {
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
	envelope: unknown,
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
	state = await runPrHealth(
		state,
		envelope === undefined ? undefined : parseWorkerEnvelope(parseEnvelope(envelope)),
		orchestration,
	);
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
