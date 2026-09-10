import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { lstatSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { inspectLocalMergeSafety } from "./pr-merge.ts";
import { withWorktreeLock } from "./pr-execution.ts";
import type {
	CiStatus,
	LocalMergeSafety,
	PullRequest,
	PullRequestConditions,
	PullRequestDiscovery,
	PullRequestLifecycle,
	PullRequestTarget,
	ReviewReadiness,
} from "./pr-routing.ts";

const EXEC_TIMEOUT_MS = 10_000;
const PR_DISCOVERY_PAGE_SIZE = 100;
const PR_DISCOVERY_CAP = 1_000;
const PR_DISCOVERY_MAX_PAGES = PR_DISCOVERY_CAP / PR_DISCOVERY_PAGE_SIZE;
const PR_FIELDS = "id,number,url,state,isDraft,baseRefName,baseRefOid,headRefName,headRefOid,headRepository,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup";
const PR_PUBLICATION_FIELDS = "number,url,state,baseRefName,headRefName,headRefOid,headRepository,title,body";
const PR_DISCOVERY_QUERY = "query($owner:String!,$name:String!,$qualifiedName:String!,$endCursor:String){repository(owner:$owner,name:$name){nameWithOwner ref(qualifiedName:$qualifiedName){name associatedPullRequests(first:100,after:$endCursor){totalCount edges{cursor node{__typename number url state baseRepository{nameWithOwner}headRepository{nameWithOwner}headRefName headRefOid}}pageInfo{hasNextPage startCursor endCursor}}}}}";
const REVIEW_THREADS_QUERY = "query($id:ID!,$endCursor:String){node(id:$id){...on PullRequest{reviewThreads(first:100,after:$endCursor){nodes{isResolved}pageInfo{hasNextPage endCursor}}}}}";
const BASE_REF_QUERY = "query($owner:String!,$name:String!,$qualifiedName:String!){repository(owner:$owner,name:$name){nameWithOwner ref(qualifiedName:$qualifiedName){name target{oid}}}}";
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
};

export type CurrentPullRequestDiscovery = PullRequestDiscovery<CurrentPullRequest>;

export type PullRequestObservation = {
	pullRequest: { url: string; number: number; host: string };
	head: PullRequestRef;
	target: { repository: string; branch: string; remote: string; ref: string };
};

export type PullRequestLoadContext = Pick<ExtensionContext, "cwd" | "signal">;

export type PullRequestCreationPreflight = {
	head: string;
	base: {
		host: string;
		repository: string;
		fetchSource: string;
		ref: string;
		oid: string;
		mergeBase: string;
	};
	ahead: number;
};

type CreationPreflightResult =
	| { kind: "same-ref" }
	| { kind: "distinct-ref"; preflight: PullRequestCreationPreflight };

type CreationIdentity = {
	target: PullRequestTarget;
	head: string;
};

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

export type PullRequestCandidate = {
	number: number;
	url: URL;
	lifecycle: PullRequestLifecycle;
	baseRepository: string;
	headRepository: string | null;
	headRef: string;
	headOid: string;
};

type SearchPullRequest = PullRequestCandidate;

export type PullRequestPublication = {
	number: number;
	url: URL;
	lifecycle: PullRequestLifecycle;
	base: { repository: string; ref: string };
	head: PullRequestRef;
	title: string;
	body: string;
};

export type ValidatedRemoteAuthority = {
	fetchSource: string;
	host: string;
	repository: string;
};

export type BranchUpstreamTarget = {
	branch: string;
	remote: string;
	ref: string;
	fetchSource: string;
	remoteOid: string;
};

export type BranchUpstreamConfiguration = {
	remote: string[];
	merge: string[];
};

type SearchSelection =
	| { kind: "candidate"; candidate: SearchPullRequest; pullRequest: ListedPullRequest | null }
	| { kind: "none" }
	| { kind: "ambiguous"; urls: URL[] }
	| { kind: "oid-mismatch"; urls: URL[] }
	| { kind: "target-invalid" };

type SearchPage = {
	totalCount: number;
	candidates: SearchPullRequest[];
	cursors: string[];
	hasNextPage: boolean;
	endCursor: string | null;
};

type CheckState = {
	state: string;
	diagnosableFailure: boolean;
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
	checkStates: CheckState[];
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

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
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

function canonicalPositiveDecimal(value: string): boolean {
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed > 0 && String(parsed) === value;
}

function isActionsJobUrl(value: unknown, pullRequestUrl: URL, repository: string): boolean {
	if (typeof value !== "string" || !value) return false;
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return false;
	}
	if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash ||
		url.hostname.toLowerCase() !== pullRequestUrl.hostname.toLowerCase()) return false;
	const parts = url.pathname.split("/").filter(Boolean);
	const expected = repository.split("/");
	return parts.length === 7 && expected.length === 2 &&
		parts[0]!.toLowerCase() === expected[0]!.toLowerCase() &&
		parts[1]!.toLowerCase() === expected[1]!.toLowerCase() &&
		parts[2] === "actions" && parts[3] === "runs" && canonicalPositiveDecimal(parts[4]!) &&
		parts[5] === "job" && canonicalPositiveDecimal(parts[6]!);
}

