import { basename, dirname, join, resolve } from "node:path";
import { commandFailure, commandOutput, errorMessage, gateEvidenceRecord, recordedGateEvidence, runRequiredGate, type CommandRunner, type RequiredGateEvidence } from "./command.ts";
import { assertAttachedBranch, deleteExpectedBranch, ensureChildWorktree, findAppliedCherryPick, retireChildWorktree, verifySingleCommit } from "./git.ts";
import { executionIssues } from "./graph.ts";
import { assertRunBoundary } from "./intake.ts";
import type { LocalIssue, ProjectConfig, PullRequestIdentity, RunState, RunTaskState, WorkerEnvelope } from "./model.ts";
import { assertSamePullRequest, parsePullRequest, viewOpenPullRequest } from "./pull-request.ts";
import { persistGateOutput, reviewPrompt, type ReviewPromptMode } from "./review.ts";
import { issueById, replaceTask, task, writeRunState, type Uuid } from "./state.ts";
import { createWorkerLaunch, ensureWorkerPane, findWorkerTab, promptWorkerAgent, reconcileWorkerTab, retireWorkerTab, startWorkerAgent, workerAgentName, workerDeliveryContext, workerIssueContext, workerTabExists, WORKER_ROLE_EVENTS, type WorkerLaunch, type WorkerRole } from "./worker.ts";
import { array, nonEmptyString, oneOf, positiveInteger, stringArray } from "./validate.ts";

type PrLifecycleOptions = {
	runner: CommandRunner;
	uuid: Uuid;
	now?: () => string;
};

/** Run the lifecycle-owned final gate and reviewer, then create or recover the one integration PR. */
export async function advancePrLifecycle(
	state: RunState,
	config: ProjectConfig,
	options: PrLifecycleOptions,
): Promise<RunState> {
	state = await recoverPrLifecycleIntegration(state, options);
	if (!allImplementationsCompleted(state)) return state;
	const issue = finalCheck(state);
	const current = task(state, issue.id);
	if (current.status === "repair_cleanup") return await finishFinalRepair(state, issue, config, options);
	if (current.status === "repair_applying") return await applyFinalRepair(state, issue, config, options);
	if (current.status === "repairing") {
		return await ensureFinalRepairCoder(state, issue, repairOwner(state, current), config, options, "resume");
	}
	if (current.status === "repair_reviewing") return await ensureFinalRepairReviewer(state, issue, repairOwner(state, current), config, options, "resume");
	if (state.pr) return await completePr(state, issue, options);
	if (current.status === "approved") return await openPr(state, issue, options);
	if (current.status === "pending" || current.status === "completed") {
		return await startFinalReview(state, issue, config, options);
	}
	if (current.status === "reviewing") return await ensureFinalReviewer(state, issue, config, options, "resume");
	return state;
}

/** Final-check envelopes and repair envelopes stay separate from dependency-wave workers. */
export async function acceptPrLifecycleEnvelope(
	state: RunState,
	envelope: WorkerEnvelope,
	config: ProjectConfig,
	options: PrLifecycleOptions,
): Promise<RunState> {
	const issue = finalCheck(state);
	if (envelope.issue_id !== issue.id) throw new Error(`PR lifecycle event belongs to another Local Issue: ${envelope.issue_id}`);
	const current = task(state, issue.id);
	if (envelope.type === "submit_review" && current.status === "reviewing") {
		return await submitFinalReview(state, issue, envelope, options);
	}
	if (envelope.type === "request_review" && current.status === "repairing") {
		return await requestFinalRepairReview(state, issue, envelope, config, options);
	}
	if (envelope.type === "submit_review" && current.status === "repair_reviewing") {
		return await submitFinalRepairReview(state, issue, envelope, config, options);
	}
	if (envelope.type === "block_task" && current.status === "reviewing" && envelope.role === "reviewer" && matchesBlock(current, envelope, false)) {
		return await failFinalGate(state, issue, nonEmptyString(envelope.payload.reason, "final-check block reason"), options);
	}
	if (envelope.type === "block_task" && current.status === "repairing" && envelope.role === "implementer" && matchesBlock(current, envelope, true)) {
		return await failFinalGate(state, issue, nonEmptyString(envelope.payload.reason, "final-gate repair block reason"), options);
	}
	if (envelope.type === "block_task" && current.status === "repair_reviewing" && envelope.role === "reviewer" && matchesBlock(current, envelope, false)) {
		return await failFinalGate(state, issue, nonEmptyString(envelope.payload.reason, "final-gate repair review block reason"), options);
	}
	throw new Error(`Unexpected PR lifecycle event ${envelope.type} while final_check is ${current.status}`);
}

