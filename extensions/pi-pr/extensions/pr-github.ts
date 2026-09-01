import { lstat } from "node:fs/promises";
import { resolve } from "node:path";
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
const PR_SEARCH_CAP = 1_000;
const PR_FIELDS = "id,number,url,state,isDraft,baseRefName,baseRefOid,headRefName,headRefOid,headRepository,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup";
const REVIEW_THREADS_QUERY = "query($id:ID!,$endCursor:String){node(id:$id){...on PullRequest{reviewThreads(first:100,after:$endCursor){nodes{isResolved}pageInfo{hasNextPage endCursor}}}}}";
const BASE_BRANCH_POLICY_QUERY = "query($owner:String!,$name:String!,$qualifiedName:String!){repository(owner:$owner,name:$name){nameWithOwner ref(qualifiedName:$qualifiedName){name branchProtectionRule{requiresStrictStatusChecks}}}}";
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
const MERGE_METHODS: MergeMethod[] = ["merge", "rebase", "squash"];

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

export type PullRequestMerge = {
	allowedMergeMethods: MergeMethod[];
	viewerDefaultMergeMethod: MergeMethod;
};

export type CurrentPullRequest = PullRequest & {
	id: string;
	number: number;
	url: URL;
	host: string;
	approved: boolean;
	base: PullRequestRef;
	head: PullRequestRef;
	headFetchSource: string;
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

type PushUrl = {
	fetchSource: string;
	host: string;
	locator: string;
	normalizedName: string;
};

type PushTarget = {
	fetchSource: string;
	headOid: string;
	remoteHeadOid: string | null;
	repository: PushRepository;
	ref: string;
};

type RulesetBranchPolicy = {
	requiresStrictStatusChecks: boolean;
	allowedMergeMethods: MergeMethod[] | null;
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

function optionalPushReference(output: string): string | null {
	const normalized = output.replace(/\r\n/g, "\n");
	if (normalized === "\n") return null;
	if (!normalized) fail("Read push target", "invalid push target");
	return singleLine(normalized, "Read push target", "push target");
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
	if (result.killed || result.code !== 0) commandFailure(action, result);
	return result;
}

function parsePushReference(value: string, remoteNames: string[]): { remote: string; ref: string } {
	const remote = remoteNames
		.filter((name) => value.startsWith(`${name}/`))
		.sort((left, right) => right.length - left.length)[0];
	if (!remote) fail("Read push target", "target does not name a configured remote");
	const ref = value.slice(remote.length + 1);
	text(ref, "Read push target", "push ref");
	return { remote, ref };
}

function parsePushUrl(value: string): PushUrl {
	if (/[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(value)) return fail("Read push URL", "invalid push URL");
	const scp = /^(?:git@)?([a-z0-9.-]+):([a-z0-9_.-]+)\/([a-z0-9_.-]+)$/i.exec(value);
	const rawUrl = scp
		? null
		: /^(https|ssh):\/\/(?:(git)@)?([a-z0-9.-]+)\/([a-z0-9_.-]+)\/([a-z0-9_.-]+)\/?$/i.exec(value);
	if (!scp && (!rawUrl || (rawUrl[1]!.toLowerCase() === "https" && rawUrl[2]))) {
		return fail("Read push URL", "invalid push URL");
	}
	const host = (scp?.[1] ?? rawUrl![3])!;
	const owner = (scp?.[2] ?? rawUrl![4])!;
	const name = (scp?.[3] ?? rawUrl![5])!.replace(/\.git$/i, "");
	const normalizedHost = host.toLowerCase();
	if (
		!name || owner === "." || owner === ".." || name === "." || name === ".." ||
		normalizedHost.length > 253 || normalizedHost.split(".").some((label) =>
			!label || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label)
		)
	) fail("Read push URL", "invalid push URL");
	const normalizedName = normalizeRepository(`${owner}/${name}`);
	if (rawUrl) {
		let url: URL;
		try {
			url = new URL(value);
		} catch {
			return fail("Read push URL", "invalid push URL");
		}
		const path = /^\/([a-z0-9_.-]+)\/([a-z0-9_.-]+)\/?$/i.exec(url.pathname);
		if (
			url.protocol !== `${rawUrl[1]!.toLowerCase()}:` ||
			url.username !== (rawUrl[2] ?? "") || url.password || url.port || url.search || url.hash ||
			url.hostname.toLowerCase() !== normalizedHost || !path ||
			normalizeRepository(`${path[1]}/${path[2]!.replace(/\.git$/i, "")}`) !== normalizedName
		) return fail("Read push URL", "invalid push URL");
	}
	return {
		fetchSource: value,
		host: normalizedHost,
		locator: `${normalizedHost}/${normalizedName}`,
		normalizedName,
	};
}

function parsePushRepository(output: string, pushUrl: PushUrl): PushRepository {
	const value = parseJson(output, "Read push repository");
	if (!isRecord(value)) fail("Read push repository", "invalid GitHub CLI output");
	const nameWithOwner = repositoryName(value.nameWithOwner, "Read push repository", "nameWithOwner");
	const url = parseHttpUrl(value.url, "Read push repository", "url");
	const path = url.pathname.split("/").filter(Boolean);
	const normalizedName = normalizeRepository(nameWithOwner);
	const host = url.hostname.toLowerCase();
	if (
		path.length !== 2 || normalizeRepository(path.join("/")) !== normalizedName ||
		host !== pushUrl.host || normalizedName !== pushUrl.normalizedName
	) fail("Read push repository", "response does not match push URL");
	return { nameWithOwner, normalizedName, host };
}

function parseRemotePushRef(output: string, ref: string): string {
	const normalized = output.replace(/\r\n/g, "\n");
	const line = normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized;
	const parts = line.split("\t");
	if (line.includes("\n") || parts.length !== 2 || parts[1] !== `refs/heads/${ref}`) {
		fail("Read remote push ref", "response does not match push ref");
	}
	return oid(parts[0], "Read remote push ref", "OID");
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
	if (value === null || value === "") return null;
	if (typeof value !== "string" || !REVIEW_DECISION_VALUES.has(value)) {
		fail("Find pull requests", "invalid reviewDecision");
	}
	return value as ListedPullRequest["reviewDecision"];
}

function optionalCheckState(check: Record<string, unknown>, field: string): string | null {
	const value = check[field];
	if (value === undefined || value === null || value === "") return null;
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

function parseCandidateUrls(output: string, host: string): URL[] {
	const pages = parseJson(output, "Find pull requests");
	if (!Array.isArray(pages) || !pages.length) fail("Find pull requests", "invalid GitHub CLI output");
	let totalCount: number | null = null;
	let incomplete = false;
	const pageItems: unknown[][] = [];
	for (const page of pages) {
		if (
			!isRecord(page) || typeof page.total_count !== "number" ||
			!Number.isSafeInteger(page.total_count) || page.total_count < 0 ||
			typeof page.incomplete_results !== "boolean" || !Array.isArray(page.items)
		) fail("Find pull requests", "invalid GitHub CLI output");
		if (totalCount !== null && page.total_count !== totalCount) {
			fail("Find pull requests", "inconsistent search result pages");
		}
		totalCount = page.total_count;
		incomplete ||= page.incomplete_results;
		pageItems.push(page.items);
	}
	if (totalCount === null) fail("Find pull requests", "invalid GitHub CLI output");
	if (incomplete) fail("Find pull requests", "incomplete search results");
	if (totalCount > PR_SEARCH_CAP) fail("Find pull requests", "GitHub search result cap reached");
	const expectedPages = Math.max(1, Math.ceil(totalCount / PR_LIST_LIMIT));
	if (pageItems.length !== expectedPages || pageItems.some((items, index) =>
		items.length !== Math.min(PR_LIST_LIMIT, Math.max(0, totalCount - index * PR_LIST_LIMIT))
	)) fail("Find pull requests", "incomplete search results");
	const urls = pageItems.flat().map((candidate) => {
		if (!isRecord(candidate)) fail("Find pull requests", "invalid GitHub CLI output");
		const url = parseHttpUrl(candidate.html_url, "Find pull requests", "url");
		const path = url.pathname.split("/").filter(Boolean);
		if (
			url.hostname.toLowerCase() !== host || path.length !== 4 || path[2] !== "pull" ||
			!/^[1-9][0-9]*$/.test(path[3])
		) fail("Find pull requests", "invalid url");
		return url;
	});
	if (new Set(urls.map((url) => url.href.toLowerCase())).size !== urls.length) {
		fail("Find pull requests", "duplicate candidate url");
	}
	return urls;
}

function parseLoadedPullRequest(output: string, expectedUrl: URL): ListedPullRequest | null {
	const value = parseJson(output, "Find pull requests");
	const candidate = listedPullRequest(value);
	if (candidate !== null && candidate.url.href !== expectedUrl.href) {
		fail("Find pull requests", "response does not match candidate url");
	}
	return candidate;
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
	if (open.length === 1) {
		if (pushTarget.remoteHeadOid === null) fail("Find pull requests", "remote push ref is absent for open pull request");
		if (open[0].head.oid !== pushTarget.remoteHeadOid) {
			fail("Find pull requests", "open pull request head does not match remote push ref");
		}
		return open[0];
	}
	if (pushTarget.remoteHeadOid === null) return null;

	const historical = matching.filter((candidate) =>
		candidate.lifecycle !== "open" && candidate.head.oid === pushTarget.remoteHeadOid
	);
	if (historical.length > 1) fail("Find pull requests", "multiple historical pull requests match remote push ref");
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

function conditions(
	candidate: ListedPullRequest,
	unresolvedThreads: number,
	requiresStrictStatusChecks: boolean,
): PullRequestConditions {
	if (
		(candidate.mergeable === "MERGEABLE" && candidate.mergeStateStatus === "DIRTY") ||
		(candidate.mergeable === "CONFLICTING" && candidate.mergeStateStatus === "CLEAN")
	) fail("Find pull requests", "inconsistent mergeability data");
	const review: ReviewReadiness = candidate.reviewDecision === "REVIEW_REQUIRED" || candidate.reviewDecision === "CHANGES_REQUESTED"
		? "pending"
		: "ready";
	const behind = candidate.mergeStateStatus === "BEHIND";
	const policy: PolicyReadiness = candidate.mergeable === "MERGEABLE" &&
		(candidate.mergeStateStatus === "CLEAN" || (behind && !requiresStrictStatusChecks))
		? "ready"
		: "pending";
	return {
		draft: candidate.isDraft,
		baseUpdateRequired: behind && requiresStrictStatusChecks,
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
		if (!isRecord(page)) fail("Read unresolved review threads", "invalid GitHub CLI output");
		if (page.errors !== undefined) {
			if (!Array.isArray(page.errors)) fail("Read unresolved review threads", "invalid GitHub CLI output");
			if (page.errors.length) fail("Read unresolved review threads", "GitHub GraphQL returned errors");
		}
		if (!isRecord(page.data) || !isRecord(page.data.node)) {
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

function parseLegacyBaseBranchPolicy(output: string, candidate: ListedPullRequest): boolean {
	const value = parseJson(output, "Read base branch policy");
	if (!isRecord(value)) fail("Read base branch policy", "invalid GitHub CLI output");
	if (value.errors !== undefined) {
		if (!Array.isArray(value.errors)) fail("Read base branch policy", "invalid GitHub CLI output");
		if (value.errors.length) fail("Read base branch policy", "GitHub GraphQL returned errors");
	}
	const repository = isRecord(value.data) ? value.data.repository : undefined;
	if (!isRecord(repository) || !isRecord(repository.ref)) {
		fail("Read base branch policy", "invalid GitHub CLI output");
	}
	if (
		normalizeRepository(repositoryName(repository.nameWithOwner, "Read base branch policy", "repository")) !==
		normalizeRepository(candidate.base.repository) ||
		text(repository.ref.name, "Read base branch policy", "ref") !== candidate.base.ref
	) fail("Read base branch policy", "response does not match pull request base");
	const rule = repository.ref.branchProtectionRule;
	if (rule === null) return false;
	if (!isRecord(rule) || typeof rule.requiresStrictStatusChecks !== "boolean") {
		fail("Read base branch policy", "invalid GitHub CLI output");
	}
	return rule.requiresStrictStatusChecks;
}

function parseRulesetBaseBranchPolicy(output: string): RulesetBranchPolicy {
	const pages = parseJson(output, "Read base branch rulesets");
	if (!Array.isArray(pages) || !pages.length) fail("Read base branch rulesets", "invalid GitHub CLI output");
	let requiresStrictStatusChecks = false;
	let allowedMergeMethods: Set<MergeMethod> | null = null;
	for (const page of pages) {
		if (!Array.isArray(page)) fail("Read base branch rulesets", "invalid GitHub CLI output");
		for (const rule of page) {
			if (!isRecord(rule)) fail("Read base branch rulesets", "invalid GitHub CLI output");
			const type = text(rule.type, "Read base branch rulesets", "rule type");
			if (type === "required_status_checks") {
				if (!isRecord(rule.parameters) || typeof rule.parameters.strict_required_status_checks_policy !== "boolean") {
					fail("Read base branch rulesets", "invalid GitHub CLI output");
				}
				requiresStrictStatusChecks ||= rule.parameters.strict_required_status_checks_policy;
			}
			if (type === "pull_request") {
				if (!isRecord(rule.parameters) || !Array.isArray(rule.parameters.allowed_merge_methods)) {
					fail("Read base branch rulesets", "invalid GitHub CLI output");
				}
				const methods = rule.parameters.allowed_merge_methods;
				if (
					methods.some((method) => typeof method !== "string" || !MERGE_METHODS.includes(method as MergeMethod)) ||
					new Set(methods).size !== methods.length
				) fail("Read base branch rulesets", "invalid GitHub CLI output");
				const restriction = new Set<MergeMethod>(methods as MergeMethod[]);
				allowedMergeMethods = allowedMergeMethods === null
					? restriction
					: new Set<MergeMethod>([...allowedMergeMethods].filter((method: MergeMethod) => restriction.has(method)));
			}
		}
	}
	return {
		requiresStrictStatusChecks,
		allowedMergeMethods: allowedMergeMethods === null
			? null
			: MERGE_METHODS.filter((method) => allowedMergeMethods.has(method)),
	};
}

function parseMergeMethodSettings(output: string, rulesetMethods: MergeMethod[] | null): PullRequestMerge {
	const value = parseJson(output, "Read merge methods");
	if (!isRecord(value)) fail("Read merge methods", "invalid GitHub CLI output");
	const { mergeCommitAllowed, rebaseMergeAllowed, squashMergeAllowed } = value;
	if (
		typeof mergeCommitAllowed !== "boolean" || typeof rebaseMergeAllowed !== "boolean" ||
		typeof squashMergeAllowed !== "boolean"
	) fail("Read merge methods", "invalid GitHub CLI output");
	let allowedMergeMethods: MergeMethod[] = [];
	if (mergeCommitAllowed) allowedMergeMethods.push("merge");
	if (rebaseMergeAllowed) allowedMergeMethods.push("rebase");
	if (squashMergeAllowed) allowedMergeMethods.push("squash");
	if (!allowedMergeMethods.length) fail("Read merge methods", "repository allows no merge method");
	const viewerDefaultMergeMethod = value.viewerDefaultMergeMethod === "MERGE"
		? "merge"
		: value.viewerDefaultMergeMethod === "REBASE"
		? "rebase"
		: value.viewerDefaultMergeMethod === "SQUASH"
		? "squash"
		: fail("Read merge methods", "invalid viewerDefaultMergeMethod");
	if (!allowedMergeMethods.includes(viewerDefaultMergeMethod)) {
		fail("Read merge methods", "viewerDefaultMergeMethod is not allowed");
	}
	if (rulesetMethods !== null) {
		allowedMergeMethods = allowedMergeMethods.filter((method) => rulesetMethods.includes(method));
	}
	if (!allowedMergeMethods.length) {
		fail("Read merge methods", "repository and applicable rules allow no common merge method");
	}
	return { allowedMergeMethods, viewerDefaultMergeMethod };
}

async function readPushTarget(
	pi: Pick<ExtensionAPI, "exec">,
	context: PullRequestLoadContext,
): Promise<PushTarget | null> {
	const branch = singleLine(
		(await execute(pi, context, "Read current branch", "git", ["branch", "--show-current"])).stdout,
		"Read current branch",
		"branch",
	);
	const headOid = oid(
		singleLine((await execute(pi, context, "Read current HEAD", "git", ["rev-parse", "--verify", "HEAD^{commit}"])).stdout, "Read current HEAD", "HEAD"),
		"Read current HEAD",
		"HEAD",
	);
	const pushReference = optionalPushReference(
		(await execute(pi, context, "Read push target", "git", [
			"for-each-ref",
			"--format=%(push:short)",
			`refs/heads/${branch}`,
		])).stdout,
	);
	if (pushReference === null) return null;
	const remoteNames = lines(
		(await execute(pi, context, "Read push remotes", "git", ["remote"])).stdout,
		"Read push remotes",
		"remote",
	);
	const push = parsePushReference(pushReference, remoteNames);
	const checkedRef = singleLine(
		(await execute(pi, context, "Read push target", "git", ["check-ref-format", "--branch", push.ref])).stdout,
		"Read push target",
		"push ref",
	);
	if (checkedRef !== push.ref) fail("Read push target", "invalid push ref");
	const pushUrls = lines(
		(await execute(pi, context, "Read push URL", "git", ["remote", "get-url", "--push", "--all", push.remote])).stdout,
		"Read push URL",
		"push URL",
	);
	if (pushUrls.length !== 1) fail("Read push URL", "multiple push URLs are configured");
	const pushUrl = parsePushUrl(pushUrls[0]);
	const repository = parsePushRepository((await execute(
		pi,
		context,
		"Read push repository",
		"gh",
		["repo", "view", pushUrl.locator, "--json", "nameWithOwner,url"],
	)).stdout, pushUrl);
	const remoteHead = await invoke(pi, context, "Read remote push ref", "git", [
		"ls-remote",
		"--exit-code",
		"--refs",
		pushUrl.fetchSource,
		`refs/heads/${push.ref}`,
	]);
	let remoteHeadOid: string | null;
	if (remoteHead.killed) commandFailure("Read remote push ref", remoteHead);
	if (remoteHead.code === 2) {
		if (remoteHead.stdout !== "") fail("Read remote push ref", "invalid absent-ref response");
		remoteHeadOid = null;
	} else {
		if (remoteHead.code !== 0) commandFailure("Read remote push ref", remoteHead);
		remoteHeadOid = parseRemotePushRef(remoteHead.stdout, push.ref);
	}
	return { fetchSource: pushUrl.fetchSource, headOid, remoteHeadOid, repository, ref: push.ref };
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

async function readLegacyBaseBranchPolicy(
	pi: Pick<ExtensionAPI, "exec">,
	context: PullRequestLoadContext,
	candidate: ListedPullRequest,
): Promise<boolean> {
	const [owner, name] = candidate.base.repository.split("/");
	const result = await execute(pi, context, "Read base branch policy", "gh", [
		"api",
		"graphql",
		"--hostname",
		candidate.url.hostname,
		"-f",
		`query=${BASE_BRANCH_POLICY_QUERY}`,
		"-F",
		`owner=${owner}`,
		"-F",
		`name=${name}`,
		"-F",
		`qualifiedName=refs/heads/${candidate.base.ref}`,
	]);
	return parseLegacyBaseBranchPolicy(result.stdout, candidate);
}

async function readRulesetBaseBranchPolicy(
	pi: Pick<ExtensionAPI, "exec">,
	context: PullRequestLoadContext,
	candidate: ListedPullRequest,
): Promise<RulesetBranchPolicy> {
	const [owner, name] = candidate.base.repository.split("/");
	const result = await execute(pi, context, "Read base branch rulesets", "gh", [
		"api",
		"--hostname",
		candidate.url.hostname,
		"--paginate",
		"--slurp",
		"-H",
		"Accept: application/vnd.github+json",
		"-H",
		"X-GitHub-Api-Version: 2022-11-28",
		`repos/${owner}/${name}/rules/branches/${encodeURIComponent(candidate.base.ref)}`,
	]);
	return parseRulesetBaseBranchPolicy(result.stdout);
}

async function readLocalMergeSafety(
	pi: Pick<ExtensionAPI, "exec">,
	context: PullRequestLoadContext,
	pushTarget: PushTarget,
	pullRequestHead: string,
): Promise<LocalMergeSafety> {
	const status = await execute(pi, context, "Read worktree status", "git", [
		"status",
		"--porcelain=v1",
		"--untracked-files=all",
	]);
	const operationStates = ["MERGE_HEAD", "rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD", "REVERT_HEAD", "sequencer"];
	const statePaths = lines(
		(await execute(pi, context, "Read Git operation state", "git", [
			"rev-parse",
			...operationStates.flatMap((state) => ["--git-path", state]),
		])).stdout,
		"Read Git operation state",
		"state path",
	);
	if (statePaths.length !== operationStates.length) fail("Read Git operation state", "invalid state paths");
	let operationInProgress = false;
	for (const [index, path] of statePaths.entries()) {
		try {
			await lstat(resolve(context.cwd, path));
			operationInProgress = true;
		} catch (error) {
			if (isRecord(error) && error.code === "ENOENT") continue;
			const code = isRecord(error) && typeof error.code === "string" ? error.code : "filesystem error";
			fail("Read Git operation state", `cannot inspect ${operationStates[index]}: ${code}`);
		}
	}
	const worktree = status.stdout === "" && !operationInProgress ? "clean" : "dirty";

	await execute(pi, context, "Fetch pull request head", "git", [
		"fetch",
		"--no-write-fetch-head",
		"--no-tags",
		"--no-recurse-submodules",
		pushTarget.fetchSource,
		pullRequestHead,
	]);
	await execute(pi, context, "Verify pull request head", "git", ["cat-file", "-e", `${pullRequestHead}^{commit}`]);
	if (pushTarget.headOid === pullRequestHead) return { worktree, head: "equal" };

	const localIsAncestor = await invoke(pi, context, "Compare pull request head", "git", [
		"merge-base",
		"--is-ancestor",
		pushTarget.headOid,
		pullRequestHead,
	]);
	if (localIsAncestor.killed) commandFailure("Compare pull request head", localIsAncestor);
	if (localIsAncestor.code === 0) return { worktree, head: "behind" };
	if (localIsAncestor.code !== 1) commandFailure("Compare pull request head", localIsAncestor);

	const pullRequestIsAncestor = await invoke(pi, context, "Compare pull request head", "git", [
		"merge-base",
		"--is-ancestor",
		pullRequestHead,
		pushTarget.headOid,
	]);
	if (pullRequestIsAncestor.killed) commandFailure("Compare pull request head", pullRequestIsAncestor);
	if (pullRequestIsAncestor.code === 0) return { worktree, head: "ahead" };
	if (pullRequestIsAncestor.code === 1) return { worktree, head: "diverged" };
	return commandFailure("Compare pull request head", pullRequestIsAncestor);
}

async function readMergeMethods(
	pi: Pick<ExtensionAPI, "exec">,
	context: PullRequestLoadContext,
	candidate: ListedPullRequest,
	rulesetMethods: MergeMethod[] | null,
): Promise<PullRequestMerge> {
	const result = await execute(pi, context, "Read merge methods", "gh", [
		"repo",
		"view",
		`${candidate.url.hostname}/${candidate.base.repository}`,
		"--json",
		"mergeCommitAllowed,rebaseMergeAllowed,squashMergeAllowed,viewerDefaultMergeMethod",
	]);
	return parseMergeMethodSettings(result.stdout, rulesetMethods);
}

export async function loadCurrentPullRequest(
	pi: Pick<ExtensionAPI, "exec">,
	context: PullRequestLoadContext,
): Promise<CurrentPullRequest | null> {
	const pushTarget = await readPushTarget(pi, context);
	if (pushTarget === null) return null;
	const [headOwner] = pushTarget.repository.nameWithOwner.split("/");
	const search = await execute(pi, context, "Find pull requests", "gh", [
		"api",
		"search/issues",
		"--hostname",
		pushTarget.repository.host,
		"--paginate",
		"--slurp",
		"-X",
		"GET",
		"-f",
		`q=is:pr head:${headOwner}:${pushTarget.ref}`,
		"-f",
		`per_page=${PR_LIST_LIMIT}`,
	]);
	const candidates: ListedPullRequest[] = [];
	for (const url of parseCandidateUrls(search.stdout, pushTarget.repository.host)) {
		const loaded = await execute(pi, context, "Find pull requests", "gh", [
			"pr",
			"view",
			url.href,
			"--json",
			PR_FIELDS,
		]);
		const candidate = parseLoadedPullRequest(loaded.stdout, url);
		if (candidate !== null) candidates.push(candidate);
	}
	const candidate = selectPullRequest(candidates, pushTarget);
	if (candidate === null) return null;
	await execute(pi, context, "Validate pull request base ref", "git", [
		"check-ref-format",
		`refs/heads/${candidate.base.ref}`,
	]);

	const unresolvedThreads = candidate.lifecycle === "open"
		? await readUnresolvedReviewThreads(pi, context, candidate)
		: 0;
	const rulesetPolicy = candidate.lifecycle === "open"
		? await readRulesetBaseBranchPolicy(pi, context, candidate)
		: null;
	const legacyStrict = candidate.lifecycle === "open" && candidate.mergeStateStatus === "BEHIND"
		? await readLegacyBaseBranchPolicy(pi, context, candidate)
		: false;
	const requiresStrictStatusChecks = legacyStrict || (rulesetPolicy?.requiresStrictStatusChecks ?? false);
	const pullRequestConditions = conditions(candidate, unresolvedThreads, requiresStrictStatusChecks);
	const local = await readLocalMergeSafety(pi, context, pushTarget, candidate.head.oid);
	const merge = candidate.lifecycle === "open"
		? await readMergeMethods(pi, context, candidate, rulesetPolicy?.allowedMergeMethods ?? null)
		: null;
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
		head: candidate.head,
		headFetchSource: pushTarget.fetchSource,
		merge,
	};
}
