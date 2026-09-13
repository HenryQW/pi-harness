import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
	CheckedGitRuntime,
	type DirectProcessOptions,
	type DirectProcessRunner,
	type ExactReviewExecutorInput,
} from "../src/git-runtime.ts";
import { sameIdentity, type AllocationIntent, type CheckBatchEvidence, type CommandEvidence, type ReviewEvidence, type TaskAttempt, type TaskRequest, type WorktreeRecord, type WorkspaceIdentity } from "../src/schema.ts";
import type { OperationContext, VerifiedReviewerLaunch } from "../src/runner.ts";

const launch: VerifiedReviewerLaunch = {
	key: "reviewer/fast",
	role: "reviewer",
	modelClass: "fast",
	model: "provider/model",
	thinkingLevel: "high",
	args: ["--model", "provider/model"],
	env: {},
	tools: ["read", "grep", "find", "ls"],
	fingerprint: "1".repeat(64),
};

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

const directProcess: DirectProcessRunner = (command, args, options) => new Promise((resolve) => {
	execFile(command, args, {
		cwd: options.cwd,
		signal: options.signal,
		timeout: options.timeoutMs,
		maxBuffer: 1024 * 1024,
		shell: false,
	}, (error, stdout, stderr) => resolve({
		code: error ? (typeof error.code === "number" ? error.code : -1) : 0,
		killed: Boolean(error && "killed" in error && error.killed),
		stdout: String(stdout),
		stderr: String(stderr),
	}));
});

function context(timeoutMs = 20_000): OperationContext {
	const signal = new AbortController().signal;
	return { signal, timeoutMs, deadline: Date.now() + timeoutMs };
}

function task(id: string, judgment = false): TaskRequest {
	return {
		id,
		modelClass: "fast",
		requirements: `Implement ${id}.`,
		deliverable: `Deliver ${id}.`,
		dependsOn: [],
		checks: [{ command: process.execPath, args: ["-e", "process.exit(0)"] }],
		...(judgment ? { judgment: { criterion: `Review ${id}.`, modelClass: "fast" as const } } : {}),
	};
}

async function repository(t: test.TestContext): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "pi-orchestrator-git-"));
	t.after(async () => await rm(root, { recursive: true, force: true }));
	git(root, "init", "-q", "-b", "main");
	git(root, "config", "user.name", "Orchestrator Test");
	git(root, "config", "user.email", "orchestrator@example.com");
	await writeFile(join(root, "base.txt"), "base\n");
	git(root, "add", "base.txt");
	git(root, "commit", "-qm", "base");
	return root;
}

async function commit(cwd: string, path: string, contents: string): Promise<void> {
	await mkdir(dirname(join(cwd, path)), { recursive: true });
	await writeFile(join(cwd, path), contents);
	git(cwd, "add", "--", path);
	git(cwd, "commit", "-qm", `change ${path}`);
}

function worktreeIntent(id: string, token: string): AllocationIntent {
	return { kind: "worktree", generation: 1, token, details: "pending", status: "allocating" };
}

async function allocate(
	runtime: CheckedGitRuntime,
	root: string,
	definition: TaskRequest,
	waveBase: WorkspaceIdentity,
	token: string,
	operationContext = context(),
): Promise<{ attempt: TaskAttempt; intent: AllocationIntent; result: Awaited<ReturnType<CheckedGitRuntime["allocateWorktree"]>> }> {
	const intent = worktreeIntent(definition.id, token);
	const attempt: TaskAttempt = {
		number: 1,
		waveNumber: 1,
		waveBase,
		correlationToken: token,
		allocationGeneration: 1,
		allocations: [intent],
		prompts: [],
		cleanup: ["worker_tab", "workspace", "worktree", "branch"].map((kind) => ({ kind: kind as any, status: "pending" })),
	};
	const result = await runtime.allocateWorktree({
		root,
		intent,
		task: definition,
		attempt,
		onPrepared: async (worktree) => {
			assert.equal(git(root, "branch", "--list", worktree.branch), "");
			intent.worktree = { ...worktree };
			intent.details = JSON.stringify(worktree);
		},
	}, operationContext);
	if (result.outcome === "owned") {
		intent.status = "owned";
		intent.resourceId = result.resourceId;
	}
	return { attempt, intent, result };
}

function recordExactWorkerTermination(attempt: TaskAttempt, candidate: WorkspaceIdentity): void {
	if (attempt.candidate && !sameIdentity(attempt.candidate, candidate)) {
		assert.fail("Worker termination candidate must match the recorded task candidate.");
	}
	attempt.candidate = { ...candidate };
	attempt.termination = {
		status: "terminated",
		workerId: `worker-${attempt.correlationToken}`,
		candidate: { ...candidate },
		at: Date.now(),
	};
}

function checksEvidence(candidate: WorkspaceIdentity, results: Awaited<ReturnType<CheckedGitRuntime["runChecks"]>>): CheckBatchEvidence {
	return {
		phase: "authoritative",
		candidate,
		identityAfter: results.identityAfter,
		results: results.results.map((result): CommandEvidence => ({
			command: result.command,
			args: [...result.args],
			code: result.code,
			killed: result.killed ?? false,
			stdout: result.stdout,
			stderr: result.stderr,
		})),
		passed: results.results.every((result) => result.code === 0 && !result.killed) && sameIdentity(candidate, results.identityAfter),
		at: Date.now(),
	};
}

function reviewEvidence(
	definition: TaskRequest,
	base: WorkspaceIdentity,
	tip: WorkspaceIdentity,
	result: Awaited<ReturnType<CheckedGitRuntime["review"]>>,
): ReviewEvidence {
	return {
		phase: "authoritative",
		launchKey: launch.key,
		criterion: definition.judgment!.criterion,
		base,
		tip,
		identityAfter: result.identityAfter,
		verdict: result.verdict,
		passed: result.verdict === "PASS" && sameIdentity(result.identityAfter, tip),
		at: Date.now(),
	};
}

