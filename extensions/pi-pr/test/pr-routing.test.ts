import assert from "node:assert/strict";
import test from "node:test";
import {
	deriveNextStep,
	derivePullRequestNextStep,
	type LocalMergeSafety,
	type NextStep,
	type PullRequest,
	type PullRequestConditions,
	type PullRequestLifecycle,
} from "../extensions/pr-routing.ts";

const conditions: PullRequestConditions = {
	draft: false,
	baseUpdateRequired: false,
	conflict: false,
	changesRequested: false,
	unresolvedThreads: 0,
	ci: "none",
	review: "ready",
	policy: "ready", mergeability: "known",
};
const local: LocalMergeSafety = { worktree: "clean", head: "equal" };

function pullRequest(overrides: {
	lifecycle?: PullRequestLifecycle;
	conditions?: Partial<PullRequestConditions>;
	local?: Partial<LocalMergeSafety>;
} = {}): PullRequest {
	return {
		lifecycle: overrides.lifecycle ?? "open",
		conditions: { ...conditions, ...overrides.conditions },
		local: { ...local, ...overrides.local },
	};
}

test("routes exactly one highest-priority next step", () => {
	const cases: Array<{ name: string; pullRequest: PullRequest; expected: NextStep }> = [
		{ name: "merged ignores open blockers", pullRequest: pullRequest({ lifecycle: "merged", conditions: { conflict: true, ci: "failure" } }), expected: "none" },
		{ name: "closed ignores open blockers", pullRequest: pullRequest({ lifecycle: "closed", conditions: { changesRequested: true, ci: "failure" } }), expected: "none" },
		{ name: "draft precedes every workflow", pullRequest: pullRequest({ conditions: { draft: true, baseUpdateRequired: true, changesRequested: true, ci: "failure" } }), expected: "none" },
		{ name: "required base update triggers the branch update", pullRequest: pullRequest({ conditions: { baseUpdateRequired: true, policy: "pending", mergeability: "known", changesRequested: true, ci: "failure" } }), expected: "update-branch" },
		{ name: "pending mergeability is re-read before any merge decision", pullRequest: pullRequest({ conditions: { mergeability: "pending", policy: "pending", changesRequested: true, ci: "failure" } }), expected: "refresh" },
		{ name: "conflict precedes feedback and CI", pullRequest: pullRequest({ conditions: { conflict: true, changesRequested: true, ci: "failure" } }), expected: "update-branch" },
		{ name: "changes requested routes to sweep", pullRequest: pullRequest({ conditions: { changesRequested: true } }), expected: "sweep" },
		{ name: "unresolved threads route to sweep", pullRequest: pullRequest({ conditions: { unresolvedThreads: 2 } }), expected: "sweep" },
		{ name: "diagnosable CI failure precedes feedback", pullRequest: pullRequest({ conditions: { changesRequested: true, unresolvedThreads: 2, ci: "failure" } }), expected: "fix-ci" },
		{ name: "diagnosable CI failure precedes waiting", pullRequest: pullRequest({ conditions: { ci: "failure", review: "pending", policy: "pending", mergeability: "known" } }), expected: "fix-ci" },
		{ name: "unsupported CI failure blocks the fixer and feedback", pullRequest: pullRequest({ conditions: { changesRequested: true, ci: "failure-blocked" } }), expected: "none" },
		{ name: "unsupported CI failure blocks merge", pullRequest: pullRequest({ conditions: { ci: "failure-blocked" } }), expected: "none" },
		{ name: "running CI waits for checks before the policy gate", pullRequest: pullRequest({ conditions: { ci: "running", policy: "pending" } }), expected: "wait-ci" },
		{ name: "running CI with review still required does not wait", pullRequest: pullRequest({ conditions: { ci: "running", review: "pending" } }), expected: "none" },
		{ name: "pending review waits", pullRequest: pullRequest({ conditions: { ci: "success", review: "pending" } }), expected: "none" },
		{ name: "pending policy waits", pullRequest: pullRequest({ conditions: { policy: "pending", mergeability: "known" } }), expected: "none" },
		{ name: "successful merge-ready PR merges", pullRequest: pullRequest({ conditions: { ci: "success" } }), expected: "merge" },
	];

	for (const { name, pullRequest: candidate, expected } of cases) {
		assert.equal(derivePullRequestNextStep(candidate), expected, name);
	}
});

