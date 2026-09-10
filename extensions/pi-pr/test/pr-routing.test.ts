import assert from "node:assert/strict";
import test from "node:test";
import {
	deriveNextStep as deriveDiscoveryNextStep,
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

function deriveNextStep(pullRequest: PullRequest | null): NextStep {
	if (pullRequest) return derivePullRequestNextStep(pullRequest);
	return deriveDiscoveryNextStep({
		kind: "none",
		creationTarget: {
			provenance: "inferred",
			branch: "feature",
			remote: "origin",
			ref: "feature",
			repository: "acme/project",
			host: "github.com",
			fetchSource: "git@github.com:acme/project.git",
			remoteOid: null,
		},
	});
}

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
	const cases: Array<{ name: string; pullRequest: PullRequest | null; expected: NextStep }> = [
		{ name: "no PR", pullRequest: null, expected: "create" },
		{ name: "merged ignores open blockers", pullRequest: pullRequest({ lifecycle: "merged", conditions: { conflict: true, ci: "failure" } }), expected: "none" },
		{ name: "closed ignores open blockers", pullRequest: pullRequest({ lifecycle: "closed", conditions: { changesRequested: true, ci: "failure" } }), expected: "none" },
		{ name: "draft precedes every workflow", pullRequest: pullRequest({ conditions: { draft: true, baseUpdateRequired: true, changesRequested: true, ci: "failure" } }), expected: "none" },
		{ name: "base update precedes conflict, feedback, and CI", pullRequest: pullRequest({ conditions: { baseUpdateRequired: true, conflict: true, changesRequested: true, unresolvedThreads: 1, ci: "failure" } }), expected: "update-branch" },
		{ name: "conflict precedes feedback and CI", pullRequest: pullRequest({ conditions: { conflict: true, changesRequested: true, ci: "failure" } }), expected: "update-branch" },
		{ name: "changes requested routes to sweep", pullRequest: pullRequest({ conditions: { changesRequested: true } }), expected: "sweep" },
		{ name: "unresolved threads route to sweep", pullRequest: pullRequest({ conditions: { unresolvedThreads: 2 } }), expected: "sweep" },
		{ name: "diagnosable CI failure precedes feedback", pullRequest: pullRequest({ conditions: { changesRequested: true, unresolvedThreads: 2, ci: "failure" } }), expected: "fix-ci" },
		{ name: "diagnosable CI failure precedes waiting", pullRequest: pullRequest({ conditions: { ci: "failure", review: "pending", policy: "pending" } }), expected: "fix-ci" },
		{ name: "unsupported CI failure blocks the fixer and feedback", pullRequest: pullRequest({ conditions: { changesRequested: true, ci: "failure-blocked" } }), expected: "none" },
		{ name: "unsupported CI failure blocks merge", pullRequest: pullRequest({ conditions: { ci: "failure-blocked" } }), expected: "none" },
		{ name: "running CI waits", pullRequest: pullRequest({ conditions: { ci: "running" } }), expected: "none" },
		{ name: "pending review waits", pullRequest: pullRequest({ conditions: { ci: "success", review: "pending" } }), expected: "none" },
		{ name: "pending policy waits", pullRequest: pullRequest({ conditions: { policy: "pending" } }), expected: "none" },
		{ name: "successful merge-ready PR merges", pullRequest: pullRequest({ conditions: { ci: "success" } }), expected: "merge" },
	];

	for (const { name, pullRequest: candidate, expected } of cases) {
		assert.equal(deriveNextStep(candidate), expected, name);
	}
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
	assert.equal(deriveDiscoveryNextStep({
		kind: "current",
		pullRequest: { ...pullRequest(), target },
	}), "link-branch");
	assert.equal(deriveDiscoveryNextStep({
		kind: "current",
		pullRequest: { ...pullRequest({ lifecycle: "merged" }), target },
	}), "none");
	assert.equal(deriveDiscoveryNextStep({
		kind: "blocked",
		issue: { kind: "candidate-remotes-ambiguous", remotes: ["fork", "origin"] },
	}), "blocked");
	assert.equal(deriveDiscoveryNextStep({ kind: "inactive" }), "none");
});

test("ordinary conversation comments do not route", () => {
	const candidate = { ...pullRequest(), comments: [{ body: "Looks good" }] };
	assert.equal(deriveNextStep(candidate), "merge");
});

test("mutating workflows require a clean worktree with local HEAD equal to the PR head", () => {
	const routes: Array<[Partial<PullRequestConditions>, NextStep]> = [
		[{ conflict: true }, "update-branch"],
		[{ changesRequested: true }, "sweep"],
		[{ ci: "failure" }, "fix-ci"],
	];
	for (const [routeConditions, expected] of routes) {
		assert.equal(deriveNextStep(pullRequest({ conditions: routeConditions })), expected);
		for (const blocked of [
			{ worktree: "dirty", head: "equal" },
			{ worktree: "clean", head: "behind" },
			{ worktree: "clean", head: "ahead" },
			{ worktree: "clean", head: "diverged" },
		] as const) {
			assert.equal(
				deriveNextStep(pullRequest({ conditions: routeConditions, local: blocked })),
				"none",
				`${expected} ${blocked.worktree}/${blocked.head}`,
			);
		}
	}
});

test("only clean local branches equal to or behind the PR head can merge", () => {
	const cases: Array<[LocalMergeSafety, NextStep]> = [
		[{ worktree: "clean", head: "equal" }, "merge"],
		[{ worktree: "clean", head: "behind" }, "merge"],
		[{ worktree: "dirty", head: "equal" }, "none"],
		[{ worktree: "dirty", head: "behind" }, "none"],
		[{ worktree: "clean", head: "ahead" }, "none"],
		[{ worktree: "clean", head: "diverged" }, "none"],
	];

	for (const [candidateLocal, expected] of cases) {
		assert.equal(deriveNextStep(pullRequest({ local: candidateLocal })), expected, `${candidateLocal.worktree}/${candidateLocal.head}`);
	}
});