async function prepareIntegration(
	runtime: CheckedGitRuntime,
	root: string,
	definition: TaskRequest,
	attempt: TaskAttempt,
	candidate: WorkspaceIdentity,
	onto: WorkspaceIdentity,
	operationContext = context(),
): Promise<{ base: WorkspaceIdentity; candidate: WorkspaceIdentity; checks: CheckBatchEvidence; review?: ReviewEvidence }> {
	recordExactWorkerTermination(attempt, candidate);
	const rebased = await runtime.rebase({ root, task: definition, attempt, candidate, onto }, operationContext);
	if (rebased.outcome !== "ready") assert.fail(rebased.failure);
	attempt.integrationBase = rebased.base;
	attempt.integrationCandidate = rebased.candidate;
	const checkResult = await runtime.runChecks({
		root,
		scope: "task",
		taskId: definition.id,
		attempt,
		checks: definition.checks,
		candidate: rebased.candidate,
	}, operationContext);
	const checks = checksEvidence(rebased.candidate, checkResult);
	attempt.authoritativeChecks = checks;
	let review: ReviewEvidence | undefined;
	if (definition.judgment) {
		const result = await runtime.review({
			root,
			scope: "task",
			phase: "authoritative",
			taskId: definition.id,
			attempt,
			criterion: definition.judgment.criterion,
			base: rebased.base,
			tip: rebased.candidate,
			verifyLaunch: async () => launch,
		}, operationContext);
		review = reviewEvidence(definition, rebased.base, rebased.candidate, result);
		attempt.authoritativeReview = review;
	}
	return { base: rebased.base, candidate: rebased.candidate, checks, ...(review ? { review } : {}) };
}

async function integrate(
	runtime: CheckedGitRuntime,
	root: string,
	definition: TaskRequest,
	attempt: TaskAttempt,
	prepared: Awaited<ReturnType<typeof prepareIntegration>>,
	operationContext = context(),
): Promise<WorkspaceIdentity> {
	const result = await runtime.integrate({
		root,
		task: definition,
		attempt,
		expectedMain: prepared.base,
		candidate: prepared.candidate,
		checks: prepared.checks,
		...(prepared.review ? { review: prepared.review } : {}),
	}, operationContext);
	if (result.outcome !== "integrated") assert.fail(result.failure);
	attempt.integration = {
		status: "integrated",
		expectedMain: prepared.base,
		candidate: prepared.candidate,
		mainAfter: result.main,
	};
	return result.main;
}

test("worktree allocation persists helper-derived intent before add and retains setup drift", async (t) => {
	const root = await repository(t);
	const calls: { command: string; args: string[]; options: DirectProcessOptions }[] = [];
	let driftAfterAdd = false;
	const operationContext = context();
	const runtime = new CheckedGitRuntime({
		runProcess: async (command, args, options) => {
			calls.push({ command, args: [...args], options });
			const result = await directProcess(command, args, options);
			if (driftAfterAdd && command === "git" && args[0] === "worktree" && args[1] === "add" && result.code === 0) {
				await commit(root, "drift.txt", "drift\n");
			}
			return result;
		},
	});
	const waveBase = await runtime.inspectMain({ root }, operationContext);
	const first = await allocate(runtime, root, task("first"), waveBase, "token-first-00001", operationContext);
	assert.equal(first.result.outcome, "owned");
	assert.equal(first.intent.worktree?.baseCommit, waveBase.head);
	assert.equal(first.intent.resourceId, first.intent.worktree?.path);
	assert.ok(first.intent.worktree && await readFile(join(first.intent.worktree.path, "base.txt"), "utf8") === "base\n");
	assert.ok(calls.every((call) => Array.isArray(call.args)
		&& call.options.signal === operationContext.signal
		&& call.options.timeoutMs > 0
		&& call.options.timeoutMs <= operationContext.timeoutMs));

	const mismatchedBase = { ...waveBase, head: "f".repeat(40) };
	const mismatch = await allocate(runtime, root, task("mismatch"), mismatchedBase, "token-mismatch-01", operationContext);
	assert.equal(mismatch.result.outcome, "absent");
	assert.equal(mismatch.intent.worktree, undefined);

	driftAfterAdd = true;
	const drifting = await allocate(runtime, root, task("drifting"), waveBase, "token-drifting-01", operationContext);
	assert.equal(drifting.result.outcome, "unknown");
	assert.ok(drifting.intent.worktree);
	assert.deepEqual(drifting.result.outcome === "unknown" && drifting.result.possibleResources, [
		drifting.intent.worktree!.path,
		drifting.intent.worktree!.branch,
	]);
});