/** A failed final gate is repaired only after the user names its owning completed Local Issue. */
export async function resolvePrLifecycle(
	state: RunState,
	issueId: string,
	resolution: string,
	config: ProjectConfig,
	options: PrLifecycleOptions,
): Promise<RunState | undefined> {
	const issue = finalCheck(state);
	const finalTask = task(state, issue.id);
	if (finalTask.status !== "blocked" || !finalTask.final_gate_head) return undefined;
	if (issueId === issue.id) {
		throw new Error("Final-gate failure must be resolved against its owning completed implementation Local Issue");
	}
	const owner = issueById(state, issueId);
	if (owner.role !== "implementation" || task(state, owner.id).status !== "completed") {
		throw new Error(`Final-gate resolution must name a completed implementation Local Issue: ${issueId}`);
	}
	const attempt = (finalTask.repair_attempt ?? 0) + 1;
	state = await retireFinalRepair(state, issue, options);
	if (task(state, issue.id).worktree) return state;
	const next: RunTaskState = {
		...task(state, issue.id),
		status: "repairing",
		activity_started_at: timestamp(options),
		attempts: task(state, issue.id).attempts + 1,
		repair_issue_id: owner.id,
		repair_attempt: attempt,
		repair_base: state.integration_head,
		wave_base: state.integration_head,
		worktree: repairWorktreePath(state, owner.id, attempt),
		branch: repairBranch(state, owner.id, attempt),
		commit: undefined,
		review_rounds: 0,
		tab_id: undefined,
		implementer_pane: undefined,
		implementer_agent: workerAgentName(state.workspace_id, state.run_id, `final-repair-${owner.id}-${attempt}`, "implementer"),
		implementer_provisioning_id: `auto-dag:${state.run_id}:final-repair:${owner.id}:${attempt}:implementer`,
		reviewer_pane: undefined,
		reviewer_agent: undefined,
		reviewer_provisioning_id: undefined,
		tab_cleanup_done: undefined,
		worktree_cleanup_done: undefined,
		branch_cleanup_done: undefined,
		implementer_instruction_pending: true,
	};
	const { block_reason: _blockReason, ...unblocked } = state;
	state = await save({
		...replaceTask(unblocked, issue.id, next),
		phase: "execution",
		resolutions: { ...state.resolutions, [owner.id]: nonEmptyString(resolution, "resolution") },
	}, options);
	return await ensureFinalRepairCoder(state, issue, owner, config, options, "initial");
}

/** Reconcile lifecycle-owned integration work before resuming generic orchestration. */
export async function resumePrLifecycle(state: RunState, options: PrLifecycleOptions): Promise<RunState> {
	state = await abortPrLifecycleCherryPick(state, options);
	return await recoverPrLifecycleIntegration(state, options);
}

/** Abort cleanup reaches lifecycle repair resources; unintegrated branches remain untouched. */
export async function cleanupPrLifecycle(state: RunState, options: PrLifecycleOptions): Promise<RunState> {
	if (state.phase !== "aborted") return state;
	const issue = finalCheck(state);
	return isFinalRepair(task(state, issue.id)) ? await cleanupAbortedFinalRepair(state, issue, options) : state;
}

async function cleanupAbortedFinalRepair(state: RunState, issue: LocalIssue, options: PrLifecycleOptions): Promise<RunState> {
	let current = task(state, issue.id);
	try {
		const tabId = current.tab_id ?? (current.implementer_provisioning_id
			? (await findWorkerTab(state, current.implementer_provisioning_id, options))?.tab_id
			: undefined);
		if (!tabId) {
			state = await save(clearLifecycleCleanupBlock(replaceTask(state, issue.id, { ...current, tab_cleanup_done: true }), issue.id, "tab"), options);
			current = task(state, issue.id);
		} else {
			await retireWorkerTab(state, tabId, options);
			state = await save(clearLifecycleCleanupBlock(replaceTask(state, issue.id, {
				...current,
				tab_id: undefined,
				implementer_pane: undefined,
				reviewer_pane: undefined,
				tab_cleanup_done: true,
			}), issue.id, "tab"), options);
			current = task(state, issue.id);
		}
	} catch (error) {
		return await recordLifecycleCleanupBlock(state, issue.id, "tab", errorMessage(error), options);
	}
	if (!current.worktree) {
		return await save(clearLifecycleCleanupBlock(replaceTask(state, issue.id, { ...current, worktree_cleanup_done: true }), issue.id, "worktree"), options);
	}
	try {
		await retireChildWorktree(options.runner, state.main_worktree, current.worktree, finalRepairBranch(state, current), "Final-gate repair");
	} catch (error) {
		return await recordLifecycleCleanupBlock(state, issue.id, "worktree", errorMessage(error), options);
	}
	return await save(clearLifecycleCleanupBlock(replaceTask(state, issue.id, {
		...task(state, issue.id),
		worktree: undefined,
		worktree_cleanup_done: true,
	}), issue.id, "worktree"), options);
}

