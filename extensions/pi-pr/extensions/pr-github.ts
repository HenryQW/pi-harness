import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type {
	CiStatus,
	LocalMergeSafety,
	PullRequest,
	PullRequestConditions,
	PullRequestLifecycle,
	ReviewReadiness,
	PolicyReadiness,
} from "./pr-routing.ts";

const EXEC_TIMEOUT_MS = 10_000;
const PR_LIST_LIMIT = 100;
const PR_FIELDS = "id,number,url,state,isDraft,baseRefName,baseRefOid,headRefName,headRefOid,headRepository,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup";
const REVIEW_THREADS_QUERY = "query($id:ID!,$endCursor:String){node(id:$id){...on PullRequest{reviewThreads(first:100,after:$endCursor){nodes{isResolved}pageInfo{hasNextPage endCursor}}}}}";
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const FAILED_CHECK_STATES = new Set([
	"ACTION_REQUIRED",
	"CANCELLED",
	"ERROR",
	"FAILURE",
	"STALE",
	"STARTUP_FAILURE",
	"TIMED_OUT",
]);
const SUCCESSFUL_CHECK_STATES = new Set(["NEUTRAL", "SKIPPED", "SUCCESS"]);
const PENDING_CHECK_STATES = new Set([
	"COMPLETED",
	"EXPECTED",
	"IN_PROGRESS",
	"PENDING",
	"QUEUED",
	"REQUESTED",
	"WAITING",
]);
const MERGEABLE_VALUES = new Set(["MERGEABLE", "CONFLICTING", "UNKNOWN"]);
const MERGE_STATE_VALUES = new Set([
	"BEHIND",
	"BLOCKED",
	"CLEAN",
	"DIRTY",
	"DRAFT",
	"HAS_HOOKS",
	"UNKNOWN",
	"UNSTABLE",
]);
const REVIEW_DECISION_VALUES = new Set(["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED"]);

export class PullRequestLoadError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PullRequestLoadError";
	}
}

export type PullRequestRef = {
	repository: string;
	ref: string;
	oid: string;
};

export type MergeMethod = "merge" | "rebase" | "squash";

export type MergeMethodSettings = {
	mergeCommitAllowed: boolean;
	rebaseMergeAllowed: boolean;
	squashMergeAllowed: boolean;
};

export type PullRequestMerge = {
	method: MergeMethod;
	methods: MergeMethodSettings;
};

export type CurrentPullRequest = PullRequest & {
	id: string;
	number: number;
	url: URL;
	host: string;
	approved: boolean;
	base: PullRequestRef;
	head: PullRequestRef;
	merge: PullRequestMerge | null;
};

export type PullRequestLoadContext = Pick<ExtensionContext, "cwd" | "signal">;

type CommandOutput = {
	stdout: string;
	stderr: string;
	code: number;
	killed: boolean;
};

type PushRepository = {
	nameWithOwner: string;
	normalizedName: string;
	host: string;
};

type PushTarget = {
	headOid: string;
	repository: PushRepository;
	ref: string;
};

type ListedPullRequest = {
	id: string;
	number: number;
	url: URL;
	lifecycle: PullRequestLifecycle;
	isDraft: boolean;
	base: PullRequestRef;
	head: PullRequestRef;
	mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
	mergeStateStatus: "BEHIND" | "BLOCKED" | "CLEAN" | "DIRTY" | "DRAFT" | "HAS_HOOKS" | "UNKNOWN" | "UNSTABLE";
	reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
	checkStates: string[];
};

