import { createHash } from "node:crypto";
import { spawnBounded, type Exec, type ExecOptions } from "@henryqw/pi-process";
import {
	cloneCurrentPullRequest,
	loadCurrentPullRequest,
	readValidatedRemoteAuthority,
	samePullRequestSnapshot,
	type CurrentPullRequest,
	type PullRequestLoadContext,
} from "./pr-github.ts";
import {
	extensionExecApi,
	inspectWorktree,
	isAncestor,
	readHead,
	readRemoteOid,
	requiredOid,
	requiredText,
	runChecked,
	withWorktreeLock,
} from "./pr-execution.ts";

const PAGE_BYTES = 512 * 1024;
const MAX_PAGES = 100;
const MAX_RECORDS = 1_000;
const LOG_TAIL_BYTES = 20 * 1024;
const LOG_TIMEOUT_MS = 60_000;
const EVIDENCE_RECORD_BYTES = 20 * 1024;
const EVIDENCE_TOTAL_BYTES = 256 * 1024;
const PAGE_SIZE = 100;
const API_HEADERS = [
	"-H", "Accept: application/vnd.github+json",
	"-H", "X-GitHub-Api-Version: 2022-11-28",
];
const FAILED_CONCLUSIONS = new Set([
	"action_required", "cancelled", "failure", "stale", "startup_failure", "timed_out",
]);
const CONCLUSIONS = new Set([
	...FAILED_CONCLUSIONS, "neutral", "skipped", "success",
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
	suiteId: number;
	headOid: string;
	name: string;
	status: string;
	conclusion: string | null;
	provider: string;
};

type RunIdentity = {
	id: number;
	attempt: number;
	suiteId: number;
	headOid: string;
	status: string;
	conclusion: string | null;
	jobs: JobIdentity[];
};

type FailureIdentity = {
	checks: CheckIdentity[];
	run: RunIdentity;
	job: JobIdentity;
	failedSteps: StepIdentity[];
};

type CiSnapshot = {
	fingerprint: string;
	failures: FailureIdentity[];
};

export type CiFailureEvidence = {
	checkRuns: Array<{ id: number; name: string; conclusion: string }>;
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

function actionsUrl(authority: CurrentPullRequest, suffix: string): string {
	const url = new URL(authority.url.origin);
	url.pathname = `/${authority.base.repository}/actions/${suffix}`;
	return url.href;
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
	authority: CurrentPullRequest,
	failure: FailureIdentity,
	log: { text: string; truncated: boolean },
): CiFailureEvidence {
	const { checks, run, job, failedSteps } = failure;
	if (job.conclusion === null || checks.some(({ conclusion: value }) => value === null)) {
		throw new Error(`Failed job ${job.id} omitted required evidence identity`);
	}
	return {
		checkRuns: checks.map((check) => ({
			id: check.id,
			name: check.name,
			conclusion: check.conclusion!,
		})),
		checkSuite: { id: run.suiteId },
		run: { id: run.id, url: actionsUrl(authority, `runs/${run.id}`), attempt: run.attempt },
		job: {
			id: job.id,
			url: actionsUrl(authority, `runs/${run.id}/job/${job.id}`),
			name: job.name,
			conclusion: job.conclusion,
		},
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

function boundedEvidenceRecord(
	authority: CurrentPullRequest,
	failure: FailureIdentity,
	rawLog: { text: string; truncated: boolean },
	maxBytes: number,
): CiFailureEvidence {
	const metadata = failureEvidence(authority, failure, { text: "", truncated: false });
	const metadataBytes = jsonBytes(metadata);
	if (metadataBytes > maxBytes) throw new Error(`Failed job ${failure.job.id} metadata exceeds its evidence budget`);
	let logBytes = Math.min(Buffer.byteLength(rawLog.text, "utf8"), maxBytes - metadataBytes);
	while (true) {
		const retained = tailUtf8(rawLog.text, logBytes);
		const evidence = failureEvidence(authority, failure, {
			text: retained.text,
			truncated: rawLog.truncated || retained.truncated,
		});
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

function snapshotFingerprint(authority: CurrentPullRequest, failures: FailureIdentity[]): string {
	return createHash("sha256").update(JSON.stringify({
		authority: authorityIdentity(authority),
		failures: failures.map(({ checks, run, job, failedSteps }) => ({
			checks,
			run: {
				id: run.id,
				attempt: run.attempt,
				suiteId: run.suiteId,
				headOid: run.headOid,
			},
			job: {
				id: job.id,
				runId: job.runId,
				attempt: job.attempt,
				headOid: job.headOid,
				name: job.name,
				status: job.status,
				conclusion: job.conclusion,
			},
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
		this.authority = cloneCurrentPullRequest(options.authority);
		this.signal = options.signal;
		this.agentDir = options.agentDir;
		this.exec = options.exec ?? spawnBounded;
		this.load = options.loadCurrentPullRequest ?? loadCurrentPullRequest;
	}

	private options(extra: Partial<ExecOptions> = {}): ExecOptions {
		return { cwd: this.cwd, signal: this.signal, ...extra };
	}

	private pi() {
		return extensionExecApi(this.exec, this.cwd, this.signal);
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
		return {
			id,
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
		if (new Set(checks.map(({ id }) => id)).size !== checks.length) {
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
		return {
			id,
			runId,
			attempt,
			headOid,
			name: text(item.name, `job ${id} name`),
			status: currentStatus,
			conclusion: conclusion(item.conclusion, currentStatus, `job ${id}`),
			steps,
		};
	}

	private async readRunIdForSuite(suiteId: number, budget: { pages: number; records: number }): Promise<number> {
		const label = `List workflow runs for check suite ${suiteId}`;
		this.consumePage(budget);
		const endpoint = `repos/${this.authority.base.repository}/actions/runs?check_suite_id=${suiteId}&head_sha=${this.authority.head.oid}&per_page=2&page=1`;
		const parsed = record(parseJson(await this.api(endpoint, label), label), label);
		const runs = array(parsed.workflow_runs, label);
		if (integer(parsed.total_count, `${label} total`, true) !== 1 || runs.length !== 1) {
			throw new Error(`Check suite ${suiteId} did not resolve to exactly one workflow run`);
		}
		this.consumeRecords(budget, 1);
		const item = record(runs[0], label);
		if (integer(item.check_suite_id, `${label} suite ID`) !== suiteId ||
			requiredOid(item.head_sha, `${label} head OID`) !== this.authority.head.oid) {
			throw new Error(`${label} returned a stale or unrelated run`);
		}
		return integer(item.id, `${label} run ID`);
	}

	private async readRun(runId: number, suiteId: number, budget: { pages: number; records: number }): Promise<RunIdentity> {
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
		if (integer(item.check_suite_id, `${label} suite ID`) !== suiteId) {
			throw new Error(`${label} does not belong to check suite ${suiteId}`);
		}
		const run: RunIdentity = {
			id: runId,
			attempt,
			suiteId,
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
		if (new Set(run.jobs.map(({ id }) => id)).size !== run.jobs.length) {
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

		const checksBySuite = new Map<number, CheckIdentity[]>();
		for (const check of failed) {
			const suiteChecks = checksBySuite.get(check.suiteId) ?? [];
			suiteChecks.push(check);
			checksBySuite.set(check.suiteId, suiteChecks);
		}

		const runs: RunIdentity[] = [];
		for (const suiteId of [...checksBySuite.keys()].sort((left, right) => left - right)) {
			const runId = await this.readRunIdForSuite(suiteId, pageBudget);
			this.consumeRecords(pageBudget, 1);
			runs.push(await this.readRun(runId, suiteId, pageBudget));
		}
		if (new Set(runs.map(({ id }) => id)).size !== runs.length) {
			throw new Error("Check suites returned ambiguous duplicate workflow run identities");
		}
		const allJobs = runs.flatMap(({ jobs }) => jobs);
		if (new Set(allJobs.map(({ id }) => id)).size !== allJobs.length) {
			throw new Error("Workflow runs returned ambiguous duplicate job identities");
		}

		const failures: FailureIdentity[] = [];
		for (const run of runs) {
			const failedJobs = run.jobs.filter(({ status: value, conclusion: result }) =>
				value === "completed" && result !== null && FAILED_CONCLUSIONS.has(result)
			);
			if (!failedJobs.length) throw new Error(`Check suite ${run.suiteId} has no current failed workflow jobs`);
			const suiteChecks = checksBySuite.get(run.suiteId)!;
			for (const job of failedJobs) {
				failures.push({
					checks: suiteChecks,
					run,
					job,
					failedSteps: job.steps.filter(({ conclusion: value }) => value !== null && FAILED_CONCLUSIONS.has(value)),
				});
			}
		}
		failures.sort((left, right) => left.run.id - right.run.id || left.job.id - right.job.id);
		return {
			fingerprint: snapshotFingerprint(fresh, failures),
			failures,
		};
	}

	private async readJobLog(jobId: number): Promise<{ text: string; truncated: boolean }> {
		const result = await runChecked(this.exec, "gh", [
			"api", "--hostname", this.authority.host, ...API_HEADERS,
			`repos/${this.authority.base.repository}/actions/jobs/${jobId}/logs`,
		], this.options({ stdoutTailBytes: LOG_TAIL_BYTES, timeoutMs: LOG_TIMEOUT_MS }));
		if (Buffer.byteLength(result.stdout, "utf8") > LOG_TAIL_BYTES) {
			throw new Error(`Read failed job ${jobId} log executor exceeded its retained tail limit`);
		}
		return { text: result.stdout, truncated: result.stdoutTruncated === true };
	}

	async collect(): Promise<CiEvidence> {
		if (this.collectConsumed || this.state.phase !== "ready") throw new Error("CI evidence collect action was already consumed");
		this.collectConsumed = true;
		this.state.phase = "collecting";
		try {
			const before = await this.readSnapshot(true);
			const metadata = before.failures.map((failure) => failureEvidence(this.authority, failure, { text: "", truncated: false }));
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
				const evidence = boundedEvidenceRecord(this.authority, failure, raw, Math.min(EVIDENCE_RECORD_BYTES, baseBytes + share));
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

	private async requireCollectedEvidence(): Promise<void> {
		const current = await this.readSnapshot(false);
		if (!this.collectedFingerprint || current.fingerprint !== this.collectedFingerprint) {
			throw new Error("CI repair publish cancelled: stored evidence fingerprint is stale or replaced");
		}
	}

	private async requireSavedDestination(original: string): Promise<void> {
		const remote = await readValidatedRemoteAuthority(this.pi(), this.context(), this.authority.target.remote);
		if (remote.fetchSource !== this.authority.target.fetchSource || remote.host !== this.authority.target.host ||
			remote.repository.toLowerCase() !== this.authority.target.repository.toLowerCase()) {
			throw new Error("CI repair publish cancelled: configured remote authority changed");
		}
		if (await readRemoteOid(this.exec, this.options(), this.authority.target.fetchSource, this.authority.target.ref) !== original) {
			throw new Error("CI repair publish cancelled: remote target no longer matches the frozen pull request head");
		}
	}

	private async validatePublishAuthority(): Promise<string> {
		await this.requireCollectedEvidence();
		const original = this.authority.head.oid;
		await this.requireSavedDestination(original);
		const branch = outputLine(
			(await runChecked(this.exec, "git", ["branch", "--show-current"], this.options())).stdout,
			"current branch",
		);
		if (branch !== this.authority.target.branch) throw new Error("CI repair publish cancelled: current branch changed");
		if (await inspectWorktree(this.exec, this.options()) !== "clean") {
			throw new Error("CI repair publish requires a clean worktree with no Git operation in progress");
		}
		const repairHead = await readHead(this.exec, this.options());
		if (repairHead === original || !(await isAncestor(this.exec, this.options(), original, repairHead))) {
			throw new Error("CI repair HEAD must be a new descendant of the frozen pull request head");
		}
		if (await readHead(this.exec, this.options()) !== repairHead) throw new Error("CI repair HEAD changed before push");
		this.state.repairHead = repairHead;
		return repairHead;
	}

	private async finalPublishRevalidation(original: string, repairHead: string): Promise<void> {
		await this.requireSavedDestination(original);
		await this.requireCollectedEvidence();
		if (await readHead(this.exec, this.options()) !== repairHead) throw new Error("CI repair HEAD changed before push");
	}

	private blockUnpublishedAttempt(): void {
		if (this.state.phase !== "published") this.state.phase = "blocked";
	}

	async publish(): Promise<CiPublishResult> {
		if (this.publishConsumed || this.state.phase !== "collected") throw new Error("CI repair publish action is unavailable or was already consumed");
		this.publishConsumed = true;
		try {
			return await withWorktreeLock(this.cwd, async () => {
				const repairHead = await this.validatePublishAuthority();
				const original = this.authority.head.oid;
				await this.finalPublishRevalidation(original, repairHead);
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
