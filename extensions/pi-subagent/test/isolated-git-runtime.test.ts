import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
	CheckedGitRuntime,
	type DirectProcessOptions,
	type DirectProcessRunner,
} from "../src/git-runtime.ts";
import { sameIdentity, type ChangesetTaskRequest, type CheckBatchEvidence, type CommandEvidence, type TaskAttempt, type WorktreeAllocationIntent, type WorkspaceIdentity } from "../src/schema.ts";
import type { OperationContext, TransientLaunchHandle, VerifiedLaunch } from "../src/runner.ts";
import { runProcess } from "../src/process.ts";
import { inspectWorktreeDirty } from "../src/worktree.ts";

const launch: VerifiedLaunch = {
	role: "reviewer",
	modelClass: "fast",
	model: "provider/model",
	thinkingLevel: "high",
	args: ["--model", "provider/model"],
	env: {},
	tools: ["read", "grep", "find", "ls"],
};

function acquiredReviewer(cleanup: () => Promise<void> = async () => {}): TransientLaunchHandle<VerifiedLaunch> {
	return { launch, cleanup };
}

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

const directProcess: DirectProcessRunner = runProcess;

function context(timeoutMs = 20_000): OperationContext {
	const signal = new AbortController().signal;
	return { signal, timeoutMs, deadline: Date.now() + timeoutMs };
}

function task(id: string, judgment = false): ChangesetTaskRequest {
	return {
		id,
		kind: "changeset",
		role: "implementer",
		modelClass: "fast",
		requirements: `Implement ${id}.`,
		deliverable: `Deliver ${id}.`,
		dependsOn: [],
		contextFrom: [],
		checks: [{ command: process.execPath, args: ["-e", "process.exit(0)"] }],
		...(judgment ? { judgment: { role: "reviewer", criterion: `Review ${id}.`, modelClass: "fast" as const } } : {}),
	};
}

async function repository(t: test.TestContext): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "pi-subagent-git-"));
	t.after(async () => await rm(root, { recursive: true, force: true }));
	git(root, "init", "-q", "-b", "main");
	git(root, "config", "user.name", "Subagent Test");
	git(root, "config", "user.email", "subagent@example.com");
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

function worktreeIntent(_id: string, token: string): WorktreeAllocationIntent {
	return { kind: "worktree", generation: 1, token, status: "allocating" };
}

async function allocate(
	runtime: CheckedGitRuntime,
	root: string,
	definition: ChangesetTaskRequest,
	waveBase: WorkspaceIdentity,
	token: string,
	operationContext = context(),
): Promise<{ attempt: TaskAttempt; intent: WorktreeAllocationIntent; result: Awaited<ReturnType<CheckedGitRuntime["allocateWorktree"]>> }> {
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
			},
	}, operationContext);
	if (result.outcome === "owned") intent.status = "owned";
	return { attempt, intent, result };
}

