import { createHash } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	loadCurrentPullRequest,
	readValidatedRemoteAuthority,
	samePullRequestSnapshot,
	type CurrentPullRequest,
	type PullRequestLoadContext,
} from "./pr-github.ts";
import {
	inspectWorktree,
	isAncestor,
	readHead,
	readRemoteOid,
	requiredOid,
	requiredText,
	runChecked,
	spawnBounded,
	withWorktreeLock,
	type Exec,
	type ExecOptions,
} from "./pr-execution.ts";

const PAGE_BYTES = 512 * 1024;
const MAX_PAGES = 100;
const MAX_RECORDS = 1_000;
const LOG_BYTES = 8 * 1024 * 1024;
const LOG_TIMEOUT_MS = 60_000;
const EVIDENCE_RECORD_BYTES = 20 * 1024;
const EVIDENCE_TOTAL_BYTES = 256 * 1024;
const PAGE_SIZE = 100;
const API_HEADERS = [
	"-H", "Accept: application/vnd.github+json",
	"-H", "X-GitHub-Api-Version: 2022-11-28",
];
const FAILED_CONCLUSIONS = new Set([
	"action_required", "cancelled", "failure", "startup_failure", "timed_out",
]);
const CONCLUSIONS = new Set([
	...FAILED_CONCLUSIONS, "neutral", "skipped", "stale", "success",
]);
const STATUSES = new Set(["completed", "in_progress", "pending", "queued", "requested", "waiting"]);

type Load = typeof loadCurrentPullRequest;

type StepIdentity = {
	number: number;
	name: string;
	status: string;
	conclusion: string | null;
};

type JobIdentity = {
	id: number;
	url: string;
	htmlUrl: string;
	checkRunUrl: string;
	runId: number;
	attempt: number;
	headOid: string;
	name: string;
	status: string;
	conclusion: string | null;
	steps: StepIdentity[];
};

type CheckIdentity = {
	id: number;
	url: string;
	detailsUrl: string | null;
	suiteId: number;
	headOid: string;
	name: string;
	status: string;
	conclusion: string | null;
	provider: string;
};

type RunIdentity = {
	id: number;
	url: string;
	htmlUrl: string;
	attempt: number;
	suiteId: number;
	headOid: string;
	status: string;
	conclusion: string | null;
	jobs: JobIdentity[];
};

type FailureIdentity = {
	check: CheckIdentity;
	run: RunIdentity;
	job: JobIdentity;
	failedSteps: StepIdentity[];
};

type CiSnapshot = {
	fingerprint: string;
	failures: FailureIdentity[];
};

export type CiFailureEvidence = {
	checkRun: { id: number; url: string; detailsUrl: string; name: string; conclusion: string };
	checkSuite: { id: number };
	run: { id: number; url: string; attempt: number };
	job: { id: number; url: string; name: string; conclusion: string };
	failedSteps: Array<{ number: number; name: string; conclusion: string }>;
	log: { scope: "job"; text: string; truncated: boolean };
};

export type CiEvidence = {
	fingerprint: string;
	pullRequest: { number: number; url: string; headOid: string };
	failures: CiFailureEvidence[];
};

export type CiPushAttempt = "before-launch" | "applied" | "not-applied" | "unknown";
export type CiFixPhase = "ready" | "collecting" | "collected" | "published" | "blocked";

export type CiFixState = {
	phase: CiFixPhase;
	pushAttempt: CiPushAttempt;
	fingerprint?: string;
	repairHead?: string;
};

export type PullRequestCiFixOptions = {
	cwd: string;
	authority: CurrentPullRequest;
	signal?: AbortSignal;
	agentDir?: string;
	exec?: Exec;
	loadCurrentPullRequest?: Load;
};

export type CiPublishResult = {
	kind: "published";
	head: string;
	attempt: "applied";
};

function cloneAuthority(value: CurrentPullRequest): CurrentPullRequest {
	return {
		...value,
		url: new URL(value.url.href),
		conditions: { ...value.conditions },
		local: { ...value.local },
		base: { ...value.base },
		head: { ...value.head },
		target: { ...value.target },
		merge: value.merge ? { ...value.merge, allowedMergeMethods: [...value.merge.allowedMergeMethods] } : null,
	};
}

