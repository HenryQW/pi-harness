import { basename, dirname, join, resolve } from "node:path";
import { recordedGateEvidence, requiredGateProcessPath, runRequiredGate, type CommandRunner } from "./command.ts";
import { revalidateResolvedProfile, type AvailableSkill } from "./config.ts";
import { gateCommandAmendments, requiredGateCommand } from "./final-gate.ts";
import { executionIssues } from "./graph.ts";
import { assertRunBoundary } from "./intake.ts";
import { assertAttachedBranch, ensureChildWorktree, verifySingleCommit } from "./git.ts";
import type { LocalIssue, ProjectConfig, RequiredGateEvidence, RunState, RunTaskState } from "./model.ts";
import { actionTicketPath, ensureActionTicket, reviewId } from "./review-ticket.ts";
import { recordGateExecution, reviewPrompt as reviewWorkerPrompt, type ReviewPromptMode } from "./review.ts";
import { replaceTask, task, writeRunState, type Uuid } from "./state.ts";
import { createWorkerTab, ensureWorkerPane, findWorkerTab, promptWorkerAgent, reconcileWorkerTab, startWorkerAgent, workerAgentName, workerTabExists } from "./worker-host.ts";
import { createWorkerLaunch, workerDeliveryContext, workerIssueContext, WORKER_ROLE_EVENTS, type WorkerLaunch, type WorkerRole } from "./worker.ts";
import { nonEmptyString, positiveInteger } from "./validate.ts";

export interface ImplementationWorkerOptions {
	runner: CommandRunner;
	uuid: Uuid;
	delay?: (milliseconds: number) => Promise<void>;
	availableSkills?: () => readonly AvailableSkill[] | undefined;
}

export type ImplementerAction = NonNullable<RunTaskState["pending_action"]>;

/** The parent of the integration worktree is deliberate: `.context` never enters a child. */
export function childWorktreePath(mainWorktree: string, runId: string, issueId: string): string {
	const root = resolve(mainWorktree);
	return join(dirname(root), `.${basename(root)}-auto-dag`, runId, issueId);
}

export function childBranch(runId: string, issueId: string): string {
	return `pi-auto-dag/${runId}/${issueId}`;
}

