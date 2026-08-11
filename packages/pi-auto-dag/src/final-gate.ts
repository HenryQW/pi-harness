import { isDeepStrictEqual } from "node:util";
import { recordedGateEvidence, requiredGateProcessPath, runRequiredGate, type CommandRunner } from "./command.ts";
import { executionIssues } from "./graph.ts";
import type { GateCommandAmendment, LocalIssue, RequiredGateEvidence, RunState, RunTaskState } from "./model.ts";
import { recordGateExecution } from "./review.ts";
import { issueById, replaceTask, task, writeRunState, type Uuid } from "./state.ts";
import { nonEmptyString } from "./validate.ts";

export type FinalGateOptions = {
	runner: CommandRunner;
	uuid: Uuid;
	now?: () => string;
};

export interface GateCommandAmendmentRequest {
	replacement_command: string;
	expected_run_id: string;
	expected_command: string;
	expected_commit: string;
	expected_evidence: RequiredGateEvidence;
}

export function requiredGateCommand(state: RunState, issue: LocalIssue): string {
	let command = issue.testing;
	for (const amendment of state.gate_command_amendments ?? []) {
		if (amendment.issue_id === issue.id) command = amendment.replacement_command;
	}
	return command;
}

export function gateCommandAmendments(state: RunState, issueId: string): GateCommandAmendment[] {
	return (state.gate_command_amendments ?? []).filter((amendment) => amendment.issue_id === issueId);
}

export function requiredGateCommandAmendmentRequest(
	state: RunState,
	issueId: string,
	replacementCommand: string,
): GateCommandAmendmentRequest {
	const issue = issueById(state, issueId);
	const current = task(state, issueId);
	const commit = current.review_commit;
	const evidence = commit ? recordedGateEvidence(current, commit) : undefined;
	if (state.phase !== "blocked" || !evidence || evidence.exit_code === 0) {
		throw new Error(`Required Gate command amendment requires failed gate evidence for Local Issue ${issueId}`);
	}
	const command = requiredGateCommand(state, issue);
	if (evidence.command !== command) {
		throw new Error(`Failed Required Gate command for Local Issue ${issueId} no longer matches active command`);
	}
	const replacement = nonEmptyString(replacementCommand, "replacement Required Gate command");
	if (replacement === command) throw new Error("Replacement Required Gate command must differ from current command");
	return {
		replacement_command: replacement,
		expected_run_id: state.run_id,
		expected_command: command,
		expected_commit: evidence.commit,
		expected_evidence: evidence,
	};
}

export function amendRequiredGateCommand(
	state: RunState,
	issueId: string,
	reason: string,
	request: GateCommandAmendmentRequest,
	approvedAt: string,
): RunState {
	const current = requiredGateCommandAmendmentRequest(state, issueId, request.replacement_command);
	if (
		request.expected_run_id !== current.expected_run_id
		|| request.expected_command !== current.expected_command
		|| request.expected_commit !== current.expected_commit
		|| !isDeepStrictEqual(request.expected_evidence, current.expected_evidence)
	) {
		throw new Error("Required Gate changed during command amendment; inspect and confirm current failure again");
	}
	const amendment: GateCommandAmendment = {
		issue_id: issueId,
		previous_command: current.expected_command,
		replacement_command: current.replacement_command,
		failed_commit: current.expected_commit,
		reason: nonEmptyString(reason, "resolution"),
		approved_at: nonEmptyString(approvedAt, "gate command amendment approval time"),
	};
	return { ...state, gate_command_amendments: [...(state.gate_command_amendments ?? []), amendment] };
}

export async function failFinalGate(
	state: RunState,
	issue: LocalIssue,
	reason: string,
	options: FinalGateOptions,
	findings: string[] = [],
	beforeReviewer = false,
): Promise<RunState> {
	const current = task(state, issue.id);
	const { blocked_role: _blockedRole, ...unblocked } = current;
	const blockedRole = beforeReviewer ? undefined : current.status === "repairing" ? "implementer" : ["reviewing", "repair_reviewing"].includes(current.status) ? "reviewer" : undefined;
	return await save({
		...replaceTask(state, issue.id, {
			...unblocked,
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

export async function ensureRecordedGate(
	state: RunState,
	issue: LocalIssue,
	commit: string,
	cwd: string,
	timeoutMs: number,
	options: FinalGateOptions,
): Promise<RunState> {
	const current = task(state, issue.id);
	const evidence = recordedGateEvidence(current, commit);
	if (!evidence) {
		const execution = await runRequiredGate(
			options.runner,
			requiredGateCommand(state, issue),
			commit,
			cwd,
			timeoutMs,
			requiredGateProcessPath(state.main_worktree, state.run_id),
			{ kind: "task", issue_id: issue.id },
		);
		state = await recordGateExecution(state, { kind: "task", issue_id: issue.id }, execution, options.uuid);
	}
	return state;
}

export function requiredTaskGate(current: RunTaskState, commit: string, label: string): RequiredGateEvidence {
	const evidence = recordedGateEvidence(current, commit);
	if (!evidence) throw new Error(`${label} required-gate evidence is missing`);
	return evidence;
}

export function isRetryableFinalGate(state: RunState): boolean {
	try {
		retryableFinalGate(state);
		return true;
	} catch {
		return false;
	}
}

export function retryableFinalGate(state: RunState): { issue: LocalIssue; evidence: RequiredGateEvidence } {
	const issue = executionIssues(state.graph).at(-1)!;
	const current = task(state, issue.id);
	const commit = state.integration_head;
	if (state.phase !== "blocked" || current.status !== "blocked" || current.final_gate_head !== commit) {
		throw new Error("Infrastructure retry requires a blocked Final Check at the current integration HEAD");
	}
	if (state.cleanup_blocks?.length) throw new Error("Infrastructure retry cannot run while cleanup is blocked");
	if (current.repair_issue_id && current.repair_base && current.repair_attempt) {
		throw new Error("Infrastructure retry cannot run while Final Check repair is active");
	}
	if (executionIssues(state.graph).some((candidate) => candidate.role === "implementation" && task(state, candidate.id).status !== "completed")) {
		throw new Error("Infrastructure retry requires every implementation Local Issue to be completed");
	}
	const evidence = recordedGateEvidence(current, commit);
	if (!evidence || evidence.exit_code === 0) {
		throw new Error("Infrastructure retry requires failed Final Check Required Gate evidence for the current integration HEAD");
	}
	if (evidence.command !== requiredGateCommand(state, issue)) {
		throw new Error("Failed Final Check Required Gate command does not match the active command");
	}
	return { issue, evidence };
}

async function save(state: RunState, options: FinalGateOptions): Promise<RunState> {
	await writeRunState(state.main_worktree, state, options.uuid);
	return state;
}

function timestamp(options: FinalGateOptions): string {
	return options.now?.() ?? new Date().toISOString();
}