test("pre-prompt inspection proves exact owned worktree identity and fails closed on drift", async (t) => {
	async function prepared(t: test.TestContext, definition: TaskRequest, runtime = new CheckedGitRuntime()) {
		const root = await repository(t);
		const base = await runtime.inspectMain({ root }, context());
		const allocated = await allocate(runtime, root, definition, base, `token-${definition.id}-000001`);
		assert.equal(allocated.result.outcome, "owned");
		return { root, base, runtime, ...allocated };
	}

	await t.test("initial and correction success", async (t) => {
		const definition = task("success");
		const setup = await prepared(t, definition);
		const initial = await setup.runtime.inspectTaskCandidate({
			root: setup.root, task: definition, attempt: setup.attempt,
		}, context());
		assert.equal(initial.branch, `refs/heads/${setup.intent.worktree!.branch}`);
		assert.equal(initial.head, setup.base.head);
		assert.equal(initial.index, setup.base.index);
		assert.equal(initial.tree, setup.base.tree);

		await commit(setup.intent.worktree!.cwd, "candidate.txt", "candidate\n");
		const candidate = await setup.runtime.inspectRetainedTask({
			root: setup.root, task: definition, attempt: setup.attempt,
		}, context());
		setup.attempt.prompts.push({ kind: "initial", status: "settled", preCandidate: initial, candidate, at: Date.now() });
		setup.attempt.candidate = candidate;
		assert.deepEqual(await setup.runtime.inspectTaskCandidate({
			root: setup.root, task: definition, attempt: setup.attempt,
		}, context()), candidate);
	});

	await t.test("ownership", async (t) => {
		const definition = task("ownership");
		const setup = await prepared(t, definition);
		setup.intent.status = "absent";
		await assert.rejects(setup.runtime.inspectTaskCandidate({
			root: setup.root, task: definition, attempt: setup.attempt,
		}, context()), /owned worktree allocation metadata/);
	});

	await t.test("registration", async (t) => {
		const definition = task("registration");
		const setup = await prepared(t, definition);
		git(setup.root, "worktree", "remove", "--force", setup.intent.worktree!.path);
		await mkdir(setup.intent.worktree!.path, { recursive: true });
		await assert.rejects(setup.runtime.inspectTaskCandidate({
			root: setup.root, task: definition, attempt: setup.attempt,
		}, context()), /not registered/);
	});

	await t.test("checked-out branch", async (t) => {
		const definition = task("branch");
		const setup = await prepared(t, definition);
		git(setup.intent.worktree!.cwd, "checkout", "-qb", "unexpected-branch");
		await assert.rejects(setup.runtime.inspectTaskCandidate({
			root: setup.root, task: definition, attempt: setup.attempt,
		}, context()), /moved off its owned branch/);
	});

	await t.test("branch tip", async (t) => {
		let recordedBranch: string | undefined;
		const runtime = new CheckedGitRuntime({
			runProcess: async (command, args, options) => {
				const result = await directProcess(command, args, options);
				if (recordedBranch && command === "git"
					&& args.join(" ") === `rev-parse --verify refs/heads/${recordedBranch}^{commit}`) {
					return { ...result, stdout: `${"f".repeat(40)}\n` };
				}
				return result;
			},
		});
		const definition = task("tip");
		const setup = await prepared(t, definition, runtime);
		recordedBranch = setup.intent.worktree!.branch;
		await assert.rejects(runtime.inspectTaskCandidate({
			root: setup.root, task: definition, attempt: setup.attempt,
		}, context()), /branch no longer names its checked-out HEAD/);
	});

	await t.test("dirty candidate", async (t) => {
		const definition = task("dirty-prompt");
		const setup = await prepared(t, definition);
		await writeFile(join(setup.intent.worktree!.cwd, "untracked.txt"), "dirty\n");
		await assert.rejects(setup.runtime.inspectTaskCandidate({
			root: setup.root, task: definition, attempt: setup.attempt,
		}, context()), /tracked|dirty|inspection/i);
	});

	await t.test("gitlink", async (t) => {
		const definition = task("gitlink-prompt");
		const setup = await prepared(t, definition);
		git(setup.intent.worktree!.cwd, "update-index", "--add", "--cacheinfo", `160000,${setup.base.head},nested`);
		await assert.rejects(setup.runtime.inspectTaskCandidate({
			root: setup.root, task: definition, attempt: setup.attempt,
		}, context()), /160000|gitlink/);
	});

	await t.test("initial wave base", async (t) => {
		const definition = task("base");
		const setup = await prepared(t, definition);
		await commit(setup.intent.worktree!.cwd, "advanced.txt", "advanced\n");
		await assert.rejects(setup.runtime.inspectTaskCandidate({
			root: setup.root, task: definition, attempt: setup.attempt,
		}, context()), /initial prompt.*recorded wave base/);
	});
});

test("in-flight candidate inspection reports transient states without relaxing worktree identity fences", async (t) => {
	const root = await repository(t);
	const runtime = new CheckedGitRuntime();
	const definition = task("in-flight");
	const base = await runtime.inspectMain({ root }, context());
	const allocated = await allocate(runtime, root, definition, base, "token-in-flight-0001");
	assert.equal(allocated.result.outcome, "owned");
	const worktree = allocated.intent.worktree!;
	const input = { root, task: definition, attempt: allocated.attempt };

	const unchanged = await runtime.inspectInFlightTaskCandidate(input, context());
	assert.equal(unchanged.candidate.head, base.head);
	assert.equal(unchanged.clean, true);
	assert.equal(unchanged.valid, true);

	await writeFile(join(worktree.cwd, "candidate.txt"), "dirty\n");
	const dirty = await runtime.inspectInFlightTaskCandidate(input, context());
	assert.equal(dirty.candidate.head, base.head);
	assert.equal(dirty.clean, false);
	assert.equal(dirty.valid, true);

	await rm(join(worktree.cwd, "candidate.txt"));
	git(worktree.cwd, "checkout", "-qb", "unexpected-in-flight");
	const wrongBranch = await runtime.inspectInFlightTaskCandidate(input, context());
	assert.equal(wrongBranch.candidate.branch, "refs/heads/unexpected-in-flight");
	assert.equal(wrongBranch.clean, true);
	assert.equal(wrongBranch.valid, false);

	git(worktree.cwd, "checkout", "-q", worktree.branch);
	await commit(worktree.cwd, "candidate.txt", "candidate\n");
	const changed = await runtime.inspectInFlightTaskCandidate(input, context());
	assert.notEqual(changed.candidate.head, base.head);
	assert.equal(changed.clean, true);
	assert.equal(changed.valid, true);

	git(root, "worktree", "remove", "--force", worktree.path);
	await mkdir(worktree.path, { recursive: true });
	await assert.rejects(runtime.inspectInFlightTaskCandidate(input, context()), /not registered/);
});

