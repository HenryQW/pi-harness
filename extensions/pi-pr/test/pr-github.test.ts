import assert from "node:assert/strict";
import test from "node:test";
import {
	loadCurrentPullRequest,
	PullRequestLoadError,
} from "../extensions/pr-github.ts";

const LOCAL_HEAD = "a".repeat(40);
const REMOTE_HEAD = "b".repeat(40);
const BASE_HEAD = "c".repeat(40);

type CommandCall = {
	command: string;
	args: string[];
	options: { cwd?: string; signal?: AbortSignal; timeout?: number } | undefined;
};

type HarnessOptions = {
	candidates?: unknown[];
	listResult?: ReturnType<typeof result>;
	localHead?: string;
	threads?: string;
	methods?: Record<string, unknown>;
	status?: string;
	ancestry?: "behind" | "ahead" | "diverged";
};

const result = (stdout = "", code = 0, stderr = "") => ({ stdout, stderr, code, killed: false });

function reviewThreadPage(nodes: unknown[], hasNextPage = false) {
	return {
		data: {
			node: {
				reviewThreads: {
					nodes,
					pageInfo: { hasNextPage, endCursor: hasNextPage ? "next" : null },
				},
			},
		},
	};
}

function reviewThreadOutput(...pages: unknown[]): string {
	return JSON.stringify(pages);
}

function pullRequest(overrides: Record<string, unknown> = {}) {
	return {
		id: "PR_kwDOExample",
		number: 42,
		url: "https://github.com/acme/project/pull/42",
		state: "OPEN",
		isDraft: false,
		baseRefName: "main",
		baseRefOid: BASE_HEAD,
		headRefName: "feature/pr",
		headRefOid: REMOTE_HEAD,
		headRepository: { nameWithOwner: "acme/fork" },
		mergeable: "MERGEABLE",
		mergeStateStatus: "CLEAN",
		reviewDecision: "APPROVED",
		statusCheckRollup: [],
		...overrides,
	};
}

function harness(options: HarnessOptions = {}) {
	const calls: CommandCall[] = [];
	const candidates = options.candidates ?? [pullRequest()];
	const localHead = options.localHead ?? LOCAL_HEAD;
	const ancestry = options.ancestry ?? "behind";
	const pi = {
		exec: async (command: string, args: string[], commandOptions?: CommandCall["options"]) => {
			calls.push({ command, args, options: commandOptions });
			if (command === "git" && args.join(" ") === "branch --show-current") return result("feature/local\n");
			if (command === "git" && args.join(" ") === "rev-parse --verify HEAD^{commit}") return result(`${localHead}\n`);
			if (command === "git" && args.join(" ") === "rev-parse --abbrev-ref --symbolic-full-name @{push}") {
				return result("fork/feature/pr\n");
			}
			if (command === "git" && args.join(" ") === "remote") return result("fork\norigin\n");
			if (command === "git" && args.join(" ") === "remote get-url --push --all fork") {
				return result("git@github.com:acme/fork.git\n");
			}
			if (command === "gh" && args.join(" ") === "repo view git@github.com:acme/fork.git --json nameWithOwner,url") {
				return result(JSON.stringify({ nameWithOwner: "acme/fork", url: "https://github.com/acme/fork" }));
			}
			if (command === "gh" && args[0] === "pr" && args[1] === "list") {
				return options.listResult ?? result(JSON.stringify(candidates));
			}
			if (command === "gh" && args[0] === "api" && args[1] === "graphql") {
				return result(options.threads ?? reviewThreadOutput(reviewThreadPage([])));
			}
			if (command === "git" && args.join(" ") === "status --porcelain=v1 --untracked-files=all") {
				return result(options.status ?? "");
			}
			if (command === "git" && args[0] === "merge-base" && args[1] === "--is-ancestor") {
				const [left, right] = args.slice(2);
				if (ancestry === "behind" && left === localHead && right === REMOTE_HEAD) return result();
				if (ancestry === "ahead" && left === REMOTE_HEAD && right === localHead) return result();
				return result("", 1);
			}
			if (command === "gh" && args.join(" ") === "repo view github.com/acme/project --json mergeCommitAllowed,rebaseMergeAllowed,squashMergeAllowed") {
				return result(JSON.stringify(options.methods ?? {
					mergeCommitAllowed: true,
					rebaseMergeAllowed: true,
					squashMergeAllowed: true,
				}));
			}
			throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
		},
	} as unknown as Parameters<typeof loadCurrentPullRequest>[0];
	const context = {
		cwd: "/repo",
		signal: new AbortController().signal,
	} as Parameters<typeof loadCurrentPullRequest>[1];
	return { pi, context, calls };
}