function fail(action: string, reason: string): never {
	throw new PullRequestLoadError(`${action} failed: ${reason}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, action: string, field: string): string {
	if (
		typeof value !== "string" || !value || value.trim() !== value ||
		/[\u0000-\u001f\u007f]/.test(value)
	) fail(action, `invalid ${field}`);
	return value;
}

function oid(value: unknown, action: string, field: string): string {
	const parsed = text(value, action, field);
	if (!OID.test(parsed)) fail(action, `invalid ${field}`);
	return parsed.toLowerCase();
}

function repositoryName(value: unknown, action: string, field: string): string {
	const parsed = text(value, action, field);
	const parts = parsed.split("/");
	if (parts.length !== 2 || parts.some((part) => !part || /\s|\//.test(part))) {
		fail(action, `invalid ${field}`);
	}
	return parsed;
}

function normalizeRepository(value: string): string {
	return value.toLowerCase();
}

function parseJson(output: string, action: string): unknown {
	try {
		return JSON.parse(output);
	} catch {
		fail(action, "invalid GitHub CLI output");
	}
}

function parseHttpUrl(value: unknown, action: string, field: string): URL {
	const parsed = text(value, action, field);
	let url: URL;
	try {
		url = new URL(parsed);
	} catch {
		fail(action, `invalid ${field}`);
	}
	if (
		(url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname ||
		url.username || url.password || url.search || url.hash
	) fail(action, `invalid ${field}`);
	return url;
}

function singleLine(output: string, action: string, field: string): string {
	const lines = output.replace(/\r\n/g, "\n").split("\n");
	if (lines.at(-1) === "") lines.pop();
	if (lines.length !== 1) fail(action, `invalid ${field}`);
	return text(lines[0], action, field);
}

function lines(output: string, action: string, field: string): string[] {
	const parsed = output.replace(/\r\n/g, "\n").split("\n");
	if (parsed.at(-1) === "") parsed.pop();
	if (!parsed.length) fail(action, `invalid ${field}`);
	const result = parsed.map((value) => text(value, action, field));
	if (new Set(result).size !== result.length) fail(action, `invalid ${field}`);
	return result;
}

function parseCommandOutput(value: unknown, action: string): CommandOutput {
	if (!isRecord(value)) fail(action, "invalid command result");
	const { stdout, stderr, code, killed } = value;
	if (
		typeof stdout !== "string" || typeof stderr !== "string" || typeof code !== "number" ||
		!Number.isSafeInteger(code) || code < 0 || typeof killed !== "boolean"
	) fail(action, "invalid command result");
	return { stdout, stderr, code, killed };
}

async function invoke(
	pi: Pick<ExtensionAPI, "exec">,
	context: PullRequestLoadContext,
	action: string,
	command: string,
	args: string[],
): Promise<CommandOutput> {
	let result: unknown;
	try {
		result = await pi.exec(command, args, {
			cwd: context.cwd,
			signal: context.signal,
			timeout: EXEC_TIMEOUT_MS,
		});
	} catch {
		fail(action, "command threw");
	}
	return parseCommandOutput(result, action);
}

function commandFailure(action: string, result: CommandOutput): never {
	fail(action, result.killed ? "command was cancelled" : `exit code ${result.code}`);
}

async function execute(
	pi: Pick<ExtensionAPI, "exec">,
	context: PullRequestLoadContext,
	action: string,
	command: string,
	args: string[],
): Promise<CommandOutput> {
	const result = await invoke(pi, context, action, command, args);
	if (result.code !== 0) commandFailure(action, result);
	return result;
}

function parsePushReference(value: string, remoteNames: string[]): { remote: string; ref: string } {
	const matches = remoteNames
		.filter((remote) => value.startsWith(`${remote}/`))
		.sort((left, right) => right.length - left.length);
	if (!matches.length) fail("Read push target", "target does not name a configured remote");
	if (matches.length > 1 && matches[0].length === matches[1].length) {
		fail("Read push target", "target names multiple configured remotes");
	}
	const remote = matches[0];
	const ref = value.slice(remote.length + 1);
	text(ref, "Read push target", "push ref");
	return { remote, ref };
}

function parsePushRepository(output: string): PushRepository {
	const value = parseJson(output, "Read push repository");
	if (!isRecord(value)) fail("Read push repository", "invalid GitHub CLI output");
	const nameWithOwner = repositoryName(value.nameWithOwner, "Read push repository", "nameWithOwner");
	const url = parseHttpUrl(value.url, "Read push repository", "url");
	const path = url.pathname.split("/").filter(Boolean);
	if (path.length !== 2 || normalizeRepository(path.join("/")) !== normalizeRepository(nameWithOwner)) {
		fail("Read push repository", "url does not match nameWithOwner");
	}
	return {
		nameWithOwner,
		normalizedName: normalizeRepository(nameWithOwner),
		host: url.hostname.toLowerCase(),
	};
}

function parsePullRequestUrl(value: unknown, number: number): { url: URL; repository: string } {
	const url = parseHttpUrl(value, "Find pull requests", "url");
	const path = url.pathname.split("/").filter(Boolean);
	if (path.length !== 4 || path[2] !== "pull" || !/^[1-9][0-9]*$/.test(path[3])) {
		fail("Find pull requests", "invalid url");
	}
	const urlNumber = Number(path[3]);
	if (!Number.isSafeInteger(urlNumber) || urlNumber !== number) fail("Find pull requests", "url does not match number");
	return {
		url,
		repository: repositoryName(`${path[0]}/${path[1]}`, "Find pull requests", "base repository"),
	};
}

function lifecycle(value: unknown): PullRequestLifecycle {
	if (value === "OPEN") return "open";
	if (value === "MERGED") return "merged";
	if (value === "CLOSED") return "closed";
	return fail("Find pull requests", "invalid state");
}

function mergeable(value: unknown): ListedPullRequest["mergeable"] {
	if (typeof value !== "string" || !MERGEABLE_VALUES.has(value)) {
		fail("Find pull requests", "invalid mergeable");
	}
	return value as ListedPullRequest["mergeable"];
}

function mergeStateStatus(value: unknown): ListedPullRequest["mergeStateStatus"] {
	if (typeof value !== "string" || !MERGE_STATE_VALUES.has(value)) {
		fail("Find pull requests", "invalid mergeStateStatus");
	}
	return value as ListedPullRequest["mergeStateStatus"];
}

function reviewDecision(value: unknown): ListedPullRequest["reviewDecision"] {
	if (value === null) return null;
	if (typeof value !== "string" || !REVIEW_DECISION_VALUES.has(value)) {
		fail("Find pull requests", "invalid reviewDecision");
	}
	return value as ListedPullRequest["reviewDecision"];
}

function optionalCheckState(check: Record<string, unknown>, field: string): string | null {
	const value = check[field];
	if (value === undefined || value === null) return null;
	if (
		typeof value !== "string" ||
		(!FAILED_CHECK_STATES.has(value) && !SUCCESSFUL_CHECK_STATES.has(value) &&
			!PENDING_CHECK_STATES.has(value))
	) fail("Find pull requests", "invalid statusCheckRollup");
	return value;
}

function checkOutcome(state: string): "failure" | "success" | "running" {
	if (FAILED_CHECK_STATES.has(state)) return "failure";
	if (SUCCESSFUL_CHECK_STATES.has(state)) return "success";
	return "running";
}

function checkState(value: unknown): string {
	if (!isRecord(value)) fail("Find pull requests", "invalid statusCheckRollup");
	const conclusion = optionalCheckState(value, "conclusion");
	const state = optionalCheckState(value, "state");
	const status = optionalCheckState(value, "status");
	const states = [conclusion, state, status].filter((value): value is string => value !== null);
	if (!states.length) fail("Find pull requests", "invalid statusCheckRollup");

	// COMPLETED describes a check run's lifecycle; its conclusion gives the outcome.
	const outcomes = states.filter((value) => value !== "COMPLETED").map(checkOutcome);
	if (
		new Set(outcomes).size > 1 ||
		(states.includes("COMPLETED") && outcomes.includes("running"))
	) fail("Find pull requests", "invalid statusCheckRollup");
	return conclusion ?? state ?? status ?? fail("Find pull requests", "invalid statusCheckRollup");
}

function checkStates(value: unknown): string[] {
	if (value === null) return [];
	if (!Array.isArray(value)) fail("Find pull requests", "invalid statusCheckRollup");
	return value.map(checkState);
}

function listedPullRequest(value: unknown): ListedPullRequest | null {
	if (!isRecord(value)) fail("Find pull requests", "invalid GitHub CLI output");
	if (value.headRepository === null) return null;
	if (!isRecord(value.headRepository)) fail("Find pull requests", "invalid headRepository");
	const number = value.number;
	if (typeof number !== "number" || !Number.isSafeInteger(number) || number <= 0) {
		fail("Find pull requests", "invalid number");
	}
	const parsedUrl = parsePullRequestUrl(value.url, number);
	const isDraft = value.isDraft;
	if (typeof isDraft !== "boolean") fail("Find pull requests", "invalid isDraft");
	return {
		id: text(value.id, "Find pull requests", "id"),
		number,
		url: parsedUrl.url,
		lifecycle: lifecycle(value.state),
		isDraft,
		base: {
			repository: parsedUrl.repository,
			ref: text(value.baseRefName, "Find pull requests", "baseRefName"),
			oid: oid(value.baseRefOid, "Find pull requests", "baseRefOid"),
		},
		head: {
			repository: repositoryName(value.headRepository.nameWithOwner, "Find pull requests", "headRepository.nameWithOwner"),
			ref: text(value.headRefName, "Find pull requests", "headRefName"),
			oid: oid(value.headRefOid, "Find pull requests", "headRefOid"),
		},
		mergeable: mergeable(value.mergeable),
		mergeStateStatus: mergeStateStatus(value.mergeStateStatus),
		reviewDecision: reviewDecision(value.reviewDecision),
		checkStates: checkStates(value.statusCheckRollup),
	};
}

function parseListedPullRequests(output: string): ListedPullRequest[] {
	const value = parseJson(output, "Find pull requests");
	if (!Array.isArray(value)) fail("Find pull requests", "invalid GitHub CLI output");
	if (value.length >= PR_LIST_LIMIT) fail("Find pull requests", "result limit reached");
	return value.flatMap((candidate) => {
		const parsed = listedPullRequest(candidate);
		return parsed === null ? [] : [parsed];
	});
}

function selectPullRequest(
	candidates: ListedPullRequest[],
	pushTarget: PushTarget,
): ListedPullRequest | null {
	const matching = candidates.filter((candidate) =>
		candidate.url.hostname.toLowerCase() === pushTarget.repository.host &&
		normalizeRepository(candidate.head.repository) === pushTarget.repository.normalizedName &&
		candidate.head.ref === pushTarget.ref,
	);
	const open = matching.filter((candidate) => candidate.lifecycle === "open");
	if (open.length > 1) fail("Find pull requests", "multiple open pull requests match current push target");
	if (open.length === 1) return open[0];

	const historical = matching.filter((candidate) =>
		candidate.lifecycle !== "open" && candidate.head.oid === pushTarget.headOid,
	);
	if (historical.length > 1) fail("Find pull requests", "multiple historical pull requests match current HEAD");
	return historical[0] ?? null;
}

function ciStatus(states: string[]): CiStatus {
	if (!states.length) return "none";
	let running = false;
	for (const state of states) {
		if (FAILED_CHECK_STATES.has(state)) return "failure";
		if (!SUCCESSFUL_CHECK_STATES.has(state)) running = true;
	}
	return running ? "running" : "success";
}

function conditions(candidate: ListedPullRequest, unresolvedThreads: number): PullRequestConditions {
	if (
		(candidate.mergeable === "MERGEABLE" && candidate.mergeStateStatus === "DIRTY") ||
		(candidate.mergeable === "CONFLICTING" && candidate.mergeStateStatus === "CLEAN")
	) fail("Find pull requests", "inconsistent mergeability data");
	const review: ReviewReadiness = candidate.reviewDecision === "REVIEW_REQUIRED" || candidate.reviewDecision === "CHANGES_REQUESTED"
		? "pending"
		: "ready";
	const policy: PolicyReadiness = candidate.mergeable === "MERGEABLE" && candidate.mergeStateStatus === "CLEAN"
		? "ready"
		: "pending";
	return {
		draft: candidate.isDraft,
		baseUpdateRequired: candidate.mergeStateStatus === "BEHIND",
		conflict: candidate.mergeable === "CONFLICTING" || candidate.mergeStateStatus === "DIRTY",
		changesRequested: candidate.reviewDecision === "CHANGES_REQUESTED",
		unresolvedThreads,
		ci: ciStatus(candidate.checkStates),
		review,
		policy,
	};
}

function parseUnresolvedReviewThreads(output: string): number {
	const pages = parseJson(output, "Read unresolved review threads");
	if (!Array.isArray(pages) || !pages.length) {
		fail("Read unresolved review threads", "invalid GitHub CLI output");
	}
	let total = 0;
	for (const [index, page] of pages.entries()) {
		if (!isRecord(page) || !isRecord(page.data) || !isRecord(page.data.node)) {
			fail("Read unresolved review threads", "invalid GitHub CLI output");
		}
		const reviewThreads = page.data.node.reviewThreads;
		if (!isRecord(reviewThreads) || !Array.isArray(reviewThreads.nodes) || !isRecord(reviewThreads.pageInfo)) {
			fail("Read unresolved review threads", "invalid GitHub CLI output");
		}
		const { hasNextPage, endCursor } = reviewThreads.pageInfo;
		if (
			typeof hasNextPage !== "boolean" ||
			(hasNextPage && typeof endCursor !== "string") ||
			(!hasNextPage && endCursor !== null && typeof endCursor !== "string") ||
			hasNextPage !== (index < pages.length - 1)
		) fail("Read unresolved review threads", "invalid GitHub CLI output");
		for (const thread of reviewThreads.nodes) {
			if (!isRecord(thread) || typeof thread.isResolved !== "boolean") {
				fail("Read unresolved review threads", "invalid GitHub CLI output");
			}
			if (!thread.isResolved) total += 1;
		}
	}
	if (!Number.isSafeInteger(total)) fail("Read unresolved review threads", "invalid GitHub CLI output");
	return total;
}

function parseMergeMethodSettings(output: string): PullRequestMerge {
	const value = parseJson(output, "Read merge methods");
	if (!isRecord(value)) fail("Read merge methods", "invalid GitHub CLI output");
	const { mergeCommitAllowed, rebaseMergeAllowed, squashMergeAllowed } = value;
	if (
		typeof mergeCommitAllowed !== "boolean" || typeof rebaseMergeAllowed !== "boolean" ||
		typeof squashMergeAllowed !== "boolean"
	) fail("Read merge methods", "invalid GitHub CLI output");
	const methods: MergeMethodSettings = {
		mergeCommitAllowed,
		rebaseMergeAllowed,
		squashMergeAllowed,
	};
	const allowed: MergeMethod[] = [];
	if (methods.mergeCommitAllowed) allowed.push("merge");
	if (methods.rebaseMergeAllowed) allowed.push("rebase");
	if (methods.squashMergeAllowed) allowed.push("squash");
	if (!allowed.length) fail("Read merge methods", "repository allows no merge method");
	if (allowed.length > 1 && !methods.squashMergeAllowed) {
		fail("Read merge methods", "multiple merge methods are allowed without squash");
	}
	return { methods, method: allowed.length === 1 ? allowed[0] : "squash" };
}

async function readPushTarget(
	pi: Pick<ExtensionAPI, "exec">,
	context: PullRequestLoadContext,
): Promise<PushTarget> {
	singleLine((await execute(pi, context, "Read current branch", "git", ["branch", "--show-current"])).stdout, "Read current branch", "branch");
	const headOid = oid(
		singleLine((await execute(pi, context, "Read current HEAD", "git", ["rev-parse", "--verify", "HEAD^{commit}"])).stdout, "Read current HEAD", "HEAD"),
		"Read current HEAD",
		"HEAD",
	);
	const pushReference = singleLine(
		(await execute(pi, context, "Read push target", "git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{push}"])).stdout,
		"Read push target",
		"push target",
	);
	const remoteNames = lines(
		(await execute(pi, context, "Read push remotes", "git", ["remote"])).stdout,
		"Read push remotes",
		"remote",
	);
	const push = parsePushReference(pushReference, remoteNames);
	const pushUrls = lines(
		(await execute(pi, context, "Read push URL", "git", ["remote", "get-url", "--push", "--all", push.remote])).stdout,
		"Read push URL",
		"push URL",
	);
	if (pushUrls.length !== 1) fail("Read push URL", "multiple push URLs are configured");
	const repository = parsePushRepository((await execute(
		pi,
		context,
		"Read push repository",
		"gh",
		["repo", "view", pushUrls[0], "--json", "nameWithOwner,url"],
	)).stdout);
	return { headOid, repository, ref: push.ref };
}

async function readUnresolvedReviewThreads(
	pi: Pick<ExtensionAPI, "exec">,
	context: PullRequestLoadContext,
	candidate: ListedPullRequest,
): Promise<number> {
	const result = await execute(pi, context, "Read unresolved review threads", "gh", [
		"api",
		"graphql",
		"--hostname",
		candidate.url.hostname,
		"--paginate",
		"--slurp",
		"-f",
		`query=${REVIEW_THREADS_QUERY}`,
		"-F",
		`id=${candidate.id}`,
	]);
	return parseUnresolvedReviewThreads(result.stdout);
}

async function readLocalMergeSafety(
	pi: Pick<ExtensionAPI, "exec">,
	context: PullRequestLoadContext,
	localHead: string,
	pullRequestHead: string,
): Promise<LocalMergeSafety> {
	const status = await execute(pi, context, "Read worktree status", "git", [
		"status",
		"--porcelain=v1",
		"--untracked-files=all",
	]);
	const worktree = status.stdout === "" ? "clean" : "dirty";
	if (localHead === pullRequestHead) return { worktree, head: "equal" };

	const localIsAncestor = await invoke(pi, context, "Compare pull request head", "git", [
		"merge-base",
		"--is-ancestor",
		localHead,
		pullRequestHead,
	]);
	if (localIsAncestor.code === 0) return { worktree, head: "behind" };
	if (localIsAncestor.code !== 1) commandFailure("Compare pull request head", localIsAncestor);

	const pullRequestIsAncestor = await invoke(pi, context, "Compare pull request head", "git", [
		"merge-base",
		"--is-ancestor",
		pullRequestHead,
		localHead,
	]);
	if (pullRequestIsAncestor.code === 0) return { worktree, head: "ahead" };
	if (pullRequestIsAncestor.code === 1) return { worktree, head: "diverged" };
	return commandFailure("Compare pull request head", pullRequestIsAncestor);
}

async function readMergeMethods(
	pi: Pick<ExtensionAPI, "exec">,
	context: PullRequestLoadContext,
	candidate: ListedPullRequest,
): Promise<PullRequestMerge> {
	const result = await execute(pi, context, "Read merge methods", "gh", [
		"repo",
		"view",
		`${candidate.url.hostname}/${candidate.base.repository}`,
		"--json",
		"mergeCommitAllowed,rebaseMergeAllowed,squashMergeAllowed",
	]);
	return parseMergeMethodSettings(result.stdout);
}

export async function loadCurrentPullRequest(
	pi: Pick<ExtensionAPI, "exec">,
	context: PullRequestLoadContext,
): Promise<CurrentPullRequest | null> {
	const pushTarget = await readPushTarget(pi, context);
	const listed = await execute(pi, context, "Find pull requests", "gh", [
		"pr",
		"list",
		"--head",
		pushTarget.ref,
		"--state",
		"all",
		"--limit",
		String(PR_LIST_LIMIT),
		"--json",
		PR_FIELDS,
	]);
	const candidate = selectPullRequest(parseListedPullRequests(listed.stdout), pushTarget);
	if (candidate === null) return null;

	const unresolvedThreads = candidate.lifecycle === "open"
		? await readUnresolvedReviewThreads(pi, context, candidate)
		: 0;
	const pullRequestConditions = conditions(candidate, unresolvedThreads);
	const local = await readLocalMergeSafety(pi, context, pushTarget.headOid, candidate.head.oid);
	const merge = candidate.lifecycle === "open" ? await readMergeMethods(pi, context, candidate) : null;
	return {
		id: candidate.id,
		number: candidate.number,
		url: candidate.url,
		host: candidate.url.hostname.toLowerCase(),
		approved: candidate.reviewDecision === "APPROVED",
		lifecycle: candidate.lifecycle,
		conditions: pullRequestConditions,
		local,
		base: candidate.base,
		head: {
			repository: pushTarget.repository.nameWithOwner,
			ref: candidate.head.ref,
			oid: candidate.head.oid,
		},
		merge,
	};
}