/** Reconcile a lifecycle-owned cherry-pick that finished before its state update. */
async function recoverPrLifecycleIntegration(state: RunState, options: PrLifecycleOptions): Promise<RunState> {
	const issue = finalCheck(state);
	const current = task(state, issue.id);
	if (current.status !== "repair_applying" || !current.integration_intent) return state;
	const integrationHead = await findAppliedCherryPick(options.runner, state.main_worktree, state.integration_branch, state.integration_head, current.integration_intent, "Main integration");
	return integrationHead
		? await save(replaceTask({ ...state, integration_head: integrationHead }, issue.id, {
			...current,
			status: "repair_cleanup",
			repair_commit: current.integration_intent,
		}), options)
		: state;
}

/** Abort only a final-repair cherry-pick whose durable intent belongs to this run. */
async function abortPrLifecycleCherryPick(state: RunState, options: PrLifecycleOptions): Promise<RunState> {
	await assertAttachedBranch(options.runner, state.main_worktree, state.integration_branch, "Main integration");
	const result = await options.runner("git", ["rev-parse", "-q", "--verify", "CHERRY_PICK_HEAD"], { cwd: state.main_worktree });
	if (result.code === 1) return state;
	if (result.code !== 0) throw new Error(commandFailure("git", ["rev-parse", "-q", "--verify", "CHERRY_PICK_HEAD"], result));
	const commit = result.stdout.trim();
	const issue = finalCheck(state);
	const current = task(state, issue.id);
	if (current.integration_intent === commit) {
		await commandOutput(options.runner, "git", ["cherry-pick", "--abort"], state.main_worktree);
		return await save(replaceTask(state, issue.id, {
			...current,
			status: "repairing",
			activity_started_at: timestamp(options),
			integration_intent: undefined,
			review_findings: [...reviewFindings(current), "Integration cherry-pick conflicted; produce a fresh repair commit."],
			implementer_instruction_pending: true,
		}), options);
	}
	return state;
}

async function startFinalReview(state: RunState, issue: LocalIssue, config: ProjectConfig, options: PrLifecycleOptions): Promise<RunState> {
	const current = task(state, issue.id);
	const attempt = current.attempts + 1;
	state = await save(replaceTask(state, issue.id, {
		...current,
		status: "reviewing",
		activity_started_at: timestamp(options),
		attempts: attempt,
		wave_base: state.integration_head,
		commit: state.integration_head,
		review_rounds: 1,
		final_gate_head: state.integration_head,
		final_gate_findings: undefined,
		implementer_provisioning_id: finalReviewerLabel(state, attempt),
		reviewer_agent: workerAgentName(state.workspace_id, state.run_id, `final-${attempt}`, "reviewer"),
		reviewer_instruction_pending: true,
		tab_cleanup_done: undefined,
	}), options);
	return await ensureFinalReviewer(state, issue, config, options, "review");
}

async function ensureFinalReviewer(
	state: RunState,
	issue: LocalIssue,
	config: ProjectConfig,
	options: PrLifecycleOptions,
	mode: "review" | "resume",
): Promise<RunState> {
	await assertRunBoundary(state, options.runner);
	let current = task(state, issue.id);
	const commit = nonEmptyString(current.commit, "final-check commit");
	if (commit !== state.integration_head) throw new Error("Final-check commit does not match the integration HEAD");
	state = await ensureRecordedGate(state, issue, commit, state.main_worktree, options);
	current = task(state, issue.id);
	const label = nonEmptyString(current.implementer_provisioning_id, "final reviewer provisioning identity");
	const launch = workerLaunch(state, issue, config, "reviewer");
	const resource = await reconcileWorkerTab(state, {
		tab_id: current.tab_id,
		pane_id: current.reviewer_pane,
		cwd: state.main_worktree,
		launch,
		label,
	}, options);
	if (current.tab_id !== resource.tab_id || current.reviewer_pane !== resource.pane_id) {
		state = await save(replaceTask(state, issue.id, {
			...current,
			tab_id: resource.tab_id,
			implementer_pane: resource.pane_id,
			reviewer_pane: resource.pane_id,
		}), options);
		current = task(state, issue.id);
	}
	const agent = nonEmptyString(current.reviewer_agent, "final reviewer agent");
	const started = await startWorkerAgent(state, agent, nonEmptyString(current.reviewer_pane, "final reviewer pane"), launch, options, {
		beforeStart: async () => {
			const latest = task(state, issue.id);
			if (!latest.reviewer_instruction_pending) state = await save(replaceTask(state, issue.id, { ...latest, reviewer_instruction_pending: true }), options);
		},
	});
	current = task(state, issue.id);
	const needsInstruction = Boolean(current.reviewer_instruction_pending) || mode === "review" || started !== "existing";
	const promptMode: ReviewPromptMode = !needsInstruction
		? "resend"
		: started !== "existing" || current.review_rounds === 1
			? "full"
			: "update";
	await promptWorkerAgent(state, agent, reviewPrompt({
		kind: "final_check",
		graph: state.graph,
		issue,
		worktree: state.main_worktree,
		base: state.source_commit,
		gate: requiredTaskGate(current, commit, "Final check"),
		main_worktree: state.main_worktree,
		run_id: state.run_id,
	}, promptMode), options);
	if (needsInstruction) {
		state = await save(replaceTask(state, issue.id, { ...task(state, issue.id), reviewer_instruction_pending: undefined }), options);
	}
	return state;
}

