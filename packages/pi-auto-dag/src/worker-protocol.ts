import { loadRoles, type Role } from "@henryqw/pi-subagent";
import { assertAttachedBranch, verifySingleCommit } from "./git.ts";
import { executionIssues } from "./graph.ts";
import type { CommandRunner } from "./command.ts";
import type { CleanupBlock, LocalIssue, ProjectConfig, RunState, RunTaskState, WorkerEnvelope } from "./model.ts";
import { actionTicketPath, reviewId, type ReviewKind, type ReviewTicketScope } from "./review-ticket.ts";
import { writeRunState, type Uuid } from "./state.ts";
import { createWorkerLaunch, WORKER_ROLE_EVENTS, type RoleLaunchResolver, type WorkerLaunch, type WorkerRole } from "./worker.ts";
import { nonEmptyString, positiveInteger } from "./validate.ts";

/** Shared worker-protocol scaffolding for the lifecycle phases (wave tasks, final check/review, final repair, PR health). */

export function finalCheck(state: RunState): LocalIssue {
	return executionIssues(state.graph).at(-1)!;
}

export function hasReviewFindings(record: { review_findings?: string[] }): boolean {
	return Array.isArray(record.review_findings) && record.review_findings.length > 0;
}

export function matchesRound(envelope: WorkerEnvelope, attempt: number | undefined, reviewRound: number | undefined, implementer: boolean): boolean {
	return envelope.attempt === attempt
		&& envelope.review_round === (implementer ? (reviewRound ?? 0) + 1 : reviewRound);
}

export async function verifyOneCommit(
	state: RunState,
	worktree: string,
	branch: string,
	base: string,
	commit: string,
	label: string,
	options: { runner: CommandRunner },
): Promise<string> {
	await assertAttachedBranch(options.runner, worktree, branch, `${label} child worktree`);
	return await verifySingleCommit(options.runner, state.main_worktree, worktree, base, commit, label);
}

export function lifecycleWorkerLaunch(
	state: RunState,
	issueId: string,
	config: ProjectConfig,
	role: WorkerRole,
	options: { resolveLaunch: RoleLaunchResolver },
	ticketScope: ReviewTicketScope,
): WorkerLaunch {
	return createWorkerLaunch({
		resolveLaunch: options.resolveLaunch,
		workerRole: role,
		role: conventionalRole(role),
		events: WORKER_ROLE_EVENTS[role],
		run_id: state.run_id,
		issue_id: issueId,
		main_pane: nonEmptyString(state.main_pane, "recorded main Herdr pane"),
		action_ticket: actionTicketPath(state.main_worktree, state.run_id, issueId, ticketScope, role),
		required_gate_timeout_ms: config.required_gate_timeout_ms,
	});
}

function conventionalRole(role: WorkerRole): Role {
	const match = loadRoles().find((candidate) => candidate.name === role);
	if (!match) throw new Error(`Configured Subagent Role is unavailable: ${role}`);
	return match;
}

export function lifecycleReviewId(state: RunState, issue: LocalIssue, current: RunTaskState, kind: ReviewKind): string {
	return reviewId({
		run_id: state.run_id,
		kind,
		issue_id: issue.id,
		commit: nonEmptyString(current.commit, `${kind} review commit`),
		attempt: current.attempts,
		review_round: positiveInteger(current.review_rounds, `${kind} review round`),
	});
}

export async function saveRunState(state: RunState, options: { uuid: Uuid }): Promise<RunState> {
	await writeRunState(state.main_worktree, state, options.uuid);
	return state;
}

export function timestamp(options: { now?: () => string }): string {
	return options.now?.() ?? new Date().toISOString();
}

export async function recordLifecycleCleanupBlock(
	state: RunState,
	issueId: string,
	operation: CleanupBlock["operation"],
	reason: string,
	options: { uuid: Uuid },
): Promise<RunState> {
	const blocks = [...(state.cleanup_blocks ?? []).filter((block) => block.issue_id !== issueId || block.operation !== operation), { issue_id: issueId, operation, reason }];
	return await saveRunState({ ...state, cleanup_blocks: blocks }, options);
}

export function clearLifecycleCleanupBlock(state: RunState, issueId: string, operation: CleanupBlock["operation"]): RunState {
	const cleanupBlocks = (state.cleanup_blocks ?? []).filter((block) => block.issue_id !== issueId || block.operation !== operation);
	return { ...state, ...(cleanupBlocks.length ? { cleanup_blocks: cleanupBlocks } : { cleanup_blocks: undefined }) };
}
