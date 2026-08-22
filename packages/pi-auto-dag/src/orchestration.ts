import { commandFailure, commandOutput, errorMessage, type CommandRunner } from "./command.ts";
import { findManagedSubagentTab, retireManagedSubagentTab } from "@henryqw/pi-subagent";
import { cleanupFinalRepair, resumeFinalRepair } from "./final-repair.ts";
import { executionIssues } from "./graph.ts";
import {
	assertTaskBranch,
	childBranch,
	childWorktreePath,
	ensureImplementer,
	ensureReviewer,
	ensureWorktree,
	provisioningIdFor,
	reconcileWorkers,
	requiredTaskGate,
	taskReviewId,
	verifyReviewCommit,
} from "./implementation-workers.ts";
import { assertRunBoundary } from "./intake.ts";
import { assertAttachedBranch, deleteExpectedBranch, findAppliedCherryPick, readCurrentBranch, retireChildWorktree } from "./git.ts";
import type { CleanupBlock, LocalIssue, ProjectConfig, RunState, RunTaskState, SubmitReviewEnvelope, WorkerEnvelope } from "./model.ts";
import { cleanupPrHealth, resumePrHealth } from "./pr-health.ts";
import { acceptPrLifecycleEnvelope, advancePrLifecycle } from "./pr-lifecycle.ts";
import { hasAcceptedWorkerEvent, issueById, readRunState, recordAcceptedWorkerEvent, replaceTask, task, type Uuid } from "./state.ts";
import { actionTicketPath, assertActiveActionTicket, eventReceiptPath, readWorkerReceipt, rejectWorkerEnvelope, rotateRejectedActionTicket, WorkerEnvelopeRejectedError, writeWorkerReceipt } from "./review-ticket.ts";
import { WORKER_ROLE_EVENTS, workerAgentName, workerHost, workerHostOptions, type RoleLaunchResolver, type WorkerEvent, type WorkerRole } from "./worker.ts";
import { hasReviewFindings, saveRunState as save, timestamp } from "./worker-protocol.ts";
import { array, exactKeys, nonEmptyString, object, oneOf, positiveInteger, stringArray } from "./validate.ts";

export interface OrchestrationOptions {
	runner: CommandRunner;
	uuid: Uuid;
	now?: () => string;
	delay?: (milliseconds: number) => Promise<void>;
	resolveLaunch: RoleLaunchResolver;
}

type CleanupOperation = CleanupBlock["operation"];

/** A wave is frozen before work starts; only completed integration opens another one. */
export function deriveReadyIssueIds(state: RunState): string[] {
	return executionIssues(state.graph)
		.filter((issue) => issue.role === "implementation")
		.filter((issue) => task(state, issue.id).status === "pending")
		.filter((issue) => issue.blocked_by.every((id) => task(state, id).status === "completed"))
		.map((issue) => issue.id)
		.sort();
}

export async function initializeOrchestration(
	state: RunState,
	mainPane: string,
	options: OrchestrationOptions,
): Promise<RunState> {
	const pane = nonEmptyString(mainPane, "main Herdr pane");
	if (state.main_pane !== pane) throw new Error("Run state main Herdr pane does not match start pane");
	return await advanceRun(state, options);
}

export async function advanceRun(state: RunState, options: OrchestrationOptions): Promise<RunState> {
	await assertIntegrationBranch(state, options);
	state = await recoverAppliedIntegration(state, options);
	state = await retryCleanup(state, options);
	if (state.cleanup_blocks?.length) return state;
	if (state.phase === "aborted" || state.phase === "blocked" || state.phase === "completed") return state;
	return await advanceWithConfig(state, await assertRunBoundary(state, options.runner), options);
}

