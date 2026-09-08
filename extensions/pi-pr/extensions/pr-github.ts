import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { lstatSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { inspectLocalMergeSafety } from "./pr-merge.ts";
import type {
	CiStatus,
	LocalMergeSafety,
	PullRequest,
	PullRequestConditions,
	PullRequestDiscovery,
	PullRequestLifecycle,
	PullRequestTarget,
	ReviewReadiness,
	PolicyReadiness,
} from "./pr-routing.ts";

const EXEC_TIMEOUT_MS = 10_000;
const PR_SEARCH_PAGE_SIZE = 100;
const PR_SEARCH_CAP = 1_000;
const PR_SEARCH_MAX_PAGES = PR_SEARCH_CAP / PR_SEARCH_PAGE_SIZE;
const PR_FIELDS = "id,number,url,state,isDraft,baseRefName,baseRefOid,headRefName,headRefOid,headRepository,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup";
const PR_SEARCH_QUERY = "query($searchQuery:String!,$endCursor:String){search(query:$searchQuery,type:ISSUE,first:100,after:$endCursor){issueCount edges{cursor node{__typename ...on PullRequest{number url state baseRepository{nameWithOwner}headRepository{nameWithOwner}headRefName headRefOid}}}pageInfo{hasNextPage startCursor endCursor}}}";
const REVIEW_THREADS_QUERY = "query($id:ID!,$endCursor:String){node(id:$id){...on PullRequest{reviewThreads(first:100,after:$endCursor){nodes{isResolved}pageInfo{hasNextPage endCursor}}}}}";
const BASE_REF_QUERY = "query($owner:String!,$name:String!,$qualifiedName:String!){repository(owner:$owner,name:$name){nameWithOwner ref(qualifiedName:$qualifiedName){name target{oid}}}}";
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
	target: PullRequestTarget;
	merge: PullRequestMerge | null;
};

export type CurrentPullRequestDiscovery = PullRequestDiscovery<CurrentPullRequest>;

export type PullRequestObservation = {
	pullRequest: { url: string; number: number; host: string };
	head: PullRequestRef;
	target: { repository: string; branch: string; remote: string; ref: string };
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
	provenance: "configured" | "inferred";
	branch: string;
	remote: string;
	fetchSource: string;
	remoteHeadOid: string | null;
	repository: PushRepository;
	ref: string;
};

type TargetReadResult =
	| { kind: "target"; target: PushTarget }
	| { kind: "missing"; branch: string; remoteNames: string[] }
	| { kind: "blocked"; issue: "detached" | "target" }
	| { kind: "inactive" };

type LinkConfiguration = {
	upstreamRemote: string[];
	upstreamMerge: string[];
	pushRemote: string[];
	pushDefaultRemote: string[];
	pushRefspec: string[];
	pushDefault: string[];
	mirror: string[];
};

type SearchPullRequest = {
	number: number;
	url: URL;
	lifecycle: PullRequestLifecycle;
	baseRepository: string;
	headRepository: string | null;
	headRef: string;
	headOid: string;
};

type SearchSelection =
	| { kind: "candidate"; candidate: SearchPullRequest; pullRequest: ListedPullRequest | null }
	| { kind: "none" }
	| { kind: "ambiguous"; urls: URL[] }
	| { kind: "oid-mismatch"; urls: URL[] }
	| { kind: "target-invalid" };