test("initialized, uninitialized, and worker-added gitlinks are rejected", async (t) => {
	const source = await repository(t);
	const root = await repository(t);
	git(root, "-c", "protocol.file.allow=always", "submodule", "add", "-q", source, "module");
	git(root, "commit", "-qm", "add submodule");
	const runtime = new CheckedGitRuntime();
	await assert.rejects(runtime.inspectMain({ root }, context()), /160000|gitlink/);
	git(root, "submodule", "deinit", "-q", "-f", "module");
	await assert.rejects(runtime.inspectMain({ root }, context()), /160000|gitlink/);

	const cleanRoot = await repository(t);
	const waveBase = await runtime.inspectMain({ root: cleanRoot }, context());
	const allocated = await allocate(runtime, cleanRoot, task("gitlink"), waveBase, "token-gitlink-0001");
	assert.equal(allocated.result.outcome, "owned");
	const worktree = allocated.intent.worktree!;
	git(worktree.cwd, "update-index", "--add", "--cacheinfo", `160000,${waveBase.head},nested`);
	git(worktree.cwd, "commit", "-qm", "add gitlink");
	await assert.rejects(runtime.inspectRetainedTask({ root: cleanRoot, task: task("gitlink"), attempt: allocated.attempt }, context()), /160000|gitlink/);
});

test("candidate inspection rejects zero commits, dirty bytes, and hidden index state", async (t) => {
	for (const kind of ["zero", "dirty", "hidden"] as const) {
		await t.test(kind, async (t) => {
			const root = await repository(t);
			const runtime = new CheckedGitRuntime();
			const base = await runtime.inspectMain({ root }, context());
			const allocated = await allocate(runtime, root, task(kind), base, `token-${kind}-00000001`);
			const worktree = allocated.intent.worktree!;
			if (kind === "dirty") await writeFile(join(worktree.cwd, "untracked.txt"), "dirty\n");
			if (kind === "hidden") {
				await commit(worktree.cwd, "change.txt", "committed\n");
				git(worktree.cwd, "update-index", "--skip-worktree", "base.txt");
				await writeFile(join(worktree.cwd, "base.txt"), "hidden\n");
			}
			await assert.rejects(
				runtime.inspectRetainedTask({ root, task: task(kind), attempt: allocated.attempt }, context()),
				kind === "zero" ? /no committed change/ : /tracked|hidden|skip-worktree|inspection/i,
			);
		});
	}
});

test("rebase accepts a freshly inspected manual repair after exact prior worker termination", async (t) => {
	const root = await repository(t);
	const runtime = new CheckedGitRuntime();
	const base = await runtime.inspectMain({ root }, context());
	const definition = task("manual-repair");
	const allocated = await allocate(runtime, root, definition, base, "token-manual-repair1");
	await commit(allocated.intent.worktree!.cwd, "repair.txt", "first\n");
	const stoppedCandidate = await runtime.inspectRetainedTask({
		root, task: definition, attempt: allocated.attempt,
	}, context());
	recordExactWorkerTermination(allocated.attempt, stoppedCandidate);
	await commit(allocated.intent.worktree!.cwd, "repair.txt", "repaired\n");
	const repairedCandidate = await runtime.inspectRetainedTask({
		root, task: definition, attempt: allocated.attempt,
	}, context());
	assert.notEqual(repairedCandidate.head, allocated.attempt.termination!.candidate.head);
	allocated.attempt.candidate = repairedCandidate;

	const rebased = await runtime.rebase({
		root, task: definition, attempt: allocated.attempt, candidate: repairedCandidate, onto: base,
	}, context());
	assert.equal(rebased.outcome, "ready");
	if (rebased.outcome === "ready") assert.deepEqual(rebased.candidate, repairedCandidate);
});

test("same-wave units use one authoritative packet from each integration base", async (t) => {
	const root = await repository(t);
	const packets: Array<ExactReviewExecutorInput["packet"] & { patch: string; taskId?: string }> = [];
	const seenContexts: OperationContext[] = [];
	const runtime = new CheckedGitRuntime({
		executeReview: async (input, operationContext) => {
			seenContexts.push(operationContext);
			packets.push({ ...input.packet, patch: await readFile(input.packet.patchPath, "utf8"), taskId: input.taskId });
			return { verdict: "PASS" };
		},
	});
	const base = await runtime.inspectMain({ root }, context());
	const firstTask = task("first", true);
	const secondTask = task("second", true);
	const first = await allocate(runtime, root, firstTask, base, "token-first-wave01");
	const second = await allocate(runtime, root, secondTask, base, "token-second-wave1");
	await commit(first.intent.worktree!.cwd, "first.txt", "first\n");
	await commit(second.intent.worktree!.cwd, "second.txt", "second\n");
	const firstCandidate = await runtime.inspectRetainedTask({ root, task: firstTask, attempt: first.attempt }, context());
	const secondCandidate = await runtime.inspectRetainedTask({ root, task: secondTask, attempt: second.attempt }, context());

	const firstPrepared = await prepareIntegration(runtime, root, firstTask, first.attempt, firstCandidate, base);
	assert.equal(firstPrepared.candidate.head, firstCandidate.head, "rebase from the unchanged wave base must be a no-op");
	const firstMain = await integrate(runtime, root, firstTask, first.attempt, firstPrepared);
	const secondPrepared = await prepareIntegration(runtime, root, secondTask, second.attempt, secondCandidate, firstMain);
	assert.notEqual(secondPrepared.candidate.head, secondCandidate.head);
	const finalMain = await integrate(runtime, root, secondTask, second.attempt, secondPrepared);

	assert.equal(packets.length, 2);
	assert.equal(packets[0]!.base, base.head);
	assert.equal(packets[1]!.base, firstMain.head);
	assert.match(packets[1]!.patch, /second\.txt/);
	assert.doesNotMatch(packets[1]!.patch, /first\.txt/);
	assert.equal(finalMain.head, secondPrepared.candidate.head);
	assert.ok(seenContexts.every((item) => item.signal instanceof AbortSignal && item.timeoutMs > 0));
});