/** Validate a fresh event before recovery while allowing durable receipt/state replay first. */
export async function preflightRunEnvelope(
	state: RunState,
	envelope: WorkerEnvelope,
	options: OrchestrationOptions,
): Promise<{ receiptPath: string; receiptAccepted: boolean }> {
	const receiptPath = eventReceiptPath(state.main_worktree, state.run_id, envelope.event_id);
	const safeReceiptPath = envelope.receipt_path === receiptPath ? receiptPath : undefined;
	if (envelope.run_id !== state.run_id) {
		return await rejectWorkerEnvelope(safeReceiptPath, envelope.event_id, `Worker event belongs to another run: ${envelope.run_id}`, options.uuid);
	}
	const issue = executionIssues(state.graph).find((candidate) => candidate.id === envelope.issue_id);
	if (!issue) {
		return await rejectWorkerEnvelope(safeReceiptPath, envelope.event_id, `Run does not contain Local Issue: ${envelope.issue_id}`, options.uuid);
	}
	if (!safeReceiptPath) throw new Error("Worker receipt path does not belong to retained run");
	const existing = await readWorkerReceipt(receiptPath);
	if (existing && existing.event_id !== envelope.event_id) throw new Error("Worker receipt belongs to another event");
	if (existing?.status === "rejected") {
		await rotateEnvelopeActionTicket(state, envelope, options);
		throw new WorkerEnvelopeRejectedError(`Auto DAG event ${envelope.event_id} rejected: ${existing.reason ?? "lifecycle rejected event"}`);
	}
	const receiptAccepted = existing?.status === "accepted";
	const accepted = hasAcceptedWorkerEvent(state, envelope);
	if (receiptAccepted && !accepted) throw new Error(`Auto DAG event ${envelope.event_id} has an accepted receipt without matching state`);
	if (!accepted) {
		try {
			await assertActiveActionTicket(
				actionTicketPath(state.main_worktree, state.run_id, issue.id, issue.role === "final_check" ? "lifecycle" : "implementation", envelope.role),
				envelope,
			);
		} catch (error) {
			if (error instanceof WorkerEnvelopeRejectedError) {
				await writeWorkerReceipt(receiptPath, { event_id: envelope.event_id, status: "rejected", reason: errorMessage(error) }, options.uuid);
				await rotateEnvelopeActionTicket(state, envelope, options);
			}
			throw error;
		}
	}
	return { receiptPath, receiptAccepted };
}

/** Resume is the only ingress for worker events, so workers never write Run State. */
export async function resumeRun(
	state: RunState,
	envelope: unknown,
	options: OrchestrationOptions,
): Promise<RunState> {
	const workerEnvelope = envelope === undefined ? undefined : parseWorkerEnvelope(envelope);
	if (state.phase === "aborted") {
		const receiptPath = workerEnvelope ? eventReceiptPath(state.main_worktree, state.run_id, workerEnvelope.event_id) : undefined;
		if (workerEnvelope && workerEnvelope.receipt_path !== receiptPath) throw new Error("Worker receipt path does not belong to retained run");
		const existing = receiptPath ? await readWorkerReceipt(receiptPath) : undefined;
		if (existing && existing.event_id !== workerEnvelope!.event_id) throw new Error("Worker receipt belongs to another event");
		if (existing?.status === "rejected") {
			await rotateEnvelopeActionTicket(state, workerEnvelope!, options);
			throw new WorkerEnvelopeRejectedError(`Auto DAG event ${workerEnvelope!.event_id} rejected: ${existing.reason ?? "lifecycle rejected event"}`);
		}
		const receiptAccepted = existing?.status === "accepted";
		if (workerEnvelope && hasAcceptedWorkerEvent(state, workerEnvelope)) {
			if (!receiptAccepted) await writeWorkerReceipt(receiptPath!, { event_id: workerEnvelope.event_id, status: "accepted" }, options.uuid);
			return state;
		}
		if (receiptAccepted) throw new Error(`Auto DAG event ${workerEnvelope!.event_id} has an accepted receipt without matching state`);
		if (workerEnvelope) {
			await writeWorkerReceipt(receiptPath!, { event_id: workerEnvelope.event_id, status: "rejected", reason: "Run is aborted" }, options.uuid);
			throw new Error("Run is aborted");
		}
		return await abortRun(state, options);
	}
	const preflight = workerEnvelope ? await preflightRunEnvelope(state, workerEnvelope, options) : undefined;
	state = await resumeFinalRepair(state, options);
	if (state.health || state.health_fast_forward_intent) state = await resumePrHealth(state, options);
	const conflictedIssueId = await abortOwnedCherryPick(state, options);
	state = await recoverAppliedIntegration(state, options);
	const config = await assertRunBoundary(state, options.runner);
	if (conflictedIssueId) {
		const { block_reason: _blockReason, ...recovered } = state;
		return await replaceConflictedCommit(hasBlockedTask(state) ? state : { ...recovered, phase: "execution" }, conflictedIssueId, config, options);
	}
	if (state.phase === "blocked" && !state.cleanup_blocks?.length && !hasBlockedTask(state)) {
		const { block_reason: _blockReason, ...recovered } = state;
		state = await save({ ...recovered, phase: "execution" }, options);
	}
	if (workerEnvelope) {
		const accepted = hasAcceptedWorkerEvent(state, workerEnvelope);
		if (preflight!.receiptAccepted && !accepted) throw new Error(`Auto DAG event ${workerEnvelope.event_id} has an accepted receipt without matching state`);
		if (accepted) {
			state = await retryCleanup(state, options);
			if (!state.cleanup_blocks?.length && !hasBlockedTask(state)) state = await reconcileWorkers(state, config, options);
			if (!state.cleanup_blocks?.length && state.phase !== "blocked") state = await advanceWithConfig(state, config, options);
			await writeWorkerReceipt(preflight!.receiptPath, { event_id: workerEnvelope.event_id, status: "accepted" }, options.uuid);
			return state;
		}
		try {
			state = await acceptEnvelope(recordAcceptedWorkerEvent(state, workerEnvelope), workerEnvelope, config, options);
		} catch (error) {
			const persisted = await readRunState(state.main_worktree, state.run_id);
			if (!persisted || !hasAcceptedWorkerEvent(persisted, workerEnvelope)) {
				await writeWorkerReceipt(preflight!.receiptPath, { event_id: workerEnvelope.event_id, status: "rejected", reason: errorMessage(error) }, options.uuid);
				await rotateEnvelopeActionTicket(state, workerEnvelope, options);
			}
			throw error;
		}
		if (state.phase !== "blocked") state = await advanceWithConfig(state, config, options);
		state = await save(state, options);
		await writeWorkerReceipt(preflight!.receiptPath, { event_id: workerEnvelope.event_id, status: "accepted" }, options.uuid);
		return state;
	}
	state = await retryCleanup(state, options);
	if (state.cleanup_blocks?.length) return state;
	if (hasBlockedTask(state)) return state;
	state = await reconcileWorkers(state, config, options);
	return state.phase === "blocked" ? state : await advanceWithConfig(state, config, options);
}