function record(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} returned invalid JSON`);
	return value as Record<string, unknown>;
}

function array(value: unknown, label: string): unknown[] {
	if (!Array.isArray(value)) throw new Error(`${label} returned invalid JSON`);
	return value;
}

function integer(value: unknown, label: string, allowZero = false): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
		throw new Error(`${label} returned an invalid integer`);
	}
	return value;
}

function text(value: unknown, label: string): string {
	const parsed = requiredText(value, label);
	if (Buffer.byteLength(parsed, "utf8") > 8 * 1024) throw new Error(`${label} was too long`);
	return parsed;
}

function conclusion(value: unknown, status: string, label: string): string | null {
	if (value === null) {
		if (status === "completed") throw new Error(`${label} omitted a completed conclusion`);
		return null;
	}
	const parsed = text(value, `${label} conclusion`);
	if (!CONCLUSIONS.has(parsed) || status !== "completed") throw new Error(`${label} returned an invalid conclusion`);
	if (parsed === "stale") throw new Error(`${label} returned stale evidence`);
	return parsed;
}

function status(value: unknown, label: string): string {
	const parsed = text(value, `${label} status`);
	if (!STATUSES.has(parsed)) throw new Error(`${label} returned an invalid status`);
	return parsed;
}

function parseJson(output: string, label: string): unknown {
	try {
		return JSON.parse(output);
	} catch {
		throw new Error(`${label} returned invalid JSON`);
	}
}

function outputLine(output: string, label: string): string {
	const normalized = output.replace(/\r\n/g, "\n");
	const lines = (normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized).split("\n");
	if (lines.length !== 1 || !lines[0]) throw new Error(`${label} returned invalid output`);
	return requiredText(lines[0], label);
}

function secureUrl(value: unknown, label: string): URL {
	const raw = text(value, label);
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new Error(`${label} returned an invalid URL`);
	}
	if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash) {
		throw new Error(`${label} returned an invalid URL`);
	}
	return url;
}

function pathParts(url: URL): string[] {
	const parts = url.pathname.split("/").filter(Boolean);
	if (parts.some((part) => !part || part === "." || part === ".." || part.includes("%"))) {
		throw new Error("GitHub returned an invalid identity URL");
	}
	return parts;
}

function sameRepository(parts: readonly string[], repository: string): boolean {
	const expected = repository.split("/");
	return parts.length === 2 && expected.length === 2 &&
		parts[0]!.toLowerCase() === expected[0]!.toLowerCase() &&
		parts[1]!.toLowerCase() === expected[1]!.toLowerCase();
}

function parseApiIdentityUrl(
	value: unknown,
	label: string,
	host: string,
	repository: string,
	kind: "check-runs" | "runs" | "jobs",
	expectedId: number,
): string {
	const url = secureUrl(value, label);
	const parts = pathParts(url);
	const expectedHost = (host === "github.com" ? "api.github.com" : host).toLowerCase();
	if (url.hostname.toLowerCase() !== expectedHost) throw new Error(`${label} returned an unexpected API origin`);
	const tailSize = kind === "check-runs" ? 5 : 6;
	const tail = parts.slice(-tailSize);
	const valid = kind === "check-runs"
		? tail[0] === "repos" && sameRepository(tail.slice(1, 3), repository) && tail[3] === kind
		: tail[0] === "repos" && sameRepository(tail.slice(1, 3), repository) && tail[3] === "actions" && tail[4] === kind;
	if (!valid || tail[tail.length - 1] !== String(expectedId)) throw new Error(`${label} did not match its immutable ID`);
	return url.href;
}

function parseRunHtmlUrl(value: unknown, label: string, host: string, repository: string, expectedId: number): string {
	const url = secureUrl(value, label);
	const parts = pathParts(url);
	if (url.hostname.toLowerCase() !== host || parts.length !== 5 || !sameRepository(parts.slice(0, 2), repository) ||
		parts[2] !== "actions" || parts[3] !== "runs" || parts[4] !== String(expectedId)) {
		throw new Error(`${label} did not match its immutable ID`);
	}
	return url.href;
}

function decimalIdentity(value: string, label: string): number {
	const parsed = integer(Number(value), label);
	if (String(parsed) !== value) throw new Error(`${label} returned a noncanonical decimal ID`);
	return parsed;
}

function parseJobHtmlUrl(
	value: unknown,
	label: string,
	host: string,
	repository: string,
): { url: string; runId: number; jobId: number } {
	const url = secureUrl(value, label);
	const parts = pathParts(url);
	if (url.hostname.toLowerCase() !== host || parts.length !== 7 || !sameRepository(parts.slice(0, 2), repository) ||
		parts[2] !== "actions" || parts[3] !== "runs" || parts[5] !== "job") {
		throw new Error(`${label} was not an immutable GitHub Actions job URL`);
	}
	return {
		url: url.href,
		runId: decimalIdentity(parts[4]!, `${label} run ID`),
		jobId: decimalIdentity(parts[6]!, `${label} job ID`),
	};
}

function tailUtf8(value: string, limit: number): { text: string; truncated: boolean } {
	const total = Buffer.byteLength(value, "utf8");
	if (total <= limit) return { text: value, truncated: false };
	let start = value.length;
	let bytes = 0;
	while (start > 0) {
		let previous = start - 1;
		if (previous > 0 && value.charCodeAt(previous) >= 0xdc00 && value.charCodeAt(previous) <= 0xdfff &&
			value.charCodeAt(previous - 1) >= 0xd800 && value.charCodeAt(previous - 1) <= 0xdbff) previous -= 1;
		const character = value.slice(previous, start);
		const size = Buffer.byteLength(character, "utf8");
		if (bytes + size > limit) break;
		bytes += size;
		start = previous;
	}
	return { text: value.slice(start), truncated: true };
}

function failureEvidence(
	failure: FailureIdentity,
	log: { text: string; truncated: boolean },
): CiFailureEvidence {
	const { check, run, job, failedSteps } = failure;
	if (check.detailsUrl === null || check.conclusion === null || job.conclusion === null) {
		throw new Error(`Failed job ${job.id} omitted required evidence identity`);
	}
	return {
		checkRun: {
			id: check.id,
			url: check.url,
			detailsUrl: check.detailsUrl,
			name: check.name,
			conclusion: check.conclusion,
		},
		checkSuite: { id: check.suiteId },
		run: { id: run.id, url: run.htmlUrl, attempt: run.attempt },
		job: { id: job.id, url: job.htmlUrl, name: job.name, conclusion: job.conclusion },
		failedSteps: failedSteps.map((step) => {
			if (step.conclusion === null) throw new Error(`Failed job ${job.id} step omitted its conclusion`);
			return { number: step.number, name: step.name, conclusion: step.conclusion };
		}),
		log: { scope: "job", ...log },
	};
}

function jsonBytes(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function boundedEvidenceRecord(failure: FailureIdentity, rawLog: string, maxBytes: number): CiFailureEvidence {
	const metadata = failureEvidence(failure, { text: "", truncated: false });
	const metadataBytes = jsonBytes(metadata);
	if (metadataBytes > maxBytes) throw new Error(`Failed job ${failure.job.id} metadata exceeds its evidence budget`);
	let logBytes = Math.min(Buffer.byteLength(rawLog, "utf8"), maxBytes - metadataBytes);
	while (true) {
		const log = tailUtf8(rawLog, logBytes);
		const evidence = failureEvidence(failure, log);
		const size = jsonBytes(evidence);
		if (size <= maxBytes) return evidence;
		if (logBytes === 0) throw new Error(`Failed job ${failure.job.id} metadata exceeds its evidence budget`);
		const serializedLogBytes = Math.max(1, size - metadataBytes);
		logBytes = Math.max(0, Math.floor(logBytes * (maxBytes - metadataBytes) / serializedLogBytes) - 1);
	}
}

function authorityIdentity(value: CurrentPullRequest) {
	return {
		id: value.id,
		number: value.number,
		url: value.url.href,
		host: value.host,
		base: { ...value.base },
		head: { ...value.head },
		target: { ...value.target },
	};
}

function snapshotFingerprint(authority: CurrentPullRequest, checks: CheckIdentity[], runs: RunIdentity[], failures: FailureIdentity[]): string {
	return createHash("sha256").update(JSON.stringify({
		authority: authorityIdentity(authority),
		checks,
		runs,
		mappings: failures.map(({ check, run, job, failedSteps }) => ({
			checkRunId: check.id,
			checkRunUrl: check.url,
			suiteId: check.suiteId,
			runId: run.id,
			attempt: run.attempt,
			jobId: job.id,
			failedSteps,
		})),
	})).digest("hex");
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export class PullRequestCiFixer {
	readonly state: CiFixState = { phase: "ready", pushAttempt: "before-launch" };

	private readonly cwd: string;
	private readonly authority: CurrentPullRequest;
	private readonly signal?: AbortSignal;
	private readonly agentDir?: string;
	private readonly exec: Exec;
	private readonly load: Load;
	private collectConsumed = false;
	private publishConsumed = false;
	private collectedFingerprint?: string;

	constructor(options: PullRequestCiFixOptions) {
		if (!options.authority || options.authority.lifecycle !== "open" ||
			options.authority.target.provenance !== "configured" || options.authority.conditions.ci !== "failure" ||
			options.authority.local.worktree !== "clean" || options.authority.local.head !== "equal") {
			throw new TypeError("CI repair requires a configured failed pull request with a clean equal local HEAD");
		}
		const head = requiredOid(options.authority.head.oid, "pull request head OID");
		const remote = options.authority.target.remoteOid === null
			? null
			: requiredOid(options.authority.target.remoteOid, "remote OID");
		if (remote !== head) throw new TypeError("CI repair requires the pull request head to match the configured remote OID");
		this.cwd = requiredText(options.cwd, "cwd");
		this.authority = cloneAuthority(options.authority);
		this.signal = options.signal;
		this.agentDir = options.agentDir;
		this.exec = options.exec ?? spawnBounded;
		this.load = options.loadCurrentPullRequest ?? loadCurrentPullRequest;
	}

	private options(extra: Partial<ExecOptions> = {}): ExecOptions {
		return { cwd: this.cwd, signal: this.signal, ...extra };
	}

	private pi(): Pick<ExtensionAPI, "exec"> {
		return {
			exec: (command, args, options) => this.exec(command, args, {
				cwd: options?.cwd ?? this.cwd,
				signal: options?.signal ?? this.signal,
				timeoutMs: options?.timeout,
			}),
		} as Pick<ExtensionAPI, "exec">;
	}

	private context(): PullRequestLoadContext {
		return { cwd: this.cwd, signal: this.signal ?? new AbortController().signal };
	}

	private async freshAuthority(requireOriginalLocal: boolean): Promise<CurrentPullRequest> {
		const discovery = await this.load(this.pi(), this.context());
		if (discovery.kind !== "current" || !samePullRequestSnapshot(this.authority, discovery.pullRequest) ||
			discovery.pullRequest.base.oid !== this.authority.base.oid ||
			discovery.pullRequest.conditions.ci !== "failure" ||
			discovery.pullRequest.target.remoteOid !== this.authority.head.oid) {
			throw new Error("CI repair cancelled: frozen pull request, base, target, head, or failed-CI authority changed");
		}
		if (requireOriginalLocal && (discovery.pullRequest.local.worktree !== "clean" || discovery.pullRequest.local.head !== "equal")) {
			throw new Error("CI repair evidence requires the original clean equal local HEAD");
		}
		return discovery.pullRequest;
	}

	private async requireOriginalLocal(): Promise<void> {
		const branch = outputLine(
			(await runChecked(this.exec, "git", ["branch", "--show-current"], this.options())).stdout,
			"current branch",
		);
		if (branch !== this.authority.target.branch) throw new Error("CI repair cancelled: current branch changed");
		if (await inspectWorktree(this.exec, this.options()) !== "clean") {
			throw new Error("CI repair requires a clean worktree with no Git operation in progress");
		}
		if (await readHead(this.exec, this.options()) !== this.authority.head.oid) {
			throw new Error("CI repair evidence requires local HEAD to equal the frozen pull request head");
		}
	}

	private async api(endpoint: string, label: string, options: Partial<ExecOptions> = {}): Promise<string> {
		const result = await runChecked(this.exec, "gh", [
			"api", "--hostname", this.authority.host, ...API_HEADERS, endpoint,
		], this.options({ stdoutLimitBytes: PAGE_BYTES, ...options }));
		const limit = options.stdoutLimitBytes ?? PAGE_BYTES;
		if (Buffer.byteLength(result.stdout, "utf8") > limit) throw new Error(`${label} exceeded ${limit} bytes`);
		return result.stdout;
	}

	private parseCheck(value: unknown): CheckIdentity {
		const item = record(value, "List commit check runs");
		const id = integer(item.id, "check-run ID");
		const currentStatus = status(item.status, `check run ${id}`);
		const currentConclusion = conclusion(item.conclusion, currentStatus, `check run ${id}`);
		const suite = record(item.check_suite, `check run ${id} suite`);
		const app = record(item.app, `check run ${id} provider`);
		const headOid = requiredOid(item.head_sha, `check run ${id} head OID`);
		if (headOid !== this.authority.head.oid) throw new Error(`Check run ${id} is stale for the frozen pull request head`);
		if (suite.head_sha !== undefined && requiredOid(suite.head_sha, `check run ${id} suite head OID`) !== headOid) {
			throw new Error(`Check run ${id} suite is stale for the frozen pull request head`);
		}
		const detailsUrl = item.details_url === null ? null : secureUrl(item.details_url, `check run ${id} details URL`).href;
		return {
			id,
			url: parseApiIdentityUrl(item.url, `check run ${id} URL`, this.authority.host, this.authority.base.repository, "check-runs", id),
			detailsUrl,
			suiteId: integer(suite.id, `check run ${id} suite ID`),
			headOid,
			name: text(item.name, `check run ${id} name`),
			status: currentStatus,
			conclusion: currentConclusion,
			provider: text(app.slug, `check run ${id} provider`),
		};
	}

	private consumePage(budget: { pages: number; records: number }): void {
		budget.pages += 1;
		if (budget.pages > MAX_PAGES) throw new Error(`CI evidence pagination exceeds ${MAX_PAGES} pages`);
	}

	private consumeRecords(budget: { pages: number; records: number }, count: number): void {
		if (count > MAX_RECORDS - budget.records) throw new Error(`CI evidence exceeds ${MAX_RECORDS} aggregate records`);
		budget.records += count;
	}

	private async readCheckRuns(budget: { pages: number; records: number }): Promise<CheckIdentity[]> {
		const checks: CheckIdentity[] = [];
		let expectedTotal: number | undefined;
		for (let page = 1; page <= MAX_PAGES; page += 1) {
			this.consumePage(budget);
			const endpoint = `repos/${this.authority.base.repository}/commits/${this.authority.head.oid}/check-runs?filter=latest&per_page=${PAGE_SIZE}&page=${page}`;
			const parsed = record(parseJson(await this.api(endpoint, "List commit check runs"), "List commit check runs"), "List commit check runs");
			const total = integer(parsed.total_count, "check-run total", true);
			const pageChecks = array(parsed.check_runs, "List commit check runs");
			if (pageChecks.length > PAGE_SIZE) throw new Error("Check-run page exceeded its record limit");
			if (expectedTotal === undefined) {
				expectedTotal = total;
				if (total > MAX_RECORDS - budget.records) throw new Error(`CI evidence exceeds ${MAX_RECORDS} aggregate records`);
			} else if (total !== expectedTotal) {
				throw new Error("Check-run pagination total changed during collection");
			}
			this.consumeRecords(budget, pageChecks.length);
			checks.push(...pageChecks.map((item) => this.parseCheck(item)));
			if (checks.length > expectedTotal) throw new Error("Check-run pagination exceeded its declared total");
			if (checks.length === expectedTotal) break;
			if (!pageChecks.length) throw new Error("Check-run pagination ended before its declared total");
			if (page === MAX_PAGES) throw new Error(`Check-run pagination exceeds ${MAX_PAGES} pages`);
		}
		if (expectedTotal === undefined || checks.length !== expectedTotal) throw new Error("Check-run pagination was incomplete");
		checks.sort((left, right) => left.id - right.id);
		if (new Set(checks.map(({ id }) => id)).size !== checks.length ||
			new Set(checks.map(({ url }) => url)).size !== checks.length) {
			throw new Error("Check-run pagination returned duplicate immutable identities");
		}
		return checks;
	}

	private parseStep(value: unknown, jobId: number): StepIdentity {
		const item = record(value, `job ${jobId} step`);
		const number = integer(item.number, `job ${jobId} step number`);
		const currentStatus = status(item.status, `job ${jobId} step ${number}`);
		return {
			number,
			name: text(item.name, `job ${jobId} step ${number} name`),
			status: currentStatus,
			conclusion: conclusion(item.conclusion, currentStatus, `job ${jobId} step ${number}`),
		};
	}

	private parseJob(value: unknown, runId: number, attempt: number): JobIdentity {
		const item = record(value, `run ${runId} job`);
		const id = integer(item.id, `run ${runId} job ID`);
		if (integer(item.run_id, `job ${id} run ID`) !== runId || integer(item.run_attempt, `job ${id} run attempt`) !== attempt) {
			throw new Error(`Job ${id} does not belong to the exact current run attempt`);
		}
		const headOid = requiredOid(item.head_sha, `job ${id} head OID`);
		if (headOid !== this.authority.head.oid) throw new Error(`Job ${id} is stale for the frozen pull request head`);
		const currentStatus = status(item.status, `job ${id}`);
		const steps = array(item.steps, `job ${id} steps`).map((step) => this.parseStep(step, id));
		steps.sort((left, right) => left.number - right.number);
		if (new Set(steps.map(({ number }) => number)).size !== steps.length) throw new Error(`Job ${id} returned duplicate step identities`);
		const html = parseJobHtmlUrl(item.html_url, `job ${id} HTML URL`, this.authority.host, this.authority.base.repository);
		if (html.runId !== runId || html.jobId !== id) throw new Error(`Job ${id} HTML URL did not match its immutable IDs`);
		return {
			id,
			url: parseApiIdentityUrl(item.url, `job ${id} URL`, this.authority.host, this.authority.base.repository, "jobs", id),
			htmlUrl: html.url,
			checkRunUrl: secureUrl(item.check_run_url, `job ${id} check-run URL`).href,
			runId,
			attempt,
			headOid,
			name: text(item.name, `job ${id} name`),
			status: currentStatus,
			conclusion: conclusion(item.conclusion, currentStatus, `job ${id}`),
			steps,
		};
	}

	private async readRun(runId: number, budget: { pages: number; records: number }): Promise<RunIdentity> {
		const label = `Read workflow run ${runId}`;
		const item = record(parseJson(await this.api(
			`repos/${this.authority.base.repository}/actions/runs/${runId}`,
			label,
		), label), label);
		if (integer(item.id, `${label} ID`) !== runId) throw new Error(`${label} returned a replaced run`);
		const attempt = integer(item.run_attempt, `${label} attempt`);
		const headOid = requiredOid(item.head_sha, `${label} head OID`);
		if (headOid !== this.authority.head.oid) throw new Error(`${label} is stale for the frozen pull request head`);
		const repository = record(item.repository, `${label} repository`);
		const headRepository = record(item.head_repository, `${label} head repository`);
		if (text(repository.full_name, `${label} repository name`).toLowerCase() !== this.authority.base.repository.toLowerCase() ||
			text(headRepository.full_name, `${label} head repository name`).toLowerCase() !== this.authority.head.repository.toLowerCase()) {
			throw new Error(`${label} does not belong to the frozen pull request repositories`);
		}
		const currentStatus = status(item.status, label);
		const run: RunIdentity = {
			id: runId,
			url: parseApiIdentityUrl(item.url, `${label} URL`, this.authority.host, this.authority.base.repository, "runs", runId),
			htmlUrl: parseRunHtmlUrl(item.html_url, `${label} HTML URL`, this.authority.host, this.authority.base.repository, runId),
			attempt,
			suiteId: integer(item.check_suite_id, `${label} suite ID`),
			headOid,
			status: currentStatus,
			conclusion: conclusion(item.conclusion, currentStatus, label),
			jobs: [],
		};

		let expectedTotal: number | undefined;
		for (let page = 1; page <= MAX_PAGES; page += 1) {
			this.consumePage(budget);
			const jobsLabel = `List workflow run ${runId} attempt ${attempt} jobs`;
			const output = await this.api(
				`repos/${this.authority.base.repository}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=${PAGE_SIZE}&page=${page}`,
				jobsLabel,
			);
			const parsed = record(parseJson(output, jobsLabel), jobsLabel);
			const total = integer(parsed.total_count, `${jobsLabel} total`, true);
			const pageJobs = array(parsed.jobs, jobsLabel);
			if (pageJobs.length > PAGE_SIZE) throw new Error(`${jobsLabel} page exceeded its record limit`);
			if (expectedTotal === undefined) {
				expectedTotal = total;
				if (total > MAX_RECORDS - budget.records) throw new Error(`CI evidence exceeds ${MAX_RECORDS} aggregate records`);
			} else if (total !== expectedTotal) {
				throw new Error(`${jobsLabel} total changed during collection`);
			}
			const stepCount = pageJobs.reduce<number>((count, job) => count + array(record(job, jobsLabel).steps, `${jobsLabel} steps`).length, 0);
			this.consumeRecords(budget, pageJobs.length + stepCount);
			run.jobs.push(...pageJobs.map((job) => this.parseJob(job, runId, attempt)));
			if (run.jobs.length > expectedTotal) throw new Error(`${jobsLabel} exceeded its declared total`);
			if (run.jobs.length === expectedTotal) break;
			if (!pageJobs.length) throw new Error(`${jobsLabel} ended before its declared total`);
			if (page === MAX_PAGES) throw new Error(`${jobsLabel} exceeds ${MAX_PAGES} pages`);
		}
		if (expectedTotal === undefined || run.jobs.length !== expectedTotal) throw new Error(`Workflow run ${runId} job pagination was incomplete`);
		run.jobs.sort((left, right) => left.id - right.id);
		if (new Set(run.jobs.map(({ id }) => id)).size !== run.jobs.length ||
			new Set(run.jobs.map(({ url }) => url)).size !== run.jobs.length ||
			new Set(run.jobs.map(({ checkRunUrl }) => checkRunUrl)).size !== run.jobs.length) {
			throw new Error(`Workflow run ${runId} returned duplicate job identities`);
		}
		return run;
	}

	private async readSnapshot(requireOriginalLocal: boolean): Promise<CiSnapshot> {
		const fresh = await this.freshAuthority(requireOriginalLocal);
		if (requireOriginalLocal) await this.requireOriginalLocal();
		const pageBudget = { pages: 0, records: 0 };
		const checks = await this.readCheckRuns(pageBudget);
		const failed = checks.filter(({ conclusion: value }) => value !== null && FAILED_CONCLUSIONS.has(value));
		if (!failed.length) throw new Error("Failed-CI evidence is stale: no current failed check runs remain");
		const unsupported = failed.find(({ provider }) => provider !== "github-actions");
		if (unsupported) throw new Error(`Unsupported failed check provider for immutable evidence: ${unsupported.provider}`);

		const runIds = new Set<number>();
		const detailIdentities = new Map<number, { url: string; runId: number; jobId: number }>();
		for (const check of failed) {
			if (check.detailsUrl === null) throw new Error(`Failed check run ${check.id} omitted its immutable job URL`);
			const detail = parseJobHtmlUrl(
				check.detailsUrl,
				`check run ${check.id} details URL`,
				this.authority.host,
				this.authority.base.repository,
			);
			detailIdentities.set(check.id, detail);
			runIds.add(detail.runId);
		}

		const runs: RunIdentity[] = [];
		this.consumeRecords(pageBudget, runIds.size);
		for (const runId of [...runIds].sort((left, right) => left - right)) {
			runs.push(await this.readRun(runId, pageBudget));
		}
		const allJobs = runs.flatMap(({ jobs }) => jobs);
		if (new Set(allJobs.map(({ id }) => id)).size !== allJobs.length ||
			new Set(allJobs.map(({ checkRunUrl }) => checkRunUrl)).size !== allJobs.length) {
			throw new Error("Workflow runs returned ambiguous duplicate job identities");
		}
		const runById = new Map(runs.map((run) => [run.id, run]));
		for (const run of runs) {
			for (const job of run.jobs) {
				const linked = checks.filter((check) => check.url === job.checkRunUrl);
				if (linked.length !== 1 || linked[0]!.detailsUrl !== job.htmlUrl || linked[0]!.suiteId !== run.suiteId ||
					linked[0]!.status !== job.status || linked[0]!.conclusion !== job.conclusion) {
					throw new Error(`Job ${job.id} has an incomplete, replaced, or ambiguous immutable check-run mapping`);
				}
			}
		}
		const usedJobs = new Set<number>();
		const failures: FailureIdentity[] = [];
		for (const check of failed) {
			const detail = detailIdentities.get(check.id)!;
			const run = runById.get(detail.runId);
			if (!run || run.suiteId !== check.suiteId) {
				throw new Error(`Failed check run ${check.id} has an ambiguous or stale suite-to-run mapping`);
			}
			const matches = run.jobs.filter((job) =>
				job.id === detail.jobId && job.checkRunUrl === check.url && job.htmlUrl === detail.url
			);
			if (matches.length !== 1 || usedJobs.has(detail.jobId)) {
				throw new Error(`Failed check run ${check.id} has an incomplete, duplicate, or ambiguous immutable job mapping`);
			}
			const job = matches[0]!;
			if (job.status !== "completed" || job.conclusion !== check.conclusion ||
				job.conclusion === null || !FAILED_CONCLUSIONS.has(job.conclusion)) {
				throw new Error(`Failed check run ${check.id} was replaced or is stale relative to its job`);
			}
			usedJobs.add(job.id);
			failures.push({
				check,
				run,
				job,
				failedSteps: job.steps.filter(({ conclusion: value }) => value !== null && FAILED_CONCLUSIONS.has(value)),
			});
		}
		failures.sort((left, right) => left.check.id - right.check.id);
		return {
			fingerprint: snapshotFingerprint(fresh, checks, runs, failures),
			failures,
		};
	}

	private async readJobLog(jobId: number): Promise<string> {
		const label = `Read failed job ${jobId} log`;
		return await this.api(
			`repos/${this.authority.base.repository}/actions/jobs/${jobId}/logs`,
			label,
			{ stdoutLimitBytes: LOG_BYTES, timeoutMs: LOG_TIMEOUT_MS },
		);
	}

	async collect(): Promise<CiEvidence> {
		if (this.collectConsumed || this.state.phase !== "ready") throw new Error("CI evidence collect action was already consumed");
		this.collectConsumed = true;
		this.state.phase = "collecting";
		try {
			const before = await this.readSnapshot(true);
			const metadata = before.failures.map((failure) => failureEvidence(failure, { text: "", truncated: false }));
			const metadataBytes = metadata.map(jsonBytes);
			const metadataTotal = jsonBytes(metadata);
			if (metadataBytes.some((bytes) => bytes > EVIDENCE_RECORD_BYTES) || metadataTotal > EVIDENCE_TOTAL_BYTES) {
				throw new Error("Failed-CI metadata exceeds the retained evidence budget");
			}
			let remainingBytes = EVIDENCE_TOTAL_BYTES - metadataTotal;
			const failures: CiFailureEvidence[] = [];
			for (let index = 0; index < before.failures.length; index += 1) {
				const failure = before.failures[index]!;
				const baseBytes = metadataBytes[index]!;
				const share = Math.floor(remainingBytes / (before.failures.length - index));
				const raw = await this.readJobLog(failure.job.id);
				const evidence = boundedEvidenceRecord(failure, raw, Math.min(EVIDENCE_RECORD_BYTES, baseBytes + share));
				remainingBytes -= jsonBytes(evidence) - baseBytes;
				failures.push(evidence);
			}
			if (failures.some((evidence) => jsonBytes(evidence) > EVIDENCE_RECORD_BYTES) || jsonBytes(failures) > EVIDENCE_TOTAL_BYTES) {
				throw new Error("Failed-CI evidence exceeds its retained byte budget");
			}
			const after = await this.readSnapshot(true);
			if (after.fingerprint !== before.fingerprint) {
				throw new Error("Failed-CI evidence was replaced or became stale during collection");
			}
			this.collectedFingerprint = after.fingerprint;
			this.state.fingerprint = after.fingerprint;
			this.state.phase = "collected";
			return {
				fingerprint: after.fingerprint,
				pullRequest: {
					number: this.authority.number,
					url: this.authority.url.href,
					headOid: this.authority.head.oid,
				},
				failures,
			};
		} catch (error) {
			this.state.phase = "blocked";
			throw error;
		}
	}

	private async validatePublishAuthority(): Promise<void> {
		const current = await this.readSnapshot(false);
		if (!this.collectedFingerprint || current.fingerprint !== this.collectedFingerprint) {
			throw new Error("CI repair publish cancelled: stored evidence fingerprint is stale or replaced");
		}
		const remote = await readValidatedRemoteAuthority(this.pi(), this.context(), this.authority.target.remote);
		if (remote.fetchSource !== this.authority.target.fetchSource || remote.host !== this.authority.target.host ||
			remote.repository.toLowerCase() !== this.authority.target.repository.toLowerCase()) {
			throw new Error("CI repair publish cancelled: configured remote authority changed");
		}
		const branch = outputLine(
			(await runChecked(this.exec, "git", ["branch", "--show-current"], this.options())).stdout,
			"current branch",
		);
		if (branch !== this.authority.target.branch) throw new Error("CI repair publish cancelled: current branch changed");
		const original = this.authority.head.oid;
		if (await readRemoteOid(this.exec, this.options(), this.authority.target.fetchSource, this.authority.target.ref) !== original) {
			throw new Error("CI repair publish cancelled: remote target no longer matches the frozen pull request head");
		}
		if (await inspectWorktree(this.exec, this.options()) !== "clean") {
			throw new Error("CI repair publish requires a clean worktree with no Git operation in progress");
		}
		const repairHead = await readHead(this.exec, this.options());
		if (repairHead === original || !(await isAncestor(this.exec, this.options(), original, repairHead))) {
			throw new Error("CI repair HEAD must be a new descendant of the frozen pull request head");
		}
		if (await readHead(this.exec, this.options()) !== repairHead) throw new Error("CI repair HEAD changed before push");
		this.state.repairHead = repairHead;
	}

	private blockUnpublishedAttempt(): void {
		if (this.state.phase !== "published") this.state.phase = "blocked";
	}

	async publish(): Promise<CiPublishResult> {
		if (this.publishConsumed || this.state.phase !== "collected") throw new Error("CI repair publish action is unavailable or was already consumed");
		this.publishConsumed = true;
		try {
			return await withWorktreeLock(this.cwd, async () => {
				await this.validatePublishAuthority();
				const original = this.authority.head.oid;
				const repairHead = this.state.repairHead!;
				let pushError: unknown;
				try {
					await runChecked(this.exec, "git", [
						"push", "--porcelain", `--force-with-lease=refs/heads/${this.authority.target.ref}:${original}`,
						"--recurse-submodules=no", "--", this.authority.target.fetchSource,
						`${repairHead}:refs/heads/${this.authority.target.ref}`,
					], this.options());
				} catch (error) {
					pushError = error;
				}

				let postcondition: string | null;
				try {
					postcondition = await readRemoteOid(
						this.exec,
						this.options(),
						this.authority.target.fetchSource,
						this.authority.target.ref,
					);
				} catch (error) {
					this.state.pushAttempt = "unknown";
					throw new Error(`CI repair push outcome is unknown: ${errorMessage(error)}`);
				}
				if (postcondition === repairHead) {
					this.state.pushAttempt = "applied";
					this.state.phase = "published";
					return { kind: "published", head: repairHead, attempt: "applied" };
				}
				if (postcondition === original) {
					this.state.pushAttempt = "not-applied";
					throw new Error(`CI repair push was not applied${pushError ? `: ${errorMessage(pushError)}` : ""}`);
				}
				this.state.pushAttempt = "unknown";
				throw new Error("CI repair push outcome is unknown: remote target has an unexpected OID");
			}, { agentDir: this.agentDir, signal: this.signal });
		} catch (error) {
			this.blockUnpublishedAttempt();
			throw error;
		}
	}
}