test("final review resolves a canonical Main worktree root without changing the launch subdirectory", async (t) => {
	const root = await repository(t);
	const subdirectory = join(root, "nested");
	await mkdir(subdirectory);
	const calls: { command: string; args: string[]; options: DirectProcessOptions }[] = [];
	const reviewCwds: string[] = [];
	const patches: string[] = [];
	const operationContext = context();
	const runtime = new CheckedGitRuntime({
		runProcess: async (command, args, options) => {
			calls.push({ command, args: [...args], options });
			return await directProcess(command, args, options);
		},
		executeReview: async (input) => {
			reviewCwds.push(input.cwd);
			patches.push(await readFile(input.packet.patchPath, "utf8"));
			return { verdict: "PASS" };
		},
	});
	const base = await runtime.inspectMain({ root: subdirectory }, operationContext);
	await commit(root, "nested/final.txt", "final\n");
	const tip = await runtime.inspectMain({ root: subdirectory }, operationContext);
	const reviewed = await runtime.review({
		root: subdirectory,
		scope: "final",
		phase: "final",
		criterion: "Review the final change.",
		base,
		tip,
		verifyLaunch: async () => launch,
	}, operationContext);

	assert.equal(reviewed.verdict, "PASS");
	assert.ok(sameIdentity(reviewed.identityAfter, tip));
	assert.deepEqual(reviewCwds, [subdirectory]);
	assert.match(patches[0]!, /final\.txt/);
	assert.ok(calls.some(({ command, args, options }) => command === "git"
		&& JSON.stringify(args) === JSON.stringify(["rev-parse", "--show-toplevel"])
		&& options.cwd === subdirectory
		&& options.signal === operationContext.signal
		&& options.timeoutMs > 0
		&& options.timeoutMs <= operationContext.timeoutMs));
});

test("rebase conflicts retain exact work and report whether abort succeeded", async (t) => {
	for (const abortFails of [false, true]) {
		await t.test(abortFails ? "abort failure" : "abort success", async (t) => {
			const root = await repository(t);
			const commands: string[][] = [];
			const runtime = new CheckedGitRuntime({
				runProcess: async (command, args, options) => {
					commands.push([command, ...args]);
					if (abortFails && command === "git" && args[0] === "rebase" && args[1] === "--abort") {
						return { code: 1, killed: false, stdout: "", stderr: "cannot abort" };
					}
					return await directProcess(command, args, options);
				},
			});
			const base = await runtime.inspectMain({ root }, context());
			const firstTask = task("first");
			const secondTask = task("second");
			const first = await allocate(runtime, root, firstTask, base, `token-first-conf${abortFails ? "1" : "0"}`);
			const second = await allocate(runtime, root, secondTask, base, `token-second-con${abortFails ? "1" : "0"}`);
			await commit(first.intent.worktree!.cwd, "base.txt", "first\n");
			await commit(second.intent.worktree!.cwd, "base.txt", "second\n");
			const firstCandidate = await runtime.inspectRetainedTask({ root, task: firstTask, attempt: first.attempt }, context());
			const firstPrepared = await prepareIntegration(runtime, root, firstTask, first.attempt, firstCandidate, base);
			const firstMain = await integrate(runtime, root, firstTask, first.attempt, firstPrepared);
			const secondCandidate = await runtime.inspectRetainedTask({ root, task: secondTask, attempt: second.attempt }, context());
			recordExactWorkerTermination(second.attempt, secondCandidate);
			const rebased = await runtime.rebase({ root, task: secondTask, attempt: second.attempt, candidate: secondCandidate, onto: firstMain }, context());
			assert.equal(rebased.outcome, "blocked");
			assert.match(rebased.outcome === "blocked" ? rebased.failure : "", abortFails ? /abort failed/ : /abort restored/);
			assert.deepEqual(commands.find((command) => command[1] === "rebase" && command[2] !== "--abort")?.slice(1), [
				"rebase", "--no-update-refs", "--no-autostash", firstMain.head,
			]);
			assert.ok(commands.some((command) => command[1] === "rebase" && command[2] === "--abort"));
			if (!abortFails) {
				assert.equal(git(second.intent.worktree!.cwd, "rev-parse", "HEAD"), secondCandidate.head);
				assert.equal(git(second.intent.worktree!.cwd, "status", "--porcelain"), "");
			} else {
				assert.notEqual(git(second.intent.worktree!.cwd, "status", "--porcelain"), "");
			}
			assert.ok(commands.every((command) => !command.includes("--force") && !command.includes("reset") && !command.includes("stash")));
		});
	}
});

