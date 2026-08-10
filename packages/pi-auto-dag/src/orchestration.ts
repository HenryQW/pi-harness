import { basename, dirname, join, resolve } from "node:path";
import { commandFailure, commandOutput, errorMessage, gateEvidenceRecord, recordedGateEvidence, runRequiredGate, type CommandRunner } from "./command.ts";
import { executionIssues } from "./graph.ts";
import { assertRunBoundary } from "./intake.ts";
import { assertAttachedBranch, deleteExpectedBranch, ensureChildWorktree, findAppliedCherryPick, readCurrentBranch, retireChildWorktree, verifySingleCommit } from "./git.ts";
import type { CleanupBlock, LocalIssue, ProjectConfig, RequiredGateEvidence, RunState, RunTaskState, WorkerEnvelope } from "./model.ts";
import { cleanupPrHealth, resumePrHealth } from "./pr-health.ts";
import { acceptPrLifecycleEnvelope, advancePrLifecycle, cleanupPrLifecycle, resumePrLifecycle } from "./pr-lifecycle.ts";
import { reviewId, reviewTicketPath, writeReviewTicket } from "./review-ticket.ts";
import { persistGateOutput, reviewPrompt as reviewWorkerPrompt, type ReviewPromptMode } from "./review.ts";
import { issueById, readRunState, replaceTask, task, type Uuid, writeRunState } from "./state.ts";
import { createWorkerLaunch, createWorkerTab, ensureWorkerPane, findWorkerTab, promptWorkerAgent, reconcileWorkerTab, retireWorkerTab, startWorkerAgent, workerAgentName, workerDeliveryContext, workerIssueContext, workerTabExists, WORKER_ROLE_EVENTS, type WorkerEvent, type WorkerLaunch, type WorkerRole } from "./worker.ts";
import { array, exactKeys, nonEmptyString, object, oneOf, positiveInteger, stringArray } from "./validate.ts";

export interface OrchestrationOptions {
	runner: CommandRunner;
	uuid: Uuid;
	now?: () => string;
	delay?: (milliseconds: number) => Promise<void>;
}

type CleanupOperation = CleanupBlock["operation"];
type ImplementerAction = NonNullable<RunTaskState["pending_action"]>;

/** The parent of the integration worktree is deliberate: `.context` never enters a child. */
export function childWorktreePath(mainWorktree: string, runId: string, issueId: string): string {
	const root = resolve(mainWorktree);
	return join(dirname(root), `.${basename(root)}-auto-dag`, runId, issueId);
}

export function childBranch(runId: string, issueId: string): string {
	return `pi-auto-dag/${runId}/${issueId}`;
}

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

/** Resume is the only ingress for worker events, so workers never write Run State. */
export async function resumeRun(
	state: RunState,
	envelope: unknown,
	options: OrchestrationOptions,
): Promise<RunState> {
	if (state.phase === "aborted") return await abortRun(state, options);
	state = await resumePrLifecycle(state, options);
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
	if (envelope !== undefined) {
		state = await acceptEnvelope(state, parseWorkerEnvelope(envelope), config, options);
		return state.phase === "blocked" ? state : await advanceWithConfig(state, config, options);
	}
	state = await retryCleanup(state, options);
	if (state.cleanup_blocks?.length) return state;
	if (hasBlockedTask(state)) return state;
	state = await reconcileWorkers(state, config, options);
	return state.phase === "blocked" ? state : await advanceWithConfig(state, config, options);
}