function isDiagnosableActionsCheck(check: Record<string, unknown>, pullRequestUrl: URL, repository: string): boolean {
	const workflowName = check.workflowName;
	return typeof workflowName === "string" && !!workflowName && workflowName.trim() === workflowName &&
		!/\p{Cc}/u.test(workflowName) && isActionsJobUrl(check.detailsUrl, pullRequestUrl, repository);
}

function checkState(value: unknown, pullRequestUrl: URL, repository: string): CheckState {
	if (!isRecord(value) || (value.__typename !== "CheckRun" && value.__typename !== "StatusContext")) {
		return fail("Find pull requests", "invalid statusCheckRollup");
	}
	const conclusion = value.__typename === "CheckRun" ? optionalCheckState(value, "conclusion") : null;
	const state = value.__typename === "StatusContext" ? optionalCheckState(value, "state") : null;
	const status = value.__typename === "CheckRun" ? optionalCheckState(value, "status") : null;
	const states = [conclusion, state, status].filter((candidate): candidate is string => candidate !== null);
	if (!states.length) fail("Find pull requests", "invalid statusCheckRollup");

	// COMPLETED describes a check run's lifecycle; its conclusion gives the outcome.
	const outcomes = states.filter((candidate) => candidate !== "COMPLETED").map(checkOutcome);
	if (
		new Set(outcomes).size > 1 ||
		(states.includes("COMPLETED") && outcomes.includes("running"))
	) fail("Find pull requests", "invalid statusCheckRollup");
	const selected = conclusion ?? state ?? status ?? fail("Find pull requests", "invalid statusCheckRollup");
	return {
		state: selected,
		diagnosableFailure: FAILED_CHECK_STATES.has(selected) && value.__typename === "CheckRun" &&
			isDiagnosableActionsCheck(value, pullRequestUrl, repository),
	};
}

