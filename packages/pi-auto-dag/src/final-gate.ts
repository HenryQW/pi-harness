import { recordedGateEvidence, requiredGateProcessPath, runRequiredGate, type CommandRunner } from "./command.ts";
import { executionIssues } from "./graph.ts";
import type { LocalIssue, RequiredGateEvidence, RunState, RunTaskState } from "./model.ts";
import { recordGateExecution } from "./review.ts";
import { replaceTask, task, writeRunState, type Uuid } from "./state.ts";

export type FinalGateOptions = {
	runner: CommandRunner;
	uuid: Uuid;
	now?: () => string;
};

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
			issue.testing,
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

export function retryableFinalGate(state: RunState): { issue: LocalIssue; evidence: RequiredGateEvidence } {
	const issue = executionIssues(state.graph).at(-1)!;
	const current = task(state, issue.id);
	const commit = state.integration_head;
	if (state.phase !== "blocked" || current.status !== "blocked" || current.final_gate_head !== commit) {
		throw new Error("Infrastructure retry requires a blocked Final Check at the current integration HEAD");
	}
	if (state.cleanup_blocks?.length) throw new Error("Infrastructure retry cannot run while cleanup is blocked");
	if (executionIssues(state.graph).some((candidate) => candidate.role === "implementation" && task(state, candidate.id).status !== "completed")) {
		throw new Error("Infrastructure retry requires every implementation Local Issue to be completed");
	}
	const evidence = recordedGateEvidence(current, commit);
	if (!evidence || evidence.exit_code === 0) {
		throw new Error("Infrastructure retry requires failed Final Check Required Gate evidence for the current integration HEAD");
	}
	if (evidence.command !== issue.testing) throw new Error("Failed Final Check Required Gate command does not match the frozen command");
	return { issue, evidence };
}

async function save(state: RunState, options: FinalGateOptions): Promise<RunState> {
	await writeRunState(state.main_worktree, state, options.uuid);
	return state;
}

function timestamp(options: FinalGateOptions): string {
	return options.now?.() ?? new Date().toISOString();
}