async function submitFinalReview(
	state: RunState,
	issue: LocalIssue,
	envelope: WorkerEnvelope,
	options: PrLifecycleOptions,
): Promise<RunState> {
	if (envelope.role !== "reviewer") throw new Error("Only the final-check reviewer can submit final review");
	const current = task(state, issue.id);
	const gate = requiredTaskGate(current, state.integration_head, "Final check");
	const verdict = oneOf(envelope.payload.verdict, ["approved", "changes_requested", "blocked"] as const, "final-check verdict");
	const findings = stringArray(envelope.payload.findings, "final-check findings");
	await assertRunBoundary(state, options.runner);
	if (current.commit !== state.integration_head || current.final_gate_head !== state.integration_head) {
		return await failFinalGate(state, issue, "Final-check review did not inspect the exact integration HEAD", options);
	}
	if (verdict !== "approved") return await failFinalGate(state, issue, findings.join("; "), options, findings);
	if (gate.exit_code !== 0) return await failFinalGate(state, issue, `Required gate exited with code ${gate.exit_code}; approval requires exit code 0`, options, findings);
	state = await save(replaceTask(state, issue.id, {
		...current,
		status: "approved",
		final_gate_findings: findings,
	}), options);
	return await openPr(state, issue, options);
}

async function failFinalGate(
	state: RunState,
	issue: LocalIssue,
	reason: string,
	options: PrLifecycleOptions,
	findings: string[] = [],
): Promise<RunState> {
	const current = task(state, issue.id);
	const blockedRole = current.status === "repairing" ? "implementer" : ["reviewing", "repair_reviewing"].includes(current.status) ? "reviewer" : undefined;
	return await save({
		...replaceTask(state, issue.id, {
			...current,
			status: "blocked",
			block_reason: reason,
			activity_started_at: timestamp(options),
			...(blockedRole ? { blocked_role: blockedRole } : {}),
			final_gate_head: state.integration_head,
			final_gate_findings: findings,
		}),
		phase: "blocked",
		block_reason: `Final check blocked: ${reason}`,
	}, options);
}

async function requestFinalRepairReview(
	state: RunState,
	issue: LocalIssue,
	envelope: WorkerEnvelope,
	config: ProjectConfig,
	options: PrLifecycleOptions,
): Promise<RunState> {
	if (envelope.role !== "implementer") throw new Error("Only the final-gate repair implementer can request review");
	const current = task(state, issue.id);
	if (envelope.payload.attempt !== current.attempts || envelope.payload.review_round !== (current.review_rounds ?? 0) + 1) return state;
	const owner = repairOwner(state, current);
	const commit = await verifyRepairCommit(
		state,
		issue,
		nonEmptyString(envelope.payload.commit, "final-gate repair commit"),
		options,
	);
	if (Array.isArray(current.review_findings) && current.review_findings.length && current.commit === commit) {
		return await failFinalGate(state, issue, "Final-gate repair revision must use a new commit", options);
	}
	state = await save(replaceTask(state, issue.id, {
		...current,
		status: "repair_reviewing",
		activity_started_at: timestamp(options),
		commit,
		review_rounds: (current.review_rounds ?? 0) + 1,
		reviewer_provisioning_id: `auto-dag:${state.run_id}:final-repair:${owner.id}:${current.repair_attempt}:reviewer`,
		reviewer_agent: workerAgentName(state.workspace_id, state.run_id, `final-repair-${owner.id}-${current.repair_attempt}`, "reviewer"),
		reviewer_instruction_pending: true,
	}), options);
	return await ensureFinalRepairReviewer(state, issue, owner, config, options, "review");
}