function checkStates(value: unknown, pullRequestUrl: URL, repository: string): CheckState[] {
	if (value === null) return [];
	if (!Array.isArray(value)) fail("Find pull requests", "invalid statusCheckRollup");
	return value.map((check) => checkState(check, pullRequestUrl, repository));
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
		checkStates: checkStates(value.statusCheckRollup, parsedUrl.url, parsedUrl.repository),
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

function parseSearchPage(output: string, pushTarget: Pick<PushTarget, "repository" | "ref">): SearchPage | null {
	const page = parseJson(output, "Find pull requests");
	if (!isRecord(page)) fail("Find pull requests", "invalid GitHub CLI output");
	if (page.errors !== undefined) {
		if (!Array.isArray(page.errors)) fail("Find pull requests", "invalid GitHub CLI output");
		if (page.errors.length) fail("Find pull requests", "GitHub GraphQL returned errors");
	}
	const repository = isRecord(page.data) ? page.data.repository : undefined;
	if (!isRecord(repository)) fail("Find pull requests", "invalid GitHub CLI output");
	if (
		normalizeRepository(repositoryName(repository.nameWithOwner, "Find pull requests", "repository.nameWithOwner")) !==
		pushTarget.repository.normalizedName
	) fail("Find pull requests", "repository does not match push target");
	if (repository.ref === null) return null;
	if (!isRecord(repository.ref)) fail("Find pull requests", "invalid GitHub CLI output");
	if (text(repository.ref.name, "Find pull requests", "ref.name") !== pushTarget.ref) {
		fail("Find pull requests", "ref does not match push target");
	}
	const search = repository.ref.associatedPullRequests;
	if (
		!isRecord(search) || typeof search.totalCount !== "number" ||
		!Number.isSafeInteger(search.totalCount) || search.totalCount < 0 ||
		!Array.isArray(search.edges) || search.edges.length > PR_DISCOVERY_PAGE_SIZE ||
		!isRecord(search.pageInfo)
	) fail("Find pull requests", "invalid GitHub CLI output");
	const candidates: SearchPullRequest[] = [];
	const cursors: string[] = [];
	for (const edge of search.edges) {
		if (!isRecord(edge)) fail("Find pull requests", "invalid GitHub CLI output");
		cursors.push(text(edge.cursor, "Find pull requests", "cursor"));
		candidates.push(searchPullRequest(edge.node, pushTarget.repository.host));
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
		totalCount: search.totalCount,
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

function parsePullRequestPublication(output: string, expectedUrl: URL): PullRequestPublication {
	const value = parseJson(output, "Read pull request publication");
	if (!isRecord(value) || !isRecord(value.headRepository)) {
		fail("Read pull request publication", "invalid GitHub CLI output");
	}
	const number = value.number;
	if (typeof number !== "number" || !Number.isSafeInteger(number) || number <= 0) {
		fail("Read pull request publication", "invalid number");
	}
	const parsedUrl = parsePullRequestUrl(value.url, number);
	if (parsedUrl.url.href !== expectedUrl.href) {
		fail("Read pull request publication", "response does not match candidate url");
	}
	return {
		number,
		url: parsedUrl.url,
		lifecycle: lifecycle(value.state),
		base: {
			repository: parsedUrl.repository,
			ref: text(value.baseRefName, "Read pull request publication", "baseRefName"),
		},
		head: {
			repository: repositoryName(value.headRepository.nameWithOwner, "Read pull request publication", "headRepository.nameWithOwner"),
			ref: text(value.headRefName, "Read pull request publication", "headRefName"),
			oid: oid(value.headRefOid, "Read pull request publication", "headRefOid"),
		},
		title: text(value.title, "Read pull request publication", "title"),
		body: typeof value.body === "string" ? value.body : fail("Read pull request publication", "invalid body"),
	};
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

function ciStatus(checks: CheckState[]): CiStatus {
	if (!checks.length) return "none";
	let failed = false;
	let running = false;
	for (const check of checks) {
		if (FAILED_CHECK_STATES.has(check.state)) {
			if (!check.diagnosableFailure) return "failure-blocked";
			failed = true;
		} else if (!SUCCESSFUL_CHECK_STATES.has(check.state)) {
			running = true;
		}
	}
	if (failed) return "failure";
	return running ? "running" : "success";
}

function conditions(
	candidate: ListedPullRequest,
	unresolvedThreads: number,
): PullRequestConditions {
	if (
		(candidate.mergeable === "MERGEABLE" && candidate.mergeStateStatus === "DIRTY") ||
		(candidate.mergeable === "CONFLICTING" && candidate.mergeStateStatus === "CLEAN")
	) fail("Find pull requests", "inconsistent mergeability data");
	const review: ReviewReadiness = candidate.reviewDecision === "REVIEW_REQUIRED" || candidate.reviewDecision === "CHANGES_REQUESTED"
		? "pending"
		: "ready";
	const behind = candidate.mergeStateStatus === "BEHIND";
	return {
		draft: candidate.isDraft,
		baseUpdateRequired: behind,
		conflict: candidate.mergeable === "CONFLICTING" || candidate.mergeStateStatus === "DIRTY",
		changesRequested: candidate.reviewDecision === "CHANGES_REQUESTED",
		unresolvedThreads,
		ci: ciStatus(candidate.checkStates),
		review,
		policy: candidate.mergeable === "MERGEABLE" && candidate.mergeStateStatus === "CLEAN"
			? "ready"
			: "pending",
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

function parseBaseRefAuthority(
	output: string,
	expected: { repository: string; ref: string },
): string {
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
		normalizeRepository(expected.repository) ||
		text(repository.ref.name, "Read base ref", "ref") !== expected.ref
	) fail("Read base ref", "response does not match pull request base");
	return oid(repository.ref.target.oid, "Read base ref", "target OID");
}

function parseBaseRefOid(output: string, candidate: ListedPullRequest): string {
	return parseBaseRefAuthority(output, candidate.base);
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

function validatedCreationTarget(target: PullRequestTarget): PullRequestTarget {
	if (!isRecord(target)) fail("Read creation target", "invalid target");
	if (target.provenance !== "configured" && target.provenance !== "inferred") {
		fail("Read creation target", "invalid provenance");
	}
	return {
		provenance: target.provenance,
		branch: text(target.branch, "Read creation target", "branch"),
		remote: text(target.remote, "Read creation target", "remote"),
		ref: text(target.ref, "Read creation target", "ref"),
		repository: repositoryName(target.repository, "Read creation target", "repository"),
		host: text(target.host, "Read creation target", "host").toLowerCase(),
		fetchSource: text(target.fetchSource, "Read creation target", "fetch source"),
		remoteOid: target.remoteOid === null ? null : oid(target.remoteOid, "Read creation target", "remote OID"),
	};
}

function sameCreationTarget(left: PullRequestTarget, right: PullRequestTarget): boolean {
	return left.provenance === right.provenance && left.branch === right.branch &&
		left.remote === right.remote && left.ref === right.ref &&
		normalizeRepository(left.repository) === normalizeRepository(right.repository) &&
		left.host === right.host && left.fetchSource === right.fetchSource && left.remoteOid === right.remoteOid;
}

async function validateCreationRef(
	pi: Pick<ExtensionAPI, "exec">,
	context: PullRequestLoadContext,
	ref: string,
): Promise<string> {
	const requested = text(ref, "Validate creation base", "ref");
	const checked = singleLine(
		(await execute(pi, context, "Validate creation base", "git", ["check-ref-format", "--branch", requested])).stdout,
		"Validate creation base",
		"ref",
	);
	if (checked !== requested) fail("Validate creation base", "ref changed");
	return requested;
}

async function captureCreationIdentity(
	pi: Pick<ExtensionAPI, "exec">,
	context: PullRequestLoadContext,
	target: PullRequestTarget,
): Promise<CreationIdentity> {
	const validatedTarget = validatedCreationTarget(target);
	const branch = singleLine(
		(await execute(pi, context, "Read creation branch", "git", ["branch", "--show-current"])).stdout,
		"Read creation branch",
		"branch",
	);
	if (branch !== validatedTarget.branch) fail("Read creation branch", "branch changed");
	await validateCreationRef(pi, context, branch);
	const head = oid(singleLine(
		(await execute(pi, context, "Read creation HEAD", "git", ["rev-parse", "--verify", "HEAD^{commit}"])).stdout,
		"Read creation HEAD",
		"OID",
	), "Read creation HEAD", "OID");
	return { target: validatedTarget, head };
}

async function readConfiguredCreationBaseRef(
	pi: Pick<ExtensionAPI, "exec">,
	context: PullRequestLoadContext,
	branch: string,
): Promise<string | null> {
	const result = await invoke(pi, context, "Read creation base configuration", "git", [
		"config", "--get-all", `branch.${branch}.gh-merge-base`,
	]);
	if (result.killed) commandFailure("Read creation base configuration", result);
	if (result.code === 1 && result.stdout === "" && result.stderr === "") return null;
	if (result.code !== 0) commandFailure("Read creation base configuration", result);
	if (result.stderr !== "") fail("Read creation base configuration", "unexpected diagnostic");
	const values = lines(result.stdout, "Read creation base configuration", "base ref");
	if (values.length !== 1) fail("Read creation base configuration", "multiple base refs");
	return await validateCreationRef(pi, context, values[0]!);
}

function parseDefaultCreationBaseRef(output: string): string {
	const value = parseJson(output, "Read creation default branch");
	if (!isRecord(value) || !hasExactKeys(value, ["defaultBranchRef"]) || !isRecord(value.defaultBranchRef) ||
		!hasExactKeys(value.defaultBranchRef, ["name"])) {
		fail("Read creation default branch", "invalid GitHub CLI output");
	}
	return text(value.defaultBranchRef.name, "Read creation default branch", "default branch ref");
}

async function readDefaultCreationBaseRef(
	pi: Pick<ExtensionAPI, "exec">,
	context: PullRequestLoadContext,
	origin: { repository: PushRepository },
): Promise<string> {
	const result = await execute(pi, context, "Read creation default branch", "gh", [
		"repo", "view", `${origin.repository.host}/${origin.repository.nameWithOwner}`, "--json", "defaultBranchRef",
	]);
	if (result.stderr !== "") fail("Read creation default branch", "unexpected diagnostic");
	return await validateCreationRef(pi, context, parseDefaultCreationBaseRef(result.stdout));
}

function parseCreationRepositoryLineage(output: string, expected: PushRepository): string {
	const value = parseJson(output, "Read creation repository");
	if (!isRecord(value)) fail("Read creation repository", "invalid GitHub CLI output");
	const fullName = repositoryName(value.full_name, "Read creation repository", "full_name");
	const url = parseHttpUrl(value.html_url, "Read creation repository", "html_url");
	if (
		normalizeRepository(fullName) !== expected.normalizedName || url.protocol !== "https:" || url.port ||
		url.hostname.toLowerCase() !== expected.host || url.pathname.toLowerCase() !== `/${expected.normalizedName}`
	) fail("Read creation repository", "response does not match repository");
	const source = value.source;
	if (source !== undefined && source !== null && !isRecord(source)) {
		fail("Read creation repository", "invalid source");
	}
	const sourceName = source === undefined || source === null
		? fullName
		: repositoryName(source.full_name, "Read creation repository", "source.full_name");
	return normalizeRepository(sourceName);
}

async function inspectCreationRepositoryRelation(
	pi: Pick<ExtensionAPI, "exec">,
	context: PullRequestLoadContext,
	target: PullRequestTarget,
	origin: { repository: PushRepository },
	baseRef: string,
): Promise<"same-ref" | "distinct-ref"> {
	if (target.host !== origin.repository.host) {
		fail("Read creation repository", "base and head hosts do not match");
	}
	if (normalizeRepository(target.repository) === origin.repository.normalizedName) {
		return target.ref === baseRef ? "same-ref" : "distinct-ref";
	}
	const read = async (repository: PushRepository): Promise<string> => {
		const [owner, name] = repository.nameWithOwner.split("/");
		const result = await execute(pi, context, "Read creation repository", "gh", [
			"api", "--hostname", origin.repository.host, `repos/${owner}/${name}`,
		]);
		if (result.stderr !== "") fail("Read creation repository", "unexpected diagnostic");
		return parseCreationRepositoryLineage(result.stdout, repository);
	};
	const originSource = await read(origin.repository);
	const targetSource = await read({
		nameWithOwner: target.repository,
		normalizedName: normalizeRepository(target.repository),
		host: target.host,
	});
	if (originSource !== targetSource) fail("Read creation repository", "base and head are unrelated");
	return "distinct-ref";
}

function parseCreationAhead(output: string): number {
	const value = singleLine(output, "Count creation commits", "ahead count");
	if (!/^(?:0|[1-9][0-9]*)$/.test(value)) fail("Count creation commits", "invalid ahead count");
	const ahead = Number(value);
	if (!Number.isSafeInteger(ahead) || ahead < 0) fail("Count creation commits", "invalid ahead count");
	return ahead;
}

async function preflightCreation(
	pi: Pick<ExtensionAPI, "exec">,
	context: PullRequestLoadContext,
	target: PullRequestTarget,
	explicitBaseRef: string | undefined,
	identity: CreationIdentity,
): Promise<CreationPreflightResult> {
	const validatedTarget = validatedCreationTarget(target);
	if (!sameCreationTarget(identity.target, validatedTarget)) {
		fail("Read creation target", "target changed");
	}
	const origin = await readRemoteAuthority(pi, context, "origin", true);
	if (!origin) fail("Read creation repository", "origin is unavailable");
	const configuredBaseRef = explicitBaseRef === undefined
		? await readConfiguredCreationBaseRef(pi, context, identity.target.branch)
		: await validateCreationRef(pi, context, explicitBaseRef);
	const baseRef = configuredBaseRef ?? await readDefaultCreationBaseRef(pi, context, origin);
	const relation = await inspectCreationRepositoryRelation(pi, context, identity.target, origin, baseRef);
	if (relation === "same-ref") return { kind: relation };
	const trackingRef = `refs/remotes/origin/${baseRef}`;
	await execute(pi, context, "Fetch creation base", "git", [
		"fetch", "--no-write-fetch-head", "--no-tags", "--no-recurse-submodules", "--",
		origin.fetchSource, `+refs/heads/${baseRef}:${trackingRef}`,
	]);
	const baseOid = oid(singleLine(
		(await execute(pi, context, "Read creation base", "git", ["rev-parse", "--verify", `${trackingRef}^{commit}`])).stdout,
		"Read creation base",
		"OID",
	), "Read creation base", "OID");
	const mergeBase = oid(singleLine(
		(await execute(pi, context, "Find creation merge base", "git", ["merge-base", identity.head, baseOid])).stdout,
		"Find creation merge base",
		"OID",
	), "Find creation merge base", "OID");
	const ahead = parseCreationAhead((await execute(pi, context, "Count creation commits", "git", [
		"rev-list", "--count", `${mergeBase}..${identity.head}`,
	])).stdout);
	return {
		kind: relation,
		preflight: {
			head: identity.head,
			base: {
				host: origin.repository.host,
				repository: origin.repository.nameWithOwner,
				fetchSource: origin.fetchSource,
				ref: baseRef,
				oid: baseOid,
				mergeBase,
			},
			ahead,
		},
	};
}

export async function preflightPullRequestCreation(
	pi: Pick<ExtensionAPI, "exec">,
	context: PullRequestLoadContext,
	target: PullRequestTarget,
	explicitBaseRef?: string,
): Promise<PullRequestCreationPreflight> {
	const identity = await captureCreationIdentity(pi, context, target);
	const result = await preflightCreation(pi, context, target, explicitBaseRef, identity);
	if (result.kind === "same-ref") fail("Read creation repository", "head and base refs match");
	return result.preflight;
}

async function creationDiscovery(
	pi: Pick<ExtensionAPI, "exec">,
	context: PullRequestLoadContext,
	target: PullRequestTarget,
	explicitBaseRef: string | undefined,
	identity?: CreationIdentity,
): Promise<CurrentPullRequestDiscovery> {
	const captured = identity ?? await captureCreationIdentity(pi, context, target);
	const result = await preflightCreation(pi, context, target, explicitBaseRef, captured);
	return {
		kind: "none",
		creationTarget: target,
		branch: { ahead: result.kind === "same-ref" ? 0 : result.preflight.ahead },
	};
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

export async function readValidatedRemoteAuthority(
	pi: Pick<ExtensionAPI, "exec">,
	context: PullRequestLoadContext,
	remote: string,
): Promise<ValidatedRemoteAuthority> {
	const authority = await readRemoteAuthority(pi, context, text(remote, "Read push remotes", "remote"), true);
	if (!authority) fail("Read push target", "invalid remote authority");
	return {
		fetchSource: authority.fetchSource,
		host: authority.repository.host,
		repository: authority.repository.nameWithOwner,
	};
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

export async function readBranchUpstreamConfiguration(
	pi: Pick<ExtensionAPI, "exec">,
	context: PullRequestLoadContext,
	branch: string,
): Promise<BranchUpstreamConfiguration> {
	const checkedBranch = text(branch, "Read branch upstream", "branch");
	const [remote, merge] = await Promise.all([
		readConfigValues(pi, context, `branch.${checkedBranch}.remote`),
		readConfigValues(pi, context, `branch.${checkedBranch}.merge`),
	]);
	if (remote === null || merge === null) {
		throw new Error("Read branch upstream failed: invalid Git configuration");
	}
	return { remote, merge };
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

export async function readPullRequestBaseRefOid(
	pi: Pick<ExtensionAPI, "exec">,
	context: PullRequestLoadContext,
	authority: { host: string; repository: string; ref: string },
): Promise<string> {
	const host = text(authority.host, "Read base ref", "host").toLowerCase();
	const repository = repositoryName(authority.repository, "Read base ref", "repository");
	const ref = text(authority.ref, "Read base ref", "ref");
	const [owner, name] = repository.split("/");
	const result = await execute(pi, context, "Read base ref", "gh", [
		"api", "graphql", "--hostname", host,
		"-f", `query=${BASE_REF_QUERY}`,
		"-F", `owner=${owner}`,
		"-F", `name=${name}`,
		"-F", `qualifiedName=refs/heads/${ref}`,
	]);
	return parseBaseRefAuthority(result.stdout, { repository, ref });
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
	const pullRequestConditions = conditions(candidate, unresolvedThreads);
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

async function enumerateSearchPullRequests(
	pi: Pick<ExtensionAPI, "exec">,
	context: PullRequestLoadContext,
	target: Pick<PushTarget, "repository" | "ref">,
): Promise<SearchPullRequest[] | null> {
	const [owner, name] = target.repository.nameWithOwner.split("/");
	const candidates: SearchPullRequest[] = [];
	const cursors = new Set<string>();
	let totalCount: number | null = null;
	let endCursor: string | null = null;
	for (let pageIndex = 0; pageIndex < PR_DISCOVERY_MAX_PAGES; pageIndex += 1) {
		const args = [
			"api", "graphql", "--hostname", target.repository.host,
			"-f", `query=${PR_DISCOVERY_QUERY}`,
			"-F", `owner=${owner}`,
			"-F", `name=${name}`,
			"-F", `qualifiedName=refs/heads/${target.ref}`,
		];
		if (endCursor !== null) args.push("-F", `endCursor=${endCursor}`);
		const result = await execute(pi, context, "Find pull requests", "gh", args);
		const page = parseSearchPage(result.stdout, target);
		if (page === null) return null;
		if (totalCount !== null && page.totalCount !== totalCount) {
			fail("Find pull requests", "inconsistent search result pages");
		}
		totalCount = page.totalCount;
		if (totalCount > PR_DISCOVERY_CAP) fail("Find pull requests", "GitHub pull request result cap reached");
		const expectedPageSize = Math.min(PR_DISCOVERY_PAGE_SIZE, Math.max(0, totalCount - candidates.length));
		if (page.candidates.length !== expectedPageSize) fail("Find pull requests", "incomplete search results");
		for (const cursor of page.cursors) {
			if (cursors.has(cursor)) fail("Find pull requests", "duplicate candidate cursor");
			cursors.add(cursor);
		}
		candidates.push(...page.candidates);
		if (new Set(candidates.map(({ url }) => url.href.toLowerCase())).size !== candidates.length) {
			fail("Find pull requests", "duplicate candidate url");
		}
		const hasMore = candidates.length < totalCount;
		if (page.hasNextPage !== hasMore) fail("Find pull requests", "incomplete search results");
		if (!hasMore) return candidates;
		if (page.endCursor === null) fail("Find pull requests", "invalid search pageInfo");
		endCursor = page.endCursor;
	}
	return fail("Find pull requests", "GitHub pull request result cap reached");
}

export async function findExactHeadPullRequests(
	pi: Pick<ExtensionAPI, "exec">,
	context: PullRequestLoadContext,
	target: { host: string; repository: string; ref: string },
): Promise<PullRequestCandidate[]> {
	const host = text(target.host, "Find pull requests", "host").toLowerCase();
	const repository = repositoryName(target.repository, "Find pull requests", "head repository");
	const ref = text(target.ref, "Find pull requests", "head ref");
	const candidates = await enumerateSearchPullRequests(pi, context, {
		repository: { host, nameWithOwner: repository, normalizedName: normalizeRepository(repository) },
		ref,
	});
	if (candidates === null) return fail("Find pull requests", "published head ref is unavailable");
	return candidates.filter((candidate) =>
		candidate.lifecycle === "open" && candidate.headRepository !== null &&
		normalizeRepository(candidate.headRepository) === normalizeRepository(repository) && candidate.headRef === ref
	);
}

export async function loadPullRequestPublication(
	pi: Pick<ExtensionAPI, "exec">,
	context: PullRequestLoadContext,
	url: URL,
): Promise<PullRequestPublication> {
	const loaded = await execute(pi, context, "Read pull request publication", "gh", [
		"pr", "view", url.href, "--json", PR_PUBLICATION_FIELDS,
	]);
	return parsePullRequestPublication(loaded.stdout, url);
}

async function searchPullRequests(
	pi: Pick<ExtensionAPI, "exec">,
	context: PullRequestLoadContext,
	pushTarget: PushTarget,
): Promise<SearchSelection> {
	const candidates = await enumerateSearchPullRequests(pi, context, pushTarget);
	if (candidates === null) {
		return pushTarget.remoteHeadOid === null ? { kind: "none" } : { kind: "target-invalid" };
	}
	const selected = selectSearchPullRequest(candidates, pushTarget);
	if (selected.kind !== "candidate") return selected;
	const loaded = await execute(pi, context, "Find pull requests", "gh", [
		"pr", "view", selected.candidate.url.href, "--json", PR_FIELDS,
	]);
	return { ...selected, pullRequest: parseLoadedPullRequest(loaded.stdout, selected.candidate.url) };
}

export async function loadCurrentPullRequest(
	pi: Pick<ExtensionAPI, "exec">,
	context: PullRequestLoadContext,
	inspectedLocal?: LocalMergeSafety,
	observed?: unknown,
	explicitCreationBase?: string,
): Promise<CurrentPullRequestDiscovery> {
	return await loadCurrentPullRequestInternal(pi, context, inspectedLocal, observed, explicitCreationBase);
}

async function loadCurrentPullRequestInternal(
	pi: Pick<ExtensionAPI, "exec">,
	context: PullRequestLoadContext,
	inspectedLocal: LocalMergeSafety | undefined,
	observed: unknown,
	explicitCreationBase: string | undefined,
	creationIdentity?: CreationIdentity,
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
			const target = publicTarget(inferred.target);
			if (creationIdentity === undefined) {
				const captured = await captureCreationIdentity(pi, context, target);
				return await loadCurrentPullRequestInternal(pi, context, inspectedLocal, observed, explicitCreationBase, captured);
			}
			if (!sameCreationTarget(creationIdentity.target, validatedCreationTarget(target))) {
				fail("Read creation target", "target changed");
			}
			if (!canLinkTarget(await readLinkConfiguration(pi, context, inferred.target), inferred.target)) {
				return { kind: "blocked", issue: { kind: "link-configuration", remote: inferred.target.remote } };
			}
			return await creationDiscovery(pi, context, target, explicitCreationBase, creationIdentity);
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
		if (candidate === null) {
			if (creationIdentity !== undefined) fail("Read creation target", "target changed");
			return await creationDiscovery(pi, context, publicTarget(pushTarget), explicitCreationBase);
		}
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

export async function readTrackingOid(
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

export function branchTrackingRef(target: Pick<BranchUpstreamTarget, "remote" | "ref">): string {
	return `refs/remotes/${text(target.remote, "Read push remotes", "remote")}/${text(target.ref, "Read push target", "push ref")}`;
}

export async function fetchBranchTrackingRef(
	pi: Pick<ExtensionAPI, "exec">,
	context: PullRequestLoadContext,
	target: BranchUpstreamTarget,
): Promise<void> {
	await execute(pi, context, "Fetch branch tracking ref", "git", [
		"fetch", "--no-write-fetch-head", "--no-tags", "--no-recurse-submodules",
		target.fetchSource, `+${target.remoteOid}:${branchTrackingRef(target)}`,
	]);
}

export async function setBranchUpstream(
	pi: Pick<ExtensionAPI, "exec">,
	context: PullRequestLoadContext,
	target: BranchUpstreamTarget,
): Promise<void> {
	await execute(pi, context, "Set branch upstream", "git", [
		"branch", `--set-upstream-to=${target.remote}/${target.ref}`, "--", target.branch,
	]);
}

export async function verifyBranchUpstream(
	pi: Pick<ExtensionAPI, "exec">,
	context: PullRequestLoadContext,
	target: BranchUpstreamTarget,
): Promise<void> {
	const trackingOid = await readTrackingOid(pi, context, branchTrackingRef(target));
	if (trackingOid !== target.remoteOid) throw new Error("Branch tracking ref does not match published OID");
	const configuredTarget = optionalPushReference((await execute(pi, context, "Verify push target", "git", [
		"for-each-ref", "--format=%(push:short)", `refs/heads/${target.branch}`,
	])).stdout);
	if (configuredTarget !== `${target.remote}/${target.ref}`) {
		throw new Error("Configured push target does not match published branch");
	}
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

function sameConfigValues(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

export async function restoreBranchUpstreamConfiguration(
	pi: Pick<ExtensionAPI, "exec">,
	context: PullRequestLoadContext,
	target: Pick<BranchUpstreamTarget, "branch" | "remote" | "ref">,
	original: BranchUpstreamConfiguration,
): Promise<void> {
	let incomplete = false;
	for (const [key, expected, values] of [
		[`branch.${target.branch}.remote`, target.remote, original.remote],
		[`branch.${target.branch}.merge`, `refs/heads/${target.ref}`, original.merge],
	] as const) {
		try {
			const current = await readConfigValues(pi, context, key);
			if (current === null) incomplete = true;
			else if (sameConfigValues(current, values)) continue;
			else if (current.length === 1 && current[0] === expected) {
				await restoreConfigValue(pi, context, key, expected, values);
			} else incomplete = true;
		} catch {
			incomplete = true;
		}
	}
	for (const [key, values] of [
		[`branch.${target.branch}.remote`, original.remote],
		[`branch.${target.branch}.merge`, original.merge],
	] as const) {
		try {
			const current = await readConfigValues(pi, context, key);
			if (current === null || !sameConfigValues(current, values)) incomplete = true;
		} catch {
			incomplete = true;
		}
	}
	if (incomplete) throw new Error("Restore branch upstream failed and rollback was incomplete");
}

async function restoreLinkState(
	pi: Pick<ExtensionAPI, "exec">,
	context: PullRequestLoadContext,
	target: PushTarget,
	configuration: LinkConfiguration,
	trackingRef: string,
	trackingOid: string | null,
	upstreamAttempted: boolean,
	fetchAttempted: boolean,
): Promise<void> {
	let incomplete = false;
	if (upstreamAttempted) {
		for (const [key, expected, original] of [
			[`branch.${target.branch}.remote`, target.remote, configuration.upstreamRemote],
			[`branch.${target.branch}.merge`, `refs/heads/${target.ref}`, configuration.upstreamMerge],
		] as const) {
			try {
				const current = await readConfigValues(pi, context, key);
				if (current === null) incomplete = true;
				else if (sameConfigValues(current, original)) continue;
				else if (current.length === 1 && current[0] === expected) {
					await restoreConfigValue(pi, context, key, expected, original);
				} else incomplete = true;
			} catch {
				incomplete = true;
			}
		}
	}
	if (fetchAttempted) {
		try {
			const currentTrackingOid = await readTrackingOid(pi, context, trackingRef);
			if (currentTrackingOid !== trackingOid) {
				if (target.remoteHeadOid === null || currentTrackingOid !== target.remoteHeadOid) {
					incomplete = true;
				} else {
					const args = trackingOid === null
						? ["update-ref", "-d", trackingRef, target.remoteHeadOid]
						: ["update-ref", trackingRef, trackingOid, target.remoteHeadOid];
					await execute(pi, context, "Restore remote-tracking ref", "git", args);
				}
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
	options: { agentDir?: string } = {},
): Promise<CurrentPullRequest> {
	if (inferred.target.provenance !== "inferred" || inferred.lifecycle !== "open") {
		throw new Error("Link branch failed: pull request is not an open inferred target");
	}
	return await withWorktreeLock(context.cwd, async () => {
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
		let fetchAttempted = false;
		let upstreamAttempted = false;
		try {
			const upstreamTarget: BranchUpstreamTarget = {
				branch: target.branch,
				remote: target.remote,
				ref: target.ref,
				fetchSource: target.fetchSource,
				remoteOid: target.remoteHeadOid,
			};
			fetchAttempted = true;
			await fetchBranchTrackingRef(pi, context, upstreamTarget);
			const verifiedFetchedOid = await readTrackingOid(pi, context, trackingRef);
			if (verifiedFetchedOid !== target.remoteHeadOid) throw new Error("Link branch cancelled: fetched remote ref changed");
			upstreamAttempted = true;
			await setBranchUpstream(pi, context, upstreamTarget);
			await verifyBranchUpstream(pi, context, upstreamTarget);
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
					upstreamAttempted,
					fetchAttempted,
				);
			} catch {
				throw new Error("Link branch failed and rollback was incomplete");
			}
			throw error;
		}
	}, { agentDir: options.agentDir, signal: context.signal });
}