test("loads the unique open PR for the exact configured push target", async () => {
	const foreign = pullRequest({
		number: 41,
		url: "https://github.com/acme/project/pull/41",
		headRepository: { nameWithOwner: "other/fork" },
	});
	const matching = pullRequest({
		mergeable: "CONFLICTING",
		mergeStateStatus: "DIRTY",
		reviewDecision: "CHANGES_REQUESTED",
		statusCheckRollup: [{ conclusion: "SUCCESS", status: "COMPLETED" }, { state: "IN_PROGRESS" }],
	});
	const { pi, context, calls } = harness({
		candidates: [foreign, matching],
		threads: reviewThreadOutput(
			reviewThreadPage([{ isResolved: false }], true),
			reviewThreadPage([{ isResolved: false }]),
		),
	});

	const loaded = await loadCurrentPullRequest(pi, context);
	assert.ok(loaded);
	assert.deepEqual(loaded, {
		id: "PR_kwDOExample",
		number: 42,
		url: new URL("https://github.com/acme/project/pull/42"),
		host: "github.com",
		approved: false,
		lifecycle: "open",
		conditions: {
			draft: false,
			baseUpdateRequired: false,
			conflict: true,
			changesRequested: true,
			unresolvedThreads: 2,
			ci: "running",
			review: "pending",
			policy: "pending",
		},
		local: { worktree: "clean", head: "behind" },
		base: { repository: "acme/project", ref: "main", oid: BASE_HEAD },
		head: { repository: "acme/fork", ref: "feature/pr", oid: REMOTE_HEAD },
		merge: {
			method: "squash",
			methods: {
				mergeCommitAllowed: true,
				rebaseMergeAllowed: true,
				squashMergeAllowed: true,
			},
		},
	});

	const list = calls.find(({ command, args }) => command === "gh" && args[0] === "pr" && args[1] === "list");
	assert.deepEqual(list?.args, [
		"pr",
		"list",
		"--head",
		"feature/pr",
		"--state",
		"all",
		"--limit",
		"100",
		"--json",
		"id,number,url,state,isDraft,baseRefName,baseRefOid,headRefName,headRefOid,headRepository,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup",
	]);
	const threads = calls.find(({ command, args }) => command === "gh" && args[0] === "api" && args[1] === "graphql");
	assert.ok(threads?.args.includes("--paginate"));
	assert.ok(threads?.args.includes("--slurp"));
	assert.equal(threads?.args.includes("--jq"), false);
	assert.doesNotMatch(threads?.args.join(" ") ?? "", /comments/);
	const mergeSettings = calls.find(({ command, args }) => command === "gh" && args[0] === "repo" && args[2] === "github.com/acme/project");
	assert.ok(mergeSettings);
	for (const call of calls) {
		assert.equal(call.options?.cwd, "/repo");
		assert.equal(call.options?.timeout, 10_000);
		assert.equal(call.options?.signal, context.signal);
	}
});

test("prefers an open PR over a matching historical PR", async () => {
	const historical = pullRequest({
		number: 41,
		url: "https://github.com/acme/project/pull/41",
		state: "CLOSED",
		headRefOid: LOCAL_HEAD,
	});
	const { pi, context } = harness({ candidates: [historical, pullRequest()] });

	const loaded = await loadCurrentPullRequest(pi, context);
	assert.ok(loaded);
	assert.equal(loaded.number, 42);
	assert.equal(loaded.lifecycle, "open");
});

test("selects historical PRs only when their head matches local HEAD", async () => {
	const stale = pullRequest({
		number: 41,
		url: "https://github.com/acme/project/pull/41",
		state: "CLOSED",
		headRefOid: REMOTE_HEAD,
	});
	const merged = pullRequest({
		number: 42,
		state: "MERGED",
		headRefOid: LOCAL_HEAD,
	});
	const { pi, context, calls } = harness({
		candidates: [stale, merged],
		status: " M extension.ts\n",
	});

	const loaded = await loadCurrentPullRequest(pi, context);
	assert.ok(loaded);
	assert.equal(loaded.lifecycle, "merged");
	assert.equal(loaded.head.oid, LOCAL_HEAD);
	assert.equal(loaded.local.worktree, "dirty");
	assert.equal(loaded.local.head, "equal");
	assert.equal(loaded.conditions.unresolvedThreads, 0);
	assert.equal(loaded.merge, null);
	assert.equal(calls.some(({ command, args }) => command === "gh" && args[0] === "api"), false);
	assert.equal(calls.some(({ command, args }) => command === "gh" && args[2] === "github.com/acme/project"), false);
});