async function ensureFinalRepairCoder(
	state: RunState,
	issue: LocalIssue,
	owner: LocalIssue,
	config: ProjectConfig,
	options: PrLifecycleOptions,
	mode: "initial" | "revision" | "resume",
): Promise<RunState> {
	await ensureRepairWorktree(state, issue, options);
	let current = task(state, issue.id);
	const launch = workerLaunch(state, owner, config, "implementer");
	const label = nonEmptyString(current.implementer_provisioning_id, "final repair implementer provisioning identity");
	const resource = await reconcileWorkerTab(state, {
		tab_id: current.tab_id,
		pane_id: current.implementer_pane,
		cwd: nonEmptyString(current.worktree, "final repair worktree"),
		launch,
		label,
	}, options);
	if (current.tab_id !== resource.tab_id || current.implementer_pane !== resource.pane_id) {
		state = await save(replaceTask(state, issue.id, { ...current, tab_id: resource.tab_id, implementer_pane: resource.pane_id }), options);
		current = task(state, issue.id);
	}
	const agent = nonEmptyString(current.implementer_agent, "final repair implementer agent");
	const started = await startWorkerAgent(state, agent, nonEmptyString(current.implementer_pane, "final repair implementer pane"), launch, options, {
		beforeStart: async () => {
			const latest = task(state, issue.id);
			if (!latest.implementer_instruction_pending) state = await save(replaceTask(state, issue.id, { ...latest, implementer_instruction_pending: true }), options);
		},
	});
	current = task(state, issue.id);
	const needsInstruction = Boolean(current.implementer_instruction_pending) || mode !== "resume" || started !== "existing";
	const promptMode = needsInstruction && mode === "resume"
		? (hasFindings(current) ? "revision" : "initial")
		: mode;
	const fullPrompt = mode === "initial" || started !== "existing" || (mode === "resume" && Boolean(current.implementer_instruction_pending));
	const instruction = promptMode === "resume"
		? "Resend your latest worker event through the worker tool."
		: promptMode === "revision"
			? "Address the reviewer findings by amending the sole repair commit, then request review again."
			: "Implement the named final-gate repair in this fresh child worktree, commit exactly one change over the repair base, then request review.";
	await promptWorkerAgent(state, agent, fullPrompt ? {
		type: "auto_dag_final_repair",
		run_id: state.run_id,
		delivery: workerDeliveryContext(state.graph),
		owner_issue: workerIssueContext(owner, true),
		resolution: state.resolutions[owner.id],
		worktree: current.worktree,
		wave_base: current.repair_base,
		attempt: current.attempts,
		review_round: (current.review_rounds ?? 0) + 1,
		instruction,
	} : {
		type: promptMode === "resume" ? "auto_dag_resend" : "auto_dag_final_repair_update",
		run_id: state.run_id,
		issue_id: owner.id,
		attempt: current.attempts,
		review_round: (current.review_rounds ?? 0) + 1,
		review_findings: current.review_findings,
		instruction,
	}, options);
	if (needsInstruction) {
		state = await save(replaceTask(state, issue.id, { ...task(state, issue.id), implementer_instruction_pending: undefined }), options);
	}
	return state;
}

async function ensureFinalRepairReviewer(
	state: RunState,
	issue: LocalIssue,
	owner: LocalIssue,
	config: ProjectConfig,
	options: PrLifecycleOptions,
	mode: "review" | "resume",
): Promise<RunState> {
	let current = task(state, issue.id);
	const commit = nonEmptyString(current.commit, "final-gate repair commit");
	await verifyRepairCommit(state, issue, commit, options);
	state = await ensureRecordedGate(state, issue, commit, nonEmptyString(current.worktree, "final repair worktree"), options);
	current = task(state, issue.id);
	const launch = workerLaunch(state, owner, config, "reviewer");
	if (current.reviewer_pane) {
		const tabId = nonEmptyString(current.tab_id, "final repair tab id");
		if (!(await workerTabExists(state, tabId, options))) throw new Error(`Final repair tab is missing: ${tabId}`);
	}
	if (!current.reviewer_pane) {
		const tab = nonEmptyString(current.tab_id, "final repair tab id");
		const root = nonEmptyString(current.implementer_pane, "final repair implementer pane");
		const label = nonEmptyString(current.reviewer_provisioning_id, "final repair reviewer provisioning identity");
		const pane = await ensureWorkerPane(state, tab, root, nonEmptyString(current.worktree, "final repair worktree"), launch, label, options);
		state = await save(replaceTask(state, issue.id, { ...current, reviewer_pane: pane }), options);
		current = task(state, issue.id);
	}
	const agent = nonEmptyString(current.reviewer_agent, "final repair reviewer agent");
	const started = await startWorkerAgent(state, agent, nonEmptyString(current.reviewer_pane, "final repair reviewer pane"), launch, options, {
		beforeStart: async () => {
			const latest = task(state, issue.id);
			if (!latest.reviewer_instruction_pending) state = await save(replaceTask(state, issue.id, { ...latest, reviewer_instruction_pending: true }), options);
		},
	});
	current = task(state, issue.id);
	const needsInstruction = Boolean(current.reviewer_instruction_pending) || mode === "review" || started !== "existing";
	const promptMode: ReviewPromptMode = !needsInstruction
		? "resend"
		: started !== "existing" || current.review_rounds === 1
			? "full"
			: "update";
	await promptWorkerAgent(state, agent, reviewPrompt({
		kind: "final_repair",
		graph: state.graph,
		issue,
		worktree: nonEmptyString(current.worktree, "final repair worktree"),
		base: nonEmptyString(current.repair_base, "final repair base"),
		gate: requiredTaskGate(current, commit, "Final-gate repair"),
		main_worktree: state.main_worktree,
		run_id: state.run_id,
		prior_findings: current.review_findings,
		resolution: state.resolutions[owner.id],
		context: { owner_issue: workerIssueContext(owner, false) },
	}, promptMode), options);
	if (needsInstruction) {
		state = await save(replaceTask(state, issue.id, { ...task(state, issue.id), reviewer_instruction_pending: undefined }), options);
	}
	return state;
}