async function rotateEnvelopeActionTicket(state: RunState, envelope: WorkerEnvelope, options: OrchestrationOptions): Promise<void> {
	const issue = executionIssues(state.graph).find((candidate) => candidate.id === envelope.issue_id);
	if (!issue) return;
	await rotateRejectedActionTicket(
		actionTicketPath(state.main_worktree, state.run_id, issue.id, issue.role === "final_check" ? "lifecycle" : "implementation", envelope.role),
		envelope.event_id,
		state.main_worktree,
		state.run_id,
		options.uuid,
	);
}

/** Abort cleanup never forces an uncommitted worktree away. */
export async function abortRun(state: RunState, options: OrchestrationOptions): Promise<RunState> {
	if (await integrationBranchIsRecorded(state, options)) {
		try {
			state = await resumeFinalRepair(state, options);
			if (state.health || state.health_fast_forward_intent) state = await resumePrHealth(state, options);
			await abortOwnedCherryPick(state, options);
			state = await recoverAppliedIntegration(state, options);
		} catch (error) {
			if (await integrationBranchIsRecorded(state, options)) throw error;
		}
	}
	const next = await save({ ...state, phase: "aborted" }, options);
	return await cleanupRun(next, options);
}

export async function cleanupRun(state: RunState, options: OrchestrationOptions): Promise<RunState> {
	state = await cleanupFinalRepair(state, options);
	state = await cleanupPrHealth(state, options);
	for (const issue of executionIssues(state.graph)) {
		state = await cleanupTask(state, issue.id, options);
	}
	return state;
}

export function parseWorkerEnvelope(value: unknown): WorkerEnvelope {
	const input = object(value, "worker envelope");
	const type = oneOf(input.type, ["request_review", "submit_review", "submit_health", "block_task"] as const, "worker envelope type");
	const keys = ["version", "type", "run_id", "issue_id", "role", "event_id", "attempt", "review_round", "receipt_path", "payload"];
	exactKeys(input, type === "submit_review" ? [...keys, "review_id"] : type === "request_review" ? [...keys, "commit"] : keys, "worker envelope");
	if (input.version !== 1) throw new Error(`Unsupported worker envelope version: ${String(input.version)}`);
	const role = oneOf(input.role, ["implementer", "reviewer"] as const, "worker envelope role");
	if (!WORKER_ROLE_EVENTS[role].includes(type)) throw new Error(`${role} worker cannot send ${type}`);
	const base = {
		version: 1 as const,
		run_id: nonEmptyString(input.run_id, "worker envelope run_id"),
		issue_id: nonEmptyString(input.issue_id, "worker envelope issue_id"),
		event_id: nonEmptyString(input.event_id, "worker envelope event_id"),
		attempt: positiveInteger(input.attempt, "worker envelope attempt"),
		review_round: positiveInteger(input.review_round, "worker envelope review_round"),
		receipt_path: nonEmptyString(input.receipt_path, "worker envelope receipt_path"),
		payload: parseEnvelopePayload(type, input.payload),
	};
	if (type === "submit_review") {
		return { ...base, type, role: "reviewer", review_id: nonEmptyString(input.review_id, "worker envelope review_id") };
	}
	if (type === "request_review") {
		return { ...base, type, role: "implementer", commit: nonEmptyString(input.commit, "worker envelope commit") };
	}
	return { ...base, type, role };
}