function checksEvidence(candidate: WorkspaceIdentity, results: Awaited<ReturnType<CheckedGitRuntime["runChecks"]>>): CheckBatchEvidence {
	return {
		phase: "preliminary",
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

test("preliminary judgment reviews the exact checked candidate before readiness", async (t) => {
	const root = await repository(t);
	const packets: string[] = [];
	const runtime = new CheckedGitRuntime({
		executeReview: async (input) => {
			assert.equal(input.scope, "task");
			packets.push(await readFile(input.packet.patchPath, "utf8"));
			return { verdict: "PASS" };
		},
	});
	const base = await runtime.inspectMain({ root }, context());
	const definition = task("preliminary-review", true);
	const allocated = await allocate(runtime, root, definition, base, "token-prelim-review1");
	await commit(allocated.intent.worktree!.cwd, "review.txt", "worker change\n");
	const candidate = await runtime.inspectRetainedTask({ root, task: definition, attempt: allocated.attempt }, context());
	allocated.attempt.candidate = candidate;
	allocated.attempt.candidateBase = base;
	const checked = await runtime.runChecks({
		root, scope: "task", taskId: definition.id, attempt: allocated.attempt,
		checks: definition.checks, candidate,
	}, context());
	allocated.attempt.preliminaryChecks = checksEvidence(candidate, checked);
	const input = {
		root, scope: "task" as const, phase: "preliminary" as const, taskId: definition.id,
		attempt: allocated.attempt, criterion: definition.judgment!.criterion, base, tip: candidate,
		acquireLaunch: async () => acquiredReviewer(),
	};
	const result = await runtime.review(input, context());
	assert.equal(result.verdict, "PASS");
	assert.deepEqual(result.identityAfter, candidate);
	assert.match(packets[0]!, /worker change/);
	assert.equal(packets.length, 1);
	await assert.rejects(runtime.review({ ...input, tip: { ...candidate, head: "f".repeat(40) } }, context()), /exact passing candidate evidence/);
});

test("concurrent worktree allocations serialize main-index inspection per repository", async (t) => {
	const root = await repository(t);
	let activeIndexOperations = 0;
	let maxConcurrentIndexOperations = 0;
	let collisions = 0;
	const runtime = new CheckedGitRuntime({
		runProcess: async (command, args, options) => {
			const inspectsMainIndex = command === "git"
				&& options.cwd === root
				&& (args[0] === "update-index" || args[0] === "write-tree");
			if (!inspectsMainIndex) return await directProcess(command, args, options);
			activeIndexOperations += 1;
			maxConcurrentIndexOperations = Math.max(maxConcurrentIndexOperations, activeIndexOperations);
			await new Promise((resolve) => setTimeout(resolve, 20));
			try {
				if (activeIndexOperations > 1) {
					collisions += 1;
					return { code: 128, stdout: "", stderr: "fatal: Unable to create index.lock", killed: false };
				}
				return await directProcess(command, args, options);
			} finally {
				activeIndexOperations -= 1;
			}
		},
	});
	const waveBase = await runtime.inspectMain({ root }, context());
	const [first, second] = await Promise.all([
		allocate(runtime, root, task("concurrent-a"), waveBase, "token-concurrent-a"),
		allocate(runtime, root, task("concurrent-b"), waveBase, "token-concurrent-b"),
	]);

	assert.equal(first.result.outcome, "owned");
	assert.equal(second.result.outcome, "owned");
	assert.equal(collisions, 0);
	assert.equal(maxConcurrentIndexOperations, 1);
});

test("a cancelled queued main-index inspection keeps a later inspection behind the active operation", async (t) => {
	const root = await repository(t);
	let releaseFirst!: () => void;
	let markStarted!: () => void;
	const firstStarted = new Promise<void>((resolve) => { markStarted = resolve; });
	const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
	let markLaterIndexStarted!: () => void;
	const laterIndexStarted = new Promise<void>((resolve) => { markLaterIndexStarted = resolve; });
	let updateIndexOperations = 0;
	let activeIndexOperations = 0;
	let maxConcurrentIndexOperations = 0;
	const runtime = new CheckedGitRuntime({
		runProcess: async (command, args, options) => {
			if (command !== "git" || options.cwd !== root || args[0] !== "update-index") {
				return await directProcess(command, args, options);
			}
			activeIndexOperations += 1;
			maxConcurrentIndexOperations = Math.max(maxConcurrentIndexOperations, activeIndexOperations);
			try {
				if (updateIndexOperations++ === 0) {
					markStarted();
					await firstGate;
				} else {
					markLaterIndexStarted();
				}
				return { code: 0, stdout: "", stderr: "", killed: false };
			} finally {
				activeIndexOperations -= 1;
			}
		},
	});
	const first = runtime.inspectMain({ root }, context());
	await firstStarted;

	const controller = new AbortController();
	const queued = runtime.inspectMain({ root }, {
		signal: controller.signal,
		timeoutMs: 20_000,
		deadline: Date.now() + 20_000,
	});
	const queuedOutcome = queued.then(() => "resolved", () => "aborted");
	controller.abort(new Error("cancel queued inspection"));
	let later: Promise<WorkspaceIdentity> | undefined;
	try {
		const promptOutcome = await Promise.race([
			queuedOutcome,
			new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 100)),
		]);
		assert.equal(promptOutcome, "aborted");

		later = runtime.inspectMain({ root }, context());
		const laterStartedBeforeRelease = await Promise.race([
			laterIndexStarted.then(() => "started" as const),
			new Promise<"waiting">((resolve) => setTimeout(() => resolve("waiting"), 100)),
		]);
		assert.equal(laterStartedBeforeRelease, "waiting");
	} finally {
		releaseFirst();
		await first;
		if (later) await later;
	}

	assert.equal(await queuedOutcome, "aborted");
	assert.equal(maxConcurrentIndexOperations, 1);
});

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
	assert.equal(first.result.outcome, "owned");
	assert.ok(first.intent.worktree && await readFile(join(first.intent.worktree.path, "base.txt"), "utf8") === "base\n");
	assert.ok(calls.every((call) => Array.isArray(call.args)
		&& call.options.signal === operationContext.signal
		&& (call.options.timeoutMs ?? 0) > 0
		&& (call.options.timeoutMs ?? 0) <= (operationContext.timeoutMs ?? 0)));

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
	async function prepared(t: test.TestContext, definition: ChangesetTaskRequest, runtime = new CheckedGitRuntime()) {
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
					&& args.join(" ") === `rev-parse --verify --quiet refs/heads/${recordedBranch}`) {
					return { ...result, code: 128, stderr: "injected branch-tip failure" };
				}
				return result;
			},
		});
		const definition = task("tip");
		const setup = await prepared(t, definition, runtime);
		recordedBranch = setup.intent.worktree!.branch;
		await assert.rejects(runtime.inspectTaskCandidate({
			root: setup.root, task: definition, attempt: setup.attempt,
		}, context()), /failed with exit 128: injected branch-tip failure/);
	});

	await t.test("ignored dependency artifacts do not dirty a candidate", async (t) => {
		const definition = task("ignored-prompt");
		const setup = await prepared(t, definition);
		await writeFile(join(setup.root, ".git", "info", "exclude"), "\nnode_modules/\n", { flag: "a" });
		await mkdir(join(setup.intent.worktree!.cwd, "node_modules"));
		await writeFile(join(setup.intent.worktree!.cwd, "node_modules", "generated"), "ignored\n");
		const candidate = await setup.runtime.inspectTaskCandidate({
			root: setup.root, task: definition, attempt: setup.attempt,
		}, context());
		assert.equal(candidate.head, setup.base.head);
		assert.equal(candidate.index, setup.base.index);
		assert.equal(candidate.tree, setup.base.tree);
	});

	await t.test("dirty candidate", async (t) => {
		const definition = task("dirty-prompt");
		const setup = await prepared(t, definition);
		await writeFile(join(setup.intent.worktree!.cwd, "untracked.txt"), "dirty\n");
		await assert.rejects(setup.runtime.inspectTaskCandidate({
			root: setup.root, task: definition, attempt: setup.attempt,
		}, context()), /tracked|dirty|inspection|workspace is not clean/i);
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
	await commit(root, ".gitignore", "node_modules/\n");
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

	await mkdir(join(worktree.cwd, "node_modules"));
	await writeFile(join(worktree.cwd, "node_modules", "generated.js"), "dependency\n");
	const generated = await runtime.inspectInFlightTaskCandidate(input, context());
	assert.equal(generated.clean, true);
	assert.equal(generated.valid, true);

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

	await commit(worktree.cwd, ".gitignore", "node_modules/\ngenerated/\n");
	await mkdir(join(worktree.cwd, "generated"));
	await writeFile(join(worktree.cwd, "generated", "cache"), "generated\n");
	const ignoredCache = await runtime.inspectInFlightTaskCandidate(input, context());
	assert.equal(ignoredCache.clean, true);
	assert.equal(ignoredCache.valid, true);
	assert.equal((await inspectWorktreeDirty(worktree.cwd)).dirty, true);

	git(root, "worktree", "remove", "--force", worktree.path);
	await mkdir(worktree.path, { recursive: true });
	await assert.rejects(runtime.inspectInFlightTaskCandidate(input, context()), /not registered/);
});

