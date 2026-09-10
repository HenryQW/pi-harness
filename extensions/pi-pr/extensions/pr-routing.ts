export type PullRequestLifecycle = "open" | "merged" | "closed";
export type CiStatus = "none" | "running" | "success" | "failure" | "failure-blocked";
export type ReviewReadiness = "ready" | "pending";
export type PolicyReadiness = "ready" | "pending";
export type LocalWorktree = "clean" | "dirty";
export type LocalHeadRelation = "equal" | "behind" | "ahead" | "diverged";

export type PullRequestConditions = {
	draft: boolean;
	baseUpdateRequired: boolean;
	conflict: boolean;
	changesRequested: boolean;
	unresolvedThreads: number;
	ci: CiStatus;
	review: ReviewReadiness;
	policy: PolicyReadiness;
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

export type NextStep = "create" | "link-branch" | "blocked" | "none" | "update-branch" | "sweep" | "fix-ci" | "merge";

function localMutationSafe(local: LocalMergeSafety): boolean {
	return local.worktree === "clean" && local.head === "equal";
}

function localMergeSafe(local: LocalMergeSafety): boolean {
	return local.worktree === "clean" && (local.head === "equal" || local.head === "behind");
}

export function derivePullRequestNextStep(pullRequest: PullRequest): Exclude<NextStep, "create" | "link-branch" | "blocked"> {
	const { lifecycle, conditions, local } = pullRequest;
	if (lifecycle !== "open" || conditions.draft) return "none";
	if (conditions.baseUpdateRequired || conditions.conflict) {
		return localMutationSafe(local) ? "update-branch" : "none";
	}
	if (conditions.ci === "failure") return localMutationSafe(local) ? "fix-ci" : "none";
	if (conditions.ci === "failure-blocked") return "none";
	if (conditions.changesRequested || conditions.unresolvedThreads > 0) {
		return localMutationSafe(local) ? "sweep" : "none";
	}
	if (
		conditions.ci === "running" ||
		conditions.review === "pending" ||
		conditions.policy === "pending" ||
		!localMergeSafe(local)
	) return "none";
	return "merge";
}

export function deriveNextStep(discovery: PullRequestDiscovery<PullRequest & { target: PullRequestTarget }>): NextStep {
	if (discovery.kind === "inactive") return "none";
	if (discovery.kind === "blocked") return "blocked";
	if (discovery.kind === "none") return discovery.branch.ahead > 0 ? "create" : "none";
	if (discovery.pullRequest.target.provenance === "inferred") {
		return discovery.pullRequest.lifecycle === "open" ? "link-branch" : "none";
	}
	return derivePullRequestNextStep(discovery.pullRequest);
}
