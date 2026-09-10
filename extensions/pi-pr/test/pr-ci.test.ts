import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CurrentPullRequest } from "../extensions/pr-github.ts";
import { spawnBounded, type Exec, type ExecResult } from "../extensions/pr-execution.ts";
import { PullRequestCiFixer } from "../extensions/pr-ci.ts";

const original = "a".repeat(40);
const repair = "b".repeat(40);
const base = "c".repeat(40);
const cwd = process.cwd();
const operationPaths = Array.from({ length: 6 }, (_, index) => `/tmp/pi-pr-ci-no-operation-${index}`).join("\n") + "\n";

type Check = ReturnType<typeof check>;
type Job = ReturnType<typeof job>;
type Snapshot = {
	checks: Check[];
	jobs: Job[];
	attempt?: number;
	runStatus?: string;
	runConclusion?: string | null;
};

type Scenario = {
	snapshots: Snapshot[];
	checkPage?: (snapshot: Snapshot, page: number) => { total_count: number; check_runs: Check[] };
	push?: "success" | "lost-applied" | "not-applied";
	log?: (jobId: number) => string;
	logCommand?: (jobId: number, options: Parameters<Exec>[2]) => Promise<ExecResult>;
	localHeads?: string[];
	pullRequests?: CurrentPullRequest[];
	pushUrls?: string[];
	remoteHeads?: string[];
	signal?: AbortSignal;
};

function result(stdout = "", code = 0, stderr = "", stdoutTruncated = false): ExecResult {
	return { stdout, stderr, code, killed: false, ...(stdoutTruncated ? { stdoutTruncated } : {}) };
}

function retainedUtf8Tail(value: string, limit: number): string {
	const bytes = Buffer.from(value, "utf8");
	if (bytes.length <= limit) return value;
	let start = bytes.length - limit;
	while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start += 1;
	return bytes.subarray(start).toString("utf8");
}

function pullRequest(localHead = original): CurrentPullRequest {
	return {
		id: "PR_ci",
		number: 42,
		url: new URL("https://github.com/acme/project/pull/42"),
		host: "github.com",
		approved: true,
		lifecycle: "open",
		conditions: {
			draft: false,
			baseUpdateRequired: false,
			conflict: false,
			changesRequested: false,
			unresolvedThreads: 0,
			ci: "failure",
			review: "ready",
			policy: "pending",
		},
		local: { worktree: "clean", head: localHead === original ? "equal" : "ahead" },
		base: { repository: "acme/project", ref: "main", oid: base },
		head: { repository: "acme/fork", ref: "feature", oid: original },
		headFetchSource: "git@github.com:acme/fork.git",
		target: {
			provenance: "configured",
			branch: "feature",
			remote: "fork",
			ref: "feature",
			repository: "acme/fork",
			host: "github.com",
			fetchSource: "git@github.com:acme/fork.git",
			remoteOid: original,
		},
	};
}

function check(id: number, jobId: number, options: {
	runId?: number;
	suiteId?: number;
	name?: string;
	status?: string;
	conclusion?: string | null;
	provider?: string;
} = {}) {
	const runId = options.runId ?? 71;
	const suiteId = options.suiteId ?? 61;
	const conclusion = options.conclusion === undefined ? "failure" : options.conclusion;
	return {
		id,
		url: `https://api.github.com/repos/acme/project/check-runs/${id}`,
		details_url: `https://github.com/acme/project/actions/runs/${runId}/job/${jobId}`,
		check_suite: { id: suiteId, head_sha: original },
		head_sha: original,
		name: options.name ?? `check-${id}`,
		status: options.status ?? "completed",
		conclusion,
		app: { slug: options.provider ?? "github-actions" },
	};
}

function job(id: number, checkId: number, options: {
	runId?: number;
	attempt?: number;
	name?: string;
	stepName?: string;
	status?: string;
	conclusion?: string | null;
	checkRunUrl?: string;
} = {}) {
	const runId = options.runId ?? 71;
	const attempt = options.attempt ?? 2;
	const status = options.status ?? "completed";
	const conclusion = options.conclusion === undefined ? "failure" : options.conclusion;
	return {
		id,
		run_id: runId,
		run_attempt: attempt,
		head_sha: original,
		url: `https://api.github.com/repos/acme/project/actions/jobs/${id}`,
		html_url: `https://github.com/acme/project/actions/runs/${runId}/job/${id}`,
		check_run_url: options.checkRunUrl ?? `https://api.github.com/repos/acme/project/check-runs/${checkId}`,
		name: options.name ?? `job-${id}`,
		status,
		conclusion,
		steps: [{ number: 1, name: options.stepName ?? `step-${id}`, status, conclusion }],
	};
}