test("in-flight inspection tolerates a worker commit during its Git snapshot", async (t) => {
	const root = await repository(t);
	const setup = new CheckedGitRuntime();
	const definition = task("commit-during-inspection");
	const base = await setup.inspectMain({ root }, context());
	const allocated = await allocate(setup, root, definition, base, "token-in-flight-0002");
	const cwd = allocated.intent.worktree!.cwd;
	let heads = 0;
	const runtime = new CheckedGitRuntime({ runProcess: async (command, args, options) => {
		const result = await directProcess(command, args, options);
		if (command === "git" && args.join(" ") === "rev-parse --verify HEAD^{commit}" && ++heads === 1) {
			await commit(cwd, "candidate.txt", "candidate\n");
		}
		return result;
	} });
	const inspection = await runtime.inspectInFlightTaskCandidate({ root, task: definition, attempt: allocated.attempt }, context());
	assert.equal(inspection.candidate.head, git(cwd, "rev-parse", "HEAD"));
	assert.equal(inspection.clean, true);
	assert.equal(inspection.valid, true);
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
				kind === "zero" ? /no committed change/ : /tracked|hidden|skip-worktree|inspection|workspace is not clean/i,
			);
		});
	}
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
		acquireLaunch: async () => acquiredReviewer(),
	}, operationContext);

	assert.equal(reviewed.verdict, "PASS");
	assert.ok(sameIdentity(reviewed.identityAfter, tip));
	assert.deepEqual(reviewCwds, [subdirectory]);
	assert.match(patches[0]!, /final\.txt/);
	assert.ok(calls.some(({ command, args, options }) => command === "git"
		&& JSON.stringify(args) === JSON.stringify(["rev-parse", "--show-toplevel"])
		&& options.cwd === subdirectory
		&& options.signal === operationContext.signal
		&& (options.timeoutMs ?? 0) > 0
		&& (options.timeoutMs ?? 0) <= (operationContext.timeoutMs ?? 0)));
});

