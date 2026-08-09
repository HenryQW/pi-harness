import { basename, dirname, join, resolve } from "node:path";
import { commandFailure, commandOutput, errorMessage, type CommandRunner } from "./command.ts";
import { assertAttachedBranch, deleteExpectedBranch, ensureChildWorktree, retireChildWorktree, verifySingleCommit } from "./git.ts";
import { assertRunBoundary } from "./intake.ts";
import type {
	HealthCheckEvidence,
	HealthFastForwardIntent,
	LocalIssue,
	PrHealthState,
	ProjectConfig,
	PullRequestIdentity,
	RunState,
	RunTaskState,
	WorkerEnvelope,
} from "./model.ts";
import { issueById, replaceTask, task, writeRunState, type Uuid } from "./state.ts";
import { createWorkerLaunch, createWorkerTab, ensureWorkerPane, findWorkerTab, promptWorkerAgent, retireWorkerTab, startWorkerAgent, workerAgentName, workerTabExists, type WorkerLaunch, type WorkerRole } from "./worker.ts";
import { array, nonEmptyString, object, oneOf, positiveInteger, stringArray } from "./validate.ts";

type PrLifecycleOptions = {
	runner: CommandRunner;
	uuid: Uuid;
	now?: () => string;
};

/** Run the non-worker final check, then create or recover the one integration PR. */
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

/** Explicit retained-run health: synchronize only by fast-forward, then triage or repair once. */
export async function runPrHealth(
	state: RunState,
	envelope: WorkerEnvelope | undefined,
	options: PrLifecycleOptions,
): Promise<RunState> {
	state = await resumePrLifecycle(state, options);
	const config = await loadPrHealthConfig(state, options);
	if (state.phase !== "completed" || !state.pr) {
		throw new Error("PR health requires a completed retained run with an integration PR");
	}
	if (state.health?.status === "applying") return await applyHealthRepair(state, options);
	if (state.health?.status === "pushing") return await continueHealthPush(state, options);
	if (state.health?.status === "post_push_cleanup") return await completeHealthRepair(state, options);
	state = await fastForwardToPrHead(state, options);
	if (state.health?.status === "blocked") return state;
	if (state.health?.status === "triaging" && state.health.actionable === false) return await completeHealthyTriage(state, options);
	if (envelope) return await acceptHealthEnvelope(state, envelope, config, options);
	if (!state.health || state.health.status === "completed") return await startHealthTriage(state, config, options);
	if (state.health.status === "triaging") return await ensureHealthReviewer(state, config, options, "resume");
	if (state.health.status === "repairing") return await ensureHealthCoder(state, config, options, "resume");
	if (state.health.status === "reviewing") return await ensureHealthReviewer(state, config, options, "resume");
	return state;
}

async function loadPrHealthConfig(state: RunState, options: PrLifecycleOptions): Promise<ProjectConfig> {
	try {
		return await assertRunBoundary(state, options.runner);
	} catch (error) {
		await save({ ...state, phase: "blocked", block_reason: errorMessage(error) }, options);
		throw error;
	}
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
	if (isFinalRepair(task(state, issue.id))) state = await cleanupAbortedFinalRepair(state, issue, options);
	if (state.cleanup_blocks?.length || !state.health) return state;
	let health = state.health;
	for (const key of ["reviewer_tab_id", "coder_tab_id"] as const) {
		try {
			const label = `auto-dag:${state.run_id}:health:${health.attempt}:${key === "reviewer_tab_id" ? "reviewer" : "coder"}`;
			const tabId = health[key] ?? (await findWorkerTab(state, label, options))?.tab_id;
			if (!tabId) {
				state = await save(clearLifecycleCleanupBlock(state, issue.id, "tab"), options);
				continue;
			}
			await closeLifecycleTab(state, tabId, options);
			health = { ...health, [key]: undefined };
			state = await save(clearLifecycleCleanupBlock({ ...state, health }, issue.id, "tab"), options);
		} catch (error) {
			return await recordLifecycleCleanupBlock(state, issue.id, "tab", errorMessage(error), options);
		}
	}
	if (health.worktree) {
		try {
			await removeLifecycleWorktree(state, health.worktree, health.branch ?? healthBranch(state, positiveInteger(health.attempt, "PR-health attempt")), "PR-health repair", options);
		} catch (error) {
			return await recordLifecycleCleanupBlock(state, issue.id, "worktree", errorMessage(error), options);
		}
		health = { ...health, worktree: undefined };
		state = await save(clearLifecycleCleanupBlock({ ...state, health }, issue.id, "worktree"), options);
	} else {
		state = await save(clearLifecycleCleanupBlock(state, issue.id, "worktree"), options);
	}
	return state;
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
			await closeLifecycleTab(state, tabId, options);
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
		await removeLifecycleWorktree(state, current.worktree, finalRepairBranch(state, current), "Final-gate repair", options);
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
	state = await recoverHealthFastForward(state, options);
	const issue = finalCheck(state);
	const current = task(state, issue.id);
	if (current.status === "repair_applying" && current.integration_intent) {
		const integrationHead = await appliedLifecyclePick(state, current.integration_intent, options);
		if (integrationHead) {
			return await save(replaceTask({ ...state, integration_head: integrationHead }, issue.id, {
				...current,
				status: "repair_cleanup",
				repair_commit: current.integration_intent,
			}), options);
		}
	}
	const health = state.health;
	if (health?.status === "applying" && health.integration_intent) {
		const integrationHead = await appliedLifecyclePick(state, health.integration_intent, options);
		if (integrationHead) {
			return await save({
				...state,
				integration_head: integrationHead,
				health: { ...health, status: "pushing" },
			}, options);
		}
	}
	return state;
}