async function advanceWithConfig(state: RunState, config: ProjectConfig, options: OrchestrationOptions): Promise<RunState> {
	if (state.phase === "aborted" || state.phase === "blocked") return state;
	if (!state.wave) {
		const issueIds = deriveReadyIssueIds(state);
		if (!issueIds.length) return await advancePrLifecycle(state, config, options);
		const base = await commandOutput(options.runner, "git", ["rev-parse", "HEAD"], state.main_worktree);
		state = await save({ ...state, wave: { base, issue_ids: issueIds } }, options);
	}

	const wave = requiredWave(state);
	if (wave.issue_ids.every((id) => task(state, id).status === "approved" || task(state, id).status === "completed")) {
		return await integrateWave(state, config, options);
	}
	return await refillWave(state, config, options);
}

async function refillWave(state: RunState, config: ProjectConfig, options: OrchestrationOptions): Promise<RunState> {
	const wave = requiredWave(state);
	let active = wave.issue_ids.filter((id) => ["starting", "implementing", "reviewing"].includes(task(state, id).status)).length;
	for (const issueId of wave.issue_ids) {
		if (active >= config.max_parallel_tasks) break;
		if (task(state, issueId).status !== "pending") continue;
		state = await startTask(state, issueId, config, options);
		if (state.phase === "blocked") return state;
		active += 1;
	}
	return state;
}

async function startTask(state: RunState, issueId: string, config: ProjectConfig, options: OrchestrationOptions): Promise<RunState> {
	const issue = implementationIssue(state, issueId);
	const current = task(state, issueId);
	const wave = requiredWave(state);
	const next: RunTaskState = {
		...current,
		status: "starting",
		attempts: current.attempts + 1,
		wave_base: current.wave_base ?? wave.base,
		worktree: current.worktree ?? childWorktreePath(state.main_worktree, state.run_id, issueId),
		branch: current.branch ?? childBranch(state.run_id, issueId),
		pending_action: "initial",
		activity_started_at: timestamp(options),
		implementer_provisioning_id: current.implementer_provisioning_id ?? provisioningIdFor(state.run_id, issueId, "implementer"),
		implementer_agent: current.implementer_agent ?? workerAgentName(state.workspace_id, state.run_id, issueId, "implementer"),
	};
	state = await save(replaceTask(state, issueId, next), options);
	try {
		state = await ensureImplementer(state, issue, config, options, "initial");
		return state;
	} catch (error) {
		return await blockLatestRun(state, errorMessage(error), options);
	}
}

async function acceptEnvelope(
	state: RunState,
	envelope: WorkerEnvelope,
	config: ProjectConfig,
	options: OrchestrationOptions,
): Promise<RunState> {
	if (envelope.run_id !== state.run_id) throw new Error(`Worker event belongs to another run: ${envelope.run_id}`);
	const issue = issueById(state, envelope.issue_id);
	if (issue.role === "final_check") return await acceptPrLifecycleEnvelope(state, envelope, config, options);

	switch (envelope.type) {
		case "request_review":
			return await requestReview(state, issue, envelope, config, options);
		case "submit_review":
			return await submitReview(state, issue, envelope, config, options);
		case "submit_health":
			throw new Error(`Health event is not valid for implementation issue ${issue.id}`);
		case "block_task":
			return await blockWorkerTask(state, issue.id, envelope, options);
	}
}

async function blockWorkerTask(state: RunState, issueId: string, envelope: WorkerEnvelope, options: OrchestrationOptions): Promise<RunState> {
	const current = task(state, issueId);
	const active = envelope.role === "implementer" ? current.status === "implementing" : current.status === "reviewing";
	const reviewRound = envelope.role === "implementer" ? (current.review_rounds ?? 0) + 1 : current.review_rounds;
	if (!active || envelope.attempt !== current.attempts || envelope.review_round !== reviewRound) throw new Error(`Worker block event is stale for Local Issue ${issueId}`);
	return await blockTask(state, issueId, nonEmptyString(envelope.payload.reason, "block_task reason"), options, envelope.role);
}

