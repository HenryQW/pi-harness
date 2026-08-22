import { basename, dirname, join, resolve } from "node:path";
import { commandFailure, commandOutput, errorMessage, type CommandRunner } from "./command.ts";
import {
	findManagedSubagentTab,
	managedSubagentTabExists,
	promptManagedSubagent,
	reconcileManagedSubagentPane,
	reconcileManagedSubagentTab,
	retireManagedSubagentTab,
	startManagedSubagent,
} from "@henryqw/pi-subagent";
import { ensureRecordedGate, failFinalGate, gateCommandAmendments, requiredGateCommand, requiredTaskGate } from "./final-gate.ts";
import { assertAttachedBranch, deleteExpectedBranch, ensureChildWorktree, findAppliedCherryPick, retireChildWorktree, verifySingleCommit } from "./git.ts";
import { assertRunBoundary } from "./intake.ts";
import type { LocalIssue, ProjectConfig, RunState, RunTaskState, SubmitReviewEnvelope, WorkerEnvelope } from "./model.ts";
import { actionTicketPath, ensureActionTicket, type ReviewKind } from "./review-ticket.ts";
import { reviewPrompt, type ReviewPromptMode } from "./review.ts";
import { issueById, replaceTask, task, type Uuid } from "./state.ts";
import {
	clearLifecycleCleanupBlock,
	finalCheck,
	hasReviewFindings,
	lifecycleReviewId,
	lifecycleWorkerLaunch,
	matchesRound,
	recordLifecycleCleanupBlock,
	saveRunState as save,
	timestamp,
	verifyOneCommit,
} from "./worker-protocol.ts";
import { workerAgentName, workerDeliveryContext, workerHost, workerHostOptions, workerIssueContext, type RoleLaunchResolver, type WorkerLaunch, type WorkerRole } from "./worker.ts";
import { nonEmptyString, oneOf, positiveInteger, stringArray } from "./validate.ts";

export type FinalRepairOptions = {
	runner: CommandRunner;
	uuid: Uuid;
	now?: () => string;
	resolveLaunch: RoleLaunchResolver;
};

export function isFinalRepairActive(state: RunState): boolean {
	return ["repairing", "repair_reviewing", "repair_applying", "repair_cleanup"].includes(task(state, finalCheck(state).id).status);
}

export async function advanceFinalRepair(
	state: RunState,
	config: ProjectConfig,
	options: FinalRepairOptions,
): Promise<RunState> {
	const issue = finalCheck(state);
	const current = task(state, issue.id);
	if (current.status === "repair_cleanup") return await finishFinalRepair(state, issue, options);
	if (current.status === "repair_applying") return await applyFinalRepair(state, issue, options);
	if (current.status === "repairing") {
		return await ensureFinalRepairCoder(state, issue, repairOwner(state, current), config, options, "resume");
	}
	if (current.status === "repair_reviewing") return await ensureFinalRepairReviewer(state, issue, repairOwner(state, current), config, options, "resume");
	return state;
}

export async function acceptFinalRepairEnvelope(
	state: RunState,
	envelope: WorkerEnvelope,
	config: ProjectConfig,
	options: FinalRepairOptions,
): Promise<RunState> {
	const issue = finalCheck(state);
	const current = task(state, issue.id);
	if (envelope.type === "request_review" && current.status === "repairing") {
		return await requestFinalRepairReview(state, issue, envelope, config, options);
	}
	if (envelope.type === "submit_review" && current.status === "repair_reviewing") {
		return await submitFinalRepairReview(state, issue, envelope, config, options);
	}
	if (envelope.type === "block_task" && current.status === "repairing" && envelope.role === "implementer" && matchesRound(envelope, current.attempts, current.review_rounds, true)) {
		return await failFinalGate(state, issue, nonEmptyString(envelope.payload.reason, "final-gate repair block reason"), options);
	}
	if (envelope.type === "block_task" && current.status === "repair_reviewing" && envelope.role === "reviewer" && matchesRound(envelope, current.attempts, current.review_rounds, false)) {
		return await failFinalGate(state, issue, nonEmptyString(envelope.payload.reason, "final-gate repair review block reason"), options);
	}
	throw new Error(`Unexpected PR lifecycle event ${envelope.type} while final_check is ${current.status}`);
}