type SearchPage = {
	issueCount: number;
	candidates: SearchPullRequest[];
	cursors: string[];
	hasNextPage: boolean;
	endCursor: string | null;
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

function hasRepositoryMarker(cwd: string): boolean {
	for (let directory = resolve(cwd);; directory = dirname(directory)) {
		try {
			lstatSync(join(directory, ".git"));
			return true;
		} catch (error) {
			if (
				!isRecord(error) || typeof error.code !== "string" ||
				(error.code !== "ENOENT" && error.code !== "ENOTDIR")
			) return true;
		}
		if (dirname(directory) === directory) return false;
	}
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

function parseRemoteUrl(value: string, kind: "push" | "fetch"): PushUrl {
	const action = `Read ${kind} URL`;
	if (/[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(value)) return fail(action, `invalid ${kind} URL`);
	const scp = /^(?:git@)?([a-z0-9.-]+):([a-z0-9_.-]+)\/([a-z0-9_.-]+)$/i.exec(value);
	const rawUrl = scp
		? null
		: /^(https|ssh):\/\/(?:(git)@)?([a-z0-9.-]+)\/([a-z0-9_.-]+)\/([a-z0-9_.-]+)\/?$/i.exec(value);
	if (!scp && (!rawUrl || (rawUrl[1]!.toLowerCase() === "https" && rawUrl[2]))) {
		return fail(action, `invalid ${kind} URL`);
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
	) fail(action, `invalid ${kind} URL`);
	const normalizedName = normalizeRepository(`${owner}/${name}`);
	if (rawUrl) {
		let url: URL;
		try {
			url = new URL(value);
		} catch {
			return fail(action, `invalid ${kind} URL`);
		}
		const path = /^\/([a-z0-9_.-]+)\/([a-z0-9_.-]+)\/?$/i.exec(url.pathname);
		if (
			url.protocol !== `${rawUrl[1]!.toLowerCase()}:` ||
			url.username !== (rawUrl[2] ?? "") || url.password || url.port || url.search || url.hash ||
			url.hostname.toLowerCase() !== normalizedHost || !path ||
			normalizeRepository(`${path[1]}/${path[2]!.replace(/\.git$/i, "")}`) !== normalizedName
		) return fail(action, `invalid ${kind} URL`);
	}
	return {
		fetchSource: value,
		host: normalizedHost,
		locator: `${normalizedHost}/${normalizedName}`,
		normalizedName,
	};
}

function parseRemoteRepository(output: string, remoteUrl: PushUrl, kind: "push" | "fetch"): PushRepository {
	const action = `Read ${kind} repository`;
	const value = parseJson(output, action);
	if (!isRecord(value)) fail(action, "invalid GitHub CLI output");
	const nameWithOwner = repositoryName(value.nameWithOwner, action, "nameWithOwner");
	const url = parseHttpUrl(value.url, action, "url");
	const path = url.pathname.split("/").filter(Boolean);
	const normalizedName = normalizeRepository(nameWithOwner);
	const host = url.hostname.toLowerCase();
	if (
		path.length !== 2 || normalizeRepository(path.join("/")) !== normalizedName ||
		host !== remoteUrl.host || normalizedName !== remoteUrl.normalizedName
	) fail(action, `response does not match ${kind} URL`);
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

export function parsePullRequestObservation(value: unknown): PullRequestObservation | null {
	try {
		if (!isRecord(value) || !isRecord(value.pullRequest) || !isRecord(value.head) || !isRecord(value.target)) {
			return null;
		}
		const number = value.pullRequest.number;
		if (typeof number !== "number" || !Number.isSafeInteger(number) || number <= 0) return null;
		const parsedUrl = parsePullRequestUrl(value.pullRequest.url, number).url;
		const host = text(value.pullRequest.host, "Read pull request observation", "host").toLowerCase();
		if (parsedUrl.hostname.toLowerCase() !== host) return null;
		return {
			pullRequest: { url: parsedUrl.href, number, host },
			head: {
				repository: repositoryName(value.head.repository, "Read pull request observation", "head repository"),
				ref: text(value.head.ref, "Read pull request observation", "head ref"),
				oid: oid(value.head.oid, "Read pull request observation", "head OID"),
			},
			target: {
				repository: repositoryName(value.target.repository, "Read pull request observation", "target repository"),
				branch: text(value.target.branch, "Read pull request observation", "target branch"),
				remote: text(value.target.remote, "Read pull request observation", "target remote"),
				ref: text(value.target.ref, "Read pull request observation", "target ref"),
			},
		};
	} catch (error) {
		if (error instanceof PullRequestLoadError) return null;
		throw error;
	}
}

export function pullRequestObservation(pullRequest: CurrentPullRequest): PullRequestObservation | null {
	if (pullRequest.target.provenance !== "configured") return null;
	return {
		pullRequest: {
			url: pullRequest.url.href,
			number: pullRequest.number,
			host: pullRequest.host,
		},
		head: { ...pullRequest.head },
		target: {
			repository: pullRequest.target.repository,
			branch: pullRequest.target.branch,
			remote: pullRequest.target.remote,
			ref: pullRequest.target.ref,
		},
	};
}

export function samePullRequestObservation(
	left: PullRequestObservation | undefined,
	right: PullRequestObservation,
): boolean {
	return left !== undefined && left.pullRequest.url === right.pullRequest.url &&
		left.pullRequest.number === right.pullRequest.number && left.pullRequest.host === right.pullRequest.host &&
		normalizeRepository(left.head.repository) === normalizeRepository(right.head.repository) &&
		left.head.ref === right.head.ref && left.head.oid === right.head.oid &&
		normalizeRepository(left.target.repository) === normalizeRepository(right.target.repository) &&
		left.target.branch === right.target.branch && left.target.remote === right.target.remote &&
		left.target.ref === right.target.ref;
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

function searchPullRequest(value: unknown, host: string): SearchPullRequest {
	if (!isRecord(value) || value.__typename !== "PullRequest") {
		fail("Find pull requests", "invalid GitHub CLI output");
	}
	const number = value.number;
	if (typeof number !== "number" || !Number.isSafeInteger(number) || number <= 0) {
		fail("Find pull requests", "invalid number");
	}
	const parsedUrl = parsePullRequestUrl(value.url, number);
	if (parsedUrl.url.hostname.toLowerCase() !== host) fail("Find pull requests", "invalid url");
	if (!isRecord(value.baseRepository)) fail("Find pull requests", "invalid baseRepository");
	const baseRepository = repositoryName(
		value.baseRepository.nameWithOwner,
		"Find pull requests",
		"baseRepository.nameWithOwner",
	);
	if (normalizeRepository(baseRepository) !== normalizeRepository(parsedUrl.repository)) {
		fail("Find pull requests", "base repository does not match url");
	}
	let headRepository: string | null;
	if (value.headRepository === null) {
		headRepository = null;
	} else {
		if (!isRecord(value.headRepository)) fail("Find pull requests", "invalid headRepository");
		headRepository = repositoryName(
			value.headRepository.nameWithOwner,
			"Find pull requests",
			"headRepository.nameWithOwner",
		);
	}
	return {
		number,
		url: parsedUrl.url,
		lifecycle: lifecycle(value.state),
		baseRepository,
		headRepository,
		headRef: text(value.headRefName, "Find pull requests", "headRefName"),
		headOid: oid(value.headRefOid, "Find pull requests", "headRefOid"),
	};
}

function parseSearchPage(output: string, host: string): SearchPage {
	const page = parseJson(output, "Find pull requests");
	if (!isRecord(page)) fail("Find pull requests", "invalid GitHub CLI output");
	if (page.errors !== undefined) {
		if (!Array.isArray(page.errors)) fail("Find pull requests", "invalid GitHub CLI output");
		if (page.errors.length) fail("Find pull requests", "GitHub GraphQL returned errors");
	}
	const search = isRecord(page.data) ? page.data.search : undefined;
	if (
		!isRecord(search) || typeof search.issueCount !== "number" ||
		!Number.isSafeInteger(search.issueCount) || search.issueCount < 0 ||
		!Array.isArray(search.edges) || search.edges.length > PR_SEARCH_PAGE_SIZE ||
		!isRecord(search.pageInfo)
	) fail("Find pull requests", "invalid GitHub CLI output");
	const candidates: SearchPullRequest[] = [];
	const cursors: string[] = [];
	for (const edge of search.edges) {
		if (!isRecord(edge)) fail("Find pull requests", "invalid GitHub CLI output");
		cursors.push(text(edge.cursor, "Find pull requests", "cursor"));
		candidates.push(searchPullRequest(edge.node, host));
	}
	if (new Set(cursors).size !== cursors.length) fail("Find pull requests", "duplicate candidate cursor");
	const { hasNextPage, startCursor, endCursor } = search.pageInfo;
	if (typeof hasNextPage !== "boolean") fail("Find pull requests", "invalid search pageInfo");
	if (cursors.length === 0) {
		if (startCursor !== null || endCursor !== null) fail("Find pull requests", "invalid search pageInfo");
	} else if (startCursor !== cursors[0] || endCursor !== cursors.at(-1)) {
		fail("Find pull requests", "invalid search pageInfo");
	}
	return {
		issueCount: search.issueCount,
		candidates,
		cursors,
		hasNextPage,
		endCursor: endCursor === null ? null : text(endCursor, "Find pull requests", "endCursor"),
	};
}

function matchingSearchPullRequests(candidates: SearchPullRequest[], pushTarget: PushTarget): SearchPullRequest[] {
	return candidates.filter((candidate) =>
		candidate.url.hostname.toLowerCase() === pushTarget.repository.host &&
		candidate.headRepository !== null &&
		normalizeRepository(candidate.headRepository) === pushTarget.repository.normalizedName &&
		candidate.headRef === pushTarget.ref
	);
}

function selectSearchPullRequest(candidates: SearchPullRequest[], pushTarget: PushTarget): SearchSelection {
	const matching = matchingSearchPullRequests(candidates, pushTarget);
	const open = matching.filter((candidate) => candidate.lifecycle === "open");
	if (open.length > 1) return { kind: "ambiguous", urls: open.map(({ url }) => url) };
	if (open.length === 1) {
		if (pushTarget.remoteHeadOid === null) return { kind: "target-invalid" };
		if (open[0].headOid !== pushTarget.remoteHeadOid) return { kind: "oid-mismatch", urls: [open[0].url] };
		return { kind: "candidate", candidate: open[0], pullRequest: null };
	}
	if (pushTarget.provenance === "inferred" || pushTarget.remoteHeadOid === null) return { kind: "none" };
	const historical = matching.filter((candidate) => candidate.headOid === pushTarget.remoteHeadOid);
	if (historical.length > 1) return { kind: "ambiguous", urls: historical.map(({ url }) => url) };
	return historical.length === 1
		? { kind: "candidate", candidate: historical[0], pullRequest: null }
		: { kind: "none" };
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

function parseBaseRefOid(output: string, candidate: ListedPullRequest): string {
	const value = parseJson(output, "Read base ref");
	if (!isRecord(value)) fail("Read base ref", "invalid GitHub CLI output");
	if (value.errors !== undefined) {
		if (!Array.isArray(value.errors)) fail("Read base ref", "invalid GitHub CLI output");
		if (value.errors.length) fail("Read base ref", "GitHub GraphQL returned errors");
	}
	const repository = isRecord(value.data) ? value.data.repository : undefined;
	if (!isRecord(repository) || !isRecord(repository.ref) || !isRecord(repository.ref.target)) {
		fail("Read base ref", "invalid GitHub CLI output");
	}
	if (
		normalizeRepository(repositoryName(repository.nameWithOwner, "Read base ref", "repository")) !==
		normalizeRepository(candidate.base.repository) ||
		text(repository.ref.name, "Read base ref", "ref") !== candidate.base.ref
	) fail("Read base ref", "response does not match pull request base");
	return oid(repository.ref.target.oid, "Read base ref", "target OID");
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

export async function hasLocalCommit(
	pi: Pick<ExtensionAPI, "exec">,
	context: PullRequestLoadContext,
): Promise<boolean> {
	const branch = singleLine(
		(await execute(pi, context, "Read current branch", "git", ["branch", "--show-current"])).stdout,
		"Read current branch",
		"branch",
	);
	const output = (await execute(pi, context, "Read branch history", "git", [
		"reflog",
		"show",
		"--format=%H",
		`refs/heads/${branch}`,
	])).stdout.replace(/\r\n/g, "\n");
	const entries = output.split("\n");
	if (entries.at(-1) === "") entries.pop();
	if (!entries.length) fail("Read branch history", "missing branch creation entry");
	const commits = entries.map((entry) => oid(entry, "Read branch history", "commit"));
	// ponytail: reflog expiry can hide old branch history; resolve the PR base if this becomes observable.
	return commits[0] !== commits.at(-1);
}

async function readRemoteAuthority(
	pi: Pick<ExtensionAPI, "exec">,
	context: PullRequestLoadContext,
	remote: string,
	strict = false,
): Promise<{ fetchSource: string; repository: PushRepository } | null> {
	try {
		const readUrl = async (kind: "push" | "fetch"): Promise<PushUrl> => {
			const action = `Read ${kind} URL`;
			const args = kind === "push"
				? ["remote", "get-url", "--push", "--all", remote]
				: ["remote", "get-url", "--all", remote];
			const result = await invoke(pi, context, action, "git", args);
			if (result.killed || result.code !== 0) commandFailure(action, result);
			const urls = lines(result.stdout, action, `${kind} URL`);
			if (urls.length !== 1) fail(action, `multiple ${kind} URLs are configured`);
			return parseRemoteUrl(urls[0], kind);
		};
		const readRepository = async (remoteUrl: PushUrl, kind: "push" | "fetch"): Promise<PushRepository> => {
			const action = `Read ${kind} repository`;
			const result = await execute(pi, context, action, "gh", [
				"repo", "view", remoteUrl.locator, "--json", "nameWithOwner,url",
			]);
			return parseRemoteRepository(result.stdout, remoteUrl, kind);
		};

		const pushUrl = await readUrl("push");
		const pushRepository = await readRepository(pushUrl, "push");
		const fetchUrl = await readUrl("fetch");
		const fetchRepository = await readRepository(fetchUrl, "fetch");
		if (
			fetchRepository.host !== pushRepository.host ||
			fetchRepository.normalizedName !== pushRepository.normalizedName
		) fail("Read fetch repository", "fetch and push repositories do not match");
		return { fetchSource: pushUrl.fetchSource, repository: pushRepository };
	} catch (error) {
		if (!strict && error instanceof PullRequestLoadError) return null;
		throw error;
	}
}

async function readRemoteHeadOid(
	pi: Pick<ExtensionAPI, "exec">,
	context: PullRequestLoadContext,
	fetchSource: string,
	ref: string,
): Promise<string | null> {
	const remoteHead = await invoke(pi, context, "Read remote push ref", "git", [
		"ls-remote",
		"--exit-code",
		"--refs",
		fetchSource,
		`refs/heads/${ref}`,
	]);
	if (remoteHead.killed) commandFailure("Read remote push ref", remoteHead);
	if (remoteHead.code === 2) {
		if (remoteHead.stdout !== "") fail("Read remote push ref", "invalid absent-ref response");
		return null;
	}
	if (remoteHead.code !== 0) commandFailure("Read remote push ref", remoteHead);
	return parseRemotePushRef(remoteHead.stdout, ref);
}

async function readConfigValues(
	pi: Pick<ExtensionAPI, "exec">,
	context: PullRequestLoadContext,
	key: string,
): Promise<string[] | null> {
	const result = await invoke(pi, context, "Read Git configuration", "git", ["config", "--get-all", key]);
	if (result.killed) commandFailure("Read Git configuration", result);
	if (result.code === 1 && result.stdout === "") return [];
	if (result.code !== 0) commandFailure("Read Git configuration", result);
	try {
		return lines(result.stdout, "Read Git configuration", "value");
	} catch (error) {
		if (error instanceof PullRequestLoadError) return null;
		throw error;
	}
}

async function readBooleanConfigValues(
	pi: Pick<ExtensionAPI, "exec">,
	context: PullRequestLoadContext,
	key: string,
): Promise<string[] | null> {
	const result = await invoke(pi, context, "Read Git configuration", "git", [
		"config", "--type=bool", "--get-all", key,
	]);
	if (result.killed) commandFailure("Read Git configuration", result);
	if (result.code === 1 && result.stdout === "") return [];
	if (result.code !== 0) return null;
	try {
		const values = lines(result.stdout, "Read Git configuration", "boolean value");
		return values.every((value) => value === "true" || value === "false") ? values : null;
	} catch (error) {
		if (error instanceof PullRequestLoadError) return null;
		throw error;
	}
}

async function readLinkConfiguration(
	pi: Pick<ExtensionAPI, "exec">,
	context: PullRequestLoadContext,
	target: PushTarget,
): Promise<LinkConfiguration | null> {
	const [upstreamRemote, upstreamMerge, pushRemote, pushDefaultRemote, pushRefspec, pushDefault, mirror] =
		await Promise.all([
			`branch.${target.branch}.remote`,
			`branch.${target.branch}.merge`,
			`branch.${target.branch}.pushRemote`,
			"remote.pushDefault",
			`remote.${target.remote}.push`,
			"push.default",
		].map((key) => readConfigValues(pi, context, key)).concat([
			readBooleanConfigValues(pi, context, `remote.${target.remote}.mirror`),
		]));
	if ([upstreamRemote, upstreamMerge, pushRemote, pushDefaultRemote, pushRefspec, pushDefault, mirror]
		.some((value) => value === null)) return null;
	return {
		upstreamRemote: upstreamRemote!,
		upstreamMerge: upstreamMerge!,
		pushRemote: pushRemote!,
		pushDefaultRemote: pushDefaultRemote!,
		pushRefspec: pushRefspec!,
		pushDefault: pushDefault!,
		mirror: mirror!,
	};
}

function canLinkTarget(configuration: LinkConfiguration | null, target: PushTarget): boolean {
	if (!configuration) return false;
	const { upstreamRemote, upstreamMerge, pushRemote, pushDefaultRemote, pushRefspec, pushDefault, mirror } = configuration;
	if (upstreamRemote.length || upstreamMerge.length || pushRefspec.length) return false;
	if (pushRemote.length > 1 || (pushRemote[0] !== undefined && pushRemote[0] !== target.remote)) return false;
	if (pushDefaultRemote.length > 1 || (pushDefaultRemote[0] !== undefined && pushDefaultRemote[0] !== target.remote)) return false;
	if (mirror.length > 1 || mirror[0] === "true") return false;
	return pushDefault.length === 0 || (pushDefault.length === 1 && pushDefault[0] === "simple");
}

function publicTarget(target: PushTarget): PullRequestTarget {
	return {
		provenance: target.provenance,
		branch: target.branch,
		remote: target.remote,
		ref: target.ref,
		repository: target.repository.nameWithOwner,
		host: target.repository.host,
		fetchSource: target.fetchSource,
		remoteOid: target.remoteHeadOid,
	};
}

async function readPushTarget(
	pi: Pick<ExtensionAPI, "exec">,
	context: PullRequestLoadContext,
): Promise<TargetReadResult> {
	const worktree = await invoke(pi, context, "Check Git worktree", "git", ["rev-parse", "--is-inside-work-tree"]);
	if (worktree.killed) commandFailure("Check Git worktree", worktree);
	const worktreeOutput = worktree.stdout.replace(/\r\n/g, "\n");
	if (worktree.code === 128 && worktreeOutput === "") {
		const probe = await invoke(pi, context, "Classify Git worktree", "env", [
			"LC_ALL=C",
			"LANG=C",
			"GIT_DISCOVERY_ACROSS_FILESYSTEM=1",
			"git",
			"-c",
			"safe.directory=*",
			"rev-parse",
			"--is-inside-work-tree",
		]);
		if (probe.killed) commandFailure("Classify Git worktree", probe);
		if (
			probe.code === 128 && probe.stdout === "" &&
			probe.stderr.replace(/\r\n/g, "\n") ===
				"fatal: not a git repository (or any of the parent directories): .git\n" &&
			!hasRepositoryMarker(context.cwd) && !process.env.GIT_DIR && !process.env.GIT_WORK_TREE
		) return { kind: "inactive" };
		commandFailure("Check Git worktree", worktree);
	}
	if (worktree.code === 0 && worktreeOutput === "false\n") return { kind: "inactive" };
	if (worktree.code !== 0) commandFailure("Check Git worktree", worktree);
	if (worktreeOutput !== "true\n") fail("Check Git worktree", "invalid response");

	const branchResult = await execute(pi, context, "Read current branch", "git", ["branch", "--show-current"]);
	if (branchResult.stdout === "") return { kind: "blocked", issue: "detached" };
	let branch: string;
	try {
		branch = singleLine(branchResult.stdout, "Read current branch", "branch");
	} catch (error) {
		if (error instanceof PullRequestLoadError) return { kind: "blocked", issue: "target" };
		throw error;
	}
	const pushResult = await execute(pi, context, "Read push target", "git", [
		"for-each-ref",
		"--format=%(push:short)",
		`refs/heads/${branch}`,
	]);
	const pushReference = optionalPushReference(pushResult.stdout);
	const remotesResult = await execute(pi, context, "Read push remotes", "git", ["remote"]);
	const normalizedRemotes = remotesResult.stdout.replace(/\r\n/g, "\n");
	const remoteNames = normalizedRemotes === "" ? [] : lines(normalizedRemotes, "Read push remotes", "remote");
	if (pushReference === null) {
		const branchCheck = await invoke(pi, context, "Read current branch", "git", ["check-ref-format", "--branch", branch]);
		if (branchCheck.killed) commandFailure("Read current branch", branchCheck);
		if (branchCheck.code !== 0 || branchCheck.stdout.replace(/\r\n/g, "\n") !== `${branch}\n`) {
			return { kind: "blocked", issue: "target" };
		}
		return { kind: "missing", branch, remoteNames };
	}

	const push = parsePushReference(pushReference, remoteNames);
	const checkedRef = singleLine(
		(await execute(pi, context, "Read push target", "git", ["check-ref-format", "--branch", push.ref])).stdout,
		"Read push target",
		"push ref",
	);
	if (checkedRef !== push.ref) fail("Read push target", "invalid push ref");
	const authority = await readRemoteAuthority(pi, context, push.remote, true);
	if (!authority) fail("Read push target", "invalid remote authority");
	const remoteHeadOid = await readRemoteHeadOid(pi, context, authority.fetchSource, push.ref);
	return {
		kind: "target",
		target: {
			provenance: "configured",
			branch,
			remote: push.remote,
			fetchSource: authority.fetchSource,
			remoteHeadOid,
			repository: authority.repository,
			ref: push.ref,
		},
	};
}

async function inferPushTarget(
	pi: Pick<ExtensionAPI, "exec">,
	context: PullRequestLoadContext,
	branch: string,
	remoteNames: string[],
): Promise<
	| { kind: "target"; target: PushTarget }
	| { kind: "none"; target: PushTarget }
	| { kind: "blocked"; issue: "target" | "origin" | "ambiguous"; remotes?: string[] }
> {
	const candidates: PushTarget[] = [];
	const authorities = new Map<string, { fetchSource: string; repository: PushRepository }>();
	for (const remote of remoteNames) {
		let validatedRemote: string;
		try {
			validatedRemote = text(remote, "Read push remotes", "remote");
		} catch {
			return { kind: "blocked", issue: "target" };
		}
		const authority = await readRemoteAuthority(pi, context, validatedRemote);
		if (!authority) {
			return { kind: "blocked", issue: validatedRemote === "origin" ? "origin" : "target" };
		}
		authorities.set(validatedRemote, authority);
		const remoteHeadOid = await readRemoteHeadOid(pi, context, authority.fetchSource, branch);
		if (remoteHeadOid !== null) {
			candidates.push({
				provenance: "inferred",
				branch,
				remote: validatedRemote,
				ref: branch,
				fetchSource: authority.fetchSource,
				remoteHeadOid,
				repository: authority.repository,
			});
		}
	}
	if (candidates.length > 1) {
		return { kind: "blocked", issue: "ambiguous", remotes: candidates.map(({ remote }) => remote).sort() };
	}
	if (candidates.length === 1) return { kind: "target", target: candidates[0] };
	const origin = authorities.get("origin");
	if (!origin) return { kind: "blocked", issue: "origin" };
	return {
		kind: "none",
		target: {
			provenance: "inferred",
			branch,
			remote: "origin",
			ref: branch,
			fetchSource: origin.fetchSource,
			remoteHeadOid: null,
			repository: origin.repository,
		},
	};
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

async function readBaseRefOid(
	pi: Pick<ExtensionAPI, "exec">,
	context: PullRequestLoadContext,
	candidate: ListedPullRequest,
): Promise<string> {
	const [owner, name] = candidate.base.repository.split("/");
	const result = await execute(pi, context, "Read base ref", "gh", [
		"api",
		"graphql",
		"--hostname",
		candidate.url.hostname,
		"-f",
		`query=${BASE_REF_QUERY}`,
		"-F",
		`owner=${owner}`,
		"-F",
		`name=${name}`,
		"-F",
		`qualifiedName=refs/heads/${candidate.base.ref}`,
	]);
	return parseBaseRefOid(result.stdout, candidate);
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

async function loadPullRequestDetails(
	pi: Pick<ExtensionAPI, "exec">,
	context: PullRequestLoadContext,
	candidate: ListedPullRequest,
	pushTarget: PushTarget,
	inspectedLocal?: LocalMergeSafety,
): Promise<CurrentPullRequest> {
	await execute(pi, context, "Validate pull request base ref", "git", [
		"check-ref-format",
		`refs/heads/${candidate.base.ref}`,
	]);

	const unresolvedThreads = candidate.lifecycle === "open"
		? await readUnresolvedReviewThreads(pi, context, candidate)
		: 0;
	const liveBaseOid = candidate.lifecycle === "open"
		? await readBaseRefOid(pi, context, candidate)
		: null;
	const rulesetPolicy = candidate.lifecycle === "open"
		? await readRulesetBaseBranchPolicy(pi, context, candidate)
		: null;
	const legacyStrict = candidate.lifecycle === "open" && candidate.mergeStateStatus === "BEHIND"
		? await readLegacyBaseBranchPolicy(pi, context, candidate)
		: false;
	const requiresStrictStatusChecks = legacyStrict || (rulesetPolicy?.requiresStrictStatusChecks ?? false);
	const pullRequestConditions = conditions(candidate, unresolvedThreads, requiresStrictStatusChecks);
	const merge = candidate.lifecycle === "open"
		? await readMergeMethods(pi, context, candidate, rulesetPolicy?.allowedMergeMethods ?? null)
		: null;
	const inspected = inspectedLocal ?? await inspectLocalMergeSafety({
		exec: (command, args, options) => pi.exec(command, args, {
			...options,
			signal: context.signal,
			timeout: EXEC_TIMEOUT_MS,
		}),
		cwd: context.cwd,
		expectedHead: candidate.head.oid,
		headFetchSource: pushTarget.fetchSource,
	});
	const local: LocalMergeSafety = { worktree: inspected.worktree, head: inspected.head };
	return {
		id: candidate.id,
		number: candidate.number,
		url: candidate.url,
		host: candidate.url.hostname.toLowerCase(),
		approved: candidate.reviewDecision === "APPROVED",
		lifecycle: candidate.lifecycle,
		conditions: pullRequestConditions,
		local,
		base: liveBaseOid ? { ...candidate.base, oid: liveBaseOid } : candidate.base,
		head: candidate.head,
		headFetchSource: pushTarget.fetchSource,
		target: publicTarget(pushTarget),
		merge,
	};
}

async function loadObservedPullRequest(
	pi: Pick<ExtensionAPI, "exec">,
	context: PullRequestLoadContext,
	pushTarget: PushTarget,
	observation: PullRequestObservation | null,
	inspectedLocal?: LocalMergeSafety,
): Promise<CurrentPullRequest | null> {
	if (
		observation === null || observation.pullRequest.host !== pushTarget.repository.host ||
		normalizeRepository(observation.target.repository) !== pushTarget.repository.normalizedName ||
		observation.target.branch !== pushTarget.branch || observation.target.remote !== pushTarget.remote ||
		observation.target.ref !== pushTarget.ref
	) return null;

	const localHead = oid(singleLine((await execute(pi, context, "Read local HEAD", "git", [
		"rev-parse", "--verify", "HEAD^{commit}",
	])).stdout, "Read local HEAD", "OID"), "Read local HEAD", "OID");
	if (localHead !== observation.head.oid) return null;

	const loaded = await execute(pi, context, "Load observed pull request", "gh", [
		"pr",
		"view",
		observation.pullRequest.url,
		"--json",
		PR_FIELDS,
	]);
	const candidate = parseLoadedPullRequest(loaded.stdout, new URL(observation.pullRequest.url));
	if (candidate === null) fail("Load observed pull request", "pull request head repository is unavailable");
	if (
		candidate.number !== observation.pullRequest.number ||
		candidate.url.hostname.toLowerCase() !== observation.pullRequest.host ||
		normalizeRepository(candidate.head.repository) !== normalizeRepository(observation.head.repository) ||
		normalizeRepository(candidate.head.repository) !== pushTarget.repository.normalizedName ||
		candidate.head.ref !== observation.head.ref || candidate.head.ref !== pushTarget.ref ||
		candidate.head.oid !== observation.head.oid
	) return null;
	return loadPullRequestDetails(pi, context, candidate, pushTarget, inspectedLocal);
}

async function searchPullRequests(
	pi: Pick<ExtensionAPI, "exec">,
	context: PullRequestLoadContext,
	pushTarget: PushTarget,
): Promise<SearchSelection> {
	const searchQuery = `is:pr${pushTarget.provenance === "inferred" ? " is:open" : ""} head:${pushTarget.ref}`;
	const candidates: SearchPullRequest[] = [];
	const cursors = new Set<string>();
	let issueCount: number | null = null;
	let endCursor: string | null = null;
	for (let pageIndex = 0; pageIndex < PR_SEARCH_MAX_PAGES; pageIndex += 1) {
		const args = [
			"api",
			"graphql",
			"--hostname",
			pushTarget.repository.host,
			"-f",
			`query=${PR_SEARCH_QUERY}`,
			"-F",
			`searchQuery=${searchQuery}`,
		];
		if (endCursor !== null) args.push("-F", `endCursor=${endCursor}`);
		const result = await execute(pi, context, "Find pull requests", "gh", args);
		const page = parseSearchPage(result.stdout, pushTarget.repository.host);
		if (issueCount !== null && page.issueCount !== issueCount) {
			fail("Find pull requests", "inconsistent search result pages");
		}
		issueCount = page.issueCount;
		if (issueCount > PR_SEARCH_CAP) fail("Find pull requests", "GitHub search result cap reached");
		const expectedPageSize = Math.min(PR_SEARCH_PAGE_SIZE, Math.max(0, issueCount - candidates.length));
		if (page.candidates.length !== expectedPageSize) fail("Find pull requests", "incomplete search results");
		for (const cursor of page.cursors) {
			if (cursors.has(cursor)) fail("Find pull requests", "duplicate candidate cursor");
			cursors.add(cursor);
		}
		candidates.push(...page.candidates);
		if (new Set(candidates.map(({ url }) => url.href.toLowerCase())).size !== candidates.length) {
			fail("Find pull requests", "duplicate candidate url");
		}
		const hasMore = candidates.length < issueCount;
		if (page.hasNextPage !== hasMore) fail("Find pull requests", "incomplete search results");
		if (!hasMore) {
			const selected = selectSearchPullRequest(candidates, pushTarget);
			if (selected.kind !== "candidate") return selected;
			const loaded = await execute(pi, context, "Find pull requests", "gh", [
				"pr",
				"view",
				selected.candidate.url.href,
				"--json",
				PR_FIELDS,
			]);
			return {
				...selected,
				pullRequest: parseLoadedPullRequest(loaded.stdout, selected.candidate.url),
			};
		}
		if (page.endCursor === null) fail("Find pull requests", "invalid search pageInfo");
		endCursor = page.endCursor;
	}
	return fail("Find pull requests", "GitHub search result cap reached");
}

export async function loadCurrentPullRequest(
	pi: Pick<ExtensionAPI, "exec">,
	context: PullRequestLoadContext,
	inspectedLocal?: LocalMergeSafety,
	observed?: unknown,
): Promise<CurrentPullRequestDiscovery> {
	const read = await readPushTarget(pi, context);
	if (read.kind === "inactive") return { kind: "inactive" };
	if (read.kind === "blocked") {
		return { kind: "blocked", issue: { kind: read.issue === "detached" ? "detached-head" : "target-invalid" } };
	}

	let pushTarget: PushTarget;
	if (read.kind === "missing") {
		const inferred = await inferPushTarget(pi, context, read.branch, read.remoteNames);
		if (inferred.kind === "blocked") {
			if (inferred.issue === "ambiguous") {
				return { kind: "blocked", issue: { kind: "candidate-remotes-ambiguous", remotes: inferred.remotes! } };
			}
			return {
				kind: "blocked",
				issue: { kind: inferred.issue === "origin" ? "origin-invalid" : "target-invalid" },
			};
		}
		if (inferred.kind === "none") {
			if (!canLinkTarget(await readLinkConfiguration(pi, context, inferred.target), inferred.target)) {
				return { kind: "blocked", issue: { kind: "link-configuration", remote: inferred.target.remote } };
			}
			return { kind: "none", creationTarget: publicTarget(inferred.target) };
		}
		pushTarget = inferred.target;
	} else {
		pushTarget = read.target;
	}

	const search = await searchPullRequests(pi, context, pushTarget);
	if (
		pushTarget.provenance === "configured" && pushTarget.remoteHeadOid === null &&
		(search.kind === "none" || search.kind === "target-invalid")
	) {
		const restored = await loadObservedPullRequest(
			pi,
			context,
			pushTarget,
			parsePullRequestObservation(observed),
			inspectedLocal,
		);
		if (restored !== null) return { kind: "current", pullRequest: restored };
	}
	if (search.kind === "ambiguous") {
		return {
			kind: "blocked",
			issue: {
				kind: "candidate-prs-ambiguous",
				urls: search.urls.sort((a, b) => a.href.localeCompare(b.href)),
			},
		};
	}
	if (search.kind === "oid-mismatch") {
		return {
			kind: "blocked",
			issue: {
				kind: "candidate-oid-mismatch",
				remote: pushTarget.remote,
				urls: search.urls,
			},
		};
	}
	if (search.kind === "target-invalid") {
		return { kind: "blocked", issue: { kind: "target-invalid" } };
	}
	const candidates = search.kind === "candidate" && search.pullRequest !== null ? [search.pullRequest] : [];
	let candidate: ListedPullRequest | null;
	if (pushTarget.provenance === "inferred") {
		const matching = candidates.filter((item) =>
			item.lifecycle === "open" &&
			item.url.hostname.toLowerCase() === pushTarget.repository.host &&
			normalizeRepository(item.head.repository) === pushTarget.repository.normalizedName &&
			item.head.ref === pushTarget.ref
		);
		if (matching.length > 1) {
			return {
				kind: "blocked",
				issue: { kind: "candidate-prs-ambiguous", urls: matching.map(({ url }) => url).sort((a, b) => a.href.localeCompare(b.href)) },
			};
		}
		if (matching.length === 0) {
			return { kind: "blocked", issue: { kind: "published-without-pr", remote: pushTarget.remote } };
		}
		candidate = matching[0];
		if (candidate.head.oid !== pushTarget.remoteHeadOid) {
			return {
				kind: "blocked",
				issue: { kind: "candidate-oid-mismatch", remote: pushTarget.remote, urls: [candidate.url] },
			};
		}
		if (!canLinkTarget(await readLinkConfiguration(pi, context, pushTarget), pushTarget)) {
			return { kind: "blocked", issue: { kind: "link-configuration", remote: pushTarget.remote } };
		}
	} else {
		try {
			candidate = selectPullRequest(candidates, pushTarget);
		} catch (error) {
			if (!(error instanceof PullRequestLoadError)) throw error;
			const matching = candidates.filter((item) =>
				normalizeRepository(item.head.repository) === pushTarget.repository.normalizedName && item.head.ref === pushTarget.ref
			);
			const urls = matching.map(({ url }) => url).sort((a, b) => a.href.localeCompare(b.href));
			if (error.message.includes("multiple ")) {
				return {
					kind: "blocked",
					issue: { kind: "candidate-prs-ambiguous", urls },
				};
			}
			if (error.message.includes("does not match remote push ref")) {
				return {
					kind: "blocked",
					issue: { kind: "candidate-oid-mismatch", remote: pushTarget.remote, urls },
				};
			}
			if (error.message.includes("remote push ref is absent")) {
				return { kind: "blocked", issue: { kind: "target-invalid" } };
			}
			throw error;
		}
		if (candidate === null) return { kind: "none", creationTarget: publicTarget(pushTarget) };
	}

	return {
		kind: "current",
		pullRequest: await loadPullRequestDetails(pi, context, candidate, pushTarget, inspectedLocal),
	};
}

export function samePullRequestSnapshot(left: CurrentPullRequest, right: CurrentPullRequest): boolean {
	return left.lifecycle === right.lifecycle && left.id === right.id && left.number === right.number &&
		left.url.href === right.url.href && left.host === right.host &&
		left.base.repository === right.base.repository && left.base.ref === right.base.ref &&
		left.head.repository === right.head.repository && left.head.ref === right.head.ref &&
		left.head.oid === right.head.oid &&
		left.target.provenance === right.target.provenance &&
		left.target.branch === right.target.branch && left.target.remote === right.target.remote &&
		left.target.ref === right.target.ref && left.target.repository === right.target.repository &&
		left.target.host === right.target.host && left.target.fetchSource === right.target.fetchSource &&
		left.target.remoteOid === right.target.remoteOid;
}

function sameLinkedPullRequest(inferred: CurrentPullRequest, configured: CurrentPullRequest): boolean {
	return inferred.lifecycle === "open" && configured.lifecycle === "open" &&
		configured.target.provenance === "configured" &&
		inferred.id === configured.id &&
		inferred.number === configured.number &&
		inferred.url.href === configured.url.href &&
		inferred.host === configured.host &&
		inferred.head.repository === configured.head.repository &&
		inferred.head.ref === configured.head.ref &&
		inferred.head.oid === configured.head.oid &&
		inferred.target.branch === configured.target.branch &&
		inferred.target.remote === configured.target.remote &&
		inferred.target.ref === configured.target.ref &&
		inferred.target.repository === configured.target.repository &&
		inferred.target.host === configured.target.host &&
		inferred.target.fetchSource === configured.target.fetchSource &&
		inferred.target.remoteOid === configured.target.remoteOid;
}

async function readTrackingOid(
	pi: Pick<ExtensionAPI, "exec">,
	context: PullRequestLoadContext,
	trackingRef: string,
): Promise<string | null> {
	const result = await invoke(pi, context, "Read remote-tracking ref", "git", [
		"rev-parse", "--verify", "--quiet", `${trackingRef}^{commit}`,
	]);
	if (result.killed) commandFailure("Read remote-tracking ref", result);
	if (result.code === 1 && result.stdout === "") return null;
	if (result.code !== 0) commandFailure("Read remote-tracking ref", result);
	return oid(singleLine(result.stdout, "Read remote-tracking ref", "OID"), "Read remote-tracking ref", "OID");
}

async function restoreConfigValue(
	pi: Pick<ExtensionAPI, "exec">,
	context: PullRequestLoadContext,
	key: string,
	expected: string,
	original: string[],
): Promise<void> {
	const current = await readConfigValues(pi, context, key);
	if (current === null) throw new Error("Restore branch upstream failed: invalid Git configuration");
	if (current.length !== 1 || current[0] !== expected) {
		throw new Error("Restore branch upstream failed: branch configuration changed concurrently");
	}
	const unset = await invoke(pi, context, "Restore branch upstream", "git", [
		"config", "--fixed-value", "--unset-all", key, expected,
	]);
	if (unset.killed) commandFailure("Restore branch upstream", unset);
	if (unset.code === 5) {
		throw new Error("Restore branch upstream failed: branch configuration changed concurrently");
	}
	if (unset.code !== 0) commandFailure("Restore branch upstream", unset);
	for (const value of original) {
		await execute(pi, context, "Restore branch upstream", "git", ["config", "--add", key, value]);
	}
	const restored = await readConfigValues(pi, context, key);
	if (restored === null || restored.length !== original.length || restored.some((value, index) => value !== original[index])) {
		throw new Error("Restore branch upstream failed: branch configuration changed concurrently");
	}
}

async function restoreLinkState(
	pi: Pick<ExtensionAPI, "exec">,
	context: PullRequestLoadContext,
	target: PushTarget,
	configuration: LinkConfiguration,
	trackingRef: string,
	trackingOid: string | null,
	upstreamMutated: boolean,
	fetchedOid: string | undefined,
): Promise<void> {
	let incomplete = false;
	if (upstreamMutated) {
		for (const [key, expected, original] of [
			[`branch.${target.branch}.remote`, target.remote, configuration.upstreamRemote],
			[`branch.${target.branch}.merge`, `refs/heads/${target.ref}`, configuration.upstreamMerge],
		] as const) {
			try {
				await restoreConfigValue(pi, context, key, expected, original);
			} catch {
				incomplete = true;
			}
		}
	}
	if (fetchedOid !== undefined) {
		try {
			const currentTrackingOid = await readTrackingOid(pi, context, trackingRef);
			if (currentTrackingOid !== fetchedOid) {
				incomplete = true;
			} else {
				const args = trackingOid === null
					? ["update-ref", "-d", trackingRef, currentTrackingOid]
					: ["update-ref", trackingRef, trackingOid, currentTrackingOid];
				await execute(pi, context, "Restore remote-tracking ref", "git", args);
			}
		} catch {
			incomplete = true;
		}
	}
	if (incomplete) throw new Error("Link branch failed and rollback was incomplete");
}

export async function linkInferredPullRequest(
	pi: Pick<ExtensionAPI, "exec">,
	context: PullRequestLoadContext,
	inferred: CurrentPullRequest,
): Promise<CurrentPullRequest> {
	if (inferred.target.provenance !== "inferred" || inferred.lifecycle !== "open") {
		throw new Error("Link branch failed: pull request is not an open inferred target");
	}
	const freshDiscovery = await loadCurrentPullRequest(pi, context);
	if (
		freshDiscovery.kind !== "current" ||
		freshDiscovery.pullRequest.target.provenance !== "inferred" ||
		!samePullRequestSnapshot(inferred, freshDiscovery.pullRequest)
	) throw new Error("Link branch cancelled: inferred pull request context changed");
	inferred = freshDiscovery.pullRequest;
	const target: PushTarget = {
		provenance: "inferred",
		branch: inferred.target.branch,
		remote: inferred.target.remote,
		ref: inferred.target.ref,
		fetchSource: inferred.target.fetchSource,
		remoteHeadOid: inferred.target.remoteOid,
		repository: {
			nameWithOwner: inferred.target.repository,
			normalizedName: normalizeRepository(inferred.target.repository),
			host: inferred.target.host,
		},
	};
	const linkConfiguration = await readLinkConfiguration(pi, context, target);
	if (target.remoteHeadOid === null || !linkConfiguration || !canLinkTarget(linkConfiguration, target)) {
		throw new Error("Link branch cancelled: target configuration changed");
	}
	const pushReference = optionalPushReference((await execute(pi, context, "Read push target", "git", [
		"for-each-ref", "--format=%(push:short)", `refs/heads/${target.branch}`,
	])).stdout);
	if (pushReference !== null) throw new Error("Link branch cancelled: push target is no longer empty");
	const remoteHeadOid = await readRemoteHeadOid(pi, context, target.fetchSource, target.ref);
	if (remoteHeadOid !== target.remoteHeadOid) throw new Error("Link branch cancelled: remote ref changed");

	const trackingRef = `refs/remotes/${target.remote}/${target.ref}`;
	const trackingOid = await readTrackingOid(pi, context, trackingRef);
	let fetchedOid: string | undefined;
	let upstreamMutated = false;
	try {
		await execute(pi, context, "Fetch inferred branch", "git", [
			"fetch",
			"--no-write-fetch-head",
			"--no-tags",
			"--no-recurse-submodules",
			target.fetchSource,
			`${target.remoteHeadOid}:${trackingRef}`,
		]);
		fetchedOid = target.remoteHeadOid;
		const verifiedFetchedOid = (await readTrackingOid(pi, context, trackingRef)) ?? undefined;
		if (verifiedFetchedOid !== fetchedOid) {
			throw new Error("Link branch cancelled: fetched remote ref changed");
		}
		await execute(pi, context, "Set branch upstream", "git", [
			"branch", `--set-upstream-to=${target.remote}/${target.ref}`, "--", target.branch,
		]);
		upstreamMutated = true;
		const configuredTarget = optionalPushReference((await execute(pi, context, "Verify push target", "git", [
			"for-each-ref", "--format=%(push:short)", `refs/heads/${target.branch}`,
		])).stdout);
		if (configuredTarget !== `${target.remote}/${target.ref}`) {
			throw new Error("Link branch failed: configured push target does not match inferred target");
		}
		const discovery = await loadCurrentPullRequest(pi, context);
		if (discovery.kind !== "current" || !sameLinkedPullRequest(inferred, discovery.pullRequest)) {
			throw new Error("Link branch failed: configured pull request does not match inferred target");
		}
		return discovery.pullRequest;
	} catch (error) {
		const rollbackContext = { cwd: context.cwd, signal: new AbortController().signal };
		try {
			await restoreLinkState(
				pi,
				rollbackContext,
				target,
				linkConfiguration,
				trackingRef,
				trackingOid,
				upstreamMutated,
				fetchedOid,
			);
		} catch {
			throw new Error("Link branch failed and rollback was incomplete");
		}
		throw error;
	}
}