async function requestReview(
	state: RunState,
	issue: LocalIssue,
	envelope: WorkerEnvelope,
	config: ProjectConfig,
	options: OrchestrationOptions,
): Promise<RunState> {
	if (envelope.type !== "request_review" || envelope.role !== "implementer") throw new Error("Only an implementer can request review");
	const current = task(state, issue.id);
	const requestedCommit = nonEmptyString(envelope.commit, "request_review commit");
	if (
		envelope.attempt !== current.attempts
		|| envelope.review_round !== (current.review_rounds ?? 0) + 1
	) throw new Error(`Review request is stale for Local Issue ${issue.id}`);
	let commit: string;
	try {
		commit = await verifyReviewCommit(state, issue.id, requestedCommit, options);
	} catch (error) {
		return await blockTask(state, issue.id, errorMessage(error), options, "implementer");
	}
	if (hasReviewFindings(current) && current.commit === commit) return state;
	if (current.status === "reviewing" && current.commit === commit) return state;
	if (current.status !== "implementing") return await blockTask(state, issue.id, `Review requested while task is ${current.status}`, options, "implementer");
	if ((current.review_rounds ?? 0) >= config.max_review_rounds) {
		return await blockTask(state, issue.id, `Review rounds exceed configured maximum of ${config.max_review_rounds}`, options, "implementer");
	}

	const dispatchBlocked = hasBlockedTask(state);
	state = await save(replaceTask(state, issue.id, {
		...current,
		status: "reviewing",
		activity_started_at: timestamp(options),
			commit,
			review_rounds: (current.review_rounds ?? 0) + 1,
			reviewer_provisioning_id: current.reviewer_provisioning_id ?? provisioningIdFor(state.run_id, issue.id, "reviewer"),
			...(dispatchBlocked ? { reviewer_instruction_pending: true } : {}),
	}), options);
	if (dispatchBlocked) return state;
	try {
		return await ensureReviewer(state, issue, config, options, "review");
	} catch (error) {
		return await blockLatestRun(state, errorMessage(error), options);
	}
}

async function submitReview(
	state: RunState,
	issue: LocalIssue,
	envelope: SubmitReviewEnvelope,
	config: ProjectConfig,
	options: OrchestrationOptions,
): Promise<RunState> {
	if (envelope.role !== "reviewer") throw new Error("Only a reviewer can submit review");
	const current = task(state, issue.id);
	if (current.status !== "reviewing") throw new Error(`Review submission is stale for Local Issue ${issue.id}`);
	if (envelope.review_id !== taskReviewId(state, issue.id, current)) throw new Error(`Review submission is stale for Local Issue ${issue.id}`);
	const commit = nonEmptyString(current.commit, `Run Task ${issue.id} review commit`);
	const gate = requiredTaskGate(current, commit, issue.id);
	try {
		await verifyReviewCommit(state, issue.id, commit, options);
	} catch (error) {
		return await blockTask(state, issue.id, errorMessage(error), options, "reviewer");
	}

	const verdict = oneOf(envelope.payload.verdict, ["approved", "changes_requested", "blocked"] as const, "review verdict");
	const findings = stringArray(envelope.payload.findings, "review findings");
	if (verdict === "blocked") {
		state = await save(replaceTask(state, issue.id, { ...current, review_findings: findings }), options);
		return await blockTask(state, issue.id, findings.join("; ") || "Reviewer blocked the task", options, "reviewer");
	}
	if (verdict === "approved" && gate.exit_code !== 0) {
		return await blockTask(state, issue.id, `Required gate exited with code ${gate.exit_code}; approval requires exit code 0`, options, "reviewer");
	}
	if (verdict === "approved") {
		return await save(replaceTask(state, issue.id, {
			...current,
			status: "approved",
			review_findings: findings,
		}), options);
	}

	const dispatchBlocked = hasBlockedTask(state);
	state = await save(replaceTask(state, issue.id, {
		...current,
		status: "implementing",
		activity_started_at: timestamp(options),
		review_findings: findings,
		pending_action: "revision",
		...(dispatchBlocked ? { implementer_instruction_pending: true } : {}),
	}), options);
	if (dispatchBlocked) return state;
	try {
		return await ensureImplementer(state, issue, config, options, "revision");
	} catch (error) {
		return await blockLatestRun(state, errorMessage(error), options);
	}
}

