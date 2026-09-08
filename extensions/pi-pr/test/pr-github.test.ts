import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	hasLocalCommit,
	linkInferredPullRequest,
	loadCurrentPullRequest as discoverCurrentPullRequest,
	PullRequestLoadError,
} from "../extensions/pr-github.ts";

async function loadCurrentPullRequest(
	...args: Parameters<typeof discoverCurrentPullRequest>
) {
	const discovery = await discoverCurrentPullRequest(...args);
	if (discovery.kind === "current") return discovery.pullRequest;
	if (discovery.kind === "none" || discovery.kind === "inactive") return null;
	throw new PullRequestLoadError(`Discovery blocked: ${discovery.issue.kind}`);
}
import { derivePullRequestNextStep } from "../extensions/pr-routing.ts";

const LOCAL_HEAD = "a".repeat(40);
const REMOTE_HEAD = "b".repeat(40);
const BASE_HEAD = "c".repeat(40);
const LIVE_BASE_HEAD = "d".repeat(40);

type CommandCall = {
	command: string;
	args: string[];
	options: { cwd?: string; signal?: AbortSignal; timeout?: number } | undefined;
};

type HarnessOptions = {
	branch?: string;
	branchResult?: ReturnType<typeof result>;
	candidates?: Record<string, unknown>[];
	searchCandidates?: Record<string, unknown>[];
	listResult?: ReturnType<typeof result>;
	listResults?: ReturnType<typeof result>[];
	pullRequestResult?: ReturnType<typeof result>;
	localHead?: string;
	localHeadAfterRulesetRead?: string;
	pushResult?: ReturnType<typeof result>;
	pushReference?: string;
	refCheckResult?: ReturnType<typeof result>;
	remote?: string;
	remoteNames?: string[];
	pushUrl?: string;
	pushUrls?: Record<string, string>;
	fetchUrl?: string;
	fetchUrls?: Record<string, string>;
	fetchUrlResult?: ReturnType<typeof result>;
	pushRepositoryResult?: ReturnType<typeof result>;
	remoteHead?: string | null;
	remoteHeads?: Record<string, string | null>;
	configValues?: Record<string, string[]>;
	remoteHeadResult?: ReturnType<typeof result>;
	threads?: string;
	baseRefResult?: ReturnType<typeof result>;
	policyResult?: ReturnType<typeof result>;
	baseRefTargetOid?: string;
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

function baseRefOutput(targetOid = BASE_HEAD): string {
	return JSON.stringify({
		data: {
			repository: {
				nameWithOwner: "acme/project",
				ref: { name: "main", target: { oid: targetOid } },
			},
		},
	});
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

function rulesetOutput(...pages: unknown[][]): string {
	return JSON.stringify(pages);
}

function rulesetPolicyOutput(...pages: boolean[]): string {
	return rulesetOutput(...pages.map((strict) => strict
		? [{ type: "required_status_checks", parameters: { strict_required_status_checks_policy: true } }]
		: []));
}

function searchIdentity(candidate: Record<string, unknown>): Record<string, unknown> {
	const url = new URL(String(candidate.url));
	const baseRepository = url.pathname.split("/").filter(Boolean).slice(0, 2).join("/");
	return {
		__typename: "PullRequest",
		number: candidate.number,
		url: candidate.url,
		state: candidate.state,
		baseRepository: { nameWithOwner: baseRepository },
		headRepository: candidate.headRepository,
		headRefName: candidate.headRefName,
		headRefOid: candidate.headRefOid,
	};
}

function searchPage(
	totalCount: number,
	nodes: unknown[],
	offset = 0,
	hasNextPage = false,
	repository = "acme/fork",
	ref = "feature/pr",
): unknown {
	const edges = nodes.map((node, index) => ({ cursor: `cursor-${offset + index + 1}`, node }));
	return {
		data: {
			repository: {
				nameWithOwner: repository,
				ref: {
					name: ref,
					associatedPullRequests: {
						totalCount,
						edges,
						pageInfo: {
							hasNextPage,
							startCursor: edges[0]?.cursor ?? null,
							endCursor: edges.at(-1)?.cursor ?? null,
						},
					},
				},
			},
		},
	};
}

function searchOutput(page: unknown): string {
	return JSON.stringify(page);
}

function candidateSearchOutput(
	candidates: Record<string, unknown>[],
	offset: number,
	repository: string,
	ref: string,
): string {
	const identities = candidates.map(searchIdentity);
	return searchOutput(searchPage(
		identities.length,
		identities.slice(offset, offset + 100),
		offset,
		offset + 100 < identities.length,
		repository,
		ref,
	));
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

function observation(overrides: Record<string, unknown> = {}) {
	return {
		pullRequest: {
			url: "https://github.com/acme/project/pull/42",
			number: 42,
			host: "github.com",
		},
		head: { repository: "acme/fork", ref: "feature/pr", oid: REMOTE_HEAD },
		target: { repository: "acme/fork", branch: "feature/local", remote: "fork", ref: "feature/pr" },
		...overrides,
	};
}

function harness(options: HarnessOptions = {}) {
	const calls: CommandCall[] = [];
	const candidates = options.candidates ?? [pullRequest()];
	const branch = options.branch ?? "feature/local";
	let localHead = options.localHead ?? LOCAL_HEAD;
	let searchPageIndex = 0;
	const ancestry = options.ancestry ?? "behind";
	const remote = options.remote ?? "fork";
	const pushUrl = options.pushUrl ?? "git@github.com:acme/fork.git";
	const pi = {
		exec: async (command: string, args: string[], commandOptions?: CommandCall["options"]) => {
			calls.push({ command, args, options: commandOptions });
			if (command === "git" && args.join(" ") === "rev-parse --is-inside-work-tree") return result("true\n");
			if (command === "git" && args.join(" ") === "branch --show-current") {
				return options.branchResult ?? result(`${branch}\n`);
			}
			if (command === "git" && args.join(" ") === "rev-parse --verify HEAD^{commit}") return result(`${localHead}\n`);
			if (command === "git" && args.join(" ") === `for-each-ref --format=%(push:short) refs/heads/${branch}`) {
				return options.pushResult ?? result(`${options.pushReference ?? `${remote}/feature/pr`}\n`);
			}
			if (command === "git" && args.join(" ") === "remote") {
				return result(`${(options.remoteNames ?? [remote, "origin"]).join("\n")}\n`);
			}
			if (command === "git" && args[0] === "check-ref-format") {
				if (args[1] === "--branch" && args[2] === "feature/local") return result("feature/local\n");
				if (args[1] === "--branch") return options.refCheckResult ?? result(`${args[2]}\n`);
				if (args[1] === "refs/heads/main") return result();
			}
			if (command === "git" && args[0] === "remote" && args[1] === "get-url") {
				const requestedRemote = args.at(-1) ?? "";
				if (!args.includes("--push") && options.fetchUrlResult) return options.fetchUrlResult;
				const defaultUrl = options.pushUrls?.[requestedRemote] ??
					(requestedRemote === remote ? pushUrl : `git@github.com:acme/${requestedRemote}.git`);
				const requestedUrl = args.includes("--push")
					? defaultUrl
					: options.fetchUrls?.[requestedRemote] ?? (requestedRemote === remote ? options.fetchUrl : undefined) ?? defaultUrl;
				return result(`${requestedUrl}\n`);
			}
			if (command === "gh" && args[0] === "repo" && args[1] === "view" && args[4] === "nameWithOwner,url") {
				if (options.pushRepositoryResult) return options.pushRepositoryResult;
				const [host, owner, name, ...rest] = (args[2] ?? "").split("/");
				if (!host || !owner || !name || rest.length) throw new Error(`Unexpected repository locator: ${args[2]}`);
				return result(JSON.stringify({ nameWithOwner: `${owner}/${name}`, url: `https://${host}/${owner}/${name}` }));
			}
			if (command === "git" && args[0] === "ls-remote") {
				if (options.remoteHeadResult) return options.remoteHeadResult;
				const fetchSource = args.at(-2) ?? "";
				const remoteHead = options.remoteHeads && fetchSource in options.remoteHeads
					? options.remoteHeads[fetchSource]
					: options.remoteHead === undefined ? REMOTE_HEAD : options.remoteHead;
				const requestedRef = args.at(-1) ?? "";
				return remoteHead === null
					? result("", 2)
					: result(`${remoteHead}\t${requestedRef}\n`);
			}
			if (command === "git" && args[0] === "config") {
				const key = args.at(-1) ?? "";
				const values = options.configValues?.[key] ?? [];
				if (values.length === 0) return result("", 1);
				if (args.includes("--type=bool")) {
					const normalized = values.map((value) => {
						if (["true", "yes", "on", "1"].includes(value.toLowerCase())) return "true";
						if (["false", "no", "off", "0"].includes(value.toLowerCase())) return "false";
						return null;
					});
					return normalized.includes(null) ? result("", 128) : result(`${normalized.join("\n")}\n`);
				}
				return result(`${values.join("\n")}\n`);
			}
			if (command === "gh" && args[0] === "pr" && args[1] === "view") {
				if (options.pullRequestResult) return options.pullRequestResult;
				const candidate = candidates.find((value) => value.url === args[2]);
				if (candidate) return result(JSON.stringify(candidate));
			}
			if (command === "gh" && args[0] === "api" && args[1] === "graphql") {
				const query = args.find((arg) => arg.startsWith("query=")) ?? "";
				if (query.includes("associatedPullRequests(")) {
					if (options.listResults) return options.listResults[searchPageIndex++] ?? result("", 1);
					if (options.listResult) return options.listResult;
					const endCursor = args.find((arg) => arg.startsWith("endCursor="))?.slice("endCursor=".length);
					const offset = endCursor ? Number(endCursor.replace("cursor-", "")) : 0;
					const owner = args.find((arg) => arg.startsWith("owner="))?.slice("owner=".length) ?? "";
					const name = args.find((arg) => arg.startsWith("name="))?.slice("name=".length) ?? "";
					if (options.remoteHead === null) {
						return result(JSON.stringify({ data: { repository: { nameWithOwner: `${owner}/${name}`, ref: null } } }));
					}
					const ref = args.find((arg) => arg.startsWith("qualifiedName=refs/heads/"))?.slice("qualifiedName=refs/heads/".length) ?? "";
					return result(candidateSearchOutput(options.searchCandidates ?? candidates, offset, `${owner}/${name}`, ref));
				}
				if (query.includes("reviewThreads")) {
					return result(options.threads ?? reviewThreadOutput(reviewThreadPage([])));
				}
				if (query.includes("target{oid}")) {
					return options.baseRefResult ?? result(baseRefOutput(options.baseRefTargetOid));
				}
				if (query.includes("branchProtectionRule")) {
					return options.policyResult ?? result(baseBranchPolicyOutput(options.requiresStrictStatusChecks ?? null));
				}
			}
			if (command === "gh" && args.at(-1) === "repos/acme/project/rules/branches/main") {
				if (options.localHeadAfterRulesetRead) localHead = options.localHeadAfterRulesetRead;
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
			if (command === "git" && args.join(" ") === `fetch --no-write-fetch-head --no-tags --no-recurse-submodules ${pushUrl} ${REMOTE_HEAD}`) {
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

async function linkHarness(failures: {
	failFinalLookup?: boolean;
	failPostFetchRead?: boolean;
	concurrentTrackingOid?: string;
	concurrentConfigValue?: string;
	closeBeforeFinalVerification?: boolean;
	initialTrackingOid?: string;
	moveRemoteBeforeFetchTo?: string;
} = {}) {
	const candidate = pullRequest({ headRefName: "feature/local" });
	const app = harness({
		pushResult: result("\n"),
		remoteNames: ["fork"],
		candidates: [candidate],
	});
	const initial = await discoverCurrentPullRequest(app.pi, app.context);
	assert.equal(initial.kind, "current");
	if (initial.kind !== "current") throw new Error("Expected inferred pull request");
	assert.equal(initial.pullRequest.target.provenance, "inferred");
	app.calls.length = 0;

	const originalExec = app.pi.exec.bind(app.pi);
	const trackingRef = "refs/remotes/fork/feature/local";
	const config = new Map<string, string[]>();
	let trackingOid: string | null = failures.initialTrackingOid ?? null;
	let trackingReads = 0;
	let movedRemoteHead: string | null = null;
	let linked = false;
	let rollbackStarted = false;
	let concurrentConfigInjected = false;
	app.pi.exec = async (command: string, args: string[], commandOptions?: CommandCall["options"]) => {
		const record = () => app.calls.push({ command, args, options: commandOptions });
		if (command === "git" && args.join(" ") === "for-each-ref --format=%(push:short) refs/heads/feature/local") {
			record();
			return result(linked ? "fork/feature/local\n" : "\n");
		}
		if (command === "git" && args[0] === "config") {
			record();
			if (args[1] === "--get-all" || args[1] === "--type=bool") {
				const key = args.at(-1) ?? "";
				const values = config.get(key) ?? [];
				if (
					rollbackStarted && failures.concurrentConfigValue && !concurrentConfigInjected &&
					key === "branch.feature/local.remote"
				) {
					config.set(key, [failures.concurrentConfigValue]);
					concurrentConfigInjected = true;
				}
				return values.length === 0 ? result("", 1) : result(`${values.join("\n")}\n`);
			}
			if (args[1] === "--get") return result("", 1);
			if (args[1] === "--fixed-value" && args[2] === "--unset-all") {
				const key = args[3] ?? "";
				const expected = args[4] ?? "";
				const values = config.get(key) ?? [];
				const remaining = values.filter((value) => value !== expected);
				if (remaining.length === values.length) return result("", 5);
				if (remaining.length === 0) config.delete(key);
				else config.set(key, remaining);
				return result();
			}
			if (args[1] === "--add") {
				const key = args[2] ?? "";
				config.set(key, [...(config.get(key) ?? []), args[3] ?? ""]);
				return result();
			}
		}
		if (command === "git" && args.join(" ") === `rev-parse --verify --quiet ${trackingRef}^{commit}`) {
			record();
			trackingReads += 1;
			if (failures.failPostFetchRead && trackingReads === 2) return result("", 128);
			if (failures.concurrentTrackingOid && trackingReads === 2) trackingOid = failures.concurrentTrackingOid;
			return trackingOid === null ? result("", 1) : result(`${trackingOid}\n`);
		}
		if (command === "git" && args[0] === "fetch" && args.at(-1)?.endsWith(`:${trackingRef}`)) {
			record();
			assert.equal(args.at(-1), `${REMOTE_HEAD}:${trackingRef}`);
			movedRemoteHead = failures.moveRemoteBeforeFetchTo ?? null;
			trackingOid = REMOTE_HEAD;
			return result();
		}
		if (movedRemoteHead && command === "git" && args[0] === "ls-remote") {
			record();
			return result(`${movedRemoteHead}\t${args.at(-1)}\n`);
		}
		if (command === "git" && args.join(" ") === "branch --set-upstream-to=fork/feature/local -- feature/local") {
			record();
			config.set("branch.feature/local.remote", ["fork"]);
			config.set("branch.feature/local.merge", ["refs/heads/feature/local"]);
			linked = true;
			return result();
		}
		if (command === "git" && args[0] === "update-ref") {
			record();
			if (args[3] !== trackingOid) return result("", 128);
			trackingOid = args[1] === "-d" ? null : args[2] ?? null;
			return result();
		}
		if (
			failures.failFinalLookup && linked && command === "gh" && args[0] === "api" && args[1] === "graphql" &&
			args.some((arg) => arg.includes("associatedPullRequests("))
		) {
			record();
			rollbackStarted = true;
			return result("", 1);
		}
		if (failures.closeBeforeFinalVerification && linked && command === "gh" && args[0] === "pr" && args[1] === "view") {
			record();
			return result(JSON.stringify({ ...candidate, state: "CLOSED" }));
		}
		return originalExec(command, args, commandOptions);
	};
	return { ...app, inferred: initial.pullRequest, config, getTrackingOid: () => trackingOid };
}

test("detects commits added after local branch creation", async (t) => {
	const repository = mkdtempSync(join(tmpdir(), "pi-pr-local-commit-"));
	t.after(() => rmSync(repository, { recursive: true, force: true }));
	git(repository, "init", "-b", "main");
	git(repository, "config", "user.name", "Pi PR Test");
	git(repository, "config", "user.email", "pi-pr@example.com");
	writeFileSync(join(repository, "tracked.txt"), "base\n");
	git(repository, "add", "tracked.txt");
	git(repository, "commit", "-m", "base");
	git(repository, "switch", "-c", "feature");

	const pi = {
		exec: async (command: string, args: string[]) => {
			assert.equal(command, "git");
			return runGit(repository, args);
		},
	} as unknown as Parameters<typeof hasLocalCommit>[0];
	const context = {
		cwd: repository,
		signal: new AbortController().signal,
	} as Parameters<typeof hasLocalCommit>[1];

	assert.equal(await hasLocalCommit(pi, context), false);
	writeFileSync(join(repository, "tracked.txt"), "changed\n");
	git(repository, "commit", "-am", "change");
	assert.equal(await hasLocalCommit(pi, context), true);
});

test("discovers an upstream PR from repository-scoped ref associations", async () => {
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
		target: {
			provenance: "configured",
			branch: "feature/local",
			remote: "publish",
			ref: "feature/pr",
			repository: "acme/fork",
			host: "github.com",
			fetchSource: "git@github.com:acme/fork.git",
			remoteOid: REMOTE_HEAD,
		},
		merge: {
			allowedMergeMethods: ["merge", "rebase", "squash"],
			viewerDefaultMergeMethod: "squash",
		},
	});

	const search = calls.find(({ command, args }) =>
		command === "gh" && args[0] === "api" && args[1] === "graphql" && args.some((arg) => arg.includes("associatedPullRequests("))
	);
	assert.ok(search?.args.includes("--hostname"));
	assert.ok(search?.args.includes("github.com"));
	assert.equal(search?.args.includes("--paginate"), false);
	assert.equal(search?.args.includes("--slurp"), false);
	assert.ok(search?.args.includes("owner=acme"));
	assert.ok(search?.args.includes("name=fork"));
	assert.ok(search?.args.includes("qualifiedName=refs/heads/feature/pr"));
	for (const field of [
		"associatedPullRequests",
		"totalCount",
		"__typename",
		"number url state",
		"baseRepository{nameWithOwner}",
		"headRepository{nameWithOwner}",
		"headRefName headRefOid",
		"pageInfo{hasNextPage startCursor endCursor}",
	]) assert.match(search?.args.join(" ") ?? "", new RegExp(field.replace(/[{}]/g, "\\$&")));
	assert.doesNotMatch(search?.args.join(" ") ?? "", /search\(query:|searchQuery=|head:acme:/);
	assert.equal(search?.args.includes("-R"), false);
	const views = calls.filter(({ command, args }) => command === "gh" && args[0] === "pr" && args[1] === "view");
	assert.deepEqual(views.map(({ args }) => args), [
		["pr", "view", "https://github.com/acme/project/pull/42", "--json", "id,number,url,state,isDraft,baseRefName,baseRefOid,headRefName,headRefOid,headRepository,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup"],
	]);
	const threads = calls.find(({ command, args }) =>
		command === "gh" && args[0] === "api" && args[1] === "graphql" && args.some((arg) => arg.includes("reviewThreads"))
	);
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
		"--no-recurse-submodules",
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

test("resolves the current base ref target instead of the pull request base snapshot", async () => {
	const app = harness({
		candidates: [pullRequest({
			baseRefOid: BASE_HEAD,
			mergeable: "CONFLICTING",
			mergeStateStatus: "DIRTY",
		})],
		baseRefTargetOid: LIVE_BASE_HEAD,
	});

	const loaded = await loadCurrentPullRequest(app.pi, app.context);
	assert.ok(loaded);
	assert.equal(loaded.base.oid, LIVE_BASE_HEAD);
	const baseRefQuery = app.calls.find(({ command, args }) =>
		command === "gh" && args.some((arg) => arg.includes("target{oid}"))
	);
	assert.ok(baseRefQuery?.args.includes("qualifiedName=refs/heads/main"));
});

test("uses inspected local safety without reopening the fetch window", async () => {
	const { pi, context, calls } = harness();
	const loaded = await loadCurrentPullRequest(pi, context, { worktree: "clean", head: "equal" });

	assert.ok(loaded);
	assert.deepEqual(loaded.local, { worktree: "clean", head: "equal" });
	assert.equal(calls.some(({ command, args }) => command === "git" && ["status", "fetch", "cat-file", "merge-base"].includes(args[0] ?? "")), false);
});

test("routes from the local HEAD sampled after remote policy reads", async () => {
	const { pi, context, calls } = harness({
		localHead: REMOTE_HEAD,
		localHeadAfterRulesetRead: LOCAL_HEAD,
		ancestry: "ahead",
	});

	const loaded = await loadCurrentPullRequest(pi, context);
	assert.ok(loaded);
	assert.equal(loaded.local.head, "ahead");
	assert.equal(derivePullRequestNextStep(loaded), "none");
	const policyRead = calls.findIndex(({ command, args }) => command === "gh" && args.at(-1) === "repos/acme/project/rules/branches/main");
	const headRead = calls.findIndex(({ command, args }) => command === "git" && args.join(" ") === "rev-parse --verify HEAD^{commit}");
	assert.ok(policyRead >= 0 && headRead > policyRead);
});

test("batches complete ref-associated pull requests beyond 100 and loads only the exact candidate", async () => {
	const candidates = Array.from({ length: 100 }, (_, index) => pullRequest({
		id: `PR_unrelated_${index + 1}`,
		number: index + 1,
		url: `https://github.com/acme/project-${index + 1}/pull/${index + 1}`,
		headRepository: { nameWithOwner: `acme/unrelated-${index + 1}` },
	}));
	candidates.push(pullRequest());
	const identities = candidates.map(searchIdentity);
	const { pi, context, calls } = harness({
		candidates,
		listResults: [
			result(searchOutput(searchPage(101, identities.slice(0, 100), 0, true))),
			result(searchOutput(searchPage(101, identities.slice(100), 100))),
		],
	});

	const loaded = await loadCurrentPullRequest(pi, context);
	assert.ok(loaded);
	assert.equal(loaded.number, 42);
	const searches = calls.filter(({ command, args }) =>
		command === "gh" && args[0] === "api" && args[1] === "graphql" && args.some((arg) => arg.includes("associatedPullRequests("))
	);
	assert.equal(searches.length, 2);
	assert.equal(searches.some(({ args }) => args.includes("--paginate") || args.includes("--slurp")), false);
	assert.ok(searches[1]?.args.includes("endCursor=cursor-100"));
	assert.equal(calls.filter(({ command, args }) => command === "gh" && args[0] === "pr" && args[1] === "view").length, 1);
});

test("rejects incomplete, capped, inconsistent, malformed, and duplicate discovery pages", async () => {
	const identity = searchIdentity(pullRequest());
	const repeated = Array.from({ length: 100 }, (_, index) => searchIdentity(pullRequest({
		number: index + 1,
		url: `https://github.com/acme/project-${index + 1}/pull/${index + 1}`,
		headRepository: { nameWithOwner: `acme/unrelated-${index + 1}` },
	})));
	const duplicateCursor = searchPage(2, [identity, searchIdentity(pullRequest({
		number: 43,
		url: "https://github.com/acme/project/pull/43",
	}))]) as { data: { repository: { ref: { associatedPullRequests: { edges: Array<{ cursor: string }> } } } } };
	const duplicateEdges = duplicateCursor.data.repository.ref.associatedPullRequests.edges;
	duplicateEdges[1]!.cursor = duplicateEdges[0]!.cursor;
	const cases: Array<{ name: string; values: unknown[]; error: RegExp }> = [
		{
			name: "GitHub cap",
			values: [searchPage(1001, repeated, 0, true)],
			error: /GitHub pull request result cap reached/,
		},
		{
			name: "count mismatch",
			values: [searchPage(1, [])],
			error: /incomplete search results/,
		},
		{
			name: "page total mismatch",
			values: [searchPage(101, repeated, 0, true), searchPage(102, [identity], 100)],
			error: /inconsistent search result pages/,
		},
		{
			name: "malformed page",
			values: [searchPage(101, repeated, 0, true), null],
			error: /invalid GitHub CLI output/,
		},
		{
			name: "malformed node",
			values: [searchPage(1, [{}])],
			error: /invalid GitHub CLI output/,
		},
		{
			name: "GraphQL errors",
			values: [{ ...(searchPage(1, [identity]) as object), errors: [{ type: "FORBIDDEN" }] }],
			error: /GitHub GraphQL returned errors/,
		},
		{
			name: "cursor does not progress",
			values: [duplicateCursor],
			error: /duplicate candidate cursor/,
		},
		{
			name: "pagination is truncated",
			values: [searchPage(101, repeated, 0, false)],
			error: /incomplete search results/,
		},
		{
			name: "duplicate URL",
			values: [searchPage(2, [identity, identity])],
			error: /duplicate candidate url/,
		},
	];
	for (const candidate of cases) {
		const { pi, context, calls } = harness({
			listResults: candidate.values.map((value) => result(JSON.stringify(value))),
		});
		await assert.rejects(loadCurrentPullRequest(pi, context), candidate.error, candidate.name);
		assert.equal(calls.some(({ command, args }) => command === "gh" && args[0] === "pr" && args[1] === "view"), false, candidate.name);
	}
});

test("stays inactive only after a C-locale safe-directory probe confirms no repository", async () => {
	const { pi, context, calls } = harness();
	pi.exec = async (command: string, args: string[], commandOptions?: CommandCall["options"]) => {
		calls.push({ command, args, options: commandOptions });
		if (command === "git" && args.join(" ") === "rev-parse --is-inside-work-tree") {
			return result("", 128, "fatal: kein Git-Repository");
		}
		if (command === "env") {
			assert.deepEqual(args, [
				"LC_ALL=C",
				"LANG=C",
				"GIT_DISCOVERY_ACROSS_FILESYSTEM=1",
				"git",
				"-c",
				"safe.directory=*",
				"rev-parse",
				"--is-inside-work-tree",
			]);
			return result("", 128, "fatal: not a git repository (or any of the parent directories): .git\n");
		}
		throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
	};

	assert.deepEqual(await discoverCurrentPullRequest(pi, context), { kind: "inactive" });
	assert.equal(calls.some(({ args }) => args[0] === "branch"), false);
});

test("surfaces repository errors and a later read recovers after the error is fixed", async () => {
	for (const repositoryError of [
		{
			name: "unsafe repository",
			stderr: "fatal: detected dubious ownership in repository at '/repo'\n",
			probe: result("true\n"),
		},
		{
			name: "malformed repository",
			stderr: "fatal: invalid gitfile format: /repo/.git\n",
			probe: result("", 128, "fatal: invalid gitfile format: /repo/.git\n"),
		},
	]) {
		const app = harness();
		const originalExec = app.pi.exec.bind(app.pi);
		let fixed = false;
		app.pi.exec = async (command: string, args: string[], commandOptions?: CommandCall["options"]) => {
			if (!fixed && command === "git" && args.join(" ") === "rev-parse --is-inside-work-tree") {
				app.calls.push({ command, args, options: commandOptions });
				return result("", 128, repositoryError.stderr);
			}
			if (!fixed && command === "env") {
				app.calls.push({ command, args, options: commandOptions });
				return repositoryError.probe;
			}
			return originalExec(command, args, commandOptions);
		};

		await assert.rejects(
			discoverCurrentPullRequest(app.pi, app.context),
			/Check Git worktree failed: exit code 128/,
			repositoryError.name,
		);
		fixed = true;
		const recovered = await discoverCurrentPullRequest(app.pi, app.context);
		assert.equal(recovered.kind, "current", repositoryError.name);
	}
});

test("infers one exact open pull request from a published same-name branch", async () => {
	const inferred = pullRequest({ headRefName: "feature/local" });
	const { pi, context, calls } = harness({
		pushResult: result("\n"),
		remoteNames: ["fork"],
		candidates: [inferred],
	});

	const discovery = await discoverCurrentPullRequest(pi, context);
	assert.equal(discovery.kind, "current");
	if (discovery.kind !== "current") return;
	assert.equal(discovery.pullRequest.target.provenance, "inferred");
	assert.equal(discovery.pullRequest.target.remote, "fork");
	assert.equal(discovery.pullRequest.target.ref, "feature/local");
	const search = calls.find(({ command, args }) =>
		command === "gh" && args[0] === "api" && args[1] === "graphql" && args.some((arg) => arg.includes("associatedPullRequests("))
	);
	assert.ok(search?.args.includes("owner=acme"));
	assert.ok(search?.args.includes("name=fork"));
	assert.ok(search?.args.includes("qualifiedName=refs/heads/feature/local"));
});

test("does not globally search a common branch with no pull request", async () => {
	const app = harness({
		branch: "main",
		remote: "origin",
		remoteNames: ["origin"],
		pushReference: "origin/main",
		pushUrl: "git@github.com:HenryQW/pi-harness.git",
		candidates: [],
		pushRepositoryResult: result(JSON.stringify({
			nameWithOwner: "HenryQW/pi-harness",
			url: "https://github.com/HenryQW/pi-harness",
		})),
	});

	assert.equal((await discoverCurrentPullRequest(app.pi, app.context)).kind, "none");
	const search = app.calls.find(({ command, args }) =>
		command === "gh" && args[0] === "api" && args[1] === "graphql" && args.some((arg) => arg.includes("associatedPullRequests("))
	);
	assert.ok(search?.args.includes("qualifiedName=refs/heads/main"));
	assert.doesNotMatch(search?.args.join(" ") ?? "", /search\(query:|searchQuery=|head:/);
});

test("rejects true, malformed, and repeated remote mirror settings but allows normalized false", async () => {
	const inferred = pullRequest({ headRefName: "feature/local" });
	for (const candidate of [
		{ name: "true spelling", values: ["yes"] },
		{ name: "malformed", values: ["sometimes"] },
		{ name: "multiple", values: ["false", "false"] },
	]) {
		const blocked = harness({
			pushResult: result("\n"),
			remoteNames: ["fork"],
			candidates: [inferred],
			configValues: { "remote.fork.mirror": candidate.values },
		});
		assert.deepEqual(await discoverCurrentPullRequest(blocked.pi, blocked.context), {
			kind: "blocked",
			issue: { kind: "link-configuration", remote: "fork" },
		}, candidate.name);
	}

	const allowed = harness({
		pushResult: result("\n"),
		remoteNames: ["fork"],
		candidates: [inferred],
		configValues: { "remote.fork.mirror": ["off"] },
	});
	const discovery = await discoverCurrentPullRequest(allowed.pi, allowed.context);
	assert.equal(discovery.kind, "current");
	assert.ok(allowed.calls.some(({ command, args }) =>
		command === "git" && args.join(" ") === "config --type=bool --get-all remote.fork.mirror"
	));
});

test("ignores historical PRs when selecting an inferred open PR", async () => {
	const historical = pullRequest({
		number: 41,
		url: "https://github.com/acme/project/pull/41",
		state: "CLOSED",
		headRefName: "feature/local",
	});
	const open = pullRequest({ headRefName: "feature/local" });
	const { pi, context } = harness({
		pushResult: result("\n"),
		remoteNames: ["fork"],
		candidates: [historical, open],
	});

	const discovery = await discoverCurrentPullRequest(pi, context);
	assert.equal(discovery.kind, "current");
	if (discovery.kind !== "current") return;
	assert.equal(discovery.pullRequest.number, 42);
	assert.equal(discovery.pullRequest.lifecycle, "open");
});

test("blocks inferred discovery when a search candidate closes before view", async () => {
	const searched = pullRequest({ headRefName: "feature/local" });
	const closed = { ...searched, state: "CLOSED" };
	const { pi, context } = harness({
		pushResult: result("\n"),
		remoteNames: ["fork"],
		searchCandidates: [searched],
		candidates: [closed],
	});

	assert.deepEqual(await discoverCurrentPullRequest(pi, context), {
		kind: "blocked",
		issue: { kind: "published-without-pr", remote: "fork" },
	});
});

test("blocks ambiguous candidate remotes before searching GitHub", async () => {
	const { pi, context, calls } = harness({
		pushResult: result("\n"),
		remoteNames: ["fork", "origin"],
	});

	assert.deepEqual(await discoverCurrentPullRequest(pi, context), {
		kind: "blocked",
		issue: { kind: "candidate-remotes-ambiguous", remotes: ["fork", "origin"] },
	});
	assert.equal(calls.some(({ command, args }) => command === "gh" && args[0] === "api"), false);
});

test("blocks a published ref without a PR and an inferred OID mismatch", async () => {
	const published = harness({ pushResult: result("\n"), remoteNames: ["fork"], searchCandidates: [] });
	assert.deepEqual(await discoverCurrentPullRequest(published.pi, published.context), {
		kind: "blocked",
		issue: { kind: "published-without-pr", remote: "fork" },
	});

	const mismatch = harness({
		pushResult: result("\n"),
		remoteNames: ["fork"],
		candidates: [pullRequest({ headRefName: "feature/local", headRefOid: LOCAL_HEAD })],
	});
	const mismatchDiscovery = await discoverCurrentPullRequest(mismatch.pi, mismatch.context);
	assert.equal(mismatchDiscovery.kind, "blocked");
	if (mismatchDiscovery.kind !== "blocked") return;
	assert.equal(mismatchDiscovery.issue.kind, "candidate-oid-mismatch");
});

test("offers creation only after validating origin and finding no published ref", async () => {
	const { pi, context } = harness({
		pushResult: result("\n"),
		remote: "origin",
		remoteNames: ["origin"],
		pushUrl: "git@github.com:acme/project.git",
		remoteHead: null,
	});

	assert.deepEqual(await discoverCurrentPullRequest(pi, context), {
		kind: "none",
		creationTarget: {
			provenance: "inferred",
			branch: "feature/local",
			remote: "origin",
			ref: "feature/local",
			repository: "acme/project",
			host: "github.com",
			fetchSource: "git@github.com:acme/project.git",
			remoteOid: null,
		},
	});

	const invalid = harness({
		pushResult: result("\n"),
		remote: "origin",
		remoteNames: ["origin"],
		pushUrl: "https://user:secret@github.com/acme/project.git",
		remoteHead: null,
	});
	assert.deepEqual(await discoverCurrentPullRequest(invalid.pi, invalid.context), {
		kind: "blocked",
		issue: { kind: "origin-invalid" },
	});

	const unsafeConfigurations: Array<Record<string, string[]>> = [
		{ "push.default": ["nothing"] },
		{ "branch.feature/local.remote": ["origin"] },
		{ "remote.origin.push": ["refs/heads/*:refs/heads/*"] },
	];
	for (const configValues of unsafeConfigurations) {
		const unsafe = harness({
			pushResult: result("\n"),
			remote: "origin",
			remoteNames: ["origin"],
			pushUrl: "git@github.com:acme/project.git",
			remoteHead: null,
			configValues,
		});
		assert.deepEqual(await discoverCurrentPullRequest(unsafe.pi, unsafe.context), {
			kind: "blocked",
			issue: { kind: "link-configuration", remote: "origin" },
		});
	}
});

test("links an inferred target only after fresh verification", async () => {
	const app = await linkHarness();
	const linked = await linkInferredPullRequest(app.pi, app.context, app.inferred);

	assert.equal(linked.target.provenance, "configured");
	assert.deepEqual(app.config.get("branch.feature/local.remote"), ["fork"]);
	assert.deepEqual(app.config.get("branch.feature/local.merge"), ["refs/heads/feature/local"]);
	assert.equal(app.getTrackingOid(), REMOTE_HEAD);
	assert.equal(app.calls.some(({ command, args }) =>
		command === "git" && args.join(" ") === "branch --set-upstream-to=fork/feature/local -- feature/local"
	), true);
	const fetch = app.calls.find(({ command, args }) =>
		command === "git" && args.at(-1)?.endsWith(":refs/remotes/fork/feature/local")
	);
	assert.deepEqual(fetch?.args, [
		"fetch",
		"--no-write-fetch-head",
		"--no-tags",
		"--no-recurse-submodules",
		"git@github.com:acme/fork.git",
		`${REMOTE_HEAD}:refs/remotes/fork/feature/local`,
	]);
	assert.equal(fetch?.args.includes("--force"), false);
});

test("cancels linking when the remote becomes a mirror after discovery", async () => {
	const app = await linkHarness();
	app.config.set("remote.fork.mirror", ["true"]);

	await assert.rejects(
		linkInferredPullRequest(app.pi, app.context, app.inferred),
		/Link branch cancelled: inferred pull request context changed/,
	);
	assert.equal(app.config.has("branch.feature/local.remote"), false);
	assert.equal(app.getTrackingOid(), null);
});

test("cancels and rolls back when the remote moves between precheck and fetch", async () => {
	const originalTrackingOid = "f".repeat(40);
	const movedRemoteOid = "e".repeat(40);
	const app = await linkHarness({
		initialTrackingOid: originalTrackingOid,
		moveRemoteBeforeFetchTo: movedRemoteOid,
	});

	await assert.rejects(
		linkInferredPullRequest(app.pi, app.context, app.inferred),
		/Link branch failed: configured pull request does not match inferred target/,
	);
	assert.equal(app.getTrackingOid(), originalTrackingOid);
	assert.equal(app.config.size, 0);
});

test("rolls back upstream and tracking state when final link verification fails", async () => {
	const app = await linkHarness({ failFinalLookup: true });
	await assert.rejects(
		linkInferredPullRequest(app.pi, app.context, app.inferred),
		/Find pull requests failed: exit code 1/,
	);

	assert.equal(app.config.has("branch.feature/local.remote"), false);
	assert.equal(app.config.has("branch.feature/local.merge"), false);
	assert.equal(app.getTrackingOid(), null);
});

test("removes its fetched tracking ref when post-fetch verification errors", async () => {
	const app = await linkHarness({ failPostFetchRead: true });
	await assert.rejects(
		linkInferredPullRequest(app.pi, app.context, app.inferred),
		/Read remote-tracking ref failed: exit code 128/,
	);
	assert.equal(app.getTrackingOid(), null);
	assert.equal(app.config.size, 0);
});

test("does not overwrite a concurrent tracking-ref update during rollback", async () => {
	const concurrentOid = "e".repeat(40);
	const app = await linkHarness({ concurrentTrackingOid: concurrentOid });
	await assert.rejects(
		linkInferredPullRequest(app.pi, app.context, app.inferred),
		/Link branch failed and rollback was incomplete/,
	);
	assert.equal(app.getTrackingOid(), concurrentOid);
	assert.equal(app.config.size, 0);
});

test("does not erase a concurrent branch-config update during rollback", async () => {
	const app = await linkHarness({ failFinalLookup: true, concurrentConfigValue: "other" });
	await assert.rejects(
		linkInferredPullRequest(app.pi, app.context, app.inferred),
		/Link branch failed and rollback was incomplete/,
	);
	assert.deepEqual(app.config.get("branch.feature/local.remote"), ["other"]);
	assert.equal(app.config.has("branch.feature/local.merge"), false);
	assert.equal(app.getTrackingOid(), null);
});

test("rolls back when the inferred pull request closes before final verification", async () => {
	const app = await linkHarness({ closeBeforeFinalVerification: true });
	await assert.rejects(
		linkInferredPullRequest(app.pi, app.context, app.inferred),
		/Link branch failed: configured pull request does not match inferred target/,
	);
	assert.equal(app.config.size, 0);
	assert.equal(app.getTrackingOid(), null);
});

test("keeps detached HEAD, malformed push refs, and push lookup failures distinct from no upstream", async () => {
	const detached = harness({ branchResult: result("") });
	assert.deepEqual(await discoverCurrentPullRequest(detached.pi, detached.context), {
		kind: "blocked",
		issue: { kind: "detached-head" },
	});
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

test("rejects credential-bearing and authority-confused push URLs before exposing them to subprocesses", async () => {
	const secret = "top-secret";
	for (const pushUrl of [
		`https://user:${secret}@github.com/acme/fork.git`,
		`https://github.com\\user:${secret}@evil.com/../acme/fork.git`,
	]) {
		const { pi, context, calls } = harness({ pushUrl });

		await assert.rejects(
			loadCurrentPullRequest(pi, context),
			(error: unknown) => error instanceof PullRequestLoadError &&
				/Read push URL failed: invalid push URL/.test(error.message) && !error.message.includes(secret),
		);
		assert.equal(calls.some(({ command }) => command === "gh"), false);
		assert.equal(calls.some(({ command, args }) => command === "git" && (args[0] === "ls-remote" || args[0] === "fetch")), false);
		assert.equal(calls.some(({ args }) => args.some((arg) => arg.includes(secret))), false);
	}
});

test("requires the credential-free locator and GitHub response to identify the same repository", async () => {
	const { pi, context, calls } = harness({
		pushRepositoryResult: result(JSON.stringify({ nameWithOwner: "acme/other", url: "https://github.com/acme/other" })),
	});

	await assert.rejects(loadCurrentPullRequest(pi, context), /response does not match push URL/);
	assert.equal(calls.some(({ command, args }) => command === "git" && args[0] === "ls-remote"), false);
});

test("requires one matching credential-free fetch URL for the named remote", async () => {
	const cases: Array<{ name: string; options: Partial<HarnessOptions>; error: RegExp }> = [
		{
			name: "different repository",
			options: { fetchUrl: "git@github.com:acme/other.git" },
			error: /fetch and push repositories do not match/,
		},
		{
			name: "multiple fetch URLs",
			options: { fetchUrlResult: result("git@github.com:acme/fork.git\nhttps:\/\/github.com\/acme\/fork.git\n") },
			error: /multiple fetch URLs are configured/,
		},
		{
			name: "credential-bearing fetch URL",
			options: { fetchUrl: "https://user:secret@github.com/acme/fork.git" },
			error: /Read fetch URL failed: invalid fetch URL/,
		},
	];
	for (const candidate of cases) {
		const app = harness(candidate.options);
		await assert.rejects(loadCurrentPullRequest(app.pi, app.context), candidate.error, candidate.name);
		assert.equal(app.calls.some(({ command, args }) => command === "git" && args[0] === "ls-remote"), false, candidate.name);
	}

	const inferred = harness({
		pushResult: result("\n"),
		remoteNames: ["fork"],
		fetchUrl: "git@github.com:acme/other.git",
	});
	assert.deepEqual(await discoverCurrentPullRequest(inferred.pi, inferred.context), {
		kind: "blocked",
		issue: { kind: "target-invalid" },
	});
	assert.equal(inferred.calls.some(({ command, args }) =>
		command === "gh" && args[0] === "api" && args.some((arg) => arg.includes("associatedPullRequests("))
	), false);
});

test("accepts a matching fetch URL over another protocol while retaining the push URL as fetch authority", async () => {
	const pushUrl = "git@github.com:acme/fork.git";
	const { pi, context, calls } = harness({
		pushUrl,
		fetchUrl: "https://github.com/acme/fork.git",
	});

	const loaded = await loadCurrentPullRequest(pi, context);
	assert.ok(loaded);
	assert.equal(loaded.headFetchSource, pushUrl);
	assert.equal(calls.filter(({ command, args }) =>
		command === "gh" && args.join(" ") === "repo view github.com/acme/fork --json nameWithOwner,url"
	).length, 2);
	assert.ok(calls.some(({ command, args }) =>
		command === "git" && args.join(" ") === "remote get-url --all fork"
	));
	assert.ok(calls.some(({ command, args }) => command === "git" && args[0] === "ls-remote" && args[3] === pushUrl));
});

test("uses a credential-free locator for GitHub and retains each supported fetch URL", async () => {
	for (const pushUrl of [
		"https://github.com/acme/fork.git",
		"ssh://git@github.com/acme/fork.git",
		"git@github.com:acme/fork.git",
	]) {
		const { pi, context, calls } = harness({ pushUrl });
		const loaded = await loadCurrentPullRequest(pi, context);
		assert.ok(loaded);
		assert.equal(loaded.headFetchSource, pushUrl);
		assert.ok(calls.some(({ command, args }) =>
			command === "gh" && args.join(" ") === "repo view github.com/acme/fork --json nameWithOwner,url"
		), pushUrl);
		assert.ok(calls.some(({ command, args }) =>
			command === "git" && args[0] === "ls-remote" && args[3] === pushUrl
		), pushUrl);
		assert.ok(calls.some(({ command, args }) =>
			command === "git" && args[0] === "fetch" && args[4] === pushUrl
		), pushUrl);
	}
});

test("ignores the same head ref in an unrelated repository", async () => {
	const unrelated = pullRequest({
		url: "https://github.com/acme/unrelated/pull/42",
		headRepository: { nameWithOwner: "acme/unrelated" },
	});
	const { pi, context, calls } = harness({ candidates: [unrelated] });

	assert.equal(await loadCurrentPullRequest(pi, context), null);
	assert.equal(calls.filter(({ command, args }) => command === "gh" && args[0] === "pr" && args[1] === "view").length, 0);
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
	assert.equal(calls.some(({ command, args }) =>
		command === "gh" && args[0] === "api" && args[1] === "graphql" && !args.some((arg) => arg.includes("associatedPullRequests("))
	), false);
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
		/Discovery blocked: candidate-prs-ambiguous/,
	);
});

test("does not fall back to local HEAD when the remote push ref is absent", async () => {
	const historical = pullRequest({ state: "CLOSED", headRefOid: LOCAL_HEAD });
	const { pi, context, calls } = harness({ candidates: [historical], remoteHead: null });

	assert.equal(await loadCurrentPullRequest(pi, context), null);
	const search = calls.find(({ command, args }) =>
		command === "gh" && args[0] === "api" && args[1] === "graphql" && args.some((arg) => arg.includes("associatedPullRequests("))
	);
	assert.ok(search?.args.includes("qualifiedName=refs/heads/feature/pr"));
	assert.equal(calls.some(({ command, args }) => command === "git" && args[0] === "status"), false);
});

test("rehydrates a merged PR from its exact observed enterprise URL after its configured ref is deleted", async () => {
	const host = "github.example.test";
	const url = `https://${host}/acme/project/pull/42`;
	const merged = pullRequest({ url, state: "MERGED" });
	const { pi, context, calls } = harness({
		candidates: [merged],
		localHead: REMOTE_HEAD,
		pushUrl: `git@${host}:acme/fork.git`,
		remoteHead: null,
	});
	const observed = observation({
		pullRequest: { url, number: 42, host },
		head: { repository: "ACME/FORK", ref: "feature/pr", oid: REMOTE_HEAD },
		target: { repository: "ACME/FORK", branch: "feature/local", remote: "fork", ref: "feature/pr" },
	});

	const discovery = await discoverCurrentPullRequest(pi, context, undefined, observed);
	assert.equal(discovery.kind, "current");
	if (discovery.kind !== "current") return;
	assert.equal(discovery.pullRequest.number, 42);
	assert.equal(discovery.pullRequest.lifecycle, "merged");
	assert.equal(discovery.pullRequest.host, host);
	assert.ok(calls.some(({ command, args }) =>
		command === "gh" && args.join(" ") === `pr view ${url} --json id,number,url,state,isDraft,baseRefName,baseRefOid,headRefName,headRefOid,headRepository,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup`
	));
});

test("ignores stale observations when configured target or local HEAD identity differs", async () => {
	const mismatches = [
		{ name: "branch", value: observation({ target: { repository: "acme/fork", branch: "other", remote: "fork", ref: "feature/pr" } }) },
		{ name: "repository", value: observation({ target: { repository: "acme/other", branch: "feature/local", remote: "fork", ref: "feature/pr" } }) },
		{ name: "ref", value: observation({ target: { repository: "acme/fork", branch: "feature/local", remote: "fork", ref: "other" } }) },
		{ name: "remote", value: observation({ target: { repository: "acme/fork", branch: "feature/local", remote: "origin", ref: "feature/pr" } }) },
		{
			name: "host",
			value: observation({
				pullRequest: { url: "https://github.example.test/acme/project/pull/42", number: 42, host: "github.example.test" },
			}),
		},
		{ name: "head OID", value: observation({ head: { repository: "acme/fork", ref: "feature/pr", oid: "e".repeat(40) } }) },
	];
	for (const mismatch of mismatches) {
		const merged = pullRequest({ state: "MERGED" });
		const { pi, context, calls } = harness({ candidates: [merged], localHead: REMOTE_HEAD, remoteHead: null });
		const discovery = await discoverCurrentPullRequest(pi, context, undefined, mismatch.value);
		assert.equal(discovery.kind, "none", mismatch.name);
		assert.equal(calls.filter(({ command, args }) => command === "gh" && args[0] === "pr" && args[1] === "view").length, 0, mismatch.name);
	}
});

test("fails closed when the exact observed PR lookup fails", async () => {
	const merged = pullRequest({ state: "MERGED" });
	const { pi, context } = harness({
		searchCandidates: [merged],
		candidates: [],
		localHead: REMOTE_HEAD,
		remoteHead: null,
		pullRequestResult: result("", 1),
	});

	await assert.rejects(
		discoverCurrentPullRequest(pi, context, undefined, observation()),
		/Load observed pull request failed: exit code 1/,
	);
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
	assert.equal(calls.some(({ command, args }) =>
		command === "gh" && args[0] === "api" && args[1] === "graphql" && !args.some((arg) => arg.includes("associatedPullRequests("))
	), false);
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
		/Discovery blocked: candidate-prs-ambiguous/,
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

test("normalizes empty gh review and check fields without accepting empty records", async () => {
	const normalized = harness({
		candidates: [pullRequest({
			reviewDecision: "",
			statusCheckRollup: [
				{ conclusion: "", status: "QUEUED" },
				{ conclusion: "SUCCESS", state: "", status: "COMPLETED" },
				{ conclusion: "", state: "IN_PROGRESS", status: "" },
			],
		})],
	});
	const loaded = await loadCurrentPullRequest(normalized.pi, normalized.context);
	assert.ok(loaded);
	assert.equal(loaded.approved, false);
	assert.equal(loaded.conditions.review, "ready");
	assert.equal(loaded.conditions.ci, "running");

	for (const candidate of [
		pullRequest({ reviewDecision: "DISMISSED" }),
		pullRequest({ statusCheckRollup: [{ conclusion: "", state: "", status: "" }] }),
		pullRequest({ statusCheckRollup: [{ conclusion: "SUCCESS", state: "FAILURE" }] }),
	]) {
		const invalid = harness({ candidates: [candidate] });
		await assert.rejects(loadCurrentPullRequest(invalid.pi, invalid.context), /invalid reviewDecision|invalid statusCheckRollup/);
	}
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
	assert.equal(blocked.calls.some(({ args }) => args.some((arg) => arg.includes("rules/branches"))), true);
});

test("fails visibly when either base branch authority fails or is malformed", async () => {
	const cases: Array<{
		name: string;
		baseRefResult?: ReturnType<typeof result>;
		policyResult?: ReturnType<typeof result>;
		rulesetResult?: ReturnType<typeof result>;
		error: RegExp;
	}> = [
		{
			name: "base ref query failure",
			baseRefResult: result("", 1),
			error: /Read base ref failed: exit code 1/,
		},
		{
			name: "base ref GraphQL denial",
			baseRefResult: result(JSON.stringify({ data: { repository: null }, errors: [{ type: "FORBIDDEN" }] })),
			error: /Read base ref failed: GitHub GraphQL returned errors/,
		},
		{
			name: "malformed base ref authority",
			baseRefResult: result(JSON.stringify({ data: { repository: null } })),
			error: /Read base ref failed: invalid GitHub CLI output/,
		},
		{
			name: "malformed base target OID",
			baseRefResult: result(baseRefOutput("not-an-oid")),
			error: /Read base ref failed: invalid target OID/,
		},
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
			name: "malformed status rule on a valid page",
			policyResult: result(baseBranchPolicyOutput(true)),
			rulesetResult: result(JSON.stringify([[{ type: "required_status_checks", parameters: {} }]])),
			error: /Read base branch rulesets failed: invalid GitHub CLI output/,
		},
		{
			name: "malformed pull request rule",
			policyResult: result(baseBranchPolicyOutput(true)),
			rulesetResult: result(rulesetOutput([{ type: "pull_request", parameters: {} }])),
			error: /Read base branch rulesets failed: invalid GitHub CLI output/,
		},
		{
			name: "unsupported pull request merge method",
			policyResult: result(baseBranchPolicyOutput(true)),
			rulesetResult: result(rulesetOutput([{ type: "pull_request", parameters: { allowed_merge_methods: ["octopus"] } }])),
			error: /Read base branch rulesets failed: invalid GitHub CLI output/,
		},
	];
	for (const candidate of cases) {
		const { pi, context } = harness({
			candidates: [pullRequest({ mergeStateStatus: "BEHIND" })],
			baseRefResult: candidate.baseRefResult,
			policyResult: candidate.policyResult,
			rulesetResult: candidate.rulesetResult,
		});
		await assert.rejects(loadCurrentPullRequest(pi, context), candidate.error, candidate.name);
	}
});

test("intersects repository merge methods with every applicable pull-request rule", async () => {
	const restricted = harness({
		rulesetResult: result(rulesetOutput(
			[{ type: "pull_request", parameters: { allowed_merge_methods: ["merge", "squash"] } }],
			[{ type: "pull_request", parameters: { allowed_merge_methods: ["rebase", "squash"] } }],
		)),
	});
	const loaded = await loadCurrentPullRequest(restricted.pi, restricted.context);
	assert.ok(loaded);
	assert.deepEqual(loaded.merge, {
		allowedMergeMethods: ["squash"],
		viewerDefaultMergeMethod: "squash",
	});

	const repositoryRestricted = harness({
		methods: {
			mergeCommitAllowed: true,
			rebaseMergeAllowed: true,
			squashMergeAllowed: false,
			viewerDefaultMergeMethod: "REBASE",
		},
		rulesetResult: result(rulesetOutput([
			{ type: "pull_request", parameters: { allowed_merge_methods: ["rebase", "squash"] } },
		])),
	});
	const repositoryLoaded = await loadCurrentPullRequest(repositoryRestricted.pi, repositoryRestricted.context);
	assert.ok(repositoryLoaded);
	assert.deepEqual(repositoryLoaded.merge, {
		allowedMergeMethods: ["rebase"],
		viewerDefaultMergeMethod: "rebase",
	});

	const empty = harness({
		methods: {
			mergeCommitAllowed: true,
			rebaseMergeAllowed: false,
			squashMergeAllowed: false,
			viewerDefaultMergeMethod: "MERGE",
		},
		rulesetResult: result(rulesetOutput([
			{ type: "pull_request", parameters: { allowed_merge_methods: ["squash"] } },
		])),
	});
	await assert.rejects(
		loadCurrentPullRequest(empty.pi, empty.context),
		/Read merge methods failed: repository and applicable rules allow no common merge method/,
	);

	const invalidDefault = harness({
		methods: {
			mergeCommitAllowed: true,
			rebaseMergeAllowed: true,
			squashMergeAllowed: false,
			viewerDefaultMergeMethod: "SQUASH",
		},
	});
	await assert.rejects(
		loadCurrentPullRequest(invalidDefault.pi, invalidDefault.context),
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
		/git rev-parse .* failed: exit code 128/,
	);
	assert.equal(failed.calls.some(({ command, args }) => command === "git" && args[0] === "fetch"), false);

	const malformed = harness({ stateResult: result("/repo/.git/MERGE_HEAD\n") });
	await assert.rejects(
		loadCurrentPullRequest(malformed.pi, malformed.context),
		/Git operation state path resolution returned invalid output/,
	);
});

test("rejects a remote push ref that moved from the advertised pull request OID", async () => {
	const { pi, context, calls } = harness({ remoteHead: "d".repeat(40) });
	await assert.rejects(
		loadCurrentPullRequest(pi, context),
		/Discovery blocked: candidate-oid-mismatch/,
	);
	assert.equal(calls.some(({ command, args }) => command === "git" && args[0] === "fetch"), false);
});

test("surfaces isolated exact-OID fetch and verification failures without ancestry checks", async () => {
	for (const options of [
		{ fetchResult: result("", 1), error: /git fetch .* failed: exit code 1/ },
		{ verifyResult: result("", 1), error: /git cat-file .* failed: exit code 1/ },
	]) {
		const { pi, context, calls } = harness(options);
		await assert.rejects(loadCurrentPullRequest(pi, context), options.error);
		assert.equal(calls.some(({ command, args }) => command === "git" && args[0] === "merge-base"), false);
		assert.equal(calls.some(({ args }) => args.some((arg) => arg.includes("FETCH_HEAD"))), false);
	}
});

test("surfaces ancestry command failures after exact-OID verification", async () => {
	for (const candidate of [
		{ ancestryResult: result("", 2), error: /git merge-base .* failed: exit code 2/ },
		{ ancestryResult: { ...result("", 1), killed: true }, error: /git merge-base .* failed: command was killed/ },
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