/** Abort only a final/health cherry-pick whose durable intent belongs to this run. */
async function abortPrLifecycleCherryPick(state: RunState, options: PrLifecycleOptions): Promise<RunState> {
	await assertRecordedIntegrationBranch(state, options);
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
	const health = state.health;
	if (health?.integration_intent === commit) {
		await commandOutput(options.runner, "git", ["cherry-pick", "--abort"], state.main_worktree);
		return await save({
			...state,
			health: {
				...health,
				status: "repairing",
				activity_started_at: timestamp(options),
				integration_intent: undefined,
				review_findings: [...(health.review_findings ?? []), "Integration cherry-pick conflicted; produce a fresh repair commit."],
			},
		}, options);
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
	let current = task(state, issue.id);
	const label = nonEmptyString(current.implementer_provisioning_id, "final reviewer provisioning identity");
	const launch = workerLaunch(state, issue, config, "reviewer");
	if (current.tab_id && !(await workerTabExists(state, current.tab_id, options))) {
		current = { ...current, tab_id: undefined, implementer_pane: undefined, reviewer_pane: undefined };
	}
	if (!current.tab_id || !current.reviewer_pane) {
		const existing = await findWorkerTab(state, label, options);
		const resource = existing ?? await createWorkerTab(state, state.main_worktree, launch, label, options);
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
	const promptMode = needsInstruction && mode === "resume" ? "review" : mode;
	const fullPrompt = started !== "existing" || (mode === "resume" && Boolean(current.reviewer_instruction_pending));
	const instruction = promptMode === "resume"
		? "Resend your latest final-check review event through the worker tool."
		: "Read-only final check: inspect exactly the recorded integration HEAD in the main worktree, run only the frozen command, and submit the exact commit, command, exit code, verdict, and findings.";
	await promptWorkerAgent(state, agent, fullPrompt ? {
		type: "auto_dag_final_check",
		run_id: state.run_id,
		issue,
		integration_head: state.integration_head,
		command: issue.testing,
		attempt: current.attempts,
		review_round: current.review_rounds,
		instruction,
	} : {
		type: promptMode === "resume" ? "auto_dag_resend" : "auto_dag_final_check_update",
		run_id: state.run_id,
		issue_id: issue.id,
		integration_head: state.integration_head,
		command: issue.testing,
		attempt: current.attempts,
		review_round: current.review_rounds,
		instruction,
	}, options);
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
	if (!matchesReview(current, envelope)) return state;
	const command = nonEmptyString(envelope.payload.command, "final-check command");
	const exitCode = nonNegativeInteger(envelope.payload.exit_code, "final-check exit_code");
	const verdict = oneOf(envelope.payload.verdict, ["approved", "changes_requested", "blocked"] as const, "final-check verdict");
	const findings = stringArray(envelope.payload.findings, "final-check findings");
	await assertRunBoundary(state, options.runner);
	if (command !== issue.testing) return await failFinalGate(state, issue, "Final-check command does not match the frozen testing command", options);
	if (envelope.payload.commit !== state.integration_head || current.final_gate_head !== state.integration_head) {
		return await failFinalGate(state, issue, "Final-check review did not inspect the exact integration HEAD", options);
	}
	if (verdict !== "approved") return await failFinalGate(state, issue, findings.join("; "), options, findings);
	if (exitCode !== 0) return await failFinalGate(state, issue, `Final-check command exited with code ${exitCode}; approval requires exit code 0`, options, findings);
	state = await save(replaceTask(state, issue.id, {
		...current,
		status: "approved",
		review_command: command,
		review_commit: state.integration_head,
		review_exit_code: exitCode,
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
	const commit = nonEmptyString(envelope.payload.commit, "final-gate repair commit");
	if (Array.isArray(current.review_findings) && current.review_findings.length && current.commit === commit) {
		return await failFinalGate(state, issue, "Final-gate repair revision must use a new commit", options);
	}
	await verifyRepairCommit(state, issue, commit, options);
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
	if (current.tab_id && !(await workerTabExists(state, current.tab_id, options))) {
		current = { ...current, tab_id: undefined, implementer_pane: undefined, reviewer_pane: undefined };
	}
	if (!current.tab_id || !current.implementer_pane) {
		const existing = await findWorkerTab(state, label, options);
		const resource = existing ?? await createWorkerTab(state, nonEmptyString(current.worktree, "final repair worktree"), launch, label, options);
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
		owner_issue: owner,
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
	const promptMode = needsInstruction && mode === "resume" ? "review" : mode;
	const fullPrompt = started !== "existing" || (mode === "resume" && Boolean(current.reviewer_instruction_pending));
	const instruction = promptMode === "resume"
		? "Resend your latest worker event through the worker tool."
		: "Read-only review: verify the exact one-commit repair and run only the frozen final-check command before submitting the exact verdict.";
	await promptWorkerAgent(state, agent, fullPrompt ? {
		type: "auto_dag_final_repair_review",
		run_id: state.run_id,
		owner_issue: owner,
		worktree: current.worktree,
		wave_base: current.repair_base,
		commit: current.commit,
		attempt: current.attempts,
		review_round: current.review_rounds,
		command: issue.testing,
		instruction,
	} : {
		type: promptMode === "resume" ? "auto_dag_resend" : "auto_dag_final_repair_review_update",
		run_id: state.run_id,
		issue_id: owner.id,
		commit: current.commit,
		attempt: current.attempts,
		review_round: current.review_rounds,
		command: issue.testing,
		instruction,
	}, options);
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
	if (!matchesReview(current, envelope)) return state;
	const command = nonEmptyString(envelope.payload.command, "final-gate repair review command");
	const exitCode = nonNegativeInteger(envelope.payload.exit_code, "final-gate repair review exit_code");
	const verdict = oneOf(envelope.payload.verdict, ["approved", "changes_requested", "blocked"] as const, "final-gate repair verdict");
	const findings = stringArray(envelope.payload.findings, "final-gate repair findings");
	await verifyRepairCommit(state, issue, nonEmptyString(current.commit, "final-gate repair commit"), options);
	if (command !== issue.testing) return await failFinalGate(state, issue, "Repair review command does not match the frozen final-check command", options);
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
	if (exitCode !== 0) return await failFinalGate(state, issue, `Repair review command exited with code ${exitCode}; approval requires exit code 0`, options, findings);
	const commit = nonEmptyString(current.commit, "final-gate repair commit");
	state = await save(replaceTask(state, issue.id, {
		...current,
		status: "repair_applying",
		integration_intent: commit,
		repair_commit: commit,
		review_command: command,
		review_commit: commit,
		review_exit_code: exitCode,
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
		await closeLifecycleTab(state, current.tab_id, options);
		state = await save(replaceTask(state, issue.id, { ...task(state, issue.id), tab_id: undefined, implementer_pane: undefined, reviewer_pane: undefined }), options);
	}
	const worktree = task(state, issue.id).worktree;
	if (worktree) {
		await removeLifecycleWorktree(state, worktree, nonEmptyString(task(state, issue.id).branch, "final-gate repair branch"), "Final-gate repair", options);
		state = await save(replaceTask(state, issue.id, { ...task(state, issue.id), worktree: undefined }), options);
	}
	const branch = task(state, issue.id).branch;
	if (branch) {
		await deleteLifecycleBranch(state, branch, commit, "Final-gate repair", options);
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
	const current = await viewPr(state, identity.number, options);
	assertSamePr(identity, current, true);
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

async function startHealthTriage(state: RunState, config: ProjectConfig, options: PrLifecycleOptions): Promise<RunState> {
	const previous = state.health;
	const attempt = (previous?.attempt ?? 0) + 1;
	const health: PrHealthState = {
		status: "triaging",
		activity_started_at: timestamp(options),
		head: state.integration_head,
		attempt,
		review_round: 1,
		reviewer_agent: workerAgentName(state.workspace_id, state.run_id, `health-${attempt}`, "reviewer"),
		instruction_pending: true,
	};
	state = await save({
		...state,
		health,
		...(previous ? { health_history: [...(state.health_history ?? []), previous] } : {}),
	}, options);
	return await ensureHealthReviewer(state, config, options, "triage");
}

async function ensureHealthReviewer(
	state: RunState,
	config: ProjectConfig,
	options: PrLifecycleOptions,
	mode: "triage" | "review" | "resume",
): Promise<RunState> {
	let health = requiredHealth(state);
	const issue = finalCheck(state);
	const launch = workerLaunch(state, issue, config, "reviewer");
	if (health.reviewer_tab_id && !(await workerTabExists(state, health.reviewer_tab_id, options))) {
		health = { ...health, reviewer_tab_id: undefined, reviewer_pane: undefined };
	}
	if (!health.reviewer_tab_id || !health.reviewer_pane) {
		const label = `auto-dag:${state.run_id}:health:${health.attempt}:reviewer`;
		const resource = (await findWorkerTab(state, label, options)) ?? await createWorkerTab(state, state.main_worktree, launch, label, options);
		health = { ...health, reviewer_tab_id: resource.tab_id, reviewer_pane: resource.pane_id };
		state = await save({ ...state, health }, options);
	}
	const agent = nonEmptyString(health.reviewer_agent, "PR-health reviewer agent");
	const started = await startWorkerAgent(state, agent, nonEmptyString(health.reviewer_pane, "PR-health reviewer pane"), launch, options, {
		beforeStart: async () => {
			const latest = requiredHealth(state);
			if (!latest.instruction_pending) state = await save({ ...state, health: { ...latest, instruction_pending: true } }, options);
		},
	});
	health = requiredHealth(state);
	const needsInstruction = Boolean(health.instruction_pending) || mode !== "resume" || started !== "existing";
	const promptMode = mode === "resume" && needsInstruction ? (health.status === "triaging" ? "triage" : "review") : mode;
	const fullPrompt = started !== "existing" || promptMode === "triage" || (mode === "resume" && Boolean(health.instruction_pending));
	const instruction = promptMode === "resume"
		? "Resend your latest worker event through the worker tool."
		: promptMode === "triage"
			? "Read-only PR health triage: inspect unresolved review threads and failing checks for this exact open PR. Submit only a concise summary, actionable boolean, unresolved thread node IDs, and failing-check name/link/output evidence."
			: "Read-only PR-health repair review: inspect exactly this one repair commit, run only the frozen command, and submit an exact verdict. List only triaged thread IDs that this repair fixes.";
	await promptWorkerAgent(state, agent, fullPrompt ? (promptMode === "triage" ? {
		type: "auto_dag_pr_health_triage",
		run_id: state.run_id,
		pr: state.pr,
		integration_head: state.integration_head,
		attempt: health.attempt,
		review_round: health.review_round,
		instruction,
	} : {
		type: "auto_dag_pr_health_review",
		run_id: state.run_id,
		pr: state.pr,
		worktree: health.worktree,
		base: health.base,
		commit: health.commit,
		attempt: health.attempt,
		review_round: health.review_round,
		command: issue.testing,
		instruction,
	}) : {
		type: promptMode === "resume" ? "auto_dag_resend" : "auto_dag_pr_health_review_update",
		run_id: state.run_id,
		issue_id: issue.id,
		commit: health.commit,
		attempt: health.attempt,
		review_round: health.review_round,
		command: issue.testing,
		instruction,
	}, options);
	if (needsInstruction) state = await save({ ...state, health: { ...requiredHealth(state), instruction_pending: undefined } }, options);
	return state;
}

async function acceptHealthEnvelope(
	state: RunState,
	envelope: WorkerEnvelope,
	config: ProjectConfig,
	options: PrLifecycleOptions,
): Promise<RunState> {
	const issue = finalCheck(state);
	if (envelope.run_id !== state.run_id || envelope.issue_id !== issue.id) throw new Error("PR-health event belongs to another retained run");
	const health = requiredHealth(state);
	if (envelope.type === "submit_health") return await submitHealthTriage(state, envelope, config, options);
	if (envelope.type === "request_review") {
		if (envelope.role !== "implementer") throw new Error("Only the PR-health coder can request repair review");
		return health.status === "repairing" ? await requestHealthRepairReview(state, envelope, config, options) : state;
	}
	if (envelope.type === "submit_review") {
		if (envelope.role !== "reviewer") throw new Error("Only the same PR-health reviewer can submit repair review");
		return health.status === "reviewing" ? await submitHealthRepairReview(state, envelope, config, options) : state;
	}
	if (envelope.type === "block_task" && health.status === "triaging" && envelope.role === "reviewer" && matchesHealthBlock(health, envelope, false)) return await blockHealth(state, nonEmptyString(envelope.payload.reason, "PR-health triage block reason"), options);
	if (envelope.type === "block_task" && health.status === "repairing" && envelope.role === "implementer" && matchesHealthBlock(health, envelope, true)) return await blockHealth(state, nonEmptyString(envelope.payload.reason, "PR-health repair block reason"), options);
	if (envelope.type === "block_task" && health.status === "reviewing" && envelope.role === "reviewer" && matchesHealthBlock(health, envelope, false)) return await blockHealth(state, nonEmptyString(envelope.payload.reason, "PR-health review block reason"), options);
	if (envelope.type === "block_task") return state;
	throw new Error(`Unexpected PR-health event ${envelope.type} while health is ${health.status}`);
}

async function submitHealthTriage(
	state: RunState,
	envelope: WorkerEnvelope,
	config: ProjectConfig,
	options: PrLifecycleOptions,
): Promise<RunState> {
	if (envelope.role !== "reviewer") throw new Error("Only the PR-health reviewer can submit health triage");
	const health = requiredHealth(state);
	if (health.status !== "triaging") return state;
	if (envelope.payload.attempt !== health.attempt || envelope.payload.review_round !== health.review_round) return state;
	if (!(await activeHealthHeadMatches(state, health, options))) {
		return await blockHealth(state, "PR head changed before health triage was accepted", options);
	}
	const actionable = envelope.payload.actionable;
	if (typeof actionable !== "boolean") throw new Error("PR-health actionable must be a boolean");
	const next: PrHealthState = {
		...health,
		summary: nonEmptyString(envelope.payload.summary, "PR-health summary"),
		actionable,
		thread_ids: stringArray(envelope.payload.thread_ids ?? [], "PR-health thread IDs"),
		checks: healthChecks(envelope.payload.checks ?? []),
	};
	state = await save({ ...state, health: next }, options);
	if (!actionable) return await completeHealthyTriage(state, options);
	return await startHealthRepair(state, config, options);
}

async function completeHealthyTriage(state: RunState, options: PrLifecycleOptions): Promise<RunState> {
	let health = requiredHealth(state);
	if (health.reviewer_tab_id) {
		await closeLifecycleTab(state, health.reviewer_tab_id, options);
		health = { ...health, reviewer_tab_id: undefined, reviewer_pane: undefined };
		state = await save({ ...state, health }, options);
	}
	return await save({ ...state, health: { ...health, status: "completed" } }, options);
}

async function startHealthRepair(state: RunState, config: ProjectConfig, options: PrLifecycleOptions): Promise<RunState> {
	let health = requiredHealth(state);
	if (!(await activeHealthHeadMatches(state, health, options))) {
		return await blockHealth(state, "PR head changed before health repair started", options);
	}
	const attempt = positiveInteger(health.attempt, "PR-health attempt");
	health = {
		...health,
		status: "repairing",
		activity_started_at: timestamp(options),
		base: state.integration_head,
		worktree: healthWorktreePath(state, attempt),
		branch: healthBranch(state, attempt),
		commit: undefined,
		review_round: 0,
		coder_agent: workerAgentName(state.workspace_id, state.run_id, `health-${attempt}`, "implementer"),
		instruction_pending: true,
	};
	state = await save({ ...state, health }, options);
	return await ensureHealthCoder(state, config, options, "initial");
}

async function ensureHealthCoder(
	state: RunState,
	config: ProjectConfig,
	options: PrLifecycleOptions,
	mode: "initial" | "revision" | "resume",
): Promise<RunState> {
	let health = requiredHealth(state);
	await ensureHealthWorktree(state, options);
	const issue = finalCheck(state);
	const launch = workerLaunch(state, { ...issue, profile: "coder", role: "implementation" }, config, "implementer");
	if (health.coder_tab_id && !(await workerTabExists(state, health.coder_tab_id, options))) {
		health = { ...health, coder_tab_id: undefined, coder_pane: undefined };
	}
	if (!health.coder_tab_id || !health.coder_pane) {
		const label = `auto-dag:${state.run_id}:health:${health.attempt}:coder`;
		const resource = (await findWorkerTab(state, label, options)) ?? await createWorkerTab(state, nonEmptyString(health.worktree, "PR-health repair worktree"), launch, label, options);
		health = { ...health, coder_tab_id: resource.tab_id, coder_pane: resource.pane_id };
		state = await save({ ...state, health }, options);
	}
	const agent = nonEmptyString(health.coder_agent, "PR-health coder agent");
	const started = await startWorkerAgent(state, agent, nonEmptyString(health.coder_pane, "PR-health coder pane"), launch, options, {
		beforeStart: async () => {
			const latest = requiredHealth(state);
			if (!latest.instruction_pending) state = await save({ ...state, health: { ...latest, instruction_pending: true } }, options);
		},
	});
	health = requiredHealth(state);
	const needsInstruction = Boolean(health.instruction_pending) || mode !== "resume" || started !== "existing";
	const promptMode = mode === "resume" && needsInstruction ? (hasFindings(health) ? "revision" : "initial") : mode;
	const fullPrompt = promptMode === "initial" || started !== "existing" || (mode === "resume" && Boolean(health.instruction_pending));
	const instruction = promptMode === "revision"
		? "Address the reviewer findings by amending the sole repair commit, then request review again."
		: promptMode === "resume"
			? "Resend your latest worker event through the worker tool."
			: "Repair the actionable PR feedback in this fresh child worktree. Commit exactly one change over the current PR head, then request review.";
	await promptWorkerAgent(state, agent, fullPrompt ? {
		type: "auto_dag_pr_health_repair",
		run_id: state.run_id,
		pr: state.pr,
		worktree: health.worktree,
		base: health.base,
		attempt: health.attempt,
		review_round: (health.review_round ?? 0) + 1,
		triage: { summary: health.summary, thread_ids: health.thread_ids, checks: health.checks },
		instruction,
	} : {
		type: promptMode === "resume" ? "auto_dag_resend" : "auto_dag_pr_health_repair_update",
		run_id: state.run_id,
		issue_id: issue.id,
		attempt: health.attempt,
		review_round: (health.review_round ?? 0) + 1,
		review_findings: health.review_findings,
		instruction,
	}, options);
	if (needsInstruction) state = await save({ ...state, health: { ...requiredHealth(state), instruction_pending: undefined } }, options);
	return state;
}

async function requestHealthRepairReview(
	state: RunState,
	envelope: WorkerEnvelope,
	config: ProjectConfig,
	options: PrLifecycleOptions,
): Promise<RunState> {
	if (envelope.role !== "implementer") throw new Error("Only the PR-health coder can request repair review");
	const health = requiredHealth(state);
	if (envelope.payload.attempt !== health.attempt || envelope.payload.review_round !== (health.review_round ?? 0) + 1) return state;
	if (!(await activeHealthHeadMatches(state, health, options))) {
		return await blockHealth(state, "PR head changed before health repair review", options);
	}
	const commit = nonEmptyString(envelope.payload.commit, "PR-health repair commit");
	if (Array.isArray(health.review_findings) && health.review_findings.length && health.commit === commit) {
		return await blockHealth(state, "PR-health repair revision must use a new commit", options);
	}
	await verifyHealthRepairCommit(state, commit, options);
	state = await save({ ...state, health: { ...health, status: "reviewing", activity_started_at: timestamp(options), commit, review_round: (health.review_round ?? 0) + 1, instruction_pending: true } }, options);
	return await ensureHealthReviewer(state, config, options, "review");
}

async function submitHealthRepairReview(
	state: RunState,
	envelope: WorkerEnvelope,
	config: ProjectConfig,
	options: PrLifecycleOptions,
): Promise<RunState> {
	if (envelope.role !== "reviewer") throw new Error("Only the same PR-health reviewer can submit repair review");
	const health = requiredHealth(state);
	if (envelope.payload.commit !== health.commit || envelope.payload.attempt !== health.attempt || envelope.payload.review_round !== health.review_round) return state;
	const issue = finalCheck(state);
	const command = nonEmptyString(envelope.payload.command, "PR-health repair review command");
	const exitCode = nonNegativeInteger(envelope.payload.exit_code, "PR-health repair review exit_code");
	const verdict = oneOf(envelope.payload.verdict, ["approved", "changes_requested", "blocked"] as const, "PR-health repair verdict");
	const findings = stringArray(envelope.payload.findings, "PR-health repair findings");
	if (!(await activeHealthHeadMatches(state, health, options))) {
		return await blockHealth(state, "PR head changed before health repair approval", options);
	}
	await verifyHealthRepairCommit(state, nonEmptyString(health.commit, "PR-health repair commit"), options);
	if (command !== issue.testing) return await blockHealth(state, "PR-health repair review command does not match the frozen final-check command", options);
	if (verdict === "blocked") return await blockHealth(state, findings.join("; "), options);
	if (verdict === "changes_requested") {
		state = await save({ ...state, health: { ...health, status: "repairing", activity_started_at: timestamp(options), review_findings: findings, instruction_pending: true } }, options);
		return await ensureHealthCoder(state, config, options, "revision");
	}
	if (exitCode !== 0) return await blockHealth(state, `PR-health repair command exited with code ${exitCode}; approval requires exit code 0`, options);
	const commit = nonEmptyString(health.commit, "PR-health repair commit");
	const fixed = stringArray(envelope.payload.fixed_thread_ids ?? [], "fixed review thread IDs");
	const triaged = new Set(health.thread_ids ?? []);
	if (fixed.some((id) => !triaged.has(id))) throw new Error("PR-health repair may resolve only triaged review threads");
	state = await save({
		...state,
		health: {
			...health,
			status: "applying",
			integration_intent: commit,
			fixed_thread_ids: fixed,
		},
	}, options);
	return await applyHealthRepair(state, options);
}

async function applyHealthRepair(state: RunState, options: PrLifecycleOptions): Promise<RunState> {
	const health = requiredHealth(state);
	const reviewed = nonEmptyString(health.commit, "PR-health repair commit");
	const commit = health.integration_intent ?? reviewed;
	if (health.integration_intent && health.integration_intent !== reviewed) throw new Error("PR-health integration intent does not match its reviewed repair");
	if (!(await activeHealthHeadMatches(state, health, options))) {
		return await blockHealth(state, "PR head changed before applying health repair", options);
	}
	await assertRunBoundary(state, options.runner);
	await verifyHealthRepairCommit(state, commit, options);
	if (!health.integration_intent) {
		state = await save({ ...state, health: { ...health, status: "applying", integration_intent: commit } }, options);
	}
	await commandOutput(options.runner, "git", ["cherry-pick", "-x", commit], state.main_worktree);
	const integrationHead = await commandOutput(options.runner, "git", ["rev-parse", "HEAD"], state.main_worktree);
	state = await save({
		...state,
		integration_head: integrationHead,
		health: { ...requiredHealth(state), status: "pushing", integration_intent: commit },
	}, options);
	return await continueHealthPush(state, options);
}

async function continueHealthPush(state: RunState, options: PrLifecycleOptions): Promise<RunState> {
	const health = requiredHealth(state);
	if (health.status !== "pushing") throw new Error("PR-health repair is not ready to push");
	const expected = state.pr!;
	let identity = await viewPr(state, expected.number, options);
	assertSamePr(expected, identity, false);
	if (identity.head_oid !== state.integration_head) {
		if (identity.head_oid !== health.head) {
			return await blockHealth(state, "PR head changed while health repair was pending push", options);
		}
		await commandOutput(options.runner, "git", ["push", "origin", state.integration_branch], state.main_worktree);
		identity = await viewPr(state, expected.number, options);
		assertSamePr(expected, identity, false);
		if (identity.head_oid !== state.integration_head) throw new Error("Pushed repair did not update the same PR to the integration HEAD");
	}
	const fixed = health.fixed_thread_ids ?? [];
	for (const id of fixed) await resolveThread(state, id, options);
	state = await save({
		...state,
		pr: identity,
		health: {
			...health,
			status: "post_push_cleanup",
			integration_intent: undefined,
			resolved_thread_ids: fixed,
		},
	}, options);
	return await completeHealthRepair(state, options);
}

async function completeHealthRepair(state: RunState, options: PrLifecycleOptions): Promise<RunState> {
	let health = requiredHealth(state);
	for (const key of ["coder_tab_id", "reviewer_tab_id"] as const) {
		if (!health[key]) continue;
		await closeLifecycleTab(state, health[key]!, options);
		health = { ...health, [key]: undefined };
		state = await save({ ...state, health }, options);
	}
	if (health.worktree) {
		await removeLifecycleWorktree(state, health.worktree, nonEmptyString(health.branch, "PR-health repair branch"), "PR-health repair", options);
		health = { ...health, worktree: undefined };
		state = await save({ ...state, health }, options);
	}
	if (health.branch) {
		const commit = nonEmptyString(health.commit, "PR-health repair commit");
		await deleteLifecycleBranch(state, health.branch, commit, "PR-health repair", options);
		health = { ...health, branch: undefined };
		state = await save({ ...state, health }, options);
	}
	return await save({ ...state, health: { ...health, status: "completed" } }, options);
}

async function closeLifecycleTab(state: RunState, tabId: string, options: PrLifecycleOptions): Promise<void> {
	await retireWorkerTab(state, tabId, options);
}

async function removeLifecycleWorktree(
	state: RunState,
	worktree: string,
	branch: string,
	label: string,
	options: PrLifecycleOptions,
): Promise<void> {
	await retireChildWorktree(options.runner, state.main_worktree, worktree, branch, label);
}

async function deleteLifecycleBranch(
	state: RunState,
	branch: string,
	commit: string,
	label: string,
	options: PrLifecycleOptions,
): Promise<void> {
	await deleteExpectedBranch(options.runner, state.main_worktree, branch, commit, label);
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

async function fastForwardToPrHead(state: RunState, options: PrLifecycleOptions): Promise<RunState> {
	const expected = state.pr!;
	const current = await viewPr(state, expected.number, options);
	assertSamePr(expected, current, false);
	if (!current.head_oid) throw new Error("Open integration PR is missing head identity");
	await commandOutput(options.runner, "git", ["fetch", "origin", state.integration_branch], state.main_worktree);
	const remote = await commandOutput(options.runner, "git", ["rev-parse", `origin/${state.integration_branch}`], state.main_worktree);
	if (remote !== current.head_oid) throw new Error("Remote integration branch does not match the open PR head identity");
	const health = state.health;
	if (health && ["triaging", "repairing", "reviewing"].includes(health.status) && health.head !== remote) {
		return await blockHealth(state, `PR head changed from ${health.head} to ${remote} during active health handling`, options);
	}
	const fastForwardArgs = ["merge-base", "--is-ancestor", state.integration_head, remote];
	const fastForward = await options.runner("git", fastForwardArgs, { cwd: state.main_worktree });
	if (fastForward.code === 1) throw new Error("Local integration branch cannot fast-forward to the remote PR head");
	if (fastForward.code !== 0) throw new Error(commandFailure("git", fastForwardArgs, fastForward));
	if (remote !== state.integration_head) {
		if (await commandOutput(options.runner, "git", ["rev-parse", "HEAD"], state.main_worktree) !== state.integration_head) {
			throw new Error("Main integration HEAD changed before PR fast-forward");
		}
		state = await save({
			...state,
			health_fast_forward_intent: { expected_head: state.integration_head, remote_head: remote, pr: current },
		}, options);
		await commandOutput(options.runner, "git", ["merge", "--ff-only", `origin/${state.integration_branch}`], state.main_worktree);
		if (await commandOutput(options.runner, "git", ["rev-parse", "HEAD"], state.main_worktree) !== remote) {
			throw new Error("Fast-forward did not reach the remote PR head");
		}
		state = await save({ ...state, integration_head: remote, pr: current, health_fast_forward_intent: undefined }, options);
	}
	return state;
}

async function recoverHealthFastForward(state: RunState, options: PrLifecycleOptions): Promise<RunState> {
	if (!state.health_fast_forward_intent) return state;
	try {
		const intent = healthFastForwardIntent(state);
		if (intent.expected_head !== state.integration_head) throw new Error("PR-health fast-forward intent does not match the recorded integration HEAD");
		if (intent.pr.head_oid !== intent.remote_head) throw new Error("PR-health fast-forward intent does not match its PR head");
		await assertRecordedIntegrationBranch(state, options);
		const head = await commandOutput(options.runner, "git", ["rev-parse", "HEAD"], state.main_worktree);
		if (head !== intent.expected_head && head !== intent.remote_head) {
			throw new Error("PR-health fast-forward did not leave the exact intended integration HEAD");
		}
		if (head === intent.expected_head) await assertRunBoundary(state, options.runner);
		const fastForwardArgs = ["merge-base", "--is-ancestor", intent.expected_head, intent.remote_head];
		const fastForward = await options.runner("git", fastForwardArgs, { cwd: state.main_worktree });
		if (fastForward.code === 1) {
			throw new Error("PR-health fast-forward intent is not a fast-forward");
		}
		if (fastForward.code !== 0) throw new Error(commandFailure("git", fastForwardArgs, fastForward));
		const current = await viewPr(state, intent.pr.number, options);
		assertSamePr(intent.pr, current, true);
		if (head === intent.expected_head) {
			await commandOutput(options.runner, "git", ["merge", "--ff-only", intent.remote_head], state.main_worktree);
			if (await commandOutput(options.runner, "git", ["rev-parse", "HEAD"], state.main_worktree) !== intent.remote_head) {
				throw new Error("PR-health fast-forward retry did not reach the intended integration HEAD");
			}
		}
		return await save({ ...state, integration_head: intent.remote_head, pr: current, health_fast_forward_intent: undefined }, options);
	} catch (error) {
		const reason = `PR-health fast-forward recovery failed: ${errorMessage(error)}`;
		await save({ ...state, phase: "blocked", block_reason: reason }, options);
		throw new Error(reason);
	}
}

async function activeHealthHeadMatches(state: RunState, health: PrHealthState, options: PrLifecycleOptions): Promise<boolean> {
	if (health.head !== state.integration_head) return false;
	const current = await viewPr(state, state.pr!.number, options);
	assertSamePr(state.pr!, current, false);
	return current.head_oid === health.head;
}

async function appliedLifecyclePick(state: RunState, commit: string, options: PrLifecycleOptions): Promise<string | undefined> {
	await assertRecordedIntegrationBranch(state, options);
	const head = await commandOutput(options.runner, "git", ["rev-parse", "HEAD"], state.main_worktree);
	const message = await commandOutput(options.runner, "git", ["log", "-1", "--format=%B", head], state.main_worktree);
	if (!message.includes(`(cherry picked from commit ${commit})`)) return undefined;
	return (await commandOutput(options.runner, "git", ["rev-parse", `${head}^`], state.main_worktree)) === state.integration_head
		? head
		: undefined;
}

async function assertRecordedIntegrationBranch(state: RunState, options: PrLifecycleOptions): Promise<void> {
	await assertAttachedBranch(options.runner, state.main_worktree, state.integration_branch, "Main integration");
}

async function ensureRepairWorktree(state: RunState, issue: LocalIssue, options: PrLifecycleOptions): Promise<void> {
	const current = task(state, issue.id);
	await ensureLifecycleWorktree(
		state,
		nonEmptyString(current.worktree, "final-gate repair worktree"),
		nonEmptyString(current.branch, "final-gate repair branch"),
		nonEmptyString(current.repair_base, "final-gate repair base"),
		"Final-gate repair",
		options,
	);
}

async function ensureHealthWorktree(state: RunState, options: PrLifecycleOptions): Promise<void> {
	const health = requiredHealth(state);
	await ensureLifecycleWorktree(
		state,
		nonEmptyString(health.worktree, "PR-health repair worktree"),
		nonEmptyString(health.branch, "PR-health repair branch"),
		nonEmptyString(health.base, "PR-health repair base"),
		"PR-health repair",
		options,
	);
}

async function ensureLifecycleWorktree(
	state: RunState,
	worktree: string,
	branch: string,
	base: string,
	label: string,
	options: PrLifecycleOptions,
): Promise<void> {
	await ensureChildWorktree(options.runner, state.main_worktree, worktree, branch, base, label);
}

async function verifyRepairCommit(state: RunState, issue: LocalIssue, commit: string, options: PrLifecycleOptions): Promise<void> {
	const current = task(state, issue.id);
	await verifyOneCommit(
		state,
		nonEmptyString(current.worktree, "final-gate repair worktree"),
		nonEmptyString(current.branch, "final-gate repair branch"),
		nonEmptyString(current.repair_base, "final-gate repair base"),
		commit,
		"Final-gate repair",
		options,
	);
}

async function verifyHealthRepairCommit(state: RunState, commit: string, options: PrLifecycleOptions): Promise<void> {
	const health = requiredHealth(state);
	await verifyOneCommit(
		state,
		nonEmptyString(health.worktree, "PR-health repair worktree"),
		nonEmptyString(health.branch, "PR-health repair branch"),
		nonEmptyString(health.base, "PR-health repair base"),
		commit,
		"PR-health repair",
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
): Promise<void> {
	await assertAttachedBranch(options.runner, worktree, branch, `${label} child worktree`);
	await verifySingleCommit(options.runner, state.main_worktree, worktree, base, commit, label);
}

async function closeFinalTab(state: RunState, issue: LocalIssue, options: PrLifecycleOptions): Promise<RunState> {
	const current = task(state, issue.id);
	if (!current.tab_id) return state;
	await closeLifecycleTab(state, current.tab_id, options);
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
		await removeLifecycleWorktree(state, current.worktree, finalRepairBranch(state, current), "Final-gate repair", options);
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
	const candidates = array(JSON.parse(text), "gh pr list").map((value, index) => parsePr(value, `gh pr list[${index}]`));
	if (candidates.length > 1) throw new Error(`Multiple open PRs match integration branch ${state.integration_branch}`);
	if (!candidates.length) return undefined;
	const candidate = candidates[0];
	if (candidate.head_ref !== state.integration_branch || candidate.base_ref !== state.default_branch) {
		throw new Error("Matching open PR has mismatched head or base identity");
	}
	return candidate;
}

async function viewPr(state: RunState, number: number, options: PrLifecycleOptions): Promise<PullRequestIdentity> {
	const text = await commandOutput(options.runner, "gh", [
		"pr", "view", String(number), "--json", "number,url,headRefName,baseRefName,headRefOid,state",
	], state.main_worktree);
	const value = object(JSON.parse(text), "gh pr view");
	if (value.state !== "OPEN") throw new Error(`Integration PR ${number} is not open`);
	return parsePr(value, "gh pr view");
}

function parsePr(value: unknown, label: string): PullRequestIdentity {
	const input = object(value, label);
	const number = input.number;
	if (typeof number !== "number" || !Number.isInteger(number) || number < 1) throw new Error(`${label}.number must be a positive integer`);
	return {
		number,
		url: nonEmptyString(input.url, `${label}.url`),
		head_ref: nonEmptyString(input.headRefName, `${label}.headRefName`),
		base_ref: nonEmptyString(input.baseRefName, `${label}.baseRefName`),
		head_oid: nonEmptyString(input.headRefOid, `${label}.headRefOid`),
	};
}

function assertSamePr(expected: PullRequestIdentity, actual: PullRequestIdentity, exactHead: boolean): void {
	if (
		expected.number !== actual.number
		|| expected.url !== actual.url
		|| expected.head_ref !== actual.head_ref
		|| expected.base_ref !== actual.base_ref
		|| (exactHead && expected.head_oid !== actual.head_oid)
	) throw new Error("Integration PR identity changed during recovery");
}

function prBody(state: RunState): string {
	const completed = state.graph.issues
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

async function resolveThread(state: RunState, id: string, options: PrLifecycleOptions): Promise<void> {
	await commandOutput(options.runner, "gh", [
		"api", "graphql",
		"-f", "query=mutation($threadId:ID!){resolveReviewThread(input:{threadId:$threadId}){thread{id isResolved}}}",
		"-F", `threadId=${id}`,
	], state.main_worktree);
}

function healthChecks(value: unknown): HealthCheckEvidence[] {
	return array(value, "PR-health checks").map((entry, index) => {
		const input = object(entry, `PR-health checks[${index}]`);
		for (const key of Object.keys(input)) if (!["name", "link", "output"].includes(key)) throw new Error(`Unknown PR-health check evidence setting: ${key}`);
		return {
			name: nonEmptyString(input.name, `PR-health checks[${index}].name`),
			...(input.link === undefined ? {} : { link: nonEmptyString(input.link, `PR-health checks[${index}].link`) }),
			...(input.output === undefined ? {} : { output: nonEmptyString(input.output, `PR-health checks[${index}].output`) }),
		};
	});
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

function requiredHealth(state: RunState): PrHealthState {
	if (!state.health) throw new Error("PR-health state is missing");
	return state.health;
}

function healthFastForwardIntent(state: RunState): HealthFastForwardIntent {
	const input = object(state.health_fast_forward_intent, "PR-health fast-forward intent");
	const pr = object(input.pr, "PR-health fast-forward PR");
	return {
		expected_head: nonEmptyString(input.expected_head, "PR-health fast-forward expected head"),
		remote_head: nonEmptyString(input.remote_head, "PR-health fast-forward remote head"),
		pr: {
			number: positiveInteger(pr.number, "PR-health fast-forward PR.number"),
			url: nonEmptyString(pr.url, "PR-health fast-forward PR.url"),
			head_ref: nonEmptyString(pr.head_ref, "PR-health fast-forward PR.head_ref"),
			base_ref: nonEmptyString(pr.base_ref, "PR-health fast-forward PR.base_ref"),
			head_oid: nonEmptyString(pr.head_oid, "PR-health fast-forward PR.head_oid"),
		},
	};
}

function repairOwner(state: RunState, current: RunTaskState): LocalIssue {
	return issueById(state, nonEmptyString(current.repair_issue_id, "final-gate repair owner Local Issue"));
}

function allImplementationsCompleted(state: RunState): boolean {
	return state.graph.issues.filter((issue) => issue.role === "implementation").every((issue) => task(state, issue.id).status === "completed");
}

function finalCheck(state: RunState): LocalIssue {
	const issue = state.graph.issues.find((candidate) => candidate.role === "final_check");
	if (!issue) throw new Error("Run state has no final_check Local Issue");
	return issue;
}

function workerLaunch(
	state: RunState,
	issue: LocalIssue,
	config: ProjectConfig,
	role: WorkerRole,
): WorkerLaunch {
	const profile = role === "reviewer" ? config.profiles.reviewer : config.profiles[issue.profile!];
	return createWorkerLaunch({
		role,
		profile_path: profile,
		main_worktree: state.main_worktree,
		run_id: state.run_id,
		issue_id: finalCheck(state).id,
		main_pane: nonEmptyString(state.main_pane, "recorded main Herdr pane"),
	});
}

function matchesReview(current: RunTaskState, envelope: WorkerEnvelope): boolean {
	return envelope.payload.commit === current.commit
		&& envelope.payload.attempt === current.attempts
		&& envelope.payload.review_round === current.review_rounds;
}

function matchesBlock(current: RunTaskState, envelope: WorkerEnvelope, implementer: boolean): boolean {
	return envelope.payload.attempt === current.attempts
		&& envelope.payload.review_round === (implementer ? (current.review_rounds ?? 0) + 1 : current.review_rounds);
}

function matchesHealthBlock(health: PrHealthState, envelope: WorkerEnvelope, implementer: boolean): boolean {
	return envelope.payload.attempt === health.attempt
		&& envelope.payload.review_round === (implementer ? (health.review_round ?? 0) + 1 : health.review_round);
}

function repairWorktreePath(state: RunState, owner: string, attempt: number): string {
	return join(dirname(resolve(state.main_worktree)), `.${basename(state.main_worktree)}-auto-dag`, state.run_id, `final-repair-${owner}-${attempt}`);
}

function repairBranch(state: RunState, owner: string, attempt: number): string {
	return `pi-auto-dag/${state.run_id}/final-repair/${owner}/${attempt}`;
}

function healthWorktreePath(state: RunState, attempt: number): string {
	return join(dirname(resolve(state.main_worktree)), `.${basename(state.main_worktree)}-auto-dag`, state.run_id, `pr-health-${attempt}`);
}

function healthBranch(state: RunState, attempt: number): string {
	return `pi-auto-dag/${state.run_id}/pr-health/${attempt}`;
}

function finalReviewerLabel(state: RunState, attempt: number): string {
	return `auto-dag:${state.run_id}:final-check:${attempt}:reviewer`;
}

function nonNegativeInteger(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
	return value;
}

async function blockHealth(state: RunState, reason: string, options: PrLifecycleOptions): Promise<RunState> {
	const health = requiredHealth(state);
	const blockedRole = health.status === "repairing" ? "implementer" : ["triaging", "reviewing"].includes(health.status) ? "reviewer" : undefined;
	return await save({
		...state,
		health: {
			...health,
			status: "blocked",
			summary: reason,
			activity_started_at: timestamp(options),
			...(blockedRole ? { blocked_role: blockedRole } : {}),
		},
	}, options);
}

async function save(state: RunState, options: PrLifecycleOptions): Promise<RunState> {
	await writeRunState(state.main_worktree, state, options.uuid);
	return state;
}

function timestamp(options: PrLifecycleOptions): string {
	return options.now?.() ?? new Date().toISOString();
}