async function integrateWave(state: RunState, config: ProjectConfig, options: OrchestrationOptions): Promise<RunState> {
	const wave = requiredWave(state);
	for (const issueId of [...wave.issue_ids].sort()) {
		const current = task(state, issueId);
		if (current.status === "completed") continue;
		if (current.status !== "approved") return state;
		config = await assertRunBoundary(state, options.runner);
		const commit = nonEmptyString(current.commit, `Run Task ${issueId} approved commit`);
		if (current.integration_intent && current.integration_intent !== commit) {
			throw new Error(`Run Task ${issueId} integration intent does not match its approved commit`);
		}
		const recoveredCommit = current.integration_intent
			? await appliedIntegrationCommit(state, current.integration_intent, options)
			: undefined;
		if (recoveredCommit) {
			state = await markIntegrated(state, issueId, recoveredCommit, options);
			if (state.cleanup_blocks?.length) return state;
			continue;
		}
		try {
			await verifyReviewCommit(state, issueId, commit, options);
		} catch (error) {
			return await blockRun(state, errorMessage(error), options);
		}
		config = await assertRunBoundary(state, options.runner);
		state = await save(replaceTask(state, issueId, { ...current, integration_intent: commit }), options);
		try {
			await commandOutput(options.runner, "git", ["cherry-pick", "-x", commit], state.main_worktree);
		} catch (error) {
			const conflictedIssueId = await abortOwnedCherryPick(state, options);
			if (conflictedIssueId !== issueId) throw error;
			return await replaceConflictedCommit(state, issueId, config, options);
		}
		const integrationCommit = await appliedIntegrationCommit(state, commit, options);
		if (!integrationCommit) throw new Error(`Main integration HEAD changed while applying Run Task ${issueId}`);
		state = await markIntegrated(state, issueId, integrationCommit, options);
		if (state.cleanup_blocks?.length) return state;
	}
	state = await save({ ...state, wave: undefined }, options);
	return await advanceWithConfig(state, await assertRunBoundary(state, options.runner), options);
}

async function markIntegrated(state: RunState, issueId: string, integrationCommit: string, options: OrchestrationOptions): Promise<RunState> {
	const current = task(state, issueId);
	state = await save({
		...replaceTask(state, issueId, {
			...current,
			status: "completed",
			integration_intent: undefined,
		}),
		integration_head: nonEmptyString(integrationCommit, `Run Task ${issueId} integration commit`),
	}, options);
	return await cleanupTask(state, issueId, options);
}

/** Complete an interrupted cherry-pick before enforcing the recorded integration head. */
async function recoverAppliedIntegration(state: RunState, options: OrchestrationOptions): Promise<RunState> {
	for (const issueId of Object.keys(state.tasks).sort()) {
		const current = task(state, issueId);
		if (!current.integration_intent || current.status === "completed") continue;
		const integrationCommit = await appliedIntegrationCommit(state, current.integration_intent, options);
		if (!integrationCommit) continue;
		return await markIntegrated(
			state,
			issueId,
			integrationCommit,
			options,
		);
	}
	return state;
}

async function replaceConflictedCommit(
	state: RunState,
	issueId: string,
	config: ProjectConfig,
	options: OrchestrationOptions,
): Promise<RunState> {
	config = await assertRunBoundary(state, options.runner);
	await ensureWorktree(state, issueId, options);
	const base = await commandOutput(options.runner, "git", ["rev-parse", "HEAD"], state.main_worktree);
	const current = task(state, issueId);
	const worktree = nonEmptyString(current.worktree, `Run Task ${issueId} worktree`);
	if (await commandOutput(options.runner, "git", ["status", "--porcelain=v1", "--untracked-files=all"], worktree)) {
		return await blockRun(state, `Run Task ${issueId} child worktree is dirty; refusing to reset after cherry-pick conflict`, options);
	}
	await commandOutput(options.runner, "git", ["reset", "--hard", base], worktree);
	const { commit: _commit, review_findings: _findings, integration_intent: _integrationIntent, ...replacement } = current;
	const dispatchBlocked = hasBlockedTask(state);
	state = await save(replaceTask(state, issueId, {
		...replacement,
		status: "implementing",
		activity_started_at: timestamp(options),
		attempts: current.attempts + 1,
		wave_base: base,
		review_rounds: 0,
		pending_action: "replacement",
		conflict_base: base,
		...(dispatchBlocked ? { implementer_instruction_pending: true } : {}),
	}), options);
	if (dispatchBlocked) return state;
	const issue = implementationIssue(state, issueId);
	try {
		return await ensureImplementer(state, issue, config, options, "replacement");
	} catch (error) {
		return await blockLatestRun(state, errorMessage(error), options);
	}
}

async function assertIntegrationBranch(state: RunState, options: OrchestrationOptions): Promise<void> {
	const branch = nonEmptyString(state.integration_branch, "recorded integration branch");
	await assertAttachedBranch(options.runner, state.main_worktree, branch, "Main integration");
}

async function integrationBranchIsRecorded(state: RunState, options: OrchestrationOptions): Promise<boolean> {
	return (await readCurrentBranch(options.runner, state.main_worktree)) === nonEmptyString(state.integration_branch, "recorded integration branch");
}

