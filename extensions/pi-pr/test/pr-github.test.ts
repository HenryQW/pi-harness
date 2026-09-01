import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
	branchResult?: ReturnType<typeof result>;
	candidates?: Record<string, unknown>[];
	candidateUrls?: unknown[];
	listResult?: ReturnType<typeof result>;
	localHead?: string;
	pushResult?: ReturnType<typeof result>;
	pushReference?: string;
	refCheckResult?: ReturnType<typeof result>;
	remote?: string;
	remoteNames?: string[];
	pushUrl?: string;
	remoteHead?: string | null;
	remoteHeadResult?: ReturnType<typeof result>;
	threads?: string;
	policyResult?: ReturnType<typeof result>;
	requiresStrictStatusChecks?: boolean | null;
	rulesetResult?: ReturnType<typeof result>;
	methods?: Record<string, unknown>;
	status?: string;
	stateResult?: ReturnType<typeof result>;
	gitStateCwd?: string;
	fetchResult?: ReturnType<typeof result>;
	verifyResult?: ReturnType<typeof result>;
	ancestry?: "behind" | "ahead" | "diverged";
	ancestryResult?: ReturnType<typeof result>;
};

const result = (stdout = "", code = 0, stderr = "") => ({ stdout, stderr, code, killed: false });

function runGit(cwd: string, args: string[]) {
	const command = spawnSync("git", args, { cwd, encoding: "utf8" });
	return {
		stdout: command.stdout ?? "",
		stderr: command.stderr ?? "",
		code: command.status ?? 1,
		killed: command.signal !== null,
	};
}

function git(cwd: string, ...args: string[]): string {
	const command = runGit(cwd, args);
	assert.equal(command.code, 0, `${args.join(" ")} failed: ${command.stderr}`);
	return command.stdout.trim();
}

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

function baseBranchPolicyOutput(requiresStrictStatusChecks: boolean | null): string {
	return JSON.stringify({
		data: {
			repository: {
				nameWithOwner: "acme/project",
				ref: {
					name: "main",
					branchProtectionRule: requiresStrictStatusChecks === null
						? null
						: { requiresStrictStatusChecks },
				},
			},
		},
	});
}

