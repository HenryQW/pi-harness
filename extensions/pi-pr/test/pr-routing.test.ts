import assert from "node:assert/strict";
import test from "node:test";
import {
	deriveNextStep,
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
	const cases: Array<{ name: string; pullRequest: PullRequest | null; expected: NextStep }> = [
		{ name: "no PR", pullRequest: null, expected: "create" },
		{ name: "merged ignores open blockers", pullRequest: pullRequest({ lifecycle: "merged", conditions: { conflict: true, ci: "failure" } }), expected: "none" },
		{ name: "closed ignores open blockers", pullRequest: pullRequest({ lifecycle: "closed", conditions: { changesRequested: true, ci: "failure" } }), expected: "none" },
		{ name: "draft precedes every workflow", pullRequest: pullRequest({ conditions: { draft: true, baseUpdateRequired: true, changesRequested: true, ci: "failure" } }), expected: "none" },
		{ name: "base update precedes conflict, feedback, and CI", pullRequest: pullRequest({ conditions: { baseUpdateRequired: true, conflict: true, changesRequested: true, unresolvedThreads: 1, ci: "failure" } }), expected: "update-branch" },
		{ name: "conflict precedes feedback and CI", pullRequest: pullRequest({ conditions: { conflict: true, changesRequested: true, ci: "failure" } }), expected: "update-branch" },
		{ name: "changes requested routes to sweep", pullRequest: pullRequest({ conditions: { changesRequested: true } }), expected: "sweep" },
		{ name: "unresolved threads route to sweep", pullRequest: pullRequest({ conditions: { unresolvedThreads: 2 } }), expected: "sweep" },
		{ name: "feedback precedes CI failure", pullRequest: pullRequest({ conditions: { changesRequested: true, unresolvedThreads: 2, ci: "failure" } }), expected: "sweep" },
		{ name: "CI failure precedes waiting", pullRequest: pullRequest({ conditions: { ci: "failure", review: "pending", policy: "pending" } }), expected: "fix-ci" },
		{ name: "running CI waits", pullRequest: pullRequest({ conditions: { ci: "running" } }), expected: "none" },
		{ name: "pending review waits", pullRequest: pullRequest({ conditions: { ci: "success", review: "pending" } }), expected: "none" },
		{ name: "pending policy waits", pullRequest: pullRequest({ conditions: { policy: "pending" } }), expected: "none" },
		{ name: "successful merge-ready PR merges", pullRequest: pullRequest({ conditions: { ci: "success" } }), expected: "merge" },
	];

	for (const { name, pullRequest: candidate, expected } of cases) {
		assert.equal(deriveNextStep(candidate), expected, name);
	}
});

test("ordinary conversation comments do not route", () => {
	const candidate = { ...pullRequest(), comments: [{ body: "Looks good" }] };
	assert.equal(deriveNextStep(candidate), "merge");
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