async function cleanupTask(
	state: RunState,
	issueId: string,
	options: OrchestrationOptions,
	only?: readonly CleanupOperation[],
): Promise<RunState> {
	const operations = only ?? ["tab", "worktree", "branch"] as const;
	for (const operation of operations) {
		const current = task(state, issueId);
		if (operation === "tab") {
			if (current.tab_cleanup_done) continue;
			let tabId: string | undefined;
			try {
				tabId = current.tab_id ?? (current.implementer_provisioning_id
					? (await findManagedSubagentTab(workerHost(state), current.implementer_provisioning_id, workerHostOptions(options)))?.tabId
					: undefined);
				if (!tabId) {
					state = await markCleanupDone(state, issueId, operation, options);
					continue;
				}
				await retireManagedSubagentTab(workerHost(state), tabId, workerHostOptions(options));
				state = await markCleanupDone(state, issueId, operation, options);
			} catch (error) {
				return await recordCleanupBlock(state, issueId, operation, errorMessage(error), options);
			}
		}
		if (operation === "worktree") {
			if (!current.worktree || current.worktree_cleanup_done) continue;
			const worktree = current.worktree;
			try {
				await retireChildWorktree(
					options.runner,
					state.main_worktree,
					worktree,
					nonEmptyString(current.branch, `Run Task ${issueId} branch`),
					`Run Task ${issueId}`,
					async () => await verifyCleanupWorktree(state, issueId, options),
				);
				state = await markCleanupDone(state, issueId, operation, options);
			} catch (error) {
				return await recordCleanupBlock(state, issueId, operation, errorMessage(error), options);
			}
		}
		if (operation === "branch") {
			if (current.status !== "completed" || !current.branch || current.branch_cleanup_done) continue;
			const branch = current.branch;
			try {
				await deleteExpectedBranch(
					options.runner,
					state.main_worktree,
					branch,
					nonEmptyString(current.commit, `Run Task ${issueId} reviewed commit`),
					`Run Task ${issueId}`,
				);
				state = await markCleanupDone(state, issueId, operation, options);
			} catch (error) {
				return await recordCleanupBlock(state, issueId, operation, errorMessage(error), options);
			}
		}
	}
	return state;
}

async function verifyCleanupWorktree(state: RunState, issueId: string, options: OrchestrationOptions): Promise<void> {
	const current = task(state, issueId);
	if (current.status !== "completed") return await assertTaskBranch(state, issueId, options);
	await verifyReviewCommit(state, issueId, nonEmptyString(current.commit, `Run Task ${issueId} reviewed commit`), options);
}

async function markCleanupDone(state: RunState, issueId: string, operation: CleanupOperation, options: OrchestrationOptions): Promise<RunState> {
	const current = task(state, issueId);
	const done = operation === "tab"
		? { tab_cleanup_done: true }
		: operation === "worktree"
			? { worktree_cleanup_done: true }
			: { branch_cleanup_done: true };
	return await save(clearCleanupBlock(replaceTask(state, issueId, { ...current, ...done }), issueId, operation), options);
}

async function retryCleanup(state: RunState, options: OrchestrationOptions): Promise<RunState> {
	if (state.phase === "aborted") return await cleanupRun(state, options);
	const issueIds = new Set((state.cleanup_blocks ?? []).map((block) => block.issue_id));
	for (const [issueId, current] of Object.entries(state.tasks)) {
		if (current.status === "completed" && (!current.tab_cleanup_done || !current.worktree_cleanup_done || !current.branch_cleanup_done)) {
			issueIds.add(issueId);
		}
	}
	for (const issueId of [...issueIds].sort()) {
		state = await cleanupTask(state, issueId, options);
	}
	return state;
}

async function recordCleanupBlock(
	state: RunState,
	issueId: string,
	operation: CleanupOperation,
	reason: string,
	options: OrchestrationOptions,
): Promise<RunState> {
	const blocks = [...(state.cleanup_blocks ?? []).filter((block) => block.issue_id !== issueId || block.operation !== operation), { issue_id: issueId, operation, reason }];
	return await save({
		...state,
		cleanup_blocks: blocks,
		...(state.phase === "aborted" ? {} : { phase: "blocked", block_reason: `Cleanup blocked for ${issueId}: ${reason}` }),
	}, options);
}