async function submitFinalRepairReview(
	state: RunState,
	issue: LocalIssue,
	envelope: WorkerEnvelope,
	config: ProjectConfig,
	options: PrLifecycleOptions,
): Promise<RunState> {
	if (envelope.role !== "reviewer") throw new Error("Only the final-gate repair reviewer can submit review");
	const current = task(state, issue.id);
	const commit = nonEmptyString(current.commit, "final-gate repair commit");
	const gate = requiredTaskGate(current, commit, "Final-gate repair");
	const verdict = oneOf(envelope.payload.verdict, ["approved", "changes_requested", "blocked"] as const, "final-gate repair verdict");
	const findings = stringArray(envelope.payload.findings, "final-gate repair findings");
	await verifyRepairCommit(state, issue, commit, options);
	if (verdict === "blocked") return await failFinalGate(state, issue, findings.join("; "), options, findings);
	if (verdict === "changes_requested") {
		const owner = repairOwner(state, current);
		state = await save(replaceTask(state, issue.id, {
			...current,
			status: "repairing",
			activity_started_at: timestamp(options),
			review_findings: findings,
			implementer_instruction_pending: true,
		}), options);
		return await ensureFinalRepairCoder(state, issue, owner, config, options, "revision");
	}
	if (gate.exit_code !== 0) return await failFinalGate(state, issue, `Required gate exited with code ${gate.exit_code}; approval requires exit code 0`, options, findings);
	state = await save(replaceTask(state, issue.id, {
		...current,
		status: "repair_applying",
		integration_intent: commit,
		repair_commit: commit,
		review_findings: findings,
	}), options);
	return await applyFinalRepair(state, issue, config, options);
}

async function applyFinalRepair(state: RunState, issue: LocalIssue, config: ProjectConfig, options: PrLifecycleOptions): Promise<RunState> {
	const current = task(state, issue.id);
	const reviewed = nonEmptyString(current.repair_commit ?? current.commit, "final-gate repair commit");
	const commit = current.integration_intent ?? reviewed;
	if (current.integration_intent && current.integration_intent !== reviewed) throw new Error("Final-gate repair integration intent does not match its reviewed commit");
	await assertRunBoundary(state, options.runner);
	await verifyRepairCommit(state, issue, commit, options);
	if (!current.integration_intent) {
		state = await save(replaceTask(state, issue.id, { ...current, status: "repair_applying", integration_intent: commit }), options);
	}
	await commandOutput(options.runner, "git", ["cherry-pick", "-x", commit], state.main_worktree);
	const integrationHead = await commandOutput(options.runner, "git", ["rev-parse", "HEAD"], state.main_worktree);
	state = await save(replaceTask({ ...state, integration_head: integrationHead }, issue.id, {
		...task(state, issue.id),
		status: "repair_cleanup",
		integration_intent: commit,
		repair_commit: commit,
	}), options);
	return await finishFinalRepair(state, issue, config, options);
}

async function finishFinalRepair(state: RunState, issue: LocalIssue, config: ProjectConfig, options: PrLifecycleOptions): Promise<RunState> {
	const current = task(state, issue.id);
	const commit = nonEmptyString(current.repair_commit ?? current.commit, "integrated final-gate repair commit");
	if (current.tab_id) {
		await retireWorkerTab(state, current.tab_id, options);
		state = await save(replaceTask(state, issue.id, { ...task(state, issue.id), tab_id: undefined, implementer_pane: undefined, reviewer_pane: undefined }), options);
	}
	const worktree = task(state, issue.id).worktree;
	if (worktree) {
		await retireChildWorktree(options.runner, state.main_worktree, worktree, nonEmptyString(task(state, issue.id).branch, "final-gate repair branch"), "Final-gate repair");
		state = await save(replaceTask(state, issue.id, { ...task(state, issue.id), worktree: undefined }), options);
	}
	const branch = task(state, issue.id).branch;
	if (branch) {
		await deleteExpectedBranch(options.runner, state.main_worktree, branch, commit, "Final-gate repair");
		state = await save(replaceTask(state, issue.id, { ...task(state, issue.id), branch: undefined }), options);
	}
	const next = task(state, issue.id);
	const { block_reason: _taskBlockReason, ...cleared } = next;
	const { block_reason: _runBlockReason, ...unblocked } = state;
	state = await save(replaceTask({ ...unblocked, phase: "execution" }, issue.id, {
		...cleared,
		status: "pending",
		branch: undefined,
		commit: undefined,
		integration_intent: undefined,
		wave_base: undefined,
		repair_base: undefined,
		reviewer_agent: undefined,
		reviewer_provisioning_id: undefined,
		implementer_agent: undefined,
		implementer_provisioning_id: undefined,
	}), options);
	return await advancePrLifecycle(state, config, options);
}