test("failed checks, Reviewer findings or mutation, and Main drift cannot integrate", async (t) => {
	const root = await repository(t);
	let reviewMode: "findings" | "mutation" = "findings";
	let reviewWorktree = "";
	const runtime = new CheckedGitRuntime({
		executeReview: async () => {
			if (reviewMode === "mutation") await commit(reviewWorktree, "reviewer.txt", "mutation\n");
			return { verdict: reviewMode === "findings" ? "Finding: incorrect" : "PASS" };
		},
	});
	const base = await runtime.inspectMain({ root }, context());
	const definition = task("gated", true);
	const allocated = await allocate(runtime, root, definition, base, "token-gated-00001");
	reviewWorktree = allocated.intent.worktree!.cwd;
	await commit(reviewWorktree, "change.txt", "change\n");
	const candidate = await runtime.inspectRetainedTask({ root, task: definition, attempt: allocated.attempt }, context());
	allocated.attempt.candidate = candidate;
	const failed = await runtime.runChecks({
		root, scope: "task", taskId: definition.id, attempt: allocated.attempt,
		checks: [{ command: process.execPath, args: ["-e", "process.exit(7)"] }], candidate,
	}, context());
	assert.equal(failed.results[0]!.code, 7);
	assert.ok(sameIdentity(failed.identityAfter, candidate));
	recordExactWorkerTermination(allocated.attempt, candidate);
	allocated.attempt.integrationBase = base;
	allocated.attempt.integrationCandidate = candidate;
	const findings = await runtime.review({
		root, scope: "task", phase: "authoritative", taskId: definition.id, attempt: allocated.attempt,
		criterion: definition.judgment!.criterion, base, tip: candidate, verifyLaunch: async () => launch,
	}, context());
	assert.match(findings.verdict, /Finding/);
	reviewMode = "mutation";
	const mutated = await runtime.review({
		root, scope: "task", phase: "authoritative", taskId: definition.id, attempt: allocated.attempt,
		criterion: definition.judgment!.criterion, base, tip: candidate, verifyLaunch: async () => launch,
	}, context());
	assert.equal(mutated.verdict, "PASS");
	assert.ok(!sameIdentity(mutated.identityAfter, candidate));

	const driftRoot = await repository(t);
	const plain = new CheckedGitRuntime();
	const driftBase = await plain.inspectMain({ root: driftRoot }, context());
	const driftTask = task("drift");
	const drifted = await allocate(plain, driftRoot, driftTask, driftBase, "token-drift-000001");
	await commit(drifted.intent.worktree!.cwd, "task.txt", "task\n");
	const driftCandidate = await plain.inspectRetainedTask({ root: driftRoot, task: driftTask, attempt: drifted.attempt }, context());
	const prepared = await prepareIntegration(plain, driftRoot, driftTask, drifted.attempt, driftCandidate, driftBase);
	await commit(driftRoot, "main.txt", "outside\n");
	const integration = await plain.integrate({
		root: driftRoot, task: driftTask, attempt: drifted.attempt, expectedMain: driftBase,
		candidate: prepared.candidate, checks: prepared.checks,
	}, context());
	assert.equal(integration.outcome, "drift");
	assert.equal(git(driftRoot, "log", "-1", "--pretty=%s"), "change main.txt");
});

test("guarded fast-forward rejects candidate-ancestor Main drift before cleanup", async (t) => {
	const root = await repository(t);
	const commands: string[][] = [];
	let candidateAncestor = "";
	let movedMain = false;
	const runtime = new CheckedGitRuntime({
		runProcess: async (command, args, options) => {
			commands.push([command, ...args]);
			if (!movedMain && command === "git" && args.includes("merge")) {
				movedMain = true;
				git(root, "merge", "--no-autostash", "--ff-only", candidateAncestor);
			}
			return await directProcess(command, args, options);
		},
	});
	const base = await runtime.inspectMain({ root }, context());
	const definition = task("cas-drift");
	const allocated = await allocate(runtime, root, definition, base, "token-cas-drift-01");
	await commit(allocated.intent.worktree!.cwd, "ancestor.txt", "ancestor\n");
	candidateAncestor = git(allocated.intent.worktree!.cwd, "rev-parse", "HEAD");
	await commit(allocated.intent.worktree!.cwd, "candidate.txt", "candidate\n");
	const candidate = await runtime.inspectRetainedTask({ root, task: definition, attempt: allocated.attempt }, context());
	const prepared = await prepareIntegration(runtime, root, definition, allocated.attempt, candidate, base);
	const result = await runtime.integrate({
		root, task: definition, attempt: allocated.attempt, expectedMain: base,
		candidate: prepared.candidate, checks: prepared.checks,
	}, context());

	assert.equal(result.outcome, "drift");
	assert.match(result.outcome === "drift" ? result.failure : "", /guarded fast-forward ref transaction/);
	assert.equal(git(root, "rev-parse", "HEAD"), candidateAncestor);
	assert.equal(git(root, "status", "--porcelain"), "");
	await assert.rejects(readFile(join(root, "candidate.txt"), "utf8"), { code: "ENOENT" });
	assert.equal(git(allocated.intent.worktree!.cwd, "rev-parse", "HEAD"), candidate.head);
	assert.match(git(root, "show-ref", "--verify", `refs/heads/${allocated.intent.worktree!.branch}`), new RegExp(candidate.head));
	const cleanup = await runtime.cleanupGit({ root, kind: "worktree", task: definition, attempt: allocated.attempt }, context());
	assert.equal(cleanup.outcome, "blocked");
	assert.ok(commands.every(([, ...args]) => args[0] !== "worktree" || args[1] !== "remove"));
	assert.ok(commands.every(([, ...args]) => args[0] !== "branch" || args[1] !== "-d"));
});