function run(snapshot: Snapshot, runId = 71) {
	const runJob = snapshot.jobs.find((candidate) => candidate.run_id === runId);
	const runCheck = snapshot.checks.find((candidate) => candidate.details_url.includes(`/runs/${runId}/`));
	const attempt = runJob?.run_attempt ?? snapshot.attempt ?? 2;
	return {
		id: runId,
		url: `https://api.github.com/repos/acme/project/actions/runs/${runId}`,
		html_url: `https://github.com/acme/project/actions/runs/${runId}`,
		run_attempt: attempt,
		check_suite_id: runCheck?.check_suite.id ?? 61,
		head_sha: original,
		repository: { full_name: "acme/project" },
		head_repository: { full_name: "acme/fork" },
		status: snapshot.runStatus ?? "completed",
		conclusion: snapshot.runConclusion === undefined ? "failure" : snapshot.runConclusion,
	};
}

function harness(scenario: Scenario) {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-pr-ci-agent-"));
	let localHead = original;
	let remoteHead = original;
	let snapshotIndex = -1;
	let headIndex = 0;
	let pullRequestIndex = 0;
	let pushUrlIndex = 0;
	let remoteHeadIndex = 0;
	const calls: Array<{ command: string; args: string[]; options: Parameters<Exec>[2] }> = [];
	const logReads = new Map<number, number>();

	const exec: Exec = async (command, args, options) => {
		calls.push({ command, args: [...args], options: { ...options } });
		const endpoint = args.at(-1) ?? "";
		if (command === "gh" && args[0] === "api") {
			const checkMatch = /\/check-runs\?.*page=(\d+)$/.exec(endpoint);
			if (checkMatch) {
				const page = Number(checkMatch[1]);
				if (page === 1) snapshotIndex += 1;
				const snapshot = scenario.snapshots[Math.min(snapshotIndex, scenario.snapshots.length - 1)]!;
				const payload = scenario.checkPage
					? scenario.checkPage(snapshot, page)
					: { total_count: snapshot.checks.length, check_runs: snapshot.checks.slice((page - 1) * 100, page * 100) };
				return result(JSON.stringify(payload));
			}
			const snapshot = scenario.snapshots[Math.min(snapshotIndex, scenario.snapshots.length - 1)]!;
			const runMatch = /\/actions\/runs\/(\d+)$/.exec(endpoint);
			if (runMatch) return result(JSON.stringify(run(snapshot, Number(runMatch[1]))));
			const jobsMatch = /\/actions\/runs\/(\d+)\/attempts\/(\d+)\/jobs\?.*page=(\d+)$/.exec(endpoint);
			if (jobsMatch) {
				const runId = Number(jobsMatch[1]);
				const page = Number(jobsMatch[3]);
				const jobs = snapshot.jobs.filter((candidate) => candidate.run_id === runId);
				return result(JSON.stringify({
					total_count: jobs.length,
					jobs: jobs.slice((page - 1) * 100, page * 100),
				}));
			}
			const logMatch = /\/actions\/jobs\/(\d+)\/logs$/.exec(endpoint);
			if (logMatch) {
				const jobId = Number(logMatch[1]);
				logReads.set(jobId, (logReads.get(jobId) ?? 0) + 1);
				if (scenario.logCommand) return await scenario.logCommand(jobId, options);
				const output = scenario.log?.(jobId) ?? `log for ${jobId}\n`;
				const limit = options.stdoutTailBytes;
				return limit !== undefined && Buffer.byteLength(output, "utf8") > limit
					? result(retainedUtf8Tail(output, limit), 0, "", true)
					: result(output);
			}
		}
		if (command === "gh" && args[0] === "repo" && args[1] === "view") {
			return result(JSON.stringify({ nameWithOwner: "acme/fork", url: "https://github.com/acme/fork" }));
		}
		if (command === "git" && args.join(" ") === "branch --show-current") return result("feature\n");
		if (command === "git" && args.join(" ") === "status --porcelain=v1 --untracked-files=all") return result();
		if (command === "git" && args[0] === "rev-parse" && args.includes("--git-path")) return result(operationPaths);
		if (command === "git" && args.join(" ") === "rev-parse --verify HEAD^{commit}") {
			return result(`${scenario.localHeads?.[headIndex++] ?? localHead}\n`);
		}
		if (command === "git" && args[0] === "merge-base") return result();
		if (command === "git" && args.join(" ") === "remote get-url --push --all fork") {
			return result(`${scenario.pushUrls?.[pushUrlIndex++] ?? "git@github.com:acme/fork.git"}\n`);
		}
		if (command === "git" && args.join(" ") === "remote get-url --all fork") {
			return result("git@github.com:acme/fork.git\n");
		}
		if (command === "git" && args[0] === "ls-remote") {
			return result(`${scenario.remoteHeads?.[remoteHeadIndex++] ?? remoteHead}\trefs/heads/feature\n`);
		}
		if (command === "git" && args[0] === "push") {
			if (scenario.push === "lost-applied") {
				remoteHead = repair;
				throw new Error("push response lost");
			}
			if (scenario.push === "not-applied") return result("", 1, "lease rejected");
			remoteHead = repair;
			return result("ok\n");
		}
		throw new Error(`Unexpected ${command} ${args.join(" ")}`);
	};
	const workflow = new PullRequestCiFixer({
		cwd,
		authority: pullRequest(),
		exec,
		agentDir,
		signal: scenario.signal,
		loadCurrentPullRequest: async () => ({
			kind: "current",
			pullRequest: scenario.pullRequests?.[pullRequestIndex++] ?? pullRequest(localHead),
		}),
	});
	return {
		agentDir,
		calls,
		logReads,
		workflow,
		setLocalHead(value: string) { localHead = value; },
	};
}

