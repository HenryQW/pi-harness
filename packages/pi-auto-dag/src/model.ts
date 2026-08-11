export const CONFIG_VERSION = 2;
export const RUN_STATE_VERSION = 2;
export const PROFILE_RESOLUTION_VERSION = 1;
export const DEFAULT_MAX_PARALLEL_TASKS = 5;
export const DEFAULT_MAX_REVIEW_ROUNDS = 5;
export const DEFAULT_REQUIRED_GATE_TIMEOUT_MS = 30 * 60 * 1_000;
export const MAX_REQUIRED_GATE_TIMEOUT_MS = 2_147_483_647;

export type ProfileId = string;
export type IssueRole = "implementation" | "final_check";

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

export interface ProfileRoutingConfig {
	version: typeof CONFIG_VERSION;
	profile_resolver: string[];
	implementation_profiles: ProfileId[];
	reviewer_profile: ProfileId;
	repair_profile: ProfileId;
	max_parallel_tasks: number;
	max_review_rounds: number;
	required_gate_timeout_ms: number;
}

export interface ResolvedProfile {
	version: typeof PROFILE_RESOLUTION_VERSION;
	id: ProfileId;
	description: string;
	agent_dir: string;
	skills: string[];
	tools: string[];
}

export interface ProjectConfig extends ProfileRoutingConfig {
	profiles: Record<ProfileId, ResolvedProfile>;
}

export interface LocalIssue {
	id: string;
	title: string;
	role: IssueRole;
	profile: ProfileId | null;
	purpose: string;
	acceptance: string[];
	testing: string;
	blocked_by: string[];
}

export interface DeliveryIssue {
	id: string;
	title: string;
	profile: ProfileId;
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
	status: "draft" | "approved";
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

export interface HealthCheckEvidence {
	name: string;
	link?: string;
	output?: string;
}

export interface PrHealthState {
	status: "triaging" | "repairing" | "reviewing" | "applying" | "pushing" | "post_push_cleanup" | "blocked" | "completed";
	head: string;
	summary?: string;
	actionable?: boolean;
	thread_ids?: string[];
	checks?: HealthCheckEvidence[];
	resolved_thread_ids?: string[];
	worktree?: string;
	branch?: string;
	base?: string;
	commit?: string;
	attempt?: number;
	review_round?: number;
	review_command?: string;
	review_commit?: string;
	review_exit_code?: number;
	review_stdout?: GateOutputEvidence;
	review_stderr?: GateOutputEvidence;
	review_findings?: string[];
	blocked_role?: "implementer" | "reviewer";
	/** A repair commit persisted before the lifecycle-owned cherry-pick starts. */
	integration_intent?: string;
	/** Reviewer-declared fixed thread IDs persisted before applying the repair. */
	fixed_thread_ids?: string[];
	reviewer_tab_id?: string;
	reviewer_pane?: string;
	reviewer_agent?: string;
	coder_tab_id?: string;
	coder_pane?: string;
	coder_agent?: string;
	activity_started_at?: string;
	instruction_pending?: boolean;
}

export interface HealthFastForwardIntent {
	expected_head: string;
	remote_head: string;
	pr: PullRequestIdentity;
}

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
	block_reason?: string;
	tasks: Record<string, RunTaskState>;
	resolutions: Record<string, string>;
	main_pane: string;
	workspace_id: string;
	wave?: RunWave;
	cleanup_blocks?: CleanupBlock[];
	pr?: PullRequestIdentity;
	health?: PrHealthState;
	health_history?: PrHealthState[];
	/** A verified PR-head fast-forward persisted before its local merge starts. */
	health_fast_forward_intent?: HealthFastForwardIntent;
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
	type: "submit_health" | "block_task";
});