export async function reconcileWorkers(state: RunState, config: ProjectConfig, options: ImplementationWorkerOptions): Promise<RunState> {
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

export async function ensureImplementer(
	state: RunState,
	issue: LocalIssue,
	config: ProjectConfig,
	options: ImplementationWorkerOptions,
	mode: ImplementerAction | "resume",
): Promise<RunState> {
	await ensureWorktree(state, issue.id, options);
	config = await assertRunBoundary(state, options.runner, options.availableSkills?.());
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
	let launch = await workerLaunch(state, issue, config, "implementer");
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
	launch = await workerLaunch(state, issue, config, "implementer");
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
	await ensureActionTicket(
		actionTicketPath(state.main_worktree, state.run_id, issue.id, "implementation", "implementer"),
		{ attempt: current.attempts, review_round: (current.review_rounds ?? 0) + 1, role: "implementer" },
		state.main_worktree,
		state.run_id,
		options.uuid,
	);
	await revalidateResolvedProfile(config, nonEmptyString(issue.profile, `Local Issue ${issue.id} profile`));
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

export async function ensureReviewer(
	state: RunState,
	issue: LocalIssue,
	config: ProjectConfig,
	options: ImplementationWorkerOptions,
	mode: "review" | "resume",
): Promise<RunState> {
	await ensureWorktree(state, issue.id, options);
	config = await assertRunBoundary(state, options.runner, options.availableSkills?.());
	state = await ensureTaskGate(state, issue, config.required_gate_timeout_ms, options);
	let current = task(state, issue.id);
	const commit = nonEmptyString(current.commit, `Run Task ${issue.id} review commit`);
	const gate = requiredTaskGate(current, commit, issue.id);
	if (gate.exit_code !== 0) throw new Error(`Required gate exited with code ${gate.exit_code}; reviewer was not launched`);
	if (!current.tab_id || !current.implementer_pane || (current.reviewer_pane && !(await workerTabExists(state, current.tab_id, options)))) {
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
				await workerLaunch(state, issue, config, "implementer"),
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
			await workerLaunch(state, issue, config, "reviewer"),
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
	const reviewerLaunch = await workerLaunch(state, issue, config, "reviewer");
	const started = await startWorkerAgent(
		state,
		agent,
		nonEmptyString(current.reviewer_pane, `Run Task ${issue.id} reviewer_pane`),
		reviewerLaunch,
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
	await ensureActionTicket(
		actionTicketPath(state.main_worktree, state.run_id, issue.id, "implementation", "reviewer"),
		{ attempt: current.attempts, review_round: positiveInteger(current.review_rounds, `Run Task ${issue.id} review round`), role: "reviewer", review_id: taskReviewId(state, issue.id, current) },
		state.main_worktree,
		state.run_id,
		options.uuid,
	);
	await revalidateResolvedProfile(config, config.reviewer_profile);
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

async function ensureTaskGate(state: RunState, issue: LocalIssue, timeoutMs: number, options: ImplementationWorkerOptions): Promise<RunState> {
	const current = task(state, issue.id);
	const commit = nonEmptyString(current.commit, `Run Task ${issue.id} review commit`);
	await verifyReviewCommit(state, issue.id, commit, options);
	const evidence = recordedGateEvidence(current, commit);
	if (!evidence) {
		const execution = await runRequiredGate(
			options.runner,
			requiredGateCommand(state, issue),
			commit,
			nonEmptyString(current.worktree, `Run Task ${issue.id} worktree`),
			timeoutMs,
			requiredGateProcessPath(state.main_worktree, state.run_id),
			{ kind: "task", issue_id: issue.id },
		);
		state = await recordGateExecution(state, { kind: "task", issue_id: issue.id }, execution, options.uuid);
	}
	return state;
}

export async function verifyReviewCommit(state: RunState, issueId: string, commit: string, options: ImplementationWorkerOptions): Promise<string> {
	const current = task(state, issueId);
	const worktree = nonEmptyString(current.worktree, `Run Task ${issueId} worktree`);
	const base = nonEmptyString(current.wave_base, `Run Task ${issueId} wave_base`);
	await assertTaskBranch(state, issueId, options);
	return await verifySingleCommit(options.runner, state.main_worktree, worktree, base, commit, `Run Task ${issueId}`, "wave base");
}

export async function assertTaskBranch(state: RunState, issueId: string, options: ImplementationWorkerOptions): Promise<void> {
	const current = task(state, issueId);
	const worktree = nonEmptyString(current.worktree, `Run Task ${issueId} worktree`);
	const branch = nonEmptyString(current.branch, `Run Task ${issueId} branch`);
	const expected = childBranch(state.run_id, issueId);
	if (branch !== expected) throw new Error(`Run Task ${issueId} branch is not its deterministic child branch: ${branch}`);
	await assertAttachedBranch(options.runner, worktree, branch, `Run Task ${issueId} child worktree`);
}

export async function ensureWorktree(state: RunState, issueId: string, options: ImplementationWorkerOptions): Promise<void> {
	const current = task(state, issueId);
	const path = nonEmptyString(current.worktree, `Run Task ${issueId} worktree`);
	const branch = nonEmptyString(current.branch, `Run Task ${issueId} branch`);
	const base = nonEmptyString(current.wave_base, `Run Task ${issueId} wave_base`);
	if (branch !== childBranch(state.run_id, issueId)) {
		throw new Error(`Run Task ${issueId} branch is not its deterministic child branch: ${branch}`);
	}
	await ensureChildWorktree(options.runner, state.main_worktree, path, branch, base, `Run Task ${issueId}`);
}

function pendingImplementerAction(current: RunTaskState): ImplementerAction {
	if (current.pending_action === "initial" || current.pending_action === "revision" || current.pending_action === "replacement") return current.pending_action;
	return hasReviewFindings(current) ? "revision" : current.conflict_base ? "replacement" : "initial";
}

function hasReviewFindings(current: RunTaskState): boolean {
	return Array.isArray(current.review_findings) && current.review_findings.length > 0;
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
		issue_id: issue.id,
		main_pane: nonEmptyString(state.main_pane, "recorded main Herdr pane"),
		action_ticket: actionTicketPath(state.main_worktree, state.run_id, issue.id, "implementation", role),
		required_gate_timeout_ms: config.required_gate_timeout_ms,
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
	const amendments = gateCommandAmendments(state, issue.id);
	const gate = amendments.length ? { required_gate: { command: requiredGateCommand(state, issue), amendments } } : {};
	if (!full) return {
		type: mode === "resume" ? "auto_dag_resend" : "auto_dag_task_update",
		run_id: state.run_id,
		issue_id: issue.id,
		attempt: current.attempts,
		review_round: (current.review_rounds ?? 0) + 1,
		review_findings: current.review_findings,
		...gate,
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
		...gate,
		instruction,
	};
}

function reviewerPrompt(
	state: RunState,
	issue: LocalIssue,
	current: RunTaskState,
	mode: ReviewPromptMode,
): Record<string, unknown> {
	const amendments = gateCommandAmendments(state, issue.id);
	return reviewWorkerPrompt({
		kind: "implementation",
		graph: state.graph,
		issue,
		worktree: nonEmptyString(current.worktree, `Run Task ${issue.id} worktree`),
		base: nonEmptyString(current.wave_base, `Run Task ${issue.id} wave_base`),
		gate: requiredTaskGate(current, nonEmptyString(current.commit, `Run Task ${issue.id} review commit`), issue.id),
		prior_findings: current.review_findings,
		resolution: state.resolutions[issue.id],
		...(amendments.length ? { context: { gate_command_amendments: amendments } } : {}),
	}, mode);
}

export function taskReviewId(state: RunState, issueId: string, current: RunTaskState): string {
	return reviewId({
		run_id: state.run_id,
		kind: "implementation",
		issue_id: issueId,
		commit: nonEmptyString(current.commit, `Run Task ${issueId} review commit`),
		attempt: current.attempts,
		review_round: positiveInteger(current.review_rounds, `Run Task ${issueId} review round`),
	});
}

export function requiredTaskGate(current: RunTaskState, commit: string, issueId: string): RequiredGateEvidence {
	const evidence = recordedGateEvidence(current, commit);
	if (!evidence) throw new Error(`Run Task ${issueId} required-gate evidence is missing`);
	return evidence;
}

export function provisioningIdFor(runId: string, issueId: string, role: WorkerRole): string {
	return `auto-dag:${runId}:${issueId}:${role}`;
}

async function save(state: RunState, options: ImplementationWorkerOptions): Promise<RunState> {
	await writeRunState(state.main_worktree, state, options.uuid);
	return state;
}