function oneFailure(): Snapshot {
	return { checks: [check(11, 101)], jobs: [job(101, 11)] };
}

test("streams bounded complete UTF-8 stdout tails and rejects invalid UTF-8", async () => {
	const streamed = await spawnBounded(process.execPath, [
		"-e",
		"process.stdout.write(Buffer.concat([Buffer.alloc(9 * 1024 * 1024, 0x78), Buffer.from('x🙂終')]))",
	], { cwd, stdoutTailBytes: 6 });
	assert.equal(streamed.stdout, "終");
	assert.equal(streamed.stdoutTruncated, true);
	assert.ok(Buffer.byteLength(streamed.stdout, "utf8") <= 6);

	await assert.rejects(
		spawnBounded(process.execPath, ["-e", "process.stdout.write(Buffer.from([0xff]))"], {
			cwd,
			stdoutTailBytes: 20 * 1024,
		}),
		/stdout was not valid UTF-8/,
	);
});

test("aborts an in-flight streamed log read and blocks collection", async (t) => {
	const controller = new AbortController();
	const app = harness({
		snapshots: [oneFailure()],
		signal: controller.signal,
		logCommand: async (_jobId, options) => {
			setTimeout(() => controller.abort(new Error("log read cancelled")), 25);
			return await spawnBounded(process.execPath, ["-e", "setInterval(() => {}, 1000)"], options);
		},
	});
	t.after(() => rmSync(app.agentDir, { recursive: true, force: true }));
	await assert.rejects(app.workflow.collect(), /log read cancelled/);
	assert.equal(app.workflow.state.phase, "blocked");
});