async function openPr(state: RunState, issue: LocalIssue, options: PrLifecycleOptions): Promise<RunState> {
	await assertRunBoundary(state, options.runner);
	if (state.pr) return await completePr(state, issue, options);
	await matchingOpenPr(state, options);
	await commandOutput(options.runner, "git", ["push", "origin", state.integration_branch], state.main_worktree);
	let identity = await matchingOpenPr(state, options);
	if (!identity) {
		const title = `feat: deliver ${state.graph.id}`;
		await commandOutput(options.runner, "gh", [
			"pr", "create", "--base", state.default_branch, "--head", state.integration_branch,
			"--title", title, "--body", prBody(state),
		], state.main_worktree);
		identity = await matchingOpenPr(state, options);
		if (!identity) throw new Error("gh pr create did not create the expected open integration PR");
	}
	state = await save({ ...state, pr: identity }, options);
	return await completePr(state, issue, options);
}

async function completePr(state: RunState, issue: LocalIssue, options: PrLifecycleOptions): Promise<RunState> {
	const identity = state.pr;
	if (!identity) throw new Error("Cannot complete a PR lifecycle without PR identity");
	const current = await viewOpenPullRequest(state.main_worktree, identity.number, options.runner);
	assertSamePullRequest(identity, current, true);
	if (current.head_oid !== state.integration_head) throw new Error("Open integration PR head does not match the recorded integration HEAD");
	return await save({
		...state,
		pr: current,
		phase: "completed",
		tasks: {
			...state.tasks,
			[issue.id]: { ...task(state, issue.id), status: "completed" },
		},
	}, options);
}

async function recordLifecycleCleanupBlock(
	state: RunState,
	issueId: string,
	operation: "tab" | "worktree",
	reason: string,
	options: PrLifecycleOptions,
): Promise<RunState> {
	const blocks = [...(state.cleanup_blocks ?? []).filter((block) => block.issue_id !== issueId || block.operation !== operation), { issue_id: issueId, operation, reason }];
	return await save({ ...state, cleanup_blocks: blocks }, options);
}

function clearLifecycleCleanupBlock(state: RunState, issueId: string, operation: "tab" | "worktree"): RunState {
	const cleanupBlocks = (state.cleanup_blocks ?? []).filter((block) => block.issue_id !== issueId || block.operation !== operation);
	return { ...state, ...(cleanupBlocks.length ? { cleanup_blocks: cleanupBlocks } : { cleanup_blocks: undefined }) };
}

async function ensureRepairWorktree(state: RunState, issue: LocalIssue, options: PrLifecycleOptions): Promise<void> {
	const current = task(state, issue.id);
	await ensureChildWorktree(
		options.runner,
		state.main_worktree,
		nonEmptyString(current.worktree, "final-gate repair worktree"),
		nonEmptyString(current.branch, "final-gate repair branch"),
		nonEmptyString(current.repair_base, "final-gate repair base"),
		"Final-gate repair",
	);
}

async function verifyRepairCommit(state: RunState, issue: LocalIssue, commit: string, options: PrLifecycleOptions): Promise<string> {
	const current = task(state, issue.id);
	return await verifyOneCommit(
		state,
		nonEmptyString(current.worktree, "final-gate repair worktree"),
		nonEmptyString(current.branch, "final-gate repair branch"),
		nonEmptyString(current.repair_base, "final-gate repair base"),
		commit,
		"Final-gate repair",
		options,
	);
}

async function verifyOneCommit(
	state: RunState,
	worktree: string,
	branch: string,
	base: string,
	commit: string,
	label: string,
	options: PrLifecycleOptions,
): Promise<string> {
	await assertAttachedBranch(options.runner, worktree, branch, `${label} child worktree`);
	return await verifySingleCommit(options.runner, state.main_worktree, worktree, base, commit, label);
}

async function closeFinalTab(state: RunState, issue: LocalIssue, options: PrLifecycleOptions): Promise<RunState> {
	const current = task(state, issue.id);
	if (!current.tab_id) return state;
	await retireWorkerTab(state, current.tab_id, options);
	return await save(replaceTask(state, issue.id, {
		...current,
		tab_id: undefined,
		implementer_pane: undefined,
		reviewer_pane: undefined,
		tab_cleanup_done: true,
	}), options);
}

async function retireFinalRepair(state: RunState, issue: LocalIssue, options: PrLifecycleOptions): Promise<RunState> {
	if (!isFinalRepair(task(state, issue.id))) return await closeFinalTab(state, issue, options);
	state = await closeFinalTab(state, issue, options);
	const current = task(state, issue.id);
	if (!current.worktree) return state;
	try {
		await retireChildWorktree(options.runner, state.main_worktree, current.worktree, finalRepairBranch(state, current), "Final-gate repair");
	} catch (error) {
		return await failFinalGate(state, issue, `Final-gate repair cannot be retired: ${errorMessage(error)}`, options, current.final_gate_findings ?? []);
	}
	return await save(replaceTask(state, issue.id, { ...current, worktree: undefined, worktree_cleanup_done: true }), options);
}