/** A failed final gate is repaired only after the user names its owning completed Local Issue. */
export async function resolveFinalRepair(
	state: RunState,
	issueId: string,
	resolution: string,
	config: ProjectConfig,
	options: FinalRepairOptions,
): Promise<RunState | undefined> {
	const issue = finalCheck(state);
	const finalTask = task(state, issue.id);
	if (finalTask.status !== "blocked" || !finalTask.final_gate_head) return undefined;
	if (issueId === issue.id) {
		if (finalTask.review_exit_code !== undefined && finalTask.review_exit_code !== 0 && finalTask.review_commit === finalTask.commit) return undefined;
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

/** Reconcile final-repair integration work before resuming generic orchestration. */
export async function resumeFinalRepair(state: RunState, options: FinalRepairOptions): Promise<RunState> {
	state = await abortFinalRepairCherryPick(state, options);
	return await recoverFinalRepairIntegration(state, options);
}

/** Abort cleanup reaches final-repair resources; unintegrated branches remain untouched. */
export async function cleanupFinalRepair(state: RunState, options: FinalRepairOptions): Promise<RunState> {
	if (state.phase !== "aborted") return state;
	const issue = finalCheck(state);
	return isFinalRepair(task(state, issue.id)) ? await cleanupAbortedFinalRepair(state, issue, options) : state;
}

/** Reconcile a final-repair cherry-pick that finished before its state update. */
export async function recoverFinalRepairIntegration(state: RunState, options: FinalRepairOptions): Promise<RunState> {
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

async function cleanupAbortedFinalRepair(state: RunState, issue: LocalIssue, options: FinalRepairOptions): Promise<RunState> {
	let current = task(state, issue.id);
	try {
		const tabId = current.tab_id ?? (current.implementer_provisioning_id
			? (await findManagedSubagentTab(workerHost(state), current.implementer_provisioning_id, workerHostOptions(options)))?.tabId
			: undefined);
		if (!tabId) {
			state = await save(clearLifecycleCleanupBlock(replaceTask(state, issue.id, { ...current, tab_cleanup_done: true }), issue.id, "tab"), options);
			current = task(state, issue.id);
		} else {
			await retireManagedSubagentTab(workerHost(state), tabId, workerHostOptions(options));
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

/** Abort only a final-repair cherry-pick whose durable intent belongs to this run. */
async function abortFinalRepairCherryPick(state: RunState, options: FinalRepairOptions): Promise<RunState> {
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
			review_findings: [...(current.review_findings ?? []), "Integration cherry-pick conflicted; produce a fresh repair commit."],
			implementer_instruction_pending: true,
		}), options);
	}
	return state;
}

async function requestFinalRepairReview(
	state: RunState,
	issue: LocalIssue,
	envelope: WorkerEnvelope,
	config: ProjectConfig,
	options: FinalRepairOptions,
): Promise<RunState> {
	if (envelope.type !== "request_review" || envelope.role !== "implementer") throw new Error("Only the final-gate repair implementer can request review");
	const current = task(state, issue.id);
	if (envelope.attempt !== current.attempts || envelope.review_round !== (current.review_rounds ?? 0) + 1) throw new Error("Final-gate repair request is stale");
	const owner = repairOwner(state, current);
	const commit = await verifyRepairCommit(
		state,
		issue,
		nonEmptyString(envelope.commit, "final-gate repair commit"),
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
	options: FinalRepairOptions,
	mode: "initial" | "revision" | "resume",
): Promise<RunState> {
	await ensureRepairWorktree(state, issue, options);
	let current = task(state, issue.id);
	let launch = await workerLaunch(state, owner, config, "implementer", options);
	const label = nonEmptyString(current.implementer_provisioning_id, "final repair implementer provisioning identity");
	const resource = await reconcileManagedSubagentTab(workerHost(state), {
		tabId: current.tab_id,
		paneId: current.implementer_pane,
		cwd: nonEmptyString(current.worktree, "final repair worktree"),
		launch,
		label,
	}, workerHostOptions(options));
	if (current.tab_id !== resource.tabId || current.implementer_pane !== resource.paneId) {
		state = await save(replaceTask(state, issue.id, { ...current, tab_id: resource.tabId, implementer_pane: resource.paneId }), options);
		current = task(state, issue.id);
	}
	const agent = nonEmptyString(current.implementer_agent, "final repair implementer agent");
	launch = await workerLaunch(state, owner, config, "implementer", options);
	const started = await startManagedSubagent(workerHost(state), agent, nonEmptyString(current.implementer_pane, "final repair implementer pane"), launch, workerHostOptions(options), {
		beforeStart: async () => {
			const latest = task(state, issue.id);
			if (!latest.implementer_instruction_pending) state = await save(replaceTask(state, issue.id, { ...latest, implementer_instruction_pending: true }), options);
		},
	});
	current = task(state, issue.id);
	const needsInstruction = Boolean(current.implementer_instruction_pending) || mode !== "resume" || started !== "existing";
	const promptMode = needsInstruction && mode === "resume"
		? (hasReviewFindings(current) ? "revision" : "initial")
		: mode;
	const fullPrompt = mode === "initial" || started !== "existing" || (mode === "resume" && Boolean(current.implementer_instruction_pending));
	const instruction = promptMode === "resume"
		? "Resend your latest worker event through the worker tool."
		: promptMode === "revision"
			? "Address the reviewer findings by amending the sole repair commit, then request review again."
			: "Implement the named final-gate repair in this fresh child worktree, commit exactly one change over the repair base, then request review.";
	const amendments = gateCommandAmendments(state, issue.id);
	const gate = amendments.length ? { required_gate: { command: requiredGateCommand(state, issue), amendments } } : {};
	await ensureActionTicket(
		actionTicketPath(state.main_worktree, state.run_id, issue.id, "lifecycle", "implementer"),
		{ attempt: current.attempts, review_round: (current.review_rounds ?? 0) + 1, role: "implementer" },
		state.main_worktree,
		state.run_id,
		options.uuid,
	);
	await promptManagedSubagent(workerHost(state), agent, fullPrompt ? {
		type: "auto_dag_final_repair",
		run_id: state.run_id,
		delivery: workerDeliveryContext(state.graph),
		owner_issue: workerIssueContext(owner, true),
		resolution: state.resolutions[owner.id],
		worktree: current.worktree,
		wave_base: current.repair_base,
		attempt: current.attempts,
		review_round: (current.review_rounds ?? 0) + 1,
		...gate,
		instruction,
	} : {
		type: promptMode === "resume" ? "auto_dag_resend" : "auto_dag_final_repair_update",
		run_id: state.run_id,
		issue_id: owner.id,
		attempt: current.attempts,
		review_round: (current.review_rounds ?? 0) + 1,
		review_findings: current.review_findings,
		...gate,
		instruction,
	}, workerHostOptions(options));
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
	options: FinalRepairOptions,
	mode: "review" | "resume",
): Promise<RunState> {
	let current = task(state, issue.id);
	const commit = nonEmptyString(current.commit, "final-gate repair commit");
	await verifyRepairCommit(state, issue, commit, options);
	state = await ensureRecordedGate(state, issue, commit, nonEmptyString(current.worktree, "final repair worktree"), config.required_gate_timeout_ms, options);
	current = task(state, issue.id);
	const gate = requiredTaskGate(current, commit, "Final-gate repair");
	if (gate.exit_code !== 0) {
		return await save({
			...state,
			phase: "blocked",
			block_reason: `Final-gate repair required gate exited with code ${gate.exit_code}; reviewer was not launched`,
		}, options);
	}
	if (!current.tab_id || !current.implementer_pane || (current.reviewer_pane && !(await managedSubagentTabExists(workerHost(state), current.tab_id, workerHostOptions(options))))) {
		const label = nonEmptyString(current.implementer_provisioning_id, "final repair implementer provisioning identity");
		const resource = await reconcileManagedSubagentTab(workerHost(state), {
			tabId: undefined,
			paneId: undefined,
			cwd: nonEmptyString(current.worktree, "final repair worktree"),
			launch: await workerLaunch(state, owner, config, "implementer", options),
			label,
		}, workerHostOptions(options));
		state = await save(replaceTask(state, issue.id, {
			...current,
			tab_id: resource.tabId,
			implementer_pane: resource.paneId,
			reviewer_pane: undefined,
		}), options);
		current = task(state, issue.id);
	}
	let launch = await workerLaunch(state, owner, config, "reviewer", options);
	if (!current.reviewer_pane) {
		const tab = nonEmptyString(current.tab_id, "final repair tab id");
		const root = nonEmptyString(current.implementer_pane, "final repair implementer pane");
		const label = nonEmptyString(current.reviewer_provisioning_id, "final repair reviewer provisioning identity");
		const pane = await reconcileManagedSubagentPane(workerHost(state), tab, root, nonEmptyString(current.worktree, "final repair worktree"), launch, label, workerHostOptions(options));
		state = await save(replaceTask(state, issue.id, { ...current, reviewer_pane: pane }), options);
		current = task(state, issue.id);
	}
	const agent = nonEmptyString(current.reviewer_agent, "final repair reviewer agent");
	launch = await workerLaunch(state, owner, config, "reviewer", options);
	const started = await startManagedSubagent(workerHost(state), agent, nonEmptyString(current.reviewer_pane, "final repair reviewer pane"), launch, workerHostOptions(options), {
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
	await ensureActionTicket(
		actionTicketPath(state.main_worktree, state.run_id, issue.id, "lifecycle", "reviewer"),
		{ attempt: current.attempts, review_round: positiveInteger(current.review_rounds, "final-gate repair review round"), role: "reviewer", review_id: lifecycleReviewId(state, issue, current, "final_repair") },
		state.main_worktree,
		state.run_id,
		options.uuid,
	);
	const amendments = gateCommandAmendments(state, issue.id);
	await promptManagedSubagent(workerHost(state), agent, reviewPrompt({
		kind: "final_repair",
		graph: state.graph,
		issue,
		worktree: nonEmptyString(current.worktree, "final repair worktree"),
		base: nonEmptyString(current.repair_base, "final repair base"),
		gate: requiredTaskGate(current, commit, "Final-gate repair"),
		prior_findings: current.review_findings,
		resolution: state.resolutions[owner.id],
		context: {
			owner_issue: workerIssueContext(owner, false),
			...(amendments.length ? { gate_command_amendments: amendments } : {}),
		},
	}, promptMode), workerHostOptions(options));
	if (needsInstruction) {
		state = await save(replaceTask(state, issue.id, { ...task(state, issue.id), reviewer_instruction_pending: undefined }), options);
	}
	return state;
}

async function submitFinalRepairReview(
	state: RunState,
	issue: LocalIssue,
	envelope: SubmitReviewEnvelope,
	config: ProjectConfig,
	options: FinalRepairOptions,
): Promise<RunState> {
	if (envelope.role !== "reviewer") throw new Error("Only the final-gate repair reviewer can submit review");
	const current = task(state, issue.id);
	if (envelope.review_id !== lifecycleReviewId(state, issue, current, "final_repair")) throw new Error("Final-gate repair review submission is stale");
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
	return await applyFinalRepair(state, issue, options);
}

async function applyFinalRepair(state: RunState, issue: LocalIssue, options: FinalRepairOptions): Promise<RunState> {
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
	return await finishFinalRepair(state, issue, options);
}

async function finishFinalRepair(state: RunState, issue: LocalIssue, options: FinalRepairOptions): Promise<RunState> {
	const current = task(state, issue.id);
	const commit = nonEmptyString(current.repair_commit ?? current.commit, "integrated final-gate repair commit");
	if (current.tab_id) {
		await retireManagedSubagentTab(workerHost(state), current.tab_id, workerHostOptions(options));
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
	return state;
}

async function ensureRepairWorktree(state: RunState, issue: LocalIssue, options: FinalRepairOptions): Promise<void> {
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

async function verifyRepairCommit(state: RunState, issue: LocalIssue, commit: string, options: FinalRepairOptions): Promise<string> {
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

async function closeFinalTab(state: RunState, issue: LocalIssue, options: FinalRepairOptions): Promise<RunState> {
	const current = task(state, issue.id);
	if (!current.tab_id) return state;
	await retireManagedSubagentTab(workerHost(state), current.tab_id, workerHostOptions(options));
	return await save(replaceTask(state, issue.id, {
		...current,
		tab_id: undefined,
		implementer_pane: undefined,
		reviewer_pane: undefined,
		tab_cleanup_done: true,
	}), options);
}

async function retireFinalRepair(state: RunState, issue: LocalIssue, options: FinalRepairOptions): Promise<RunState> {
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

function repairOwner(state: RunState, current: RunTaskState): LocalIssue {
	return issueById(state, nonEmptyString(current.repair_issue_id, "final-gate repair owner Local Issue"));
}

async function workerLaunch(
	state: RunState,
	issue: LocalIssue,
	config: ProjectConfig,
	role: WorkerRole,
	options: FinalRepairOptions,
): Promise<WorkerLaunch> {
	return await lifecycleWorkerLaunch(state, issue, finalCheck(state).id, config, role, options, "lifecycle");
}

function repairWorktreePath(state: RunState, owner: string, attempt: number): string {
	return join(dirname(resolve(state.main_worktree)), `.${basename(state.main_worktree)}-auto-dag`, state.run_id, `final-repair-${owner}-${attempt}`);
}

function repairBranch(state: RunState, owner: string, attempt: number): string {
	return `pi-auto-dag/${state.run_id}/final-repair/${owner}/${attempt}`;
}
