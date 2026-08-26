export const CONFIG_VERSION = 5;
export const RUN_STATE_VERSION = 5;
export const DEFAULT_MAX_PARALLEL_TASKS = 5;
export const DEFAULT_MAX_REVIEW_ROUNDS = 5;
export const DEFAULT_REQUIRED_GATE_TIMEOUT_MS = 30 * 60 * 1_000;
export const MAX_REQUIRED_GATE_TIMEOUT_MS = 2_147_483_647;

export interface GateOutputReference {
	path: string;
	sha256: string;
}

export interface GateOutputEvidence {
	excerpt: string;
	bytes: number;
	truncated: boolean;
	full_output?: GateOutputReference;
}

export interface RequiredGateEvidence {
	command: string;
	commit: string;
	exit_code: number;
	output: {
		stdout: GateOutputEvidence;
		stderr: GateOutputEvidence;
	};
}

export interface RequiredGateInvalidation {
	invalidated_at: string;
	reason: string;
	evidence: RequiredGateEvidence;
}

export interface GateCommandAmendment {
	issue_id: string;
	previous_command: string;
	replacement_command: string;
	failed_commit: string;
	reason: string;
	approved_at: string;
}

export interface ProjectConfig {
	version: typeof CONFIG_VERSION;
	max_parallel_tasks: number;
	max_review_rounds: number;
	required_gate_timeout_ms: number;
}

export interface LocalIssue {
	id: string;
	title: string;
	purpose: string;
	acceptance: string[];
	testing: string;
	blocked_by: string[];
}

export interface DeliveryIssue {
	id: string;
	title: string;
	objective: string;
	acceptance: string[];
	testing: string;
	depends_on: string[];
}

export interface DeliveryFinalCheck {
	acceptance: string[];
	testing: string;
}

/** Exact user-authored Delivery Graph contract. Execution-only fields are derived. */
export interface DeliveryGraph {
	id: string;
	goal: string;
	constraints: string[];
	non_goals: string[];
	issues: DeliveryIssue[];
	final_check: DeliveryFinalCheck;
}

export type RunPhase = "execution" | "blocked" | "aborted" | "completed";
export const RUN_TASK_STATUSES = ["pending", "starting", "implementing", "reviewing", "approved", "completed", "blocked", "repairing", "repair_reviewing", "repair_applying", "repair_cleanup"] as const;
export type RunTaskStatus = (typeof RUN_TASK_STATUSES)[number];

export interface RunTaskState {
	status: RunTaskStatus;
	attempts: number;
	block_reason?: string;
	wave_base?: string;
	worktree?: string;
	branch?: string;
	tab_id?: string;
	implementer_provisioning_id?: string;
	implementer_pane?: string;
	implementer_agent?: string;
	reviewer_provisioning_id?: string;
	reviewer_pane?: string;
	reviewer_agent?: string;
	activity_started_at?: string;
	commit?: string;
	review_rounds?: number;
	pending_action?: "initial" | "revision" | "replacement";
	/** Set before launching or prompting until the implementer receives its durable action. */
	implementer_instruction_pending?: boolean;
	/** Set before launching or prompting until the reviewer receives its durable review request. */
	reviewer_instruction_pending?: boolean;
	/** The approved child commit being applied to the integration worktree. */
	integration_intent?: string;
	/** A resolution must be delivered as a full role instruction, even to a live agent. */
	resolution_pending?: boolean;
	/** Identifies which active role raised a task block. */
	blocked_role?: "implementer" | "reviewer";
	/** System-executed required-gate evidence for the active review commit. */
	review_command?: string;
	review_commit?: string;
	review_exit_code?: number;
	review_stdout?: GateOutputEvidence;
	review_stderr?: GateOutputEvidence;
	/** Base and commit last delivered to the reviewer in a full packet. */
	review_packet_base?: string;
	review_packet_commit?: string;
	/** Failed Required Gate evidence invalidated by explicit infrastructure retry. */
	required_gate_invalidations?: RequiredGateInvalidation[];
	review_findings?: string[];
	conflict_base?: string;
	final_gate_head?: string;
	final_gate_findings?: string[];
	repair_issue_id?: string;
	repair_base?: string;
	repair_attempt?: number;
	repair_commit?: string;
	tab_cleanup_done?: boolean;
	worktree_cleanup_done?: boolean;
	branch_cleanup_done?: boolean;
}

export interface RunWave {
	base: string;
	issue_ids: string[];
}

export interface CleanupBlock {
	issue_id: string;
	operation: "tab" | "worktree" | "branch";
	reason: string;
}

export interface PullRequestIdentity {
	number: number;
	url: string;
	head_ref: string;
	base_ref: string;
	head_oid: string;
}

export type BlockedNotificationPayload = Readonly<{
	graph_id: string;
	graph_hash: string;
	integration_head: string;
	block_reason: string;
	blocked_tasks: readonly Readonly<{
		issue_id: string;
		block_reason: string;
		attempts: number;
		review_rounds?: number;
		blocked_role?: "implementer" | "reviewer";
	}>[];
	cleanup_blocks: readonly Readonly<CleanupBlock>[];
}>;

export type CompletedNotificationPayload = Readonly<{
	graph_id: string;
	graph_hash: string;
	integration_head: string;
	pr: Readonly<PullRequestIdentity>;
}>;

export type RunNotification = Readonly<{
	event_id: string;
	created_at: string;
	delivered_at?: string;
} & ({
	kind: "blocked";
	payload: BlockedNotificationPayload;
} | {
	kind: "completed";
	payload: CompletedNotificationPayload;
})>;

/** Core fields are fixed; later lifecycle phases may add durable evidence. */
export interface RunState {
	version: typeof RUN_STATE_VERSION;
	run_id: string;
	graph_hash: string;
	graph: DeliveryGraph;
	source_commit: string;
	integration_head: string;
	main_worktree: string;
	integration_branch: string;
	default_branch: string;
	created_at: string;
	phase: RunPhase;
	abort_reason?: string;
	/** Persisted only after aborted-run cleanup completes without a cleanup block. */
	abort_cleanup_complete?: true;
	block_reason?: string;
	tasks: Record<string, RunTaskState>;
	resolutions: Record<string, string>;
	gate_command_amendments?: GateCommandAmendment[];
	main_pane: string;
	workspace_id: string;
	wave?: RunWave;
	cleanup_blocks?: CleanupBlock[];
	pr?: PullRequestIdentity;
	notifications: RunNotification[];
	/** Notification representing the current blocked/completed transition. */
	current_notification_id?: string;
	/** Worker event IDs bound to SHA-256 hashes of envelopes whose lifecycle transition was persisted. */
	accepted_events?: Record<string, string>;
}

interface WorkerEnvelopeBase {
	version: 1;
	run_id: string;
	issue_id: string;
	role: "implementer" | "reviewer";
	event_id: string;
	attempt: number;
	review_round: number;
	receipt_path: string;
	payload: Record<string, unknown>;
}

export interface RequestReviewEnvelope extends WorkerEnvelopeBase {
	type: "request_review";
	role: "implementer";
	/** System-read Git HEAD; never supplied by implementer model. */
	commit: string;
}

export interface SubmitReviewEnvelope extends WorkerEnvelopeBase {
	type: "submit_review";
	role: "reviewer";
	/** System-owned review dispatch identity; never supplied by reviewer model. */
	review_id: string;
}

export type WorkerEnvelope = RequestReviewEnvelope | SubmitReviewEnvelope | (WorkerEnvelopeBase & {
	type: "block_task";
});
