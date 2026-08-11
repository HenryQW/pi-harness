import { basename, dirname, join, resolve } from "node:path";
import { commandOutput, recordedGateEvidence, restoreCleanCommit, type CommandRunner } from "./command.ts";
import { revalidateResolvedProfile } from "./config.ts";
import { ensureRecordedGate, failFinalGate, requiredTaskGate } from "./final-gate.ts";
import { acceptFinalRepairEnvelope, advanceFinalRepair, isFinalRepairActive, recoverFinalRepairIntegration } from "./final-repair.ts";
import { deleteExpectedBranch, ensureChildWorktree, retireChildWorktree } from "./git.ts";
import { executionIssues } from "./graph.ts";
import { assertRunBoundary } from "./intake.ts";
import type { LocalIssue, ProjectConfig, PullRequestIdentity, RunState, RunTaskState, SubmitReviewEnvelope, WorkerEnvelope } from "./model.ts";
import { assertSamePullRequest, parsePullRequest, viewOpenPullRequest } from "./pull-request.ts";
import { actionTicketPath, ensureActionTicket, reviewId, type ReviewKind } from "./review-ticket.ts";
import { reviewPrompt, type ReviewPromptMode } from "./review.ts";
import { replaceTask, task, writeRunState, type Uuid } from "./state.ts";
import { promptWorkerAgent, reconcileWorkerTab, startWorkerAgent, workerAgentName } from "./worker-host.ts";
import { createWorkerLaunch, WORKER_ROLE_EVENTS, type WorkerLaunch, type WorkerRole } from "./worker.ts";
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
	state = await recoverFinalRepairIntegration(state, options);
	if (!allImplementationsCompleted(state)) return state;
	state = await advanceFinalRepair(state, config, options);
	if (isFinalRepairActive(state)) return state;
	const issue = finalCheck(state);
	const current = task(state, issue.id);
	if (state.pr) return await completePr(state, issue, options);
	if (current.status === "approved") return await openPr(state, issue, options);
	if (current.status === "pending" || current.status === "completed") {
		return await startFinalReview(state, issue, config, options);
	}
	if (current.status === "reviewing") return await ensureFinalReviewer(state, issue, config, options, "resume");
	return state;
}

/** Final-check envelopes stay separate from dependency-wave workers. */
export async function acceptPrLifecycleEnvelope(
	state: RunState,
	envelope: WorkerEnvelope,
	config: ProjectConfig,
	options: PrLifecycleOptions,
): Promise<RunState> {
	const issue = finalCheck(state);
	if (envelope.issue_id !== issue.id) throw new Error(`PR lifecycle event belongs to another Local Issue: ${envelope.issue_id}`);
	if (isFinalRepairActive(state)) {
		const next = await acceptFinalRepairEnvelope(state, envelope, config, options);
		return task(next, issue.id).status === "pending" ? await advancePrLifecycle(next, config, options) : next;
	}
	const current = task(state, issue.id);
	if (envelope.type === "submit_review" && current.status === "reviewing") {
		return await submitFinalReview(state, issue, envelope, options);
	}
	if (envelope.type === "block_task" && current.status === "reviewing" && envelope.role === "reviewer" && matchesBlock(current, envelope, false)) {
		return await failFinalGate(state, issue, nonEmptyString(envelope.payload.reason, "final-check block reason"), options);
	}
	throw new Error(`Unexpected PR lifecycle event ${envelope.type} while final_check is ${current.status}`);
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
	state = await ensureFinalGate(state, issue, commit, config.required_gate_timeout_ms, options);
	current = task(state, issue.id);
	const gate = requiredTaskGate(current, commit, "Final check");
	if (gate.exit_code !== 0) {
		return await failFinalGate(state, issue, `Required gate exited with code ${gate.exit_code}; reviewer was not launched`, options, [], true);
	}
	const label = nonEmptyString(current.implementer_provisioning_id, "final reviewer provisioning identity");
	let launch = await workerLaunch(state, issue, config, "reviewer");
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
	launch = await workerLaunch(state, issue, config, "reviewer");
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
	await ensureActionTicket(
		actionTicketPath(state.main_worktree, state.run_id, issue.id, "lifecycle", "reviewer"),
		{ attempt: current.attempts, review_round: positiveInteger(current.review_rounds, "final-check review round"), role: "reviewer", review_id: lifecycleReviewId(state, issue, current, "final_check") },
		state.main_worktree,
		state.run_id,
		options.uuid,
	);
	await revalidateResolvedProfile(config, config.reviewer_profile);
	await promptWorkerAgent(state, agent, reviewPrompt({
		kind: "final_check",
		graph: state.graph,
		issue,
		worktree: state.main_worktree,
		base: state.source_commit,
		gate: requiredTaskGate(current, commit, "Final check"),
	}, promptMode), options);
	if (needsInstruction) {
		state = await save(replaceTask(state, issue.id, { ...task(state, issue.id), reviewer_instruction_pending: undefined }), options);
	}
	return state;
}

