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
	policyResult?: ReturnType<typeof result>;
	requiresStrictStatusChecks?: boolean;
	methods?: Record<string, unknown>;
	status?: string;
	fetchedHead?: string;
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

function baseBranchPolicyOutput(requiresStrictStatusChecks: boolean): string {
	return JSON.stringify({
		data: {
			repository: {
				nameWithOwner: "acme/project",
				ref: {
					name: "main",
					branchProtectionRule: { requiresStrictStatusChecks },
				},
			},
		},
	});
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
				const query = args.find((arg) => arg.startsWith("query=")) ?? "";
				if (query.includes("reviewThreads")) {
					return result(options.threads ?? reviewThreadOutput(reviewThreadPage([])));
				}
				if (query.includes("branchProtectionRule")) {
					return options.policyResult ?? result(baseBranchPolicyOutput(options.requiresStrictStatusChecks ?? false));
				}
			}
			if (command === "git" && args.join(" ") === "status --porcelain=v1 --untracked-files=all") {
				return result(options.status ?? "");
			}
			if (command === "git" && args.join(" ") === "fetch --no-tags fork refs/heads/feature/pr") return result();
			if (command === "git" && args.join(" ") === "rev-parse --verify FETCH_HEAD^{commit}") {
				return result(`${options.fetchedHead ?? REMOTE_HEAD}\n`);
			}
			if (command === "git" && args[0] === "merge-base" && args[1] === "--is-ancestor") {
				const [left, right] = args.slice(2);
				if (ancestry === "behind" && left === localHead && right === REMOTE_HEAD) return result();
				if (ancestry === "ahead" && left === REMOTE_HEAD && right === localHead) return result();
				return result("", 1);
			}
			if (command === "gh" && args.join(" ") === "repo view github.com/acme/project --json mergeCommitAllowed,rebaseMergeAllowed,squashMergeAllowed,viewerDefaultMergeMethod") {
				return result(JSON.stringify(options.methods ?? {
					mergeCommitAllowed: true,
					rebaseMergeAllowed: true,
					squashMergeAllowed: true,
					viewerDefaultMergeMethod: "SQUASH",
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
			allowedMergeMethods: ["merge", "rebase", "squash"],
			viewerDefaultMergeMethod: "squash",
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
	assert.ok(mergeSettings?.args.includes("mergeCommitAllowed,rebaseMergeAllowed,squashMergeAllowed,viewerDefaultMergeMethod"));
	const fetch = calls.find(({ command, args }) => command === "git" && args[0] === "fetch");
	assert.deepEqual(fetch?.args, ["fetch", "--no-tags", "fork", "refs/heads/feature/pr"]);
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
	assert.equal(calls.some(({ command, args }) => command === "git" && args[0] === "fetch"), false);
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

test("requires a base update for BEHIND only when the exact base policy is strict", async () => {
	const strict = harness({
		candidates: [pullRequest({ mergeStateStatus: "BEHIND" })],
		requiresStrictStatusChecks: true,
	});
	const strictPullRequest = await loadCurrentPullRequest(strict.pi, strict.context);
	assert.ok(strictPullRequest);
	assert.equal(strictPullRequest.conditions.baseUpdateRequired, true);
	assert.equal(strictPullRequest.conditions.policy, "pending");
	const policy = strict.calls.find(({ command, args }) =>
		command === "gh" && args.some((arg) => arg.includes("branchProtectionRule"))
	);
	assert.ok(policy);
	assert.ok(policy.args.includes("owner=acme"));
	assert.ok(policy.args.includes("name=project"));
	assert.ok(policy.args.includes("qualifiedName=refs/heads/main"));

	const nonStrict = harness({
		candidates: [pullRequest({ mergeStateStatus: "BEHIND" })],
		requiresStrictStatusChecks: false,
	});
	const nonStrictPullRequest = await loadCurrentPullRequest(nonStrict.pi, nonStrict.context);
	assert.ok(nonStrictPullRequest);
	assert.equal(nonStrictPullRequest.conditions.baseUpdateRequired, false);
	assert.equal(nonStrictPullRequest.conditions.policy, "ready");

	const blocked = harness({ candidates: [pullRequest({ mergeStateStatus: "BLOCKED" })] });
	const blockedPullRequest = await loadCurrentPullRequest(blocked.pi, blocked.context);
	assert.ok(blockedPullRequest);
	assert.equal(blockedPullRequest.conditions.baseUpdateRequired, false);
	assert.equal(blockedPullRequest.conditions.policy, "pending");
	assert.equal(blocked.calls.some(({ args }) => args.some((arg) => arg.includes("branchProtectionRule"))), false);
});

test("fails visibly when base branch policy authority fails or is malformed", async () => {
	const cases = [
		{
			name: "query failure",
			policyResult: result("", 1),
			error: /Read base branch policy failed: exit code 1/,
		},
		{
			name: "GraphQL denial",
			policyResult: result(JSON.stringify({ data: { repository: null }, errors: [{ type: "FORBIDDEN" }] })),
			error: /Read base branch policy failed: GitHub GraphQL returned errors/,
		},
		{
			name: "malformed authority",
			policyResult: result(JSON.stringify({ data: { repository: null } })),
			error: /Read base branch policy failed: invalid GitHub CLI output/,
		},
	];
	for (const candidate of cases) {
		const { pi, context } = harness({
			candidates: [pullRequest({ mergeStateStatus: "BEHIND" })],
			policyResult: candidate.policyResult,
		});
		await assert.rejects(loadCurrentPullRequest(pi, context), candidate.error, candidate.name);
	}
});

test("exposes all allowed merge methods and the validated viewer default", async () => {
	const { pi, context } = harness({
		methods: {
			mergeCommitAllowed: true,
			rebaseMergeAllowed: true,
			squashMergeAllowed: false,
			viewerDefaultMergeMethod: "REBASE",
		},
	});
	const loaded = await loadCurrentPullRequest(pi, context);
	assert.ok(loaded);
	assert.deepEqual(loaded.merge, {
		allowedMergeMethods: ["merge", "rebase"],
		viewerDefaultMergeMethod: "rebase",
	});

	const invalid = harness({
		methods: {
			mergeCommitAllowed: true,
			rebaseMergeAllowed: true,
			squashMergeAllowed: false,
			viewerDefaultMergeMethod: "SQUASH",
		},
	});
	await assert.rejects(
		loadCurrentPullRequest(invalid.pi, invalid.context),
		/Read merge methods failed: viewerDefaultMergeMethod is not allowed/,
	);
});

test("rejects a fetched head that moved from the advertised pull request OID", async () => {
	const movedHead = "d".repeat(40);
	const { pi, context, calls } = harness({ fetchedHead: movedHead });
	await assert.rejects(
		loadCurrentPullRequest(pi, context),
		/Fetch pull request head failed: FETCH_HEAD does not match advertised pull request head/,
	);
	assert.deepEqual(
		calls.find(({ command, args }) => command === "git" && args[0] === "fetch")?.args,
		["fetch", "--no-tags", "fork", "refs/heads/feature/pr"],
	);
	assert.equal(calls.some(({ command, args }) => command === "git" && args[0] === "merge-base"), false);
});

test("classifies behind, ahead, and diverged only after fetching the exact PR head", async () => {
	for (const ancestry of ["behind", "ahead", "diverged"] as const) {
		const { pi, context, calls } = harness({ ancestry });
		const loaded = await loadCurrentPullRequest(pi, context);
		assert.ok(loaded);
		assert.equal(loaded.local.head, ancestry);
		const fetchIndex = calls.findIndex(({ command, args }) => command === "git" && args[0] === "fetch");
		const compareIndex = calls.findIndex(({ command, args }) => command === "git" && args[0] === "merge-base");
		assert.ok(fetchIndex >= 0 && compareIndex > fetchIndex, ancestry);
	}
});