test("guarded fast-forward accepts Git 2.43 paired reference transaction", async (t) => {
	const root = await repository(t);
	let integrationBase: WorkspaceIdentity | undefined;
	let integrationCandidate: WorkspaceIdentity | undefined;
	let exercised = false;
	const runtime = new CheckedGitRuntime({
		runProcess: async (command, args, options) => {
			if (command === "git" && args.includes("merge")) {
				const hookSetting = args.find((arg) => arg.startsWith("core.hooksPath="));
				if (!hookSetting || !integrationBase || !integrationCandidate) throw new Error("Pair regression was not prepared.");
				const hookPath = join(hookSetting.slice("core.hooksPath=".length), "reference-transaction");
				const invoke = (input: string) => execFileSync(process.execPath, [hookPath, "prepared"], {
					cwd: options.cwd,
					input,
					encoding: "utf8",
					stdio: ["pipe", "pipe", "pipe"],
				});
				const pair = [
					`${integrationBase.head} ${integrationCandidate.head} HEAD`,
					`${integrationBase.head} ${integrationCandidate.head} ${integrationBase.branch}`,
				].join("\n") + "\n";
				invoke(pair);
				for (const invalid of [
					`${integrationBase.head} ${integrationCandidate.head} HEAD\n${integrationBase.head} ${integrationCandidate.head} HEAD\n${integrationBase.head} ${integrationCandidate.head} ${integrationBase.branch}\n`,
					`${integrationBase.head} ${integrationCandidate.head} HEAD\n${integrationBase.head} ${integrationCandidate.head} refs/heads/unexpected\n`,
					`${integrationBase.head} ${integrationCandidate.head} HEAD\n`,
					`${"0".repeat(40)} ${integrationCandidate.head} HEAD\n${integrationBase.head} ${integrationCandidate.head} ${integrationBase.branch}\n`,
				]) assert.throws(() => invoke(invalid));
				exercised = true;
			}
			return await directProcess(command, args, options);
		},
	});
	const base = await runtime.inspectMain({ root }, context());
	const definition = task("git-243-pair");
	const allocated = await allocate(runtime, root, definition, base, "token-git-243-pair1");
	await commit(allocated.intent.worktree!.cwd, "paired.txt", "paired\n");
	const candidate = await runtime.inspectRetainedTask({ root, task: definition, attempt: allocated.attempt }, context());
	const prepared = await prepareIntegration(runtime, root, definition, allocated.attempt, candidate, base);
	integrationBase = base;
	integrationCandidate = prepared.candidate;
	const result = await runtime.integrate({
		root, task: definition, attempt: allocated.attempt, expectedMain: base,
		candidate: prepared.candidate, checks: prepared.checks,
	}, context());

	assert.equal(result.outcome, "integrated");
	assert.equal(exercised, true);
});

test("fast-forward failure preserves Main and exact retained work", async (t) => {
	const root = await repository(t);
	const commands: string[][] = [];
	const runtime = new CheckedGitRuntime({
		runProcess: async (command, args, options) => {
			commands.push([command, ...args]);
			if (command === "git" && args.includes("merge")) return { code: 1, killed: false, stdout: "", stderr: "refused" };
			return await directProcess(command, args, options);
		},
	});
	const base = await runtime.inspectMain({ root }, context());
	const definition = task("failure");
	const allocated = await allocate(runtime, root, definition, base, "token-failure-0001");
	await commit(allocated.intent.worktree!.cwd, "failure.txt", "work\n");
	const candidate = await runtime.inspectRetainedTask({ root, task: definition, attempt: allocated.attempt }, context());
	const prepared = await prepareIntegration(runtime, root, definition, allocated.attempt, candidate, base);
	const authoritativeChecks = allocated.attempt.authoritativeChecks;
	delete allocated.attempt.authoritativeChecks;
	const unpersisted = await runtime.integrate({
		root, task: definition, attempt: allocated.attempt, expectedMain: base,
		candidate: prepared.candidate, checks: prepared.checks,
	}, context());
	assert.equal(unpersisted.outcome, "failed");
	allocated.attempt.authoritativeChecks = authoritativeChecks;
	const result = await runtime.integrate({
		root, task: definition, attempt: allocated.attempt, expectedMain: base,
		candidate: prepared.candidate, checks: prepared.checks,
	}, context());
	assert.equal(result.outcome, "failed");
	assert.equal(git(root, "rev-parse", "HEAD"), base.head);
	assert.equal(git(allocated.intent.worktree!.cwd, "rev-parse", "HEAD"), candidate.head);
	const mergeCommand = commands.find((command) => command.includes("merge"));
	assert.equal(mergeCommand?.[1], "-c");
	assert.match(mergeCommand?.[2] ?? "", /^core\.hooksPath=.*pi-orchestrator-ref-guard-/);
	assert.deepEqual(mergeCommand?.slice(mergeCommand.indexOf("merge")), [
		"merge", "--no-overwrite-ignore", "--no-autostash", "--ff-only", candidate.head,
	]);
});