test("proves check-run and job pagination complete and rejects bounded overflow or truncation", async (t) => {
	await t.test("paginates both collections to their declared totals", async (t) => {
		const checks = Array.from({ length: 101 }, (_, index) => check(
			1_000 + index,
			2_000 + index,
			{ conclusion: index === 100 ? "failure" : "success" },
		));
		const jobs = Array.from({ length: 101 }, (_, index) => job(
			2_000 + index,
			1_000 + index,
			{ conclusion: index === 100 ? "failure" : "success" },
		));
		const app = harness({ snapshots: [{ checks, jobs }] });
		t.after(() => rmSync(app.agentDir, { recursive: true, force: true }));
		const evidence = await app.workflow.collect();
		assert.equal(evidence.failures.length, 1);
		assert.equal(app.calls.filter(({ args }) => /check-runs\?.*page=2$/.test(args.at(-1) ?? "")).length, 2);
		assert.equal(app.calls.filter(({ args }) => /\/jobs\?.*page=2$/.test(args.at(-1) ?? "")).length, 2);
		for (const call of app.calls.filter(({ command, args }) => command === "gh" && args[0] === "api" && !/\/logs$/.test(args.at(-1) ?? ""))) {
			assert.equal(call.options.stdoutLimitBytes, 512 * 1024);
		}
	});

	await t.test("rejects more than 1000 declared check runs", async (t) => {
		const app = harness({
			snapshots: [oneFailure()],
			checkPage: (_snapshot, page) => ({ total_count: 1_001, check_runs: page === 1 ? [check(11, 101)] : [] }),
		});
		t.after(() => rmSync(app.agentDir, { recursive: true, force: true }));
		await assert.rejects(app.workflow.collect(), /exceeds 1000 aggregate records/);
		assert.equal(app.calls.filter(({ args }) => /check-runs\?/.test(args.at(-1) ?? "")).length, 1);
	});

	await t.test("rejects pagination beyond 100 pages", async (t) => {
		const app = harness({
			snapshots: [oneFailure()],
			checkPage: (_snapshot, page) => ({
				total_count: 101,
				check_runs: [check(1_000 + page, 2_000 + page, { conclusion: "success" })],
			}),
		});
		t.after(() => rmSync(app.agentDir, { recursive: true, force: true }));
		await assert.rejects(app.workflow.collect(), /exceeds 100 pages/);
		assert.equal(app.calls.filter(({ args }) => /check-runs\?/.test(args.at(-1) ?? "")).length, 100);
	});

	await t.test("rejects an empty page before the declared total", async (t) => {
		const app = harness({
			snapshots: [oneFailure()],
			checkPage: (_snapshot, page) => ({ total_count: 2, check_runs: page === 1 ? [check(11, 101)] : [] }),
		});
		t.after(() => rmSync(app.agentDir, { recursive: true, force: true }));
		await assert.rejects(app.workflow.collect(), /ended before its declared total/);
	});

	await t.test("rejects a later run's declared jobs before exceeding the global record cap", async (t) => {
		const firstJobs = Array.from({ length: 400 }, (_, index) => job(101 + index, 10_000 + index, {
			runId: 71,
			checkRunUrl: `https://api.github.com/repos/acme/project/check-runs/${10_000 + index}`,
		}));
		const secondJobs = Array.from({ length: 100 }, (_, index) => job(1_001 + index, 20_000 + index, {
			runId: 72,
			checkRunUrl: `https://api.github.com/repos/acme/project/check-runs/${20_000 + index}`,
		}));
		const app = harness({ snapshots: [{
			checks: [check(11, 101), check(12, 1_001, { runId: 72, suiteId: 62 })],
			jobs: [...firstJobs, ...secondJobs],
		}] });
		t.after(() => rmSync(app.agentDir, { recursive: true, force: true }));
		await assert.rejects(app.workflow.collect(), /exceeds 1000 aggregate records/);
		assert.equal(app.calls.filter(({ args }) => /\/actions\/runs\/72\/.*\/jobs\?/.test(args.at(-1) ?? "")).length, 1);
	});
});