async function submitFinalReview(
	state: RunState,
	issue: LocalIssue,
	envelope: SubmitReviewEnvelope,
	options: PrLifecycleOptions,
): Promise<RunState> {
	if (envelope.role !== "reviewer") throw new Error("Only the final-check reviewer can submit final review");
	const current = task(state, issue.id);
	if (envelope.review_id !== lifecycleReviewId(state, issue, current, "final_check")) throw new Error("Final-check review submission is stale");
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

function allImplementationsCompleted(state: RunState): boolean {
	return executionIssues(state.graph).filter((issue) => issue.role === "implementation").every((issue) => task(state, issue.id).status === "completed");
}

function finalCheck(state: RunState): LocalIssue {
	return executionIssues(state.graph).at(-1)!;
}

async function workerLaunch(
	state: RunState,
	issue: LocalIssue,
	config: ProjectConfig,
	role: WorkerRole,
): Promise<WorkerLaunch> {
	const profileId = role === "reviewer" ? config.reviewer_profile : nonEmptyString(issue.profile, `Local Issue ${issue.id} profile`);
	const profile = await revalidateResolvedProfile(config, profileId);
	return createWorkerLaunch({
		role,
		events: WORKER_ROLE_EVENTS[role].filter((event) => event !== "submit_health"),
		profile,
		run_id: state.run_id,
		issue_id: finalCheck(state).id,
		main_pane: nonEmptyString(state.main_pane, "recorded main Herdr pane"),
		action_ticket: actionTicketPath(state.main_worktree, state.run_id, finalCheck(state).id, "lifecycle", role),
		required_gate_timeout_ms: config.required_gate_timeout_ms,
	});
}

function lifecycleReviewId(state: RunState, issue: LocalIssue, current: RunTaskState, kind: ReviewKind): string {
	return reviewId({
		run_id: state.run_id,
		kind,
		issue_id: issue.id,
		commit: nonEmptyString(current.commit, `${kind} review commit`),
		attempt: current.attempts,
		review_round: positiveInteger(current.review_rounds, `${kind} review round`),
	});
}

function matchesBlock(current: RunTaskState, envelope: WorkerEnvelope, implementer: boolean): boolean {
	return envelope.attempt === current.attempts
		&& envelope.review_round === (implementer ? (current.review_rounds ?? 0) + 1 : current.review_rounds);
}

function finalReviewerLabel(state: RunState, attempt: number): string {
	return `auto-dag:${state.run_id}:final-check:${attempt}:reviewer`;
}

async function ensureFinalGate(
	state: RunState,
	issue: LocalIssue,
	commit: string,
	timeoutMs: number,
	options: PrLifecycleOptions,
): Promise<RunState> {
	const worktree = finalGateWorktreePath(state);
	const branch = finalGateBranch(state);
	try {
		if (!recordedGateEvidence(task(state, issue.id), commit)) {
			await ensureChildWorktree(options.runner, state.main_worktree, worktree, branch, commit, "Final gate");
			await restoreCleanCommit(options.runner, commit, worktree);
			await commandOutput(options.runner, "git", ["clean", "-ffdx"], worktree);
			state = await ensureRecordedGate(state, issue, commit, worktree, timeoutMs, options);
		}
	} finally {
		await retireChildWorktree(options.runner, state.main_worktree, worktree, branch, "Final gate");
		await deleteExpectedBranch(options.runner, state.main_worktree, branch, commit, "Final gate");
	}
	return state;
}

function finalGateWorktreePath(state: RunState): string {
	return join(dirname(resolve(state.main_worktree)), `.${basename(state.main_worktree)}-auto-dag`, state.run_id, "final-gate");
}

function finalGateBranch(state: RunState): string {
	return `pi-auto-dag/${state.run_id}/final-gate`;
}

async function save(state: RunState, options: PrLifecycleOptions): Promise<RunState> {
	await writeRunState(state.main_worktree, state, options.uuid);
	return state;
}

function timestamp(options: PrLifecycleOptions): string {
	return options.now?.() ?? new Date().toISOString();
}