test("fails for ambiguous historical PRs matching current HEAD", async () => {
	const first = pullRequest({
		number: 41,
		url: "https://github.com/acme/project/pull/41",
		state: "CLOSED",
		headRefOid: LOCAL_HEAD,
	});
	const second = pullRequest({
		number: 43,
		url: "https://github.com/acme/project/pull/43",
		state: "MERGED",
		headRefOid: LOCAL_HEAD,
	});
	const { pi, context } = harness({ candidates: [first, second] });

	await assert.rejects(
		loadCurrentPullRequest(pi, context),
		/multiple historical pull requests match current HEAD/,
	);
});

test("returns null only when no current-branch PR matches", async () => {
	const stale = pullRequest({
		state: "CLOSED",
		headRefOid: REMOTE_HEAD,
	});
	const { pi, context, calls } = harness({ candidates: [stale] });

	assert.equal(await loadCurrentPullRequest(pi, context), null);
	assert.equal(calls.some(({ command, args }) => command === "git" && args[0] === "status"), false);
	assert.equal(calls.some(({ command, args }) => command === "gh" && args[0] === "api"), false);
});

test("fails rather than treating command errors, malformed data, or ambiguity as no PR", async () => {
	const failedLookup = harness({ listResult: result("", 1) });
	await assert.rejects(
		loadCurrentPullRequest(failedLookup.pi, failedLookup.context),
		(error: unknown) => error instanceof PullRequestLoadError && /Find pull requests failed: exit code 1/.test(error.message),
	);

	const ambiguous = harness({
		candidates: [
			pullRequest(),
			pullRequest({ number: 43, url: "https://github.com/acme/project/pull/43" }),
		],
	});
	await assert.rejects(
		loadCurrentPullRequest(ambiguous.pi, ambiguous.context),
		/multiple open pull requests match current push target/,
	);

	const malformed = harness({
		candidates: [pullRequest({ statusCheckRollup: [{ conclusion: "SUCCESS", state: "BROKEN" }] })],
	});
	await assert.rejects(
		loadCurrentPullRequest(malformed.pi, malformed.context),
		/invalid statusCheckRollup/,
	);

	const contradictory = harness({
		candidates: [pullRequest({ statusCheckRollup: [{ conclusion: "SUCCESS", status: "IN_PROGRESS" }] })],
	});
	await assert.rejects(
		loadCurrentPullRequest(contradictory.pi, contradictory.context),
		/invalid statusCheckRollup/,
	);

	const malformedThreads = harness({
		threads: reviewThreadOutput(reviewThreadPage([{ isResolved: false }, { isResolved: "false" }])),
	});
	await assert.rejects(
		loadCurrentPullRequest(malformedThreads.pi, malformedThreads.context),
		/Read unresolved review threads failed: invalid GitHub CLI output/,
	);

	const malformedPage = harness({
		threads: reviewThreadOutput({
			data: {
				node: {
					reviewThreads: {
						nodes: [],
						pageInfo: { hasNextPage: true, endCursor: null },
					},
				},
			},
		}),
	});
	await assert.rejects(
		loadCurrentPullRequest(malformedPage.pi, malformedPage.context),
		/Read unresolved review threads failed: invalid GitHub CLI output/,
	);
});

test("sets required base update only for GitHub's BEHIND status", async () => {
	const behind = harness({
		candidates: [pullRequest({ mergeStateStatus: "BEHIND" })],
		methods: { mergeCommitAllowed: true, rebaseMergeAllowed: false, squashMergeAllowed: false },
	});
	const behindPullRequest = await loadCurrentPullRequest(behind.pi, behind.context);
	assert.ok(behindPullRequest);
	assert.equal(behindPullRequest.conditions.baseUpdateRequired, true);
	assert.equal(behindPullRequest.conditions.policy, "pending");
	assert.equal(behindPullRequest.merge?.method, "merge");

	const blocked = harness({
		candidates: [pullRequest({ mergeStateStatus: "BLOCKED" })],
		methods: { mergeCommitAllowed: false, rebaseMergeAllowed: false, squashMergeAllowed: true },
	});
	const blockedPullRequest = await loadCurrentPullRequest(blocked.pi, blocked.context);
	assert.ok(blockedPullRequest);
	assert.equal(blockedPullRequest.conditions.baseUpdateRequired, false);
	assert.equal(blockedPullRequest.conditions.policy, "pending");
	assert.equal(blockedPullRequest.merge?.method, "squash");
});