async function matchingOpenPr(state: RunState, options: PrLifecycleOptions): Promise<PullRequestIdentity | undefined> {
	const text = await commandOutput(options.runner, "gh", [
		"pr", "list", "--state", "open", "--head", state.integration_branch,
		"--json", "number,url,headRefName,baseRefName,headRefOid",
	], state.main_worktree);
	const candidates = array(JSON.parse(text), "gh pr list").map((value, index) => parsePullRequest(value, `gh pr list[${index}]`));
	if (candidates.length > 1) throw new Error(`Multiple open PRs match integration branch ${state.integration_branch}`);
	if (!candidates.length) return undefined;
	const candidate = candidates[0];
	if (candidate.head_ref !== state.integration_branch || candidate.base_ref !== state.default_branch) {
		throw new Error("Matching open PR has mismatched head or base identity");
	}
	return candidate;
}

function prBody(state: RunState): string {
	const completed = executionIssues(state.graph)
		.filter((issue) => issue.role === "implementation" && task(state, issue.id).status === "completed")
		.map((issue) => issue.id)
		.sort();
	return [
		"## Delivery Graph",
		`- ID: \`${state.graph.id}\``,
		`- SHA-256: \`${state.graph_hash}\``,
		`- Source commit: \`${state.source_commit}\``,
		`- Completed Local Issues: ${completed.map((id) => `\`${id}\``).join(", ")}`,
	].join("\n");
}

function hasFindings(value: unknown): boolean {
	return reviewFindings(value).length > 0;
}

function isFinalRepair(current: RunTaskState): boolean {
	return Boolean(current.repair_issue_id && current.repair_base && current.repair_attempt);
}

function finalRepairBranch(state: RunState, current: RunTaskState): string {
	return current.branch ?? repairBranch(
		state,
		nonEmptyString(current.repair_issue_id, "final-gate repair owner Local Issue"),
		positiveInteger(current.repair_attempt, "final-gate repair attempt"),
	);
}

function reviewFindings(value: unknown): string[] {
	if (typeof value !== "object" || value === null || !Array.isArray((value as Record<string, unknown>).review_findings)) return [];
	return (value as Record<string, unknown>).review_findings as string[];
}

function repairOwner(state: RunState, current: RunTaskState): LocalIssue {
	return issueById(state, nonEmptyString(current.repair_issue_id, "final-gate repair owner Local Issue"));
}

function allImplementationsCompleted(state: RunState): boolean {
	return executionIssues(state.graph).filter((issue) => issue.role === "implementation").every((issue) => task(state, issue.id).status === "completed");
}

function finalCheck(state: RunState): LocalIssue {
	return executionIssues(state.graph).at(-1)!;
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
		issue_id: finalCheck(state).id,
		main_pane: nonEmptyString(state.main_pane, "recorded main Herdr pane"),
	});
}

function matchesBlock(current: RunTaskState, envelope: WorkerEnvelope, implementer: boolean): boolean {
	return envelope.payload.attempt === current.attempts
		&& envelope.payload.review_round === (implementer ? (current.review_rounds ?? 0) + 1 : current.review_rounds);
}

function repairWorktreePath(state: RunState, owner: string, attempt: number): string {
	return join(dirname(resolve(state.main_worktree)), `.${basename(state.main_worktree)}-auto-dag`, state.run_id, `final-repair-${owner}-${attempt}`);
}

function repairBranch(state: RunState, owner: string, attempt: number): string {
	return `pi-auto-dag/${state.run_id}/final-repair/${owner}/${attempt}`;
}

function finalReviewerLabel(state: RunState, attempt: number): string {
	return `auto-dag:${state.run_id}:final-check:${attempt}:reviewer`;
}

async function ensureRecordedGate(
	state: RunState,
	issue: LocalIssue,
	commit: string,
	cwd: string,
	options: PrLifecycleOptions,
): Promise<RunState> {
	const current = task(state, issue.id);
	let evidence = recordedGateEvidence(current, commit);
	if (!evidence) {
		evidence = await runRequiredGate(options.runner, issue.testing, commit, cwd);
		state = await save(replaceTask(state, issue.id, { ...current, ...gateEvidenceRecord(evidence) }), options);
	}
	await persistGateOutput(state, issue.id, evidence, options.uuid);
	return state;
}

function requiredTaskGate(current: RunTaskState, commit: string, label: string): RequiredGateEvidence {
	const evidence = recordedGateEvidence(current, commit);
	if (!evidence) throw new Error(`${label} required-gate evidence is missing`);
	return evidence;
}

async function save(state: RunState, options: PrLifecycleOptions): Promise<RunState> {
	await writeRunState(state.main_worktree, state, options.uuid);
	return state;
}

function timestamp(options: PrLifecycleOptions): string {
	return options.now?.() ?? new Date().toISOString();
}