function clearCleanupBlock(state: RunState, issueId: string, operation: CleanupOperation): RunState {
	const cleanupBlocks = (state.cleanup_blocks ?? []).filter((block) => block.issue_id !== issueId || block.operation !== operation);
	if (cleanupBlocks.length) return { ...state, cleanup_blocks: cleanupBlocks };
	if (state.phase !== "blocked") return { ...state, cleanup_blocks: undefined };
	if (hasBlockedTask(state)) return { ...state, cleanup_blocks: undefined };
	const { block_reason: _blockReason, ...next } = state;
	return { ...next, phase: "execution", cleanup_blocks: undefined };
}

async function blockTask(state: RunState, issueId: string, reason: string, options: OrchestrationOptions, role?: WorkerRole): Promise<RunState> {
	const { blocked_role: _blockedRole, ...current } = task(state, issueId);
	return await save({
		...replaceTask(state, issueId, {
			...current,
			status: "blocked",
			block_reason: reason,
			activity_started_at: timestamp(options),
			...(role ? { blocked_role: role } : {}),
		}),
		phase: "blocked",
		block_reason: `Local Issue ${issueId} blocked: ${reason}`,
	}, options);
}

async function blockRun(state: RunState, reason: string, options: OrchestrationOptions): Promise<RunState> {
	return await save({ ...state, phase: "blocked", block_reason: reason }, options);
}

async function blockLatestRun(state: RunState, reason: string, options: OrchestrationOptions): Promise<RunState> {
	return await blockRun(await readRunState(state.main_worktree, state.run_id) ?? state, reason, options);
}

function implementationIssue(state: RunState, issueId: string): LocalIssue {
	const issue = issueById(state, issueId);
	if (issue.role !== "implementation" || !issue.profile) throw new Error(`Local Issue ${issueId} is not an implementation task`);
	return issue;
}

function hasBlockedTask(state: RunState): boolean {
	return Object.values(state.tasks).some((candidate) => candidate.status === "blocked");
}


function requiredWave(state: RunState): NonNullable<RunState["wave"]> {
	if (!state.wave) throw new Error("Run has no active dependency wave");
	return state.wave;
}

function parseEnvelopePayload(type: WorkerEvent, value: unknown): Record<string, unknown> {
	const input = object(value, `worker envelope ${type} payload`);
	const only = (keys: readonly string[]) => {
		for (const key of Object.keys(input)) if (!keys.includes(key)) throw new Error(`Unknown worker envelope ${type} payload setting: ${key}`);
	};
	switch (type) {
		case "request_review":
			only(["summary"]);
			return input.summary === undefined ? {} : { summary: nonEmptyString(input.summary, "request_review summary") };
		case "submit_review":
			only(["verdict", "findings"]);
			const verdict = oneOf(input.verdict, ["approved", "changes_requested", "blocked"] as const, "submit_review verdict");
			const findings = stringArray(input.findings, "submit_review findings");
			if (verdict !== "approved" && !findings.length) {
				throw new Error("Non-approval review verdict requires findings");
			}
			return { verdict, findings };
		case "submit_health":
			only(["summary", "actionable", "thread_ids", "checks"]);
			if (typeof input.actionable !== "boolean") throw new Error("submit_health actionable must be a boolean");
			return {
				summary: nonEmptyString(input.summary, "submit_health summary"),
				actionable: input.actionable,
				...(input.thread_ids === undefined ? {} : { thread_ids: stringArray(input.thread_ids, "submit_health thread_ids") }),
				...(input.checks === undefined ? {} : { checks: array(input.checks, "submit_health checks") }),
			};
		case "block_task":
			only(["reason"]);
			return { reason: nonEmptyString(input.reason, "block_task reason") };
	}
}

async function appliedIntegrationCommit(state: RunState, commit: string, options: OrchestrationOptions): Promise<string | undefined> {
	return await findAppliedCherryPick(options.runner, state.main_worktree, state.integration_branch, state.integration_head, commit, "Main integration");
}

/** Abort only the conflict this run durably recorded before checking the clean boundary. */
async function abortOwnedCherryPick(state: RunState, options: OrchestrationOptions): Promise<string | undefined> {
	await assertIntegrationBranch(state, options);
	const result = await options.runner("git", ["rev-parse", "-q", "--verify", "CHERRY_PICK_HEAD"], { cwd: state.main_worktree });
	if (result.code === 1) return undefined;
	if (result.code !== 0) throw new Error(commandFailure("git", ["rev-parse", "-q", "--verify", "CHERRY_PICK_HEAD"], result));
	const commit = result.stdout.trim();
	const issueId = Object.keys(state.tasks).find((id) => task(state, id).integration_intent === commit);
	if (!issueId) throw new Error(`Refusing to abort a cherry-pick not owned by this run: ${commit}`);
	await commandOutput(options.runner, "git", ["cherry-pick", "--abort"], state.main_worktree);
	return issueId;
}

