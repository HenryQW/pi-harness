export type PullRequestLifecycle = "open" | "merged" | "closed";
export type CiStatus = "none" | "running" | "success" | "failure" | "failure-blocked";
export type ReviewReadiness = "ready" | "pending";
/** Codex review state; `findings` counts unresolved Codex P0/P1 threads, a subset of `unresolvedThreads`. */
export type CodexReview = { status: "running" | "complete"; findings: number };
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
	/** Present only when the `codexReview` policy is enabled. */
	codex?: CodexReview;
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
	// nonGitHubHosts is set when the remotes point only to hosts that gh has no credentials for.
	| { kind: "inactive"; nonGitHubHosts?: string[] };

export type NextStep =
	| "create" | "link-branch" | "blocked" | "none"
	| "sync-local" | "publish-work" | "refresh" | "update-branch" | "sweep" | "fix-ci" | "wait-ci" | "wait-review" | "merge";

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
	// Unresolved Codex findings are review threads, so the sweep above already precedes this gate.
	if (conditions.codex?.status === "running") return "wait-review";
	return "merge";
}

export type NamedPullRequestVerdict = {
	verdict: "ready" | "wait" | "block";
	reasons: string[];
	/** Set when `ready` depends on the current user's bypass of these rulesets. */
	bypass?: { rulesets: Array<{ id: number; name: string | null }>; reason: string };
};
export type CheckOutcome = "success" | "failure" | "running";
/** Rulesets that apply to the base branch and the check contexts they require. */
export type RulesetBypassEvidence = {
	/**
	 * Rulesets with a rule that a merge must satisfy. `currentUserCanBypass` is null when unknown;
	 * `allowedMergeMethods` is null without a merge method limit; `unverifiedRules` lists rule types pi-pr cannot check.
	 */
	rulesets: Array<{ id: number; name: string | null; currentUserCanBypass: string | null; allowedMergeMethods: string[] | null; unverifiedRules: string[] }>;
	requiredChecks: string[];
	/** True unless GitHub reports classic branch protection disabled for the base branch. */
	classicProtection: boolean;
	ref: string;
};
const BYPASS_GRANTS = new Set(["always", "pull_requests_only", "exempt"]);
const POLICY_REASONS = new Set(["required review pending", "merge policy not satisfied"]);

/**
 * Merge bar for a named pull request: any block reason blocks, then any wait reason waits.
 * `blockingThreads` counts unresolved P0/P1 threads; other unresolved threads never block.
 */
export function deriveNamedPullRequestVerdict(
	lifecycle: PullRequestLifecycle,
	conditions: PullRequestConditions,
	blockingThreads: number,
): NamedPullRequestVerdict {
	if (lifecycle !== "open") return { verdict: "block", reasons: [`pull request is ${lifecycle}`] };
	const block: string[] = [];
	const wait: string[] = [];
	if (conditions.draft) block.push("draft");
	if (conditions.conflict) block.push("merge conflict");
	if (conditions.baseUpdateRequired) block.push("base update required");
	if (conditions.ci === "failure" || conditions.ci === "failure-blocked") block.push("CI failed");
	if (conditions.changesRequested) block.push("changes requested");
	else if (conditions.review === "pending") block.push("required review pending");
	if (blockingThreads > 0) block.push(`${blockingThreads} unresolved P0/P1 threads`);
	if (conditions.mergeability === "pending") wait.push("mergeability pending");
	if (conditions.ci === "running") wait.push("CI running");
	if (conditions.codex?.status === "running") wait.push("Codex review of the current head not finished");
	// Running checks usually leave merge policy BLOCKED, so the policy gate applies only without a wait reason.
	if (conditions.policy === "pending" && !wait.length) block.push("merge policy not satisfied");
	if (block.length) return { verdict: "block", reasons: [...block, ...wait] };
	return wait.length ? { verdict: "wait", reasons: wait } : { verdict: "ready", reasons: [] };
}

/** Only a required review or a BLOCKED merge policy remains, so a ruleset bypass could make the PR ready. */
export function isRulesetBypassCandidate(verdict: NamedPullRequestVerdict, mergeStateStatus: string): boolean {
	return verdict.verdict === "block" && verdict.reasons.every((reason) => POLICY_REASONS.has(reason)) &&
		(!verdict.reasons.includes("merge policy not satisfied") || mergeStateStatus === "BLOCKED");
}

/**
 * Re-derive a bypass candidate's verdict. A bypass needs every applicable ruleset to be bypassable and to
 * allow `mergeMethod`. It also skips the rulesets' required checks, so each must pass on the exact head.
 */
export function applyRulesetBypass(
	verdict: NamedPullRequestVerdict,
	evidence: RulesetBypassEvidence,
	checks: Array<{ name: string; outcome: CheckOutcome }>,
	mergeMethod: string,
): NamedPullRequestVerdict {
	const block: string[] = [];
	const wait: string[] = [];
	if (evidence.classicProtection) block.push(`classic branch protection applies to ${evidence.ref}`);
	if (!evidence.rulesets.length) block.push("no ruleset applies to the base branch, so no bypass is available");
	for (const ruleset of evidence.rulesets) {
		if (!BYPASS_GRANTS.has(ruleset.currentUserCanBypass ?? "")) block.push(`ruleset ${ruleset.id} cannot be bypassed by the current user`);
		// A bypass skips every rule of the ruleset, so a rule that pi-pr cannot check fails closed.
		for (const type of ruleset.unverifiedRules) block.push(`ruleset ${ruleset.id} rule ${type} is not verified for a bypass merge`);
		if (ruleset.allowedMergeMethods && !ruleset.allowedMergeMethods.includes(mergeMethod)) {
			block.push(`ruleset ${ruleset.id} does not allow merge method ${mergeMethod}`);
		}
	}
	for (const context of evidence.requiredChecks) {
		const outcomes = checks.filter(({ name }) => name === context).map(({ outcome }) => outcome);
		if (outcomes.includes("failure")) block.push(`required check ${context} failed`);
		else if (!outcomes.length || outcomes.includes("running")) wait.push(`required check ${context} has not passed`);
	}
	if (block.length) return { verdict: "block", reasons: [...verdict.reasons, ...block, ...wait] };
	if (wait.length) return { verdict: "wait", reasons: wait };
	const reason = verdict.reasons.join("; ");
	return {
		verdict: "ready",
		reasons: [`merge uses ruleset bypass: ${reason}`],
		bypass: { rulesets: evidence.rulesets.map(({ id, name }) => ({ id, name })), reason },
	};
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