test("binds names only for display, retains immutable attempt identities, and caps evidence", async (t) => {
	const checks = Array.from({ length: 14 }, (_, index) => check(100 + index, 200 + index, { name: "display-name" }));
	const jobs = Array.from({ length: 14 }, (_, index) => job(200 + index, 100 + index, { name: `different-job-${index}` }));
	const app = harness({ snapshots: [{ checks, jobs }], log: () => "x".repeat(30 * 1024) });
	t.after(() => rmSync(app.agentDir, { recursive: true, force: true }));
	const evidence = await app.workflow.collect();
	assert.equal(evidence.failures.length, 14);
	assert.deepEqual(evidence.failures[0]!.checkRun, {
		id: 100,
		url: "https://api.github.com/repos/acme/project/check-runs/100",
		detailsUrl: "https://github.com/acme/project/actions/runs/71/job/200",
		name: "display-name",
		conclusion: "failure",
	});
	assert.deepEqual(evidence.failures[0]!.checkSuite, { id: 61 });
	assert.deepEqual(evidence.failures[0]!.run, {
		id: 71,
		url: "https://github.com/acme/project/actions/runs/71",
		attempt: 2,
	});
	assert.equal(evidence.failures[0]!.job.id, 200);
	assert.equal(evidence.failures[0]!.failedSteps[0]!.number, 1);
	assert.ok(evidence.failures.every((failure) => Buffer.byteLength(JSON.stringify(failure), "utf8") <= 20 * 1024));
	assert.ok(Buffer.byteLength(JSON.stringify(evidence.failures), "utf8") <= 256 * 1024);
	assert.ok([...app.logReads.values()].every((reads) => reads === 1));
	assert.ok(evidence.failures.every(({ log }) => log.truncated));
	for (const call of app.calls.filter(({ args }) => /\/logs$/.test(args.at(-1) ?? ""))) {
		assert.equal(call.options.stdoutTailBytes, 20 * 1024);
		assert.equal(call.options.stdoutLimitBytes, undefined);
		assert.equal(call.options.timeoutMs, 60_000);
	}
});

test("rejects evidence whose complete emitted metadata exceeds its byte budget", async (t) => {
	const oversized = check(11, 101, { name: "x".repeat(8 * 1024) });
	const oversizedJob = job(101, 11, { name: "y".repeat(8 * 1024), stepName: "z".repeat(8 * 1024) });
	const app = harness({ snapshots: [{ checks: [oversized], jobs: [oversizedJob] }] });
	t.after(() => rmSync(app.agentDir, { recursive: true, force: true }));
	await assert.rejects(app.workflow.collect(), /metadata exceeds/);
	assert.equal(app.logReads.size, 0);
});

test("blocks unsupported or ambiguous evidence and collects diagnosable stale failures", async (t) => {
	await t.test("stale check and job conclusions", async (t) => {
		const app = harness({ snapshots: [{ checks: [check(11, 101, { conclusion: "stale" })], jobs: [job(101, 11, { conclusion: "stale" })] }] });
		t.after(() => rmSync(app.agentDir, { recursive: true, force: true }));
		const evidence = await app.workflow.collect();
		assert.equal(evidence.failures[0]!.checkRun.conclusion, "stale");
		assert.equal(evidence.failures[0]!.job.conclusion, "stale");
		assert.equal(app.logReads.get(101), 1);
	});

	await t.test("stale nested step conclusion", async (t) => {
		const staleStep = job(101, 11);
		staleStep.steps[0]!.conclusion = "stale";
		const app = harness({ snapshots: [{ checks: [check(11, 101)], jobs: [staleStep] }] });
		t.after(() => rmSync(app.agentDir, { recursive: true, force: true }));
		const evidence = await app.workflow.collect();
		assert.equal(evidence.failures[0]!.failedSteps[0]!.conclusion, "stale");
		assert.equal(app.logReads.get(101), 1);
	});

	await t.test("unexpected API origin", async (t) => {
		const foreign = check(11, 101);
		foreign.url = "https://example.com/repos/acme/project/check-runs/11";
		const app = harness({ snapshots: [{ checks: [foreign], jobs: [job(101, 11)] }] });
		t.after(() => rmSync(app.agentDir, { recursive: true, force: true }));
		await assert.rejects(app.workflow.collect(), /unexpected API origin/);
	});

	await t.test("noncanonical decimal job identity", async (t) => {
		const malformed = check(11, 101);
		malformed.details_url = "https://github.com/acme/project/actions/runs/71/job/0101";
		const app = harness({ snapshots: [{ checks: [malformed], jobs: [job(101, 11)] }] });
		t.after(() => rmSync(app.agentDir, { recursive: true, force: true }));
		await assert.rejects(app.workflow.collect(), /noncanonical decimal ID/);
	});

	await t.test("external failed provider", async (t) => {
		const app = harness({
			snapshots: [{ checks: [check(11, 101, { provider: "external-ci" })], jobs: [job(101, 11)] }],
		});
		t.after(() => rmSync(app.agentDir, { recursive: true, force: true }));
		await assert.rejects(app.workflow.collect(), /Unsupported failed check provider/);
		assert.equal(app.calls.some(({ args }) => /\/actions\/runs\/71$/.test(args.at(-1) ?? "")), false);
	});

	await t.test("duplicate immutable job mapping", async (t) => {
		const duplicate = job(102, 12, {
			checkRunUrl: "https://api.github.com/repos/acme/project/check-runs/11",
		});
		const app = harness({ snapshots: [{ checks: [check(11, 101)], jobs: [job(101, 11), duplicate] }] });
		t.after(() => rmSync(app.agentDir, { recursive: true, force: true }));
		await assert.rejects(app.workflow.collect(), /duplicate job identities|ambiguous duplicate job identities/);
	});

	await t.test("replacement between log capture and fingerprint recomputation", async (t) => {
		const first = oneFailure();
		const second = { checks: [check(12, 102)], jobs: [job(102, 12)] };
		const app = harness({ snapshots: [first, second] });
		t.after(() => rmSync(app.agentDir, { recursive: true, force: true }));
		await assert.rejects(app.workflow.collect(), /replaced or became stale/);
		assert.equal(app.logReads.get(101), 1);
		assert.equal(app.workflow.state.phase, "blocked");
	});

	await t.test("replacement before publish", async (t) => {
		const first = oneFailure();
		const second = { checks: [check(12, 102)], jobs: [job(102, 12)] };
		const app = harness({ snapshots: [first, first, second] });
		t.after(() => rmSync(app.agentDir, { recursive: true, force: true }));
		await app.workflow.collect();
		app.setLocalHead(repair);
		await assert.rejects(app.workflow.publish(), /stored evidence fingerprint is stale or replaced/);
		assert.equal(app.calls.some(({ command, args }) => command === "git" && args[0] === "push"), false);
	});
});

