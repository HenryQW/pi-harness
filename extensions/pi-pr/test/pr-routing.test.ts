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
	policy: "ready",
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
		{ name: "base update alone does not trigger rebase", pullRequest: pullRequest({ conditions: { baseUpdateRequired: true, policy: "pending" } }), expected: "none" },
		{ name: "conflict precedes feedback and CI", pullRequest: pullRequest({ conditions: { conflict: true, changesRequested: true, ci: "failure" } }), expected: "update-branch" },
		{ name: "changes requested routes to sweep", pullRequest: pullRequest({ conditions: { changesRequested: true } }), expected: "sweep" },
		{ name: "unresolved threads route to sweep", pullRequest: pullRequest({ conditions: { unresolvedThreads: 2 } }), expected: "sweep" },
		{ name: "diagnosable CI failure precedes feedback", pullRequest: pullRequest({ conditions: { changesRequested: true, unresolvedThreads: 2, ci: "failure" } }), expected: "fix-ci" },
		{ name: "diagnosable CI failure precedes waiting", pullRequest: pullRequest({ conditions: { ci: "failure", review: "pending", policy: "pending" } }), expected: "fix-ci" },
		{ name: "unsupported CI failure blocks the fixer and feedback", pullRequest: pullRequest({ conditions: { changesRequested: true, ci: "failure-blocked" } }), expected: "none" },
		{ name: "unsupported CI failure blocks merge", pullRequest: pullRequest({ conditions: { ci: "failure-blocked" } }), expected: "none" },
		{ name: "running CI blocks merge", pullRequest: pullRequest({ conditions: { ci: "running" } }), expected: "none" },
		{ name: "pending review waits", pullRequest: pullRequest({ conditions: { ci: "success", review: "pending" } }), expected: "none" },
		{ name: "pending policy waits", pullRequest: pullRequest({ conditions: { policy: "pending" } }), expected: "none" },
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

test("mutating workflows require a clean worktree with local HEAD equal to the PR head", () => {
	const routes: Array<[Partial<PullRequestConditions>, NextStep]> = [
		[{ conflict: true }, "update-branch"],
		[{ changesRequested: true }, "sweep"],
		[{ ci: "failure" }, "fix-ci"],
	];
	for (const [routeConditions, expected] of routes) {
		assert.equal(derivePullRequestNextStep(pullRequest({ conditions: routeConditions })), expected);
		for (const blocked of [
			{ worktree: "dirty", head: "equal" },
			{ worktree: "clean", head: "behind" },
			{ worktree: "clean", head: "ahead" },
			{ worktree: "clean", head: "diverged" },
		] as const) {
			assert.equal(
				derivePullRequestNextStep(pullRequest({ conditions: routeConditions, local: blocked })),
				(blocked.worktree === "dirty" && blocked.head === "equal") || blocked.head === "ahead" ? "publish-work" : "none",
				`${expected} ${blocked.worktree}/${blocked.head}`,
			);
		}
	}
});

test("only clean local branches equal to or behind the PR head can merge", () => {
	const cases: Array<[LocalMergeSafety, NextStep]> = [
		[{ worktree: "clean", head: "equal" }, "merge"],
		[{ worktree: "clean", head: "behind" }, "merge"],
		[{ worktree: "dirty", head: "equal" }, "publish-work"],
		[{ worktree: "dirty", head: "behind" }, "none"],
		[{ worktree: "dirty", head: "diverged" }, "none"],
		[{ worktree: "clean", head: "ahead" }, "publish-work"],
		[{ worktree: "clean", head: "diverged" }, "none"],
	];

	for (const [candidateLocal, expected] of cases) {
		assert.equal(derivePullRequestNextStep(pullRequest({ local: candidateLocal })), expected, `${candidateLocal.worktree}/${candidateLocal.head}`);
	}
});
