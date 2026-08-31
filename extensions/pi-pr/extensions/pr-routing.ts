export type PullRequestLifecycle = "open" | "merged" | "closed";
export type CiStatus = "none" | "running" | "success" | "failure";
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

export type NextStep = "create" | "none" | "update-branch" | "sweep" | "fix-ci" | "merge";

function localMergeSafe(local: LocalMergeSafety): boolean {
	return local.worktree === "clean" && (local.head === "equal" || local.head === "behind");
}

export function deriveNextStep(pullRequest: PullRequest | null): NextStep {
	if (pullRequest === null) return "create";

	const { lifecycle, conditions } = pullRequest;
	if (lifecycle !== "open" || conditions.draft) return "none";
	if (conditions.baseUpdateRequired || conditions.conflict) return "update-branch";
	if (conditions.changesRequested || conditions.unresolvedThreads > 0) return "sweep";
	if (conditions.ci === "failure") return "fix-ci";
	if (
		conditions.ci === "running" ||
		conditions.review === "pending" ||
		conditions.policy === "pending" ||
		!localMergeSafe(pullRequest.local)
	) return "none";
	return "merge";
}