test("revalidates destination, open PR, failed evidence, and HEAD immediately before push", async (t) => {
	await t.test("saved push URL changed", async (t) => {
		const app = harness({
			snapshots: [oneFailure()],
			pushUrls: ["git@github.com:acme/fork.git", "git@github.com:acme/other.git"],
		});
		t.after(() => rmSync(app.agentDir, { recursive: true, force: true }));
		await app.workflow.collect();
		app.setLocalHead(repair);
		await assert.rejects(app.workflow.publish(), /repository|authority/);
		assert.equal(app.calls.some(({ command, args }) => command === "git" && args[0] === "push"), false);
	});

	await t.test("saved remote ref moved", async (t) => {
		const app = harness({
			snapshots: [oneFailure()],
			remoteHeads: [original, "d".repeat(40)],
		});
		t.after(() => rmSync(app.agentDir, { recursive: true, force: true }));
		await app.workflow.collect();
		app.setLocalHead(repair);
		await assert.rejects(app.workflow.publish(), /remote target no longer matches/);
		assert.equal(app.calls.some(({ command, args }) => command === "git" && args[0] === "push"), false);
	});

	await t.test("pull request closed", async (t) => {
		const open = pullRequest();
		const closed = { ...pullRequest(), lifecycle: "closed" as const };
		const app = harness({ snapshots: [oneFailure()], pullRequests: [open, open, open, closed] });
		t.after(() => rmSync(app.agentDir, { recursive: true, force: true }));
		await app.workflow.collect();
		app.setLocalHead(repair);
		await assert.rejects(app.workflow.publish(), /frozen pull request/);
		assert.equal(app.calls.some(({ command, args }) => command === "git" && args[0] === "push"), false);
	});

	await t.test("failure evidence changed", async (t) => {
		const first = oneFailure();
		const changed = { checks: [check(12, 102)], jobs: [job(102, 12)] };
		const app = harness({ snapshots: [first, first, first, changed] });
		t.after(() => rmSync(app.agentDir, { recursive: true, force: true }));
		await app.workflow.collect();
		app.setLocalHead(repair);
		await assert.rejects(app.workflow.publish(), /stored evidence fingerprint is stale or replaced/);
		assert.equal(app.calls.some(({ command, args }) => command === "git" && args[0] === "push"), false);
	});

	await t.test("repair HEAD changed", async (t) => {
		const changedHead = "d".repeat(40);
		const app = harness({
			snapshots: [oneFailure()],
			localHeads: [original, original, repair, repair, changedHead],
		});
		t.after(() => rmSync(app.agentDir, { recursive: true, force: true }));
		await app.workflow.collect();
		app.setLocalHead(repair);
		await assert.rejects(app.workflow.publish(), /HEAD changed before push/);
		assert.equal(app.calls.some(({ command, args }) => command === "git" && args[0] === "push"), false);
	});
});

