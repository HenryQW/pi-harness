export const CONFIG_VERSION = 1;
export const GRAPH_VERSION = 1;
export const RUN_STATE_VERSION = 1;
export const DEFAULT_MAX_PARALLEL_TASKS = 5;
export const DEFAULT_MAX_REVIEW_ROUNDS = 5;

export const IMPLEMENTATION_PROFILES = ["coder", "backend", "frontend"] as const;
export const PROFILE_NAMES = [...IMPLEMENTATION_PROFILES, "reviewer"] as const;
export const ISSUE_ROLES = ["implementation", "final_check"] as const;

export type ImplementationProfile = (typeof IMPLEMENTATION_PROFILES)[number];
export type ProfileName = (typeof PROFILE_NAMES)[number];
export type IssueRole = (typeof ISSUE_ROLES)[number];

export interface ProjectConfig {
	version: typeof CONFIG_VERSION;
	profiles: Record<ProfileName, string>;
	max_parallel_tasks: number;
	max_review_rounds: number;
}

export interface LocalIssue {
	id: string;
	title: string;
	role: IssueRole;
	profile: ImplementationProfile | null;
	purpose: string;
	acceptance: string[];
	testing: string;
	blocked_by: string[];
}

export interface DeliveryGraph {
	version: typeof GRAPH_VERSION;
	status: "draft" | "approved";
	id: string;
	title: string;
	goal: string;
	constraints: string[];
	issues: LocalIssue[];
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
	/** The reviewer-reported frozen command evidence for the active review. */
	review_command?: string;
	review_commit?: string;
	review_exit_code?: number;
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
}

export interface WorkerEnvelope {
	version: 1;
	type: "request_review" | "submit_review" | "submit_health" | "block_task";
	run_id: string;
	issue_id: string;
	role: "implementer" | "reviewer";
	payload: Record<string, unknown>;
}