test("guarded cleanup reconciles partial removal without force or reintegration", async (t) => {
	const root = await repository(t);
	let refuseRemove = true;
	let refuseDelete = true;
	const commands: string[][] = [];
	const runtime = new CheckedGitRuntime({
		runProcess: async (command, args, options) => {
			commands.push([command, ...args]);
			if (refuseRemove && command === "git" && args[0] === "worktree" && args[1] === "remove") {
				return { code: 1, killed: false, stdout: "", stderr: "busy" };
			}
			if (refuseDelete && command === "git" && args[0] === "branch" && args[1] === "-d") {
				return { code: 1, killed: false, stdout: "", stderr: "refused" };
			}
			return await directProcess(command, args, options);
		},
	});
	const base = await runtime.inspectMain({ root }, context());
	const definition = task("cleanup");
	const allocated = await allocate(runtime, root, definition, base, "token-cleanup-0001");
	await commit(allocated.intent.worktree!.cwd, "cleanup.txt", "cleanup\n");
	const candidate = await runtime.inspectRetainedTask({ root, task: definition, attempt: allocated.attempt }, context());
	const prepared = await prepareIntegration(runtime, root, definition, allocated.attempt, candidate, base);
	await integrate(runtime, root, definition, allocated.attempt, prepared);
	const worktree = allocated.intent.worktree!;

	assert.equal((await runtime.cleanupGit({ root, kind: "worktree", task: definition, attempt: allocated.attempt }, context())).outcome, "blocked");
	assert.equal(git(root, "show-ref", "--verify", `refs/heads/${worktree.branch}`), `${candidate.head} refs/heads/${worktree.branch}`);
	refuseRemove = false;
	assert.equal((await runtime.cleanupGit({ root, kind: "worktree", task: definition, attempt: allocated.attempt }, context())).outcome, "completed");
	assert.equal((await runtime.cleanupGit({ root, kind: "worktree", task: definition, attempt: allocated.attempt }, context())).outcome, "absent");
	assert.equal((await runtime.cleanupGit({ root, kind: "branch", task: definition, attempt: allocated.attempt }, context())).outcome, "blocked");
	refuseDelete = false;
	assert.equal((await runtime.cleanupGit({ root, kind: "branch", task: definition, attempt: allocated.attempt }, context())).outcome, "completed");
	assert.equal((await runtime.cleanupGit({ root, kind: "branch", task: definition, attempt: allocated.attempt }, context())).outcome, "absent");
	assert.ok(commands.every((command) => !command.includes("--force") && !command.includes("reset") && !command.includes("stash")));
	assert.equal(commands.filter((command) => command.includes("merge")).length, 1);
});

test("cleanup preserves exact resources when integration evidence is incomplete or Main identity drifted", async (t) => {
	const root = await repository(t);
	const commands: string[][] = [];
	const runtime = new CheckedGitRuntime({
		runProcess: async (command, args, options) => {
			commands.push([command, ...args]);
			return await directProcess(command, args, options);
		},
	});
	const base = await runtime.inspectMain({ root }, context());
	const definition = task("cleanup-drift");
	const allocated = await allocate(runtime, root, definition, base, "token-clean-drift1");
	await commit(allocated.intent.worktree!.cwd, "accepted.txt", "accepted\n");
	const candidate = await runtime.inspectRetainedTask({ root, task: definition, attempt: allocated.attempt }, context());
	const prepared = await prepareIntegration(runtime, root, definition, allocated.attempt, candidate, base);
	await integrate(runtime, root, definition, allocated.attempt, prepared);
	const worktree = allocated.intent.worktree!;
	const integration = allocated.attempt.integration!;

	allocated.attempt.integration = {
		...integration,
		expectedMain: { ...integration.expectedMain, head: "f".repeat(40) },
	};
	const incomplete = await runtime.cleanupGit({ root, kind: "worktree", task: definition, attempt: allocated.attempt }, context());
	assert.equal(incomplete.outcome, "blocked");
	assert.match(incomplete.outcome === "blocked" ? incomplete.failure : "", /integration evidence/);
	assert.ok(await readFile(join(worktree.cwd, "accepted.txt"), "utf8"));
	assert.match(git(root, "show-ref", "--verify", `refs/heads/${worktree.branch}`), new RegExp(candidate.head));

	allocated.attempt.integration = integration;
	git(root, "switch", "-q", "-c", "drift");
	const driftedWorktree = await runtime.cleanupGit({ root, kind: "worktree", task: definition, attempt: allocated.attempt }, context());
	assert.equal(driftedWorktree.outcome, "blocked");
	assert.match(driftedWorktree.outcome === "blocked" ? driftedWorktree.failure : "", /post-integration identity/);
	assert.ok(await readFile(join(worktree.cwd, "accepted.txt"), "utf8"));
	assert.match(git(root, "show-ref", "--verify", `refs/heads/${worktree.branch}`), new RegExp(candidate.head));

	git(root, "worktree", "remove", worktree.path);
	const driftedBranch = await runtime.cleanupGit({ root, kind: "branch", task: definition, attempt: allocated.attempt }, context());
	assert.equal(driftedBranch.outcome, "blocked");
	assert.match(driftedBranch.outcome === "blocked" ? driftedBranch.failure : "", /post-integration identity/);
	assert.match(git(root, "show-ref", "--verify", `refs/heads/${worktree.branch}`), new RegExp(candidate.head));
	assert.ok(commands.every(([, ...args]) => args[0] !== "worktree" || args[1] !== "remove"));
	assert.ok(commands.every(([, ...args]) => args[0] !== "branch" || args[1] !== "-d"));
});

test("cleanup refuses branch/tip mismatch and runner host release remains ordered before Git", async (t) => {
	const root = await repository(t);
	const runtime = new CheckedGitRuntime();
	const base = await runtime.inspectMain({ root }, context());
	const definition = task("mismatch");
	const allocated = await allocate(runtime, root, definition, base, "token-clean-tip-01");
	await commit(allocated.intent.worktree!.cwd, "accepted.txt", "accepted\n");
	const candidate = await runtime.inspectRetainedTask({ root, task: definition, attempt: allocated.attempt }, context());
	const prepared = await prepareIntegration(runtime, root, definition, allocated.attempt, candidate, base);
	await integrate(runtime, root, definition, allocated.attempt, prepared);
	await commit(allocated.intent.worktree!.cwd, "later.txt", "later\n");
	const cleanup = await runtime.cleanupGit({ root, kind: "worktree", task: definition, attempt: allocated.attempt }, context());
	assert.equal(cleanup.outcome, "blocked");
	assert.match(cleanup.outcome === "blocked" ? cleanup.failure : "", /approved tip/);
	assert.ok(await readFile(join(allocated.intent.worktree!.cwd, "later.txt"), "utf8"));
});