test("allows unrelated running checks and jobs to succeed before publication", async (t) => {
	const running: Snapshot = {
		checks: [check(11, 101), check(12, 102, { status: "in_progress", conclusion: null })],
		jobs: [job(101, 11), job(102, 12, { status: "in_progress", conclusion: null })],
		runStatus: "in_progress",
		runConclusion: null,
	};
	const completed: Snapshot = {
		checks: [check(11, 101), check(12, 102, { conclusion: "success" })],
		jobs: [job(101, 11), job(102, 12, { conclusion: "success" })],
	};
	const app = harness({ snapshots: [running, running, completed], push: "success" });
	t.after(() => rmSync(app.agentDir, { recursive: true, force: true }));
	await app.workflow.collect();
	app.setLocalHead(repair);
	assert.deepEqual(await app.workflow.publish(), { kind: "published", head: repair, attempt: "applied" });
});

test("rejects new failures or changed original failure evidence before publication", async (t) => {
	await t.test("new failure", async (t) => {
		const first = oneFailure();
		const second = { checks: [...first.checks, check(12, 102)], jobs: [...first.jobs, job(102, 12)] };
		const app = harness({ snapshots: [first, first, second] });
		t.after(() => rmSync(app.agentDir, { recursive: true, force: true }));
		await app.workflow.collect();
		app.setLocalHead(repair);
		await assert.rejects(app.workflow.publish(), /stored evidence fingerprint is stale or replaced/);
	});

	await t.test("changed failed step", async (t) => {
		const first = oneFailure();
		const second = oneFailure();
		second.jobs[0]!.steps[0]!.name = "changed failure evidence";
		const app = harness({ snapshots: [first, first, second] });
		t.after(() => rmSync(app.agentDir, { recursive: true, force: true }));
		await app.workflow.collect();
		app.setLocalHead(repair);
		await assert.rejects(app.workflow.publish(), /stored evidence fingerprint is stale or replaced/);
	});
});

test("classifies a lost push response as applied from the remote postcondition and cannot replay", async (t) => {
	const app = harness({ snapshots: [oneFailure()], push: "lost-applied" });
	t.after(() => rmSync(app.agentDir, { recursive: true, force: true }));
	await app.workflow.collect();
	app.setLocalHead(repair);
	assert.deepEqual(await app.workflow.publish(), { kind: "published", head: repair, attempt: "applied" });
	assert.equal(app.workflow.state.pushAttempt, "applied");
	await assert.rejects(app.workflow.publish(), /unavailable or was already consumed/);
	assert.equal(app.calls.filter(({ command, args }) => command === "git" && args[0] === "push").length, 1);
});

test("captures repair HEAD internally and pushes one explicit OID refspec with an exact lease", async (t) => {
	const app = harness({ snapshots: [oneFailure()], push: "success" });
	t.after(() => rmSync(app.agentDir, { recursive: true, force: true }));
	await app.workflow.collect();
	app.setLocalHead(repair);
	await app.workflow.publish();
	const pushes = app.calls.filter(({ command, args }) => command === "git" && args[0] === "push");
	assert.deepEqual(pushes.map(({ args }) => args), [[
		"push",
		"--porcelain",
		`--force-with-lease=refs/heads/feature:${original}`,
		"--recurse-submodules=no",
		"--",
		"git@github.com:acme/fork.git",
		`${repair}:refs/heads/feature`,
	]]);
	assert.equal(app.workflow.state.repairHead, repair);
	const pushIndex = app.calls.findIndex(({ command, args }) => command === "git" && args[0] === "push");
	assert.equal(app.calls[pushIndex - 1]?.args.join(" "), "rev-parse --verify HEAD^{commit}");
	assert.equal(app.calls.filter(({ command, args }) => command === "gh" && args[0] === "repo" && args[1] === "view").length, 4);
	assert.equal(app.calls.filter(({ args }) => /check-runs\?.*page=1$/.test(args.at(-1) ?? "")).length, 4);
});