test("Reviewer launch cleanup runs after success, failure, and abort, and cleanup errors surface", async (t) => {
	const root = await repository(t);
	const baseRuntime = new CheckedGitRuntime();
	const base = await baseRuntime.inspectMain({ root }, context());
	await commit(root, "reviewed.txt", "reviewed\n");
	const tip = await baseRuntime.inspectMain({ root }, context());

	for (const outcome of ["success", "failure", "abort"] as const) {
		await t.test(outcome, async () => {
			let cleanups = 0;
			const controller = new AbortController();
			const operationContext: OperationContext = {
				signal: controller.signal,
				deadline: Date.now() + 60_000,
				timeoutMs: 60_000,
			};
			const runtime = new CheckedGitRuntime({
				executeReview: async () => {
					if (outcome === "failure") throw new Error("review failed");
					if (outcome === "abort") {
						controller.abort(new Error("review aborted"));
						throw controller.signal.reason;
					}
					return { verdict: "PASS" };
				},
			});
			const reviewed = runtime.review({
				root,
				scope: "final",
				phase: "final",
				criterion: "Review cleanup.",
				base,
				tip,
				acquireLaunch: async () => acquiredReviewer(async () => { cleanups += 1; }),
			}, operationContext);
			if (outcome === "success") assert.equal((await reviewed).verdict, "PASS");
			else await assert.rejects(reviewed, new RegExp(outcome === "failure" ? "review failed" : "review aborted"));
			assert.equal(cleanups, 1);
		});
	}

	const cleanupFailure = new CheckedGitRuntime({ executeReview: async () => ({ verdict: "PASS" }) });
	await assert.rejects(cleanupFailure.review({
		root,
		scope: "final",
		phase: "final",
		criterion: "Review cleanup failure.",
		base,
		tip,
		acquireLaunch: async () => acquiredReviewer(async () => { throw new Error("prompt cleanup failed"); }),
	}, context()), /prompt cleanup failed/);
});