function rulesetPolicyOutput(...pages: boolean[]): string {
	return JSON.stringify(pages.map((strict) => strict
		? [{ type: "required_status_checks", parameters: { strict_required_status_checks_policy: true } }]
		: []));
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
	const remote = options.remote ?? "fork";
	const pushUrl = options.pushUrl ?? "git@github.com:acme/fork.git";
	const pi = {
		exec: async (command: string, args: string[], commandOptions?: CommandCall["options"]) => {
			calls.push({ command, args, options: commandOptions });
			if (command === "git" && args.join(" ") === "branch --show-current") {
				return options.branchResult ?? result("feature/local\n");
			}
			if (command === "git" && args.join(" ") === "rev-parse --verify HEAD^{commit}") return result(`${localHead}\n`);
			if (command === "git" && args.join(" ") === "for-each-ref --format=%(push:short) refs/heads/feature/local") {
				return options.pushResult ?? result(`${options.pushReference ?? `${remote}/feature/pr`}\n`);
			}
			if (command === "git" && args.join(" ") === "remote") {
				return result(`${(options.remoteNames ?? [remote, "origin"]).join("\n")}\n`);
			}
			if (command === "git" && args[0] === "check-ref-format") {
				if (args[1] === "--branch") return options.refCheckResult ?? result(`${args[2]}\n`);
				if (args[1] === "refs/heads/main") return result();
			}
			if (command === "git" && args.join(" ") === `remote get-url --push --all ${remote}`) {
				return result(`${pushUrl}\n`);
			}
			if (command === "gh" && args.join(" ") === `repo view ${pushUrl} --json nameWithOwner,url`) {
				return result(JSON.stringify({ nameWithOwner: "acme/fork", url: "https://github.com/acme/fork" }));
			}
			if (command === "git" && args[0] === "ls-remote") {
				if (options.remoteHeadResult) return options.remoteHeadResult;
				const remoteHead = options.remoteHead === undefined ? REMOTE_HEAD : options.remoteHead;
				return remoteHead === null
					? result("", 2)
					: result(`${remoteHead}\trefs/heads/feature/pr\n`);
			}
			if (command === "gh" && args[0] === "api" && args[1] === "search/issues") {
				const items = options.candidateUrls ?? candidates.map((candidate) => ({ html_url: candidate.url }));
				return options.listResult ?? result(JSON.stringify({
					total_count: items.length,
					incomplete_results: false,
					items,
				}));
			}
			if (command === "gh" && args[0] === "pr" && args[1] === "view") {
				const candidate = candidates.find((value) => value.url === args[2]);
				if (candidate) return result(JSON.stringify(candidate));
			}
			if (command === "gh" && args[0] === "api" && args[1] === "graphql") {
				const query = args.find((arg) => arg.startsWith("query=")) ?? "";
				if (query.includes("reviewThreads")) {
					return result(options.threads ?? reviewThreadOutput(reviewThreadPage([])));
				}
				if (query.includes("branchProtectionRule")) {
					return options.policyResult ?? result(baseBranchPolicyOutput(options.requiresStrictStatusChecks ?? null));
				}
			}
			if (command === "gh" && args.at(-1) === "repos/acme/project/rules/branches/main") {
				return options.rulesetResult ?? result(rulesetPolicyOutput(false));
			}
			if (command === "git" && args.join(" ") === "status --porcelain=v1 --untracked-files=all") {
				return options.gitStateCwd ? runGit(options.gitStateCwd, args) : result(options.status ?? "");
			}
			if (command === "git" && args[0] === "rev-parse" && args.includes("--git-path")) {
				if (options.stateResult) return options.stateResult;
				if (options.gitStateCwd) return runGit(options.gitStateCwd, args);
				const states = args.flatMap((arg, index) => args[index - 1] === "--git-path" ? [arg] : []);
				return result(`${states.map((state) => `/repo/.git/${state}`).join("\n")}\n`);
			}
			if (command === "git" && args.join(" ") === `fetch --no-write-fetch-head --no-tags ${pushUrl} ${REMOTE_HEAD}`) {
				return options.fetchResult ?? result();
			}
			if (command === "git" && args.join(" ") === `cat-file -e ${REMOTE_HEAD}^{commit}`) {
				return options.verifyResult ?? result();
			}
			if (command === "git" && args[0] === "merge-base" && args[1] === "--is-ancestor") {
				if (options.ancestryResult) return options.ancestryResult;
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
		cwd: options.gitStateCwd ?? "/repo",
		signal: new AbortController().signal,
	} as Parameters<typeof loadCurrentPullRequest>[1];
	return { pi, context, calls };
}

test("loads an upstream PR for the exact fork push target and retains its fetch source", async () => {
	const foreign = pullRequest({
		number: 41,
		url: "https://github.com/acme/unrelated/pull/41",
		headRepository: { nameWithOwner: "acme/unrelated" },
	});
	const matching = pullRequest({
		mergeable: "CONFLICTING",
		mergeStateStatus: "DIRTY",
		reviewDecision: "CHANGES_REQUESTED",
		statusCheckRollup: [{ conclusion: "SUCCESS", status: "COMPLETED" }, { state: "IN_PROGRESS" }],
	});
	const { pi, context, calls } = harness({
		candidates: [foreign, matching],
		remote: "publish",
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
		headFetchSource: "git@github.com:acme/fork.git",
		merge: {
			allowedMergeMethods: ["merge", "rebase", "squash"],
			viewerDefaultMergeMethod: "squash",
		},
	});

	const search = calls.find(({ command, args }) => command === "gh" && args[0] === "api" && args[1] === "search/issues");
	assert.deepEqual(search?.args, [
		"api",
		"search/issues",
		"--hostname",
		"github.com",
		"-X",
		"GET",
		"-f",
		"q=is:pr head:acme:feature/pr",
		"-f",
		"per_page=100",
	]);
	assert.equal(search?.args.includes("-R"), false);
	const views = calls.filter(({ command, args }) => command === "gh" && args[0] === "pr" && args[1] === "view");
	assert.deepEqual(views.map(({ args }) => args), [
		["pr", "view", "https://github.com/acme/unrelated/pull/41", "--json", "id,number,url,state,isDraft,baseRefName,baseRefOid,headRefName,headRefOid,headRepository,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup"],
		["pr", "view", "https://github.com/acme/project/pull/42", "--json", "id,number,url,state,isDraft,baseRefName,baseRefOid,headRefName,headRefOid,headRepository,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup"],
	]);
	const threads = calls.find(({ command, args }) => command === "gh" && args[0] === "api" && args[1] === "graphql");
	assert.ok(threads?.args.includes("--paginate"));
	assert.ok(threads?.args.includes("--slurp"));
	assert.equal(threads?.args.includes("--jq"), false);
	assert.doesNotMatch(threads?.args.join(" ") ?? "", /comments/);
	const mergeSettings = calls.find(({ command, args }) => command === "gh" && args[0] === "repo" && args[2] === "github.com/acme/project");
	assert.ok(mergeSettings?.args.includes("mergeCommitAllowed,rebaseMergeAllowed,squashMergeAllowed,viewerDefaultMergeMethod"));
	const fetch = calls.find(({ command, args }) => command === "git" && args[0] === "fetch");
	assert.deepEqual(fetch?.args, [
		"fetch",
		"--no-write-fetch-head",
		"--no-tags",
		"git@github.com:acme/fork.git",
		REMOTE_HEAD,
	]);
	assert.equal(calls.some(({ args }) => args.some((arg) => arg.includes("FETCH_HEAD"))), false);
	for (const call of calls) {
		assert.equal(call.options?.cwd, "/repo");
		assert.equal(call.options?.timeout, 10_000);
		assert.equal(call.options?.signal, context.signal);
	}
});

test("accepts exactly 100 complete pull request search results", async () => {
	const candidates = Array.from({ length: 99 }, (_, index) => pullRequest({
		id: `PR_unrelated_${index + 1}`,
		number: index + 1,
		url: `https://github.com/acme/project-${index + 1}/pull/${index + 1}`,
		headRepository: { nameWithOwner: `acme/unrelated-${index + 1}` },
	}));
	candidates.push(pullRequest());
	const { pi, context, calls } = harness({ candidates });

	const loaded = await loadCurrentPullRequest(pi, context);
	assert.ok(loaded);
	assert.equal(loaded.number, 42);
	assert.equal(calls.filter(({ command, args }) => command === "gh" && args[0] === "pr" && args[1] === "view").length, 100);
});

test("rejects over-limit, incomplete, mismatched, malformed, and duplicate search results", async () => {
	const url = "https://github.com/acme/project/pull/42";
	const cases: Array<{ name: string; value: unknown; error: RegExp }> = [
		{
			name: "over limit",
			value: { total_count: 101, incomplete_results: false, items: [] },
			error: /result limit reached/,
		},
		{
			name: "incomplete",
			value: { total_count: 1, incomplete_results: true, items: [{ html_url: url }] },
			error: /incomplete search results/,
		},
		{
			name: "count mismatch",
			value: { total_count: 1, incomplete_results: false, items: [] },
			error: /incomplete search results/,
		},
		{
			name: "malformed item",
			value: { total_count: 1, incomplete_results: false, items: [{}] },
			error: /invalid url/,
		},
		{
			name: "duplicate",
			value: { total_count: 2, incomplete_results: false, items: [{ html_url: url }, { html_url: url }] },
			error: /duplicate candidate url/,
		},
	];
	for (const candidate of cases) {
		const { pi, context, calls } = harness({ listResult: result(JSON.stringify(candidate.value)) });
		await assert.rejects(loadCurrentPullRequest(pi, context), candidate.error, candidate.name);
		assert.equal(calls.some(({ command, args }) => command === "gh" && args[0] === "pr" && args[1] === "view"), false, candidate.name);
	}
});

test("returns null for an attached branch whose push target is specifically absent", async () => {
	const { pi, context, calls } = harness({ pushResult: result("\n") });

	assert.equal(await loadCurrentPullRequest(pi, context), null);
	assert.equal(calls.some(({ command }) => command === "gh"), false);
	assert.equal(calls.some(({ command, args }) => command === "git" && args[0] === "remote"), false);
});

test("keeps detached HEAD, malformed push refs, and push lookup failures distinct from no upstream", async () => {
	const detached = harness({ branchResult: result("") });
	await assert.rejects(
		loadCurrentPullRequest(detached.pi, detached.context),
		/Read current branch failed: invalid branch/,
	);
	assert.equal(detached.calls.some(({ args }) => args[0] === "for-each-ref"), false);

	const malformed = harness({ pushResult: result("fork/feature/pr\norigin/feature/pr\n") });
	await assert.rejects(
		loadCurrentPullRequest(malformed.pi, malformed.context),
		/Read push target failed: invalid push target/,
	);

	const invalidRef = harness({ pushReference: "fork/feature..pr", refCheckResult: result("", 128) });
	await assert.rejects(
		loadCurrentPullRequest(invalidRef.pi, invalidRef.context),
		/Read push target failed: exit code 128/,
	);

	const failed = harness({ pushResult: result("", 128) });
	await assert.rejects(
		loadCurrentPullRequest(failed.pi, failed.context),
		/Read push target failed: exit code 128/,
	);
});

test("ignores the same head ref in an unrelated repository", async () => {
	const unrelated = pullRequest({
		url: "https://github.com/acme/unrelated/pull/42",
		headRepository: { nameWithOwner: "acme/unrelated" },
	});
	const { pi, context, calls } = harness({ candidates: [unrelated] });

	assert.equal(await loadCurrentPullRequest(pi, context), null);
	assert.equal(calls.filter(({ command, args }) => command === "gh" && args[0] === "pr" && args[1] === "view").length, 1);
	assert.equal(calls.some(({ command, args }) => command === "git" && args[0] === "status"), false);
});

test("chooses the longest configured remote-name prefix for a push target", async () => {
	const { pi, context, calls } = harness({
		pushReference: "team/fork/feature/pr",
		remote: "team/fork",
		remoteNames: ["origin", "team", "team/fork"],
	});

	assert.ok(await loadCurrentPullRequest(pi, context));
	assert.ok(calls.some(({ command, args }) =>
		command === "git" && args.join(" ") === "remote get-url --push --all team/fork"
	));
	assert.equal(calls.some(({ command, args }) =>
		command === "git" && args.join(" ") === "remote get-url --push --all team"
	), false);
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

test("retains a just-merged PR by its exact remote push-ref OID when local HEAD is behind", async () => {
	const stale = pullRequest({
		number: 41,
		url: "https://github.com/acme/project/pull/41",
		state: "CLOSED",
		headRefOid: LOCAL_HEAD,
	});
	const merged = pullRequest({ state: "MERGED", headRefOid: REMOTE_HEAD });
	const { pi, context, calls } = harness({
		candidates: [stale, merged],
		status: " M extension.ts\n",
		ancestry: "behind",
	});

	const loaded = await loadCurrentPullRequest(pi, context);
	assert.ok(loaded);
	assert.equal(loaded.lifecycle, "merged");
	assert.equal(loaded.head.oid, REMOTE_HEAD);
	assert.equal(loaded.local.worktree, "dirty");
	assert.equal(loaded.local.head, "behind");
	assert.equal(loaded.conditions.unresolvedThreads, 0);
	assert.equal(loaded.merge, null);
	assert.equal(calls.some(({ command, args }) => command === "gh" && args[0] === "api" && args[1] === "graphql"), false);
	assert.equal(calls.some(({ command, args }) => command === "gh" && args[2] === "github.com/acme/project"), false);
	assert.ok(calls.some(({ command, args }) => command === "git" && args[0] === "fetch"));
});

test("retains a historical PR despite unpublished local commits", async () => {
	const { pi, context } = harness({
		candidates: [pullRequest({ state: "MERGED" })],
		ancestry: "ahead",
	});

	const loaded = await loadCurrentPullRequest(pi, context);
	assert.ok(loaded);
	assert.equal(loaded.lifecycle, "merged");
	assert.equal(loaded.local.head, "ahead");
});

test("fails for ambiguous historical PRs matching the remote push ref", async () => {
	const first = pullRequest({
		number: 41,
		url: "https://github.com/acme/project/pull/41",
		state: "CLOSED",
	});
	const second = pullRequest({
		number: 43,
		url: "https://github.com/acme/project/pull/43",
		state: "MERGED",
	});
	const { pi, context } = harness({ candidates: [first, second] });

	await assert.rejects(
		loadCurrentPullRequest(pi, context),
		/multiple historical pull requests match remote push ref/,
	);
});

test("does not fall back to local HEAD when the remote push ref is absent", async () => {
	const historical = pullRequest({ state: "CLOSED", headRefOid: LOCAL_HEAD });
	const { pi, context, calls } = harness({ candidates: [historical], remoteHead: null });

	assert.equal(await loadCurrentPullRequest(pi, context), null);
	assert.equal(calls.some(({ command, args }) => command === "git" && args[0] === "status"), false);
});

test("fails visibly when remote push-ref authority errors or is malformed", async () => {
	for (const candidate of [
		{ result: result("", 1), error: /Read remote push ref failed: exit code 1/ },
		{ result: result(`${REMOTE_HEAD}\trefs/heads/other\n`), error: /response does not match push ref/ },
	]) {
		const { pi, context } = harness({ remoteHeadResult: candidate.result });
		await assert.rejects(loadCurrentPullRequest(pi, context), candidate.error);
	}
});

test("returns null only when no current-branch PR matches", async () => {
	const stale = pullRequest({ state: "CLOSED", headRefOid: LOCAL_HEAD });
	const { pi, context, calls } = harness({ candidates: [stale] });

	assert.equal(await loadCurrentPullRequest(pi, context), null);
	assert.equal(calls.some(({ command, args }) => command === "git" && args[0] === "status"), false);
	assert.equal(calls.some(({ command, args }) => command === "gh" && args[0] === "api" && args[1] === "graphql"), false);
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

test("rejects partial review-thread data when any paginated GraphQL page has errors", async () => {
	const { pi, context } = harness({
		threads: reviewThreadOutput(
			reviewThreadPage([{ isResolved: false }], true),
			{
				...reviewThreadPage([{ isResolved: false }]),
				errors: [{ message: "Review threads are unavailable" }],
			},
		),
	});

	await assert.rejects(
		loadCurrentPullRequest(pi, context),
		/Read unresolved review threads failed: GitHub GraphQL returned errors/,
	);
});

test("requires a base update for strict legacy protection or an applicable strict ruleset", async () => {
	const cases = [
		{ name: "legacy only", legacy: true, rulesets: rulesetPolicyOutput(false), required: true },
		{ name: "ruleset only", legacy: null, rulesets: rulesetPolicyOutput(true), required: true },
		{ name: "later ruleset page", legacy: null, rulesets: rulesetPolicyOutput(false, true), required: true },
		{ name: "neither", legacy: null, rulesets: rulesetPolicyOutput(false), required: false },
	] as const;
	for (const candidate of cases) {
		const app = harness({
			candidates: [pullRequest({ mergeStateStatus: "BEHIND" })],
			requiresStrictStatusChecks: candidate.legacy,
			rulesetResult: result(candidate.rulesets),
		});
		const loaded = await loadCurrentPullRequest(app.pi, app.context);
		assert.ok(loaded);
		assert.equal(loaded.conditions.baseUpdateRequired, candidate.required, candidate.name);
		assert.equal(loaded.conditions.policy, candidate.required ? "pending" : "ready", candidate.name);
		const legacy = app.calls.find(({ command, args }) =>
			command === "gh" && args.some((arg) => arg.includes("branchProtectionRule"))
		);
		assert.ok(legacy, candidate.name);
		assert.ok(legacy.args.includes("owner=acme"), candidate.name);
		assert.ok(legacy.args.includes("name=project"), candidate.name);
		assert.ok(legacy.args.includes("qualifiedName=refs/heads/main"), candidate.name);
		const rulesets = app.calls.find(({ command, args }) =>
			command === "gh" && args.at(-1) === "repos/acme/project/rules/branches/main"
		);
		assert.ok(rulesets?.args.includes("--hostname"), candidate.name);
		assert.ok(rulesets?.args.includes("github.com"), candidate.name);
		assert.ok(rulesets?.args.includes("--paginate"), candidate.name);
		assert.ok(rulesets?.args.includes("--slurp"), candidate.name);
	}

	const blocked = harness({ candidates: [pullRequest({ mergeStateStatus: "BLOCKED" })] });
	const blockedPullRequest = await loadCurrentPullRequest(blocked.pi, blocked.context);
	assert.ok(blockedPullRequest);
	assert.equal(blockedPullRequest.conditions.baseUpdateRequired, false);
	assert.equal(blockedPullRequest.conditions.policy, "pending");
	assert.equal(blocked.calls.some(({ args }) => args.some((arg) => arg.includes("branchProtectionRule"))), false);
	assert.equal(blocked.calls.some(({ args }) => args.some((arg) => arg.includes("rules/branches"))), false);
});

test("fails visibly when either base policy authority fails or is malformed", async () => {
	const cases: Array<{ name: string; policyResult?: ReturnType<typeof result>; rulesetResult?: ReturnType<typeof result>; error: RegExp }> = [
		{
			name: "legacy query failure",
			policyResult: result("", 1),
			error: /Read base branch policy failed: exit code 1/,
		},
		{
			name: "legacy GraphQL denial",
			policyResult: result(JSON.stringify({ data: { repository: null }, errors: [{ type: "FORBIDDEN" }] })),
			error: /Read base branch policy failed: GitHub GraphQL returned errors/,
		},
		{
			name: "malformed legacy authority",
			policyResult: result(JSON.stringify({ data: { repository: null } })),
			error: /Read base branch policy failed: invalid GitHub CLI output/,
		},
		{
			name: "ruleset authorization failure",
			rulesetResult: result("", 1),
			error: /Read base branch rulesets failed: exit code 1/,
		},
		{
			name: "malformed ruleset page collection",
			policyResult: result(baseBranchPolicyOutput(true)),
			rulesetResult: result(JSON.stringify([[], {}])),
			error: /Read base branch rulesets failed: invalid GitHub CLI output/,
		},
		{
			name: "malformed rule on a valid page",
			policyResult: result(baseBranchPolicyOutput(true)),
			rulesetResult: result(JSON.stringify([[{ type: "required_status_checks", parameters: {} }]])),
			error: /Read base branch rulesets failed: invalid GitHub CLI output/,
		},
	];
	for (const candidate of cases) {
		const { pi, context } = harness({
			candidates: [pullRequest({ mergeStateStatus: "BEHIND" })],
			policyResult: candidate.policyResult,
			rulesetResult: candidate.rulesetResult,
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

test("classifies clean and in-progress Git operations in a linked worktree", async (t) => {
	const temporary = mkdtempSync(join(tmpdir(), "pi-pr-git-state-"));
	t.after(() => rmSync(temporary, { recursive: true, force: true }));
	const repository = join(temporary, "repository");
	const linked = join(temporary, "linked");

	git(temporary, "init", "--initial-branch=main", repository);
	git(repository, "config", "user.name", "Pi PR test");
	git(repository, "config", "user.email", "pi-pr@example.test");
	writeFileSync(join(repository, "tracked.txt"), "base\n");
	git(repository, "add", "tracked.txt");
	git(repository, "commit", "-m", "base");
	const base = git(repository, "rev-parse", "HEAD");

	git(repository, "switch", "-c", "operation-source");
	writeFileSync(join(repository, "tracked.txt"), "picked\n");
	git(repository, "commit", "-am", "pick one");
	const firstPick = git(repository, "rev-parse", "HEAD");
	writeFileSync(join(repository, "tracked.txt"), "picked again\n");
	git(repository, "commit", "-am", "pick two");
	const secondPick = git(repository, "rev-parse", "HEAD");

	git(repository, "switch", "main");
	writeFileSync(join(repository, "tracked.txt"), "target\n");
	git(repository, "commit", "-am", "target");
	git(repository, "branch", "merge-source", base);
	git(repository, "switch", "merge-source");
	git(repository, "commit", "--allow-empty", "-m", "merge source");
	const mergeSource = git(repository, "rev-parse", "HEAD");
	git(repository, "switch", "main");
	git(repository, "worktree", "add", "-b", "linked", linked, "main");

	const worktreeState = async () => {
		const { pi, context } = harness({ gitStateCwd: linked });
		const loaded = await loadCurrentPullRequest(pi, context);
		assert.ok(loaded);
		return loaded.local.worktree;
	};
	assert.equal(await worktreeState(), "clean");

	git(linked, "merge", "--no-ff", "--no-commit", mergeSource);
	assert.equal(git(linked, "status", "--porcelain=v1", "--untracked-files=all"), "");
	assert.equal(await worktreeState(), "dirty");
	git(linked, "merge", "--abort");

	assert.notEqual(runGit(linked, ["rebase", "--force-rebase", "--exec", "false", base]).code, 0);
	assert.equal(git(linked, "status", "--porcelain=v1", "--untracked-files=all"), "");
	assert.equal(await worktreeState(), "dirty");
	git(linked, "rebase", "--abort");

	assert.notEqual(runGit(linked, ["cherry-pick", firstPick, secondPick]).code, 0);
	git(linked, "checkout", "--ours", "tracked.txt");
	git(linked, "add", "tracked.txt");
	assert.equal(git(linked, "status", "--porcelain=v1", "--untracked-files=all"), "");
	assert.equal(await worktreeState(), "dirty");
	const cherryPickHead = git(linked, "rev-parse", "--git-path", "CHERRY_PICK_HEAD");
	const cherryPickState = readFileSync(cherryPickHead);
	rmSync(cherryPickHead);
	assert.equal(git(linked, "status", "--porcelain=v1", "--untracked-files=all"), "");
	assert.equal(await worktreeState(), "dirty");
	writeFileSync(cherryPickHead, cherryPickState);
	git(linked, "cherry-pick", "--abort");

	assert.notEqual(runGit(linked, ["revert", "--no-edit", secondPick, firstPick]).code, 0);
	git(linked, "checkout", "--ours", "tracked.txt");
	git(linked, "add", "tracked.txt");
	assert.equal(git(linked, "status", "--porcelain=v1", "--untracked-files=all"), "");
	assert.equal(await worktreeState(), "dirty");
	const revertHead = git(linked, "rev-parse", "--git-path", "REVERT_HEAD");
	const revertState = readFileSync(revertHead);
	rmSync(revertHead);
	assert.equal(git(linked, "status", "--porcelain=v1", "--untracked-files=all"), "");
	assert.equal(await worktreeState(), "dirty");
	writeFileSync(revertHead, revertState);
	git(linked, "revert", "--abort");

	assert.equal(await worktreeState(), "clean");
});

test("surfaces Git operation-state resolution failures", async () => {
	const failed = harness({ stateResult: result("", 128) });
	await assert.rejects(
		loadCurrentPullRequest(failed.pi, failed.context),
		/Read Git operation state failed: exit code 128/,
	);
	assert.equal(failed.calls.some(({ command, args }) => command === "git" && args[0] === "fetch"), false);

	const malformed = harness({ stateResult: result("/repo/.git/MERGE_HEAD\n") });
	await assert.rejects(
		loadCurrentPullRequest(malformed.pi, malformed.context),
		/Read Git operation state failed: invalid state paths/,
	);
});

test("rejects a remote push ref that moved from the advertised pull request OID", async () => {
	const { pi, context, calls } = harness({ remoteHead: "d".repeat(40) });
	await assert.rejects(
		loadCurrentPullRequest(pi, context),
		/Find pull requests failed: open pull request head does not match remote push ref/,
	);
	assert.equal(calls.some(({ command, args }) => command === "git" && args[0] === "fetch"), false);
});

test("surfaces isolated exact-OID fetch and verification failures without ancestry checks", async () => {
	for (const options of [
		{ fetchResult: result("", 1), error: /Fetch pull request head failed: exit code 1/ },
		{ verifyResult: result("", 1), error: /Verify pull request head failed: exit code 1/ },
	]) {
		const { pi, context, calls } = harness(options);
		await assert.rejects(loadCurrentPullRequest(pi, context), options.error);
		assert.equal(calls.some(({ command, args }) => command === "git" && args[0] === "merge-base"), false);
		assert.equal(calls.some(({ args }) => args.some((arg) => arg.includes("FETCH_HEAD"))), false);
	}
});

test("surfaces ancestry command failures after exact-OID verification", async () => {
	for (const candidate of [
		{ ancestryResult: result("", 2), error: /Compare pull request head failed: exit code 2/ },
		{ ancestryResult: { ...result("", 1), killed: true }, error: /Compare pull request head failed: command was cancelled/ },
	]) {
		const { pi, context } = harness(candidate);
		await assert.rejects(loadCurrentPullRequest(pi, context), candidate.error);
	}
});

test("fetches and verifies the exact advertised OID even when local HEAD is equal", async () => {
	const { pi, context, calls } = harness({ localHead: REMOTE_HEAD });
	const loaded = await loadCurrentPullRequest(pi, context);
	assert.ok(loaded);
	assert.equal(loaded.local.head, "equal");
	assert.ok(calls.some(({ command, args }) => command === "git" && args[0] === "fetch"));
	assert.ok(calls.some(({ command, args }) => command === "git" && args[0] === "cat-file"));
	assert.equal(calls.some(({ args }) => args.some((arg) => arg.includes("FETCH_HEAD"))), false);
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