test("routes creation for commits or ordinary pending work only on a distinct ref", () => {
	const creation = {
		kind: "none" as const,
		creationTarget: {
			provenance: "inferred" as const,
			branch: "feature",
			remote: "origin",
			ref: "feature",
			repository: "acme/project",
			host: "github.com",
			fetchSource: "git@github.com:acme/project.git",
			remoteOid: null,
		},
		branch: { ahead: 0, worktree: "clean" as const, relation: "distinct-ref" as const },
	};
	assert.equal(deriveNextStep(creation), "none");
	assert.equal(deriveNextStep({ ...creation, branch: { ...creation.branch, ahead: 1 } }), "create");
	assert.equal(deriveNextStep({ ...creation, branch: { ...creation.branch, worktree: "dirty" } }), "create");
	assert.equal(deriveNextStep({ ...creation, branch: { ...creation.branch, worktree: "operation" } }), "none");
	assert.equal(deriveNextStep({ ...creation, branch: { ...creation.branch, worktree: "dirty", relation: "same-ref" } }), "none");
});

test("routes discovery states without mutating ambiguous targets", () => {
	const target = {
		provenance: "inferred" as const,
		branch: "feature",
		remote: "fork",
		ref: "feature",
		repository: "acme/fork",
		host: "github.com",
		fetchSource: "git@github.com:acme/fork.git",
		remoteOid: "a".repeat(40),
	};
	assert.equal(deriveNextStep({
		kind: "current",
		pullRequest: { ...pullRequest(), target },
	}), "link-branch");
	assert.equal(deriveNextStep({
		kind: "current",
		pullRequest: { ...pullRequest({ lifecycle: "merged" }), target },
	}), "none");
	assert.equal(deriveNextStep({
		kind: "blocked",
		issue: { kind: "candidate-remotes-ambiguous", remotes: ["fork", "origin"] },
	}), "blocked");
	assert.equal(deriveNextStep({ kind: "inactive" }), "none");
});

test("local state is normalized before any remote condition is acted on", () => {
	const localRoutes: Array<[LocalMergeSafety, NextStep]> = [
		[{ worktree: "clean", head: "behind" }, "sync-local"],
		[{ worktree: "dirty", head: "behind" }, "sync-local"],
		[{ worktree: "clean", head: "diverged" }, "sync-local"],
		[{ worktree: "dirty", head: "diverged" }, "publish-work"],
		[{ worktree: "dirty", head: "equal" }, "publish-work"],
		[{ worktree: "clean", head: "ahead" }, "publish-work"],
		[{ worktree: "dirty", head: "ahead" }, "publish-work"],
	];
	const remoteConditions: Array<Partial<PullRequestConditions>> = [
		{},
		{ conflict: true },
		{ baseUpdateRequired: true, policy: "pending" },
		{ mergeability: "pending", policy: "pending" },
		{ changesRequested: true },
		{ ci: "failure" },
		{ ci: "running" },
	];
	for (const [candidateLocal, expected] of localRoutes) {
		for (const routeConditions of remoteConditions) {
			const actual = derivePullRequestNextStep(pullRequest({ conditions: routeConditions, local: candidateLocal }));
			assert.equal(actual, expected, `${candidateLocal.worktree}/${candidateLocal.head} ${JSON.stringify(routeConditions)}`);
		}
	}
	assert.equal(derivePullRequestNextStep(pullRequest({ conditions: { ci: "success" } })), "merge");
});