/** Abort cleanup never forces an uncommitted worktree away. */
export async function abortRun(state: RunState, options: OrchestrationOptions): Promise<RunState> {
	if (await integrationBranchIsRecorded(state, options)) {
		try {
			state = await resumePrLifecycle(state, options);
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
	state = await cleanupPrLifecycle(state, options);
	state = await cleanupPrHealth(state, options);
	for (const issue of executionIssues(state.graph)) {
		state = await cleanupTask(state, issue.id, options);
	}
	return state;
}

export function parseWorkerEnvelope(value: unknown): WorkerEnvelope {
	const input = object(value, "worker envelope");
	const type = oneOf(input.type, ["request_review", "submit_review", "submit_health", "block_task"] as const, "worker envelope type");
	exactKeys(
		input,
		type === "submit_review"
			? ["version", "type", "run_id", "issue_id", "role", "review_id", "payload"]
			: ["version", "type", "run_id", "issue_id", "role", "payload"],
		"worker envelope",
	);
	if (input.version !== 1) throw new Error(`Unsupported worker envelope version: ${String(input.version)}`);
	const role = oneOf(input.role, ["implementer", "reviewer"] as const, "worker envelope role");
	if (!WORKER_ROLE_EVENTS[role].includes(type)) throw new Error(`${role} worker cannot send ${type}`);
	const payload = parseEnvelopePayload(type, input.payload);
	return {
		version: 1,
		type,
		run_id: nonEmptyString(input.run_id, "worker envelope run_id"),
		issue_id: nonEmptyString(input.issue_id, "worker envelope issue_id"),
		role,
		...(type === "submit_review" ? { review_id: nonEmptyString(input.review_id, "worker envelope review_id") } : {}),
		payload,
	};
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
			return state;
		case "block_task":
			return await blockWorkerTask(state, issue.id, envelope, options);
	}
}

async function blockWorkerTask(state: RunState, issueId: string, envelope: WorkerEnvelope, options: OrchestrationOptions): Promise<RunState> {
	const current = task(state, issueId);
	const active = envelope.role === "implementer" ? current.status === "implementing" : current.status === "reviewing";
	const reviewRound = envelope.role === "implementer" ? (current.review_rounds ?? 0) + 1 : current.review_rounds;
	if (!active || envelope.payload.attempt !== current.attempts || envelope.payload.review_round !== reviewRound) return state;
	return await blockTask(state, issueId, nonEmptyString(envelope.payload.reason, "block_task reason"), options, envelope.role);
}

async function requestReview(
	state: RunState,
	issue: LocalIssue,
	envelope: WorkerEnvelope,
	config: ProjectConfig,
	options: OrchestrationOptions,
): Promise<RunState> {
	if (envelope.role !== "implementer") throw new Error("Only an implementer can request review");
	const current = task(state, issue.id);
	const requestedCommit = nonEmptyString(envelope.payload.commit, "request_review commit");
	if (
		envelope.payload.attempt !== current.attempts
		|| envelope.payload.review_round !== (current.review_rounds ?? 0) + 1
	) return state;
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
	envelope: WorkerEnvelope,
	config: ProjectConfig,
	options: OrchestrationOptions,
): Promise<RunState> {
	if (envelope.role !== "reviewer") throw new Error("Only a reviewer can submit review");
	const current = task(state, issue.id);
	if (current.status !== "reviewing") return state;
	if (envelope.review_id !== taskReviewId(state, issue.id, current)) return state;
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

async function reconcileWorkers(state: RunState, config: ProjectConfig, options: OrchestrationOptions): Promise<RunState> {
	const active = executionIssues(state.graph).filter((issue) => issue.role === "implementation" && ["starting", "implementing", "reviewing"].includes(task(state, issue.id).status));
	if (!active.length) return state;
	for (const issue of active.sort((left, right) => left.id.localeCompare(right.id))) {
		const current = task(state, issue.id);
		if (["starting", "implementing"].includes(current.status)) {
			state = await ensureImplementer(state, issue, config, options, "resume");
		}
		if (task(state, issue.id).status === "reviewing") {
			state = await ensureReviewer(state, issue, config, options, "resume");
		}
	}
	return state;
}

async function ensureImplementer(
	state: RunState,
	issue: LocalIssue,
	config: ProjectConfig,
	options: OrchestrationOptions,
	mode: ImplementerAction | "resume",
): Promise<RunState> {
	await ensureWorktree(state, issue.id, options);
	config = await assertRunBoundary(state, options.runner);
	let current = task(state, issue.id);
	const action = pendingImplementerAction(current);
	if (current.pending_action !== action) {
		state = await save(replaceTask(state, issue.id, { ...current, pending_action: action }), options);
		current = task(state, issue.id);
	}
	const provisioningId = current.implementer_provisioning_id ?? provisioningIdFor(state.run_id, issue.id, "implementer");
	if (current.implementer_provisioning_id !== provisioningId) {
		state = await save(replaceTask(state, issue.id, { ...current, implementer_provisioning_id: provisioningId }), options);
		current = task(state, issue.id);
	}
	const launch = workerLaunch(state, issue, config, "implementer");
	const resource = await reconcileWorkerTab(state, {
		tab_id: current.tab_id,
		pane_id: current.implementer_pane,
		cwd: nonEmptyString(current.worktree, `Run Task ${issue.id} worktree`),
		launch,
		label: provisioningId,
	}, options);
	if (current.tab_id !== resource.tab_id || current.implementer_pane !== resource.pane_id) {
		state = await save(replaceTask(state, issue.id, {
			...current,
			tab_id: resource.tab_id,
			implementer_pane: resource.pane_id,
			implementer_agent: current.implementer_agent ?? workerAgentName(state.workspace_id, state.run_id, issue.id, "implementer"),
		}), options);
		current = task(state, issue.id);
	}
	const agent = nonEmptyString(current.implementer_agent, `Run Task ${issue.id} implementer_agent`);
	const started = await startWorkerAgent(
		state,
		agent,
		nonEmptyString(current.implementer_pane, `Run Task ${issue.id} implementer_pane`),
		launch,
		options,
		{
			beforeStart: async () => {
				const latest = task(state, issue.id);
				if (!latest.implementer_instruction_pending) state = await save(replaceTask(state, issue.id, { ...latest, implementer_instruction_pending: true }), options);
			},
			onStarted: async () => {
				if (mode === "resume") {
					const latest = task(state, issue.id);
					state = await save(replaceTask(state, issue.id, { ...latest, attempts: latest.attempts + 1 }), options);
				}
			},
		},
	);
	current = task(state, issue.id);
	const needsInstruction = Boolean(current.implementer_instruction_pending) || current.resolution_pending || current.status === "starting" || mode !== "resume" || started !== "existing";
	if (needsInstruction && !current.implementer_instruction_pending) {
		state = await save(replaceTask(state, issue.id, { ...current, implementer_instruction_pending: true }), options);
		current = task(state, issue.id);
	}
	if (current.status === "starting") {
		state = await save(replaceTask(state, issue.id, { ...current, status: "implementing" }), options);
		current = task(state, issue.id);
	}
	const promptMode = needsInstruction ? action : mode;
	const fullPrompt = Boolean(mode === "initial" || mode === "replacement" || started !== "existing" || current.resolution_pending || (mode === "resume" && current.implementer_instruction_pending));
	await promptWorkerAgent(state, agent, implementerPrompt(state, issue, current, promptMode, fullPrompt), options);
	if (task(state, issue.id).implementer_instruction_pending || task(state, issue.id).resolution_pending) {
		state = await save(replaceTask(state, issue.id, {
			...task(state, issue.id),
			implementer_instruction_pending: undefined,
			resolution_pending: undefined,
		}), options);
	}
	return state;
}

async function ensureReviewer(
	state: RunState,
	issue: LocalIssue,
	config: ProjectConfig,
	options: OrchestrationOptions,
	mode: "review" | "resume",
): Promise<RunState> {
	await ensureWorktree(state, issue.id, options);
	config = await assertRunBoundary(state, options.runner);
	state = await ensureTaskGate(state, issue, config.required_gate_timeout_ms, options);
	let current = task(state, issue.id);
	if (current.reviewer_pane) {
		const tabId = nonEmptyString(current.tab_id, `Run Task ${issue.id} tab_id`);
		if (!(await workerTabExists(state, tabId, options))) {
			const provisioningId = current.implementer_provisioning_id ?? provisioningIdFor(state.run_id, issue.id, "implementer");
			current = {
				...current,
				tab_id: undefined,
				implementer_pane: undefined,
				reviewer_pane: undefined,
				implementer_provisioning_id: provisioningId,
			};
			const created = await findWorkerTab(state, provisioningId, options)
				?? await createWorkerTab(
					state,
					nonEmptyString(current.worktree, `Run Task ${issue.id} worktree`),
					workerLaunch(state, issue, config, "implementer"),
					provisioningId,
					options,
				);
			state = await save(replaceTask(state, issue.id, {
				...current,
				tab_id: created.tab_id,
				implementer_pane: created.pane_id,
			}), options);
			current = task(state, issue.id);
		}
	}
	if (!current.reviewer_pane) {
		const provisioningId = current.reviewer_provisioning_id ?? provisioningIdFor(state.run_id, issue.id, "reviewer");
		if (current.reviewer_provisioning_id !== provisioningId) {
			state = await save(replaceTask(state, issue.id, { ...current, reviewer_provisioning_id: provisioningId }), options);
			current = task(state, issue.id);
		}
		const tabId = nonEmptyString(current.tab_id, `Run Task ${issue.id} tab_id`);
		const implementerPane = nonEmptyString(current.implementer_pane, `Run Task ${issue.id} implementer_pane`);
		const paneId = await ensureWorkerPane(
			state,
			tabId,
			implementerPane,
			nonEmptyString(current.worktree, `Run Task ${issue.id} worktree`),
			workerLaunch(state, issue, config, "reviewer"),
			provisioningId,
			options,
		);
		state = await save(replaceTask(state, issue.id, {
			...current,
			reviewer_pane: paneId,
			reviewer_agent: current.reviewer_agent ?? workerAgentName(state.workspace_id, state.run_id, issue.id, "reviewer"),
		}), options);
		current = task(state, issue.id);
	}
	const agent = nonEmptyString(current.reviewer_agent, `Run Task ${issue.id} reviewer_agent`);
	const started = await startWorkerAgent(
		state,
		agent,
		nonEmptyString(current.reviewer_pane, `Run Task ${issue.id} reviewer_pane`),
		workerLaunch(state, issue, config, "reviewer"),
		options,
		{
			beforeStart: async () => {
				const latest = task(state, issue.id);
				if (!latest.reviewer_instruction_pending) state = await save(replaceTask(state, issue.id, { ...latest, reviewer_instruction_pending: true }), options);
			},
		},
	);
	current = task(state, issue.id);
	const needsInstruction = Boolean(current.reviewer_instruction_pending) || current.resolution_pending || mode === "review" || started !== "existing";
	if (needsInstruction && !current.reviewer_instruction_pending) {
		state = await save(replaceTask(state, issue.id, { ...current, reviewer_instruction_pending: true }), options);
		current = task(state, issue.id);
	}
	const promptMode: ReviewPromptMode = !needsInstruction
		? "resend"
		: started !== "existing" || current.review_rounds === 1
			? "full"
			: "update";
	await writeReviewTicket(
		reviewTicketPath(state.main_worktree, state.run_id, issue.id),
		taskReviewId(state, issue.id, current),
		options.uuid,
	);
	await promptWorkerAgent(state, agent, reviewerPrompt(state, issue, current, promptMode), options);
	if (task(state, issue.id).reviewer_instruction_pending || task(state, issue.id).resolution_pending) {
		state = await save(replaceTask(state, issue.id, {
			...task(state, issue.id),
			reviewer_instruction_pending: undefined,
			resolution_pending: undefined,
		}), options);
	}
	return state;
}

async function ensureTaskGate(state: RunState, issue: LocalIssue, timeoutMs: number, options: OrchestrationOptions): Promise<RunState> {
	const current = task(state, issue.id);
	const commit = nonEmptyString(current.commit, `Run Task ${issue.id} review commit`);
	await verifyReviewCommit(state, issue.id, commit, options);
	let evidence = recordedGateEvidence(current, commit);
	if (!evidence) {
		const execution = await runRequiredGate(
			options.runner,
			issue.testing,
			commit,
			nonEmptyString(current.worktree, `Run Task ${issue.id} worktree`),
			timeoutMs,
		);
		evidence = await persistGateOutput(state, issue.id, execution, options.uuid);
		state = await save(replaceTask(state, issue.id, { ...current, ...gateEvidenceRecord(evidence) }), options);
	}
	return state;
}

async function verifyReviewCommit(state: RunState, issueId: string, commit: string, options: OrchestrationOptions): Promise<string> {
	const current = task(state, issueId);
	const worktree = nonEmptyString(current.worktree, `Run Task ${issueId} worktree`);
	const base = nonEmptyString(current.wave_base, `Run Task ${issueId} wave_base`);
	await assertTaskBranch(state, issueId, options);
	return await verifySingleCommit(options.runner, state.main_worktree, worktree, base, commit, `Run Task ${issueId}`, "wave base");
}

async function assertTaskBranch(state: RunState, issueId: string, options: OrchestrationOptions): Promise<void> {
	const current = task(state, issueId);
	const worktree = nonEmptyString(current.worktree, `Run Task ${issueId} worktree`);
	const branch = nonEmptyString(current.branch, `Run Task ${issueId} branch`);
	const expected = childBranch(state.run_id, issueId);
	if (branch !== expected) throw new Error(`Run Task ${issueId} branch is not its deterministic child branch: ${branch}`);
	await assertAttachedBranch(options.runner, worktree, branch, `Run Task ${issueId} child worktree`);
}

async function assertIntegrationBranch(state: RunState, options: OrchestrationOptions): Promise<void> {
	const branch = nonEmptyString(state.integration_branch, "recorded integration branch");
	await assertAttachedBranch(options.runner, state.main_worktree, branch, "Main integration");
}

async function integrationBranchIsRecorded(state: RunState, options: OrchestrationOptions): Promise<boolean> {
	return (await readCurrentBranch(options.runner, state.main_worktree)) === nonEmptyString(state.integration_branch, "recorded integration branch");
}

async function ensureWorktree(state: RunState, issueId: string, options: OrchestrationOptions): Promise<void> {
	const current = task(state, issueId);
	const path = nonEmptyString(current.worktree, `Run Task ${issueId} worktree`);
	const branch = nonEmptyString(current.branch, `Run Task ${issueId} branch`);
	const base = nonEmptyString(current.wave_base, `Run Task ${issueId} wave_base`);
	if (branch !== childBranch(state.run_id, issueId)) {
		throw new Error(`Run Task ${issueId} branch is not its deterministic child branch: ${branch}`);
	}
	await ensureChildWorktree(options.runner, state.main_worktree, path, branch, base, `Run Task ${issueId}`);
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
					? (await findWorkerTab(state, current.implementer_provisioning_id, options))?.tab_id
					: undefined);
				if (!tabId) {
					state = await markCleanupDone(state, issueId, operation, options);
					continue;
				}
				await retireWorkerTab(state, tabId, options);
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

function pendingImplementerAction(current: RunTaskState): ImplementerAction {
	if (current.pending_action === "initial" || current.pending_action === "revision" || current.pending_action === "replacement") return current.pending_action;
	return hasReviewFindings(current) ? "revision" : current.conflict_base ? "replacement" : "initial";
}

function hasReviewFindings(current: RunTaskState): boolean {
	return Array.isArray(current.review_findings) && current.review_findings.length > 0;
}

function requiredWave(state: RunState): NonNullable<RunState["wave"]> {
	if (!state.wave) throw new Error("Run has no active dependency wave");
	return state.wave;
}

function workerLaunch(
	state: RunState,
	issue: LocalIssue,
	config: ProjectConfig,
	role: WorkerRole,
): WorkerLaunch {
	const profileId = role === "reviewer" ? config.reviewer_profile : nonEmptyString(issue.profile, `Local Issue ${issue.id} profile`);
	const profile = config.profiles[profileId];
	if (!profile) throw new Error(`Resolved Pi profile is missing: ${profileId}`);
	return createWorkerLaunch({
		role,
		events: WORKER_ROLE_EVENTS[role].filter((event) => event !== "submit_health"),
		profile,
		run_id: state.run_id,
		issue_id: issue.id,
		main_pane: nonEmptyString(state.main_pane, "recorded main Herdr pane"),
		...(role === "reviewer" ? { review_ticket: reviewTicketPath(state.main_worktree, state.run_id, issue.id) } : {}),
	});
}

function implementerPrompt(
	state: RunState,
	issue: LocalIssue,
	current: RunTaskState,
	mode: ImplementerAction | "resume",
	full: boolean,
): Record<string, unknown> {
	const instruction = mode === "resume"
		? "Resend your latest worker event through the worker tool. Do not start duplicate orchestration."
		: mode === "revision"
			? "Address the reviewer findings by amending the sole commit; do not add another commit, then request review again."
			: mode === "replacement"
				? "The previous commit conflicted. Produce one replacement commit on the new base, then request review again."
				: "Implement this frozen Local Issue, commit exactly one change over the wave base, then request review through the worker tool.";
	if (!full) return {
		type: mode === "resume" ? "auto_dag_resend" : "auto_dag_task_update",
		run_id: state.run_id,
		issue_id: issue.id,
		attempt: current.attempts,
		review_round: (current.review_rounds ?? 0) + 1,
		review_findings: current.review_findings,
		instruction,
	};
	return {
		type: "auto_dag_task",
		run_id: state.run_id,
		delivery: workerDeliveryContext(state.graph),
		issue: workerIssueContext(issue, true),
		wave_base: current.wave_base,
		attempt: current.attempts,
		review_round: (current.review_rounds ?? 0) + 1,
		worktree: current.worktree,
		review_findings: current.review_findings,
		resolution: state.resolutions[issue.id],
		instruction,
	};
}

function reviewerPrompt(
	state: RunState,
	issue: LocalIssue,
	current: RunTaskState,
	mode: ReviewPromptMode,
): Record<string, unknown> {
	return reviewWorkerPrompt({
		kind: "implementation",
		graph: state.graph,
		issue,
		worktree: nonEmptyString(current.worktree, `Run Task ${issue.id} worktree`),
		base: nonEmptyString(current.wave_base, `Run Task ${issue.id} wave_base`),
		gate: requiredTaskGate(current, nonEmptyString(current.commit, `Run Task ${issue.id} review commit`), issue.id),
		prior_findings: current.review_findings,
		resolution: state.resolutions[issue.id],
	}, mode);
}

function taskReviewId(state: RunState, issueId: string, current: RunTaskState): string {
	return reviewId({
		run_id: state.run_id,
		kind: "implementation",
		issue_id: issueId,
		commit: nonEmptyString(current.commit, `Run Task ${issueId} review commit`),
		attempt: current.attempts,
		review_round: positiveInteger(current.review_rounds, `Run Task ${issueId} review round`),
	});
}

function requiredTaskGate(current: RunTaskState, commit: string, issueId: string): RequiredGateEvidence {
	const evidence = recordedGateEvidence(current, commit);
	if (!evidence) throw new Error(`Run Task ${issueId} required-gate evidence is missing`);
	return evidence;
}

function parseEnvelopePayload(type: WorkerEvent, value: unknown): Record<string, unknown> {
	const input = object(value, `worker envelope ${type} payload`);
	const only = (keys: readonly string[]) => {
		for (const key of Object.keys(input)) if (!keys.includes(key)) throw new Error(`Unknown worker envelope ${type} payload setting: ${key}`);
	};
	switch (type) {
		case "request_review":
			only(["commit", "attempt", "review_round", "summary"]);
			return {
				commit: nonEmptyString(input.commit, "request_review commit"),
				attempt: positiveInteger(input.attempt, "request_review attempt"),
				review_round: positiveInteger(input.review_round, "request_review review_round"),
				...(input.summary === undefined ? {} : { summary: nonEmptyString(input.summary, "request_review summary") }),
			};
		case "submit_review":
			only(["verdict", "findings"]);
			const verdict = oneOf(input.verdict, ["approved", "changes_requested", "blocked"] as const, "submit_review verdict");
			const findings = stringArray(input.findings, "submit_review findings");
			if (verdict !== "approved" && !findings.length) {
				throw new Error("Non-approval review verdict requires findings");
			}
			return { verdict, findings };
		case "submit_health":
			only(["summary", "actionable", "thread_ids", "checks", "attempt", "review_round"]);
			if (typeof input.actionable !== "boolean") throw new Error("submit_health actionable must be a boolean");
			return {
				summary: nonEmptyString(input.summary, "submit_health summary"),
				actionable: input.actionable,
				attempt: positiveInteger(input.attempt, "submit_health attempt"),
				review_round: positiveInteger(input.review_round, "submit_health review_round"),
				...(input.thread_ids === undefined ? {} : { thread_ids: stringArray(input.thread_ids, "submit_health thread_ids") }),
				...(input.checks === undefined ? {} : { checks: array(input.checks, "submit_health checks") }),
			};
		case "block_task":
			only(["reason", "attempt", "review_round"]);
			return {
				reason: nonEmptyString(input.reason, "block_task reason"),
				attempt: positiveInteger(input.attempt, "block_task attempt"),
				review_round: positiveInteger(input.review_round, "block_task review_round"),
			};
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

function provisioningIdFor(runId: string, issueId: string, role: WorkerRole): string {
	return `auto-dag:${runId}:${issueId}:${role}`;
}

async function save(state: RunState, options: OrchestrationOptions): Promise<RunState> {
	await writeRunState(state.main_worktree, state, options.uuid);
	return state;
}

function timestamp(options: OrchestrationOptions): string {
	return options.now?.() ?? new Date().toISOString();
}
