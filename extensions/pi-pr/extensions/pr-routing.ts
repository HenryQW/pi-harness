export type PullRequestLifecycle = "open" | "merged" | "closed";
export type CiStatus = "none" | "running" | "success" | "failure" | "failure-blocked";
export type ReviewReadiness = "ready" | "pending";
type PolicyReadiness = "ready" | "pending";
/** GitHub computes mergeability asynchronously; `pending` is transient, not a blocker. */
type Mergeability = "known" | "pending";
type LocalWorktree = "clean" | "dirty";
type LocalHeadRelation = "equal" | "behind" | "ahead" | "diverged";

export type PullRequestConditions = {
	draft: boolean;
	baseUpdateRequired: boolean;
	conflict: boolean;
	changesRequested: boolean;
	unresolvedThreads: number;
	ci: CiStatus;
	review: ReviewReadiness;
	policy: PolicyReadiness;
	mergeability: Mergeability;
};

export type LocalMergeSafety = {
	worktree: LocalWorktree;
	head: LocalHeadRelation;
};

export type PullRequest = {
	lifecycle: PullRequestLifecycle;
	conditions: PullRequestConditions;
	local: LocalMergeSafety;
};

export type PullRequestTarget = {
	provenance: "configured" | "inferred";
	branch: string;
	remote: string;
	ref: string;
	repository: string;
	host: string;
	fetchSource: string;
	remoteOid: string | null;
};

export type BranchCreationState = {
	ahead: number;
	worktree: "clean" | "dirty" | "operation";
	relation: "same-ref" | "distinct-ref";
};

export type DiscoveryIssue =
	| { kind: "detached-head" }
	| { kind: "target-invalid" }
	| { kind: "origin-invalid" }
	| { kind: "candidate-remotes-ambiguous"; remotes: string[] }
	| { kind: "candidate-prs-ambiguous"; urls: URL[] }
	| { kind: "candidate-oid-mismatch"; remote: string; urls: URL[] }
	| { kind: "published-without-pr"; remote: string }
	| { kind: "link-configuration"; remote: string };

export type PullRequestDiscovery<T extends PullRequest = PullRequest> =
	| { kind: "current"; pullRequest: T }
	| { kind: "none"; creationTarget: PullRequestTarget; branch: BranchCreationState }
	| { kind: "blocked"; issue: DiscoveryIssue }
	| { kind: "inactive" };

export type NextStep =
	| "create" | "link-branch" | "blocked" | "none"
	| "sync-local" | "publish-work" | "refresh" | "update-branch" | "sweep" | "fix-ci" | "wait-ci" | "merge";

/**
 * Priority ladder for an open pull request. Local state is normalized first
 * (sync, then publish), so every later route sees a clean HEAD equal to the PR head.
 */
export function derivePullRequestNextStep(pullRequest: PullRequest): Exclude<NextStep, "create" | "link-branch" | "blocked"> {
	const { lifecycle, conditions, local } = pullRequest;
	if (lifecycle !== "open" || conditions.draft) return "none";
	if (local.head === "behind") return "sync-local";
	// Dirty diverged work is committed by publish-work first; the committed branch then syncs.
	if (local.head === "diverged") return local.worktree === "clean" ? "sync-local" : "publish-work";
	if (local.worktree === "dirty" || local.head === "ahead") return "publish-work";
	if (conditions.mergeability === "pending") return "refresh";
	if (conditions.conflict || conditions.baseUpdateRequired) return "update-branch";
	if (conditions.ci === "failure") return "fix-ci";
	if (conditions.ci === "failure-blocked") return "none";
	if (conditions.changesRequested || conditions.unresolvedThreads > 0) return "sweep";
	// Running checks usually leave merge policy BLOCKED, so the wait decision comes before the policy gate.
	if (conditions.ci === "running") return conditions.review === "pending" ? "none" : "wait-ci";
	if (conditions.review === "pending" || conditions.policy === "pending") return "none";
	return "merge";
}

export function isPullRequestCreationEligible(branch: BranchCreationState): boolean {
	return branch.relation === "distinct-ref" && branch.worktree !== "operation" &&
		(branch.ahead > 0 || branch.worktree === "dirty");
}

export function deriveNextStep(discovery: PullRequestDiscovery<PullRequest & { target: PullRequestTarget }>): NextStep {
	if (discovery.kind === "inactive") return "none";
	if (discovery.kind === "blocked") return "blocked";
	if (discovery.kind === "none") return isPullRequestCreationEligible(discovery.branch) ? "create" : "none";
	if (discovery.pullRequest.target.provenance === "inferred") {
		return discovery.pullRequest.lifecycle === "open" ? "link-branch" : "none";
	}
	return derivePullRequestNextStep(discovery.pullRequest);
}
