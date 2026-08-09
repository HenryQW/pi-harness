import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { fakeHerdr } from "./support/fake-herdr.ts";
import { type CommandRunner, runCommand } from "../src/command.ts";
import { startLocalRun } from "../src/intake.ts";
import { createCoreLifecycle, type CoreLifecycle } from "../src/lifecycle.ts";
import { type RunState } from "../src/model.ts";
import { abortRun } from "../src/orchestration.ts";
import { readActiveRunId, runDirectory, writeRunState } from "../src/state.ts";

const execFile = promisify(execFileCallback);
const RUN_ID = "33333333-3333-4333-8333-333333333333";
const ACTIVE_RUN_ID = "44444444-4444-4444-8444-444444444444";

test("resume rejects a recorded final-check tab from another workspace", async (t) => {
	const project = await makeProject(t);
	const herdr = fakeHerdr();
	const lifecycle = makeLifecycle(herdr.runner);
	const state = await advanceToFinalReview(project.root, lifecycle);
	const tab = herdr.tabs.get(state.tasks["final-check"].tab_id!);
	assert.ok(tab);
	tab.workspace_id = "wrong-workspace";

	await assert.rejects(lifecycle.resume(project.root), /expected initiating workspace main-workspace/);
});

test("resume rejects a recorded final-repair reviewer pane from another workspace", async (t) => {
	const project = await makeProject(t);
	const herdr = fakeHerdr();
	const lifecycle = makeLifecycle(herdr.runner);
	let state = await advanceToFinalReview(project.root, lifecycle);
	state = await lifecycle.resume(project.root, reviewEvent(state, "final-check", "changes_requested", ["repair alpha"]));
	state = await lifecycle.resolve(project.root, "alpha", "Repair alpha.");
	const repair = await commit(state.tasks["final-check"].worktree!, "repair.txt", "fixed\n", "repair alpha");
	state = await lifecycle.resume(project.root, requestReviewEvent(state, "final-check", repair));
	const tab = herdr.tabs.get(state.tasks["final-check"].tab_id!);
	assert.ok(tab);
	tab.workspace_id = "wrong-workspace";

	await assert.rejects(lifecycle.resume(project.root), /expected initiating workspace main-workspace/);
});

test("resume reuses a final-repair reviewer pane split before its state save", async (t) => {
	const project = await makeProject(t);
	const herdr = fakeHerdr();
	let crashAfterSplit = false;
	const lifecycle = makeLifecycle(async (command, args, options) => {
		const result = await herdr.runner(command, args, options);
		if (crashAfterSplit && command === "herdr" && args[0] === "pane" && args[1] === "split") {
			crashAfterSplit = false;
			return { code: 1, stdout: "", stderr: "simulated final-repair split crash" };
		}
		return result;
	});
	let state = await advanceToFinalReview(project.root, lifecycle);
	state = await lifecycle.resume(project.root, reviewEvent(state, "final-check", "changes_requested", ["repair alpha"]));
	state = await lifecycle.resolve(project.root, "alpha", "Repair alpha.");
	const repair = await commit(state.tasks["final-check"].worktree!, "repair.txt", "fixed\n", "repair alpha");
	const splits = herdr.count("pane split");

	crashAfterSplit = true;
	await assert.rejects(lifecycle.resume(project.root, requestReviewEvent(state, "final-check", repair)), /simulated final-repair split crash/);
	state = (await lifecycle.status(project.root, RUN_ID))!;
	const orphan = [...herdr.panes.values()].find((pane) => pane.tab_id === state.tasks["final-check"].tab_id && pane.pane_id !== state.tasks["final-check"].implementer_pane);
	assert.equal(state.tasks["final-check"].reviewer_pane, undefined);
	assert.equal(herdr.count("pane split"), splits + 1);

	state = await lifecycle.resume(project.root);
	assert.equal(state.tasks["final-check"].status, "repair_reviewing");
	assert.equal(state.tasks["final-check"].reviewer_pane, orphan?.pane_id);
	assert.equal(herdr.count("pane split"), splits + 1);
});

test("the frozen final check opens one exact integration PR and cleans successful resources", async (t) => {
	const project = await makeProject(t);
	const herdr = fakeHerdr();
	const gh = fakeGh(project.root);
	const lifecycle = makeLifecycle(combinedRunner(herdr, gh));

	const state = await finishInitialRun(project.root, lifecycle);

	assert.equal(state.phase, "completed");
	assert.equal(state.tasks["final-check"].status, "completed");
	assert.equal(await readActiveRunId(project.root), undefined);
	assert.equal(gh.pr?.headRefName, "dag");
	assert.equal(gh.pr?.baseRefName, "main");
	assert.match(gh.pr?.body ?? "", /ID: `pr-lifecycle-test`/);
	assert.match(gh.pr?.body ?? "", /Completed Local Issues: `alpha`/);
	assert.doesNotMatch(gh.pr?.body ?? "", /close[sd]? #/i);
	assert.equal(herdr.tabs.size, 0);
	assert.equal(gh.count("pr create"), 1);
});

test("retained health recovers a completed PR cleanup crash before health resources", async (t) => {
	const project = await makeProject(t);
	const herdr = fakeHerdr();
	const gh = fakeGh(project.root);
	let finalTab = "";
	let failCleanup = true;
	const calls: string[] = [];
	let lockDuringNormalCleanup: string | undefined;
	let lockDuringHealthCreate: string | undefined;
	const base = combinedRunner(herdr, gh);
	const runner: CommandRunner = async (command, args, options) => {
		if (command === "herdr" && args[0] === "tab" && args[1] === "close" && args[2] === finalTab) {
			calls.push("normal-cleanup");
			lockDuringNormalCleanup = await readActiveRunId(project.root);
			if (failCleanup) return { code: 1, stdout: "", stderr: "simulated normal cleanup failure" };
		}
		if (command === "herdr" && args[0] === "tab" && args[1] === "create") {
			calls.push("health-create");
			lockDuringHealthCreate = await readActiveRunId(project.root);
		}
		return await base(command, args, options);
	};
	const lifecycle = makeLifecycle(runner);
	let state = await advanceToFinalReview(project.root, lifecycle);
	finalTab = state.tasks["final-check"].tab_id!;
	await git(project.root, "push", "origin", "dag");
	await gh.runner("gh", ["pr", "create", "--base", "main", "--head", "dag", "--title", "test", "--body", "test"]);
	const head = await git(project.root, "rev-parse", "HEAD");
	// Exact durable snapshot from completePr before completeSuccessfulRun cleans its worker resources.
	state = {
		...state,
		phase: "completed",
		pr: { number: 42, url: "https://example.test/pr/42", head_ref: "dag", base_ref: "main", head_oid: head },
		tasks: { ...state.tasks, "final-check": { ...state.tasks["final-check"], status: "completed" } },
	};
	await writeRunState(project.root, state, () => RUN_ID);
	calls.length = 0;
	lockDuringNormalCleanup = undefined;
	lockDuringHealthCreate = undefined;

	state = await lifecycle.health(project.root, RUN_ID);
	assert.equal(state.phase, "blocked");
	assert.equal(state.health, undefined);
	assert.ok(state.cleanup_blocks?.some((block) => block.issue_id === "final-check" && block.operation === "tab"));
	assert.equal(await readActiveRunId(project.root), RUN_ID);
	assert.equal(lockDuringNormalCleanup, RUN_ID);
	assert.equal(herdr.tabs.size, 1);
	assert.deepEqual(calls, ["normal-cleanup"]);

	failCleanup = false;
	state = await lifecycle.health(project.root, RUN_ID);
	assert.equal(state.phase, "completed");
	assert.equal(state.cleanup_blocks, undefined);
	assert.equal(state.health?.status, "triaging");
	assert.equal(state.tasks["final-check"].tab_cleanup_done, true);
	assert.equal(lockDuringHealthCreate, RUN_ID);
	assert.deepEqual(calls, ["normal-cleanup", "normal-cleanup", "health-create"]);
	assert.equal((await lifecycle.status(project.root))?.health?.status, "triaging");

	state = await lifecycle.resume(project.root);
	assert.equal(state.health?.status, "triaging");
	const healthReviewer = state.health?.reviewer_agent;
	const healthPrompt = JSON.parse(herdr.calls.filter((call) => call.command === "herdr" && call.args[0] === "agent" && call.args[1] === "prompt" && call.args[2] === healthReviewer).at(-1)!.args[3]);
	assert.equal(healthPrompt.type, "auto_dag_resend");
	assert.equal("pr" in healthPrompt, false);
	state = await lifecycle.health(project.root, RUN_ID, healthEvent(state, {
		summary: "No unresolved review threads or failing checks.", actionable: false, thread_ids: [], checks: [],
	}));
	assert.equal(state.health?.status, "completed");
	assert.equal(herdr.tabs.size, 0);
	assert.equal(await readActiveRunId(project.root), undefined);
});

test("health refuses a retained historical run while another run is active without touching it", async (t) => {
	const project = await makeProject(t);
	const herdr = fakeHerdr();
	const gh = fakeGh(project.root);
	const runner = combinedRunner(herdr, gh);
	const historical = await finishInitialRun(project.root, makeLifecycle(runner));
	await startLocalRun({
		mainWorktree: project.root,
		runner,
		uuid: () => ACTIVE_RUN_ID,
		now: () => "2026-08-09T00:00:00.000Z",
		mainPane: "main-pane",
		workspaceId: "main-workspace",
	});

	const historicalPath = join(runDirectory(project.root, historical.run_id), "state.json");
	const activePath = join(runDirectory(project.root, ACTIVE_RUN_ID), "state.json");
	const [historicalState, activeState, head] = await Promise.all([
		readFile(historicalPath, "utf8"),
		readFile(activePath, "utf8"),
		git(project.root, "rev-parse", "HEAD"),
	]);
	const calls: string[][] = [];
	const observed: CommandRunner = async (command, args, options) => {
		calls.push([command, ...args]);
		return await runner(command, args, options);
	};

	await assert.rejects(makeLifecycle(observed).health(project.root, historical.run_id), /while active run .* exists/);
	assert.deepEqual(calls, []);
	assert.equal(await git(project.root, "rev-parse", "HEAD"), head);
	assert.equal(await readFile(historicalPath, "utf8"), historicalState);
	assert.equal(await readFile(activePath, "utf8"), activeState);
});

test("a failed final gate requires a completed owner resolution and a fresh reviewed repair", async (t) => {
	const project = await makeProject(t);
	const herdr = fakeHerdr();
	const gh = fakeGh(project.root);
	const lifecycle = makeLifecycle(combinedRunner(herdr, gh));
	let state = await advanceToFinalReview(project.root, lifecycle);

	state = await lifecycle.resume(project.root, reviewEvent(state, "final-check", "changes_requested", ["alpha owns this repair"]));
	assert.equal(state.phase, "blocked");
	await assert.rejects(lifecycle.resolve(project.root, "final-check", "Fix it."), /must be resolved against/);

	state = await lifecycle.resolve(project.root, "alpha", "Repair alpha for the final check.");
	const repairWorktree = state.tasks["final-check"].worktree!;
	assert.match(repairWorktree, /final-repair-alpha-1$/);
	const repair = await commit(repairWorktree, "repair.txt", "fixed\n", "repair alpha");
	state = await lifecycle.resume(project.root, requestReviewEvent(state, "final-check", repair));
	state = await lifecycle.resume(project.root, reviewEvent(state, "final-check", "approved", []));
	assert.equal(state.tasks["final-check"].status, "reviewing");
	assert.equal(await git(project.root, "show", "HEAD:repair.txt"), "fixed");
	const finalReviewer = state.tasks["final-check"].reviewer_agent!;
	const prompts = () => herdr.calls
		.filter((call) => call.command === "herdr" && call.args[0] === "agent" && call.args[1] === "prompt" && call.args[2] === finalReviewer)
		.map((call) => JSON.parse(call.args[3]));
	const fullPrompt = prompts().find((value) => value.type === "auto_dag_final_check");
	assert.equal(fullPrompt.attempt, state.tasks["final-check"].attempts);
	assert.equal(fullPrompt.review_round, state.tasks["final-check"].review_rounds);
	state = await lifecycle.resume(project.root);
	const compactPrompt = prompts().at(-1);
	assert.equal(compactPrompt.type, "auto_dag_resend");
	assert.equal(compactPrompt.attempt, state.tasks["final-check"].attempts);
	assert.equal(compactPrompt.review_round, state.tasks["final-check"].review_rounds);

	state = await lifecycle.resume(project.root, reviewEvent(state, "final-check", "approved", []));
	assert.equal(state.phase, "completed");
	assert.equal(gh.count("pr create"), 1);
	const creates = herdr.calls.filter((call) => call.command === "herdr" && call.args[0] === "tab" && call.args[1] === "create");
	assert.ok(creates.every((call) => call.args[call.args.indexOf("--workspace") + 1] === "main-workspace"));
	await assert.rejects(git(project.root, "rev-parse", "--verify", "pi-auto-dag/33333333-3333-4333-8333-333333333333/final-repair/alpha/1"));
});

test("final repair handoff recovers after its final tab closes before state saves", async (t) => {
	const project = await makeProject(t);
	const herdr = fakeHerdr();
	const base = combinedRunner(herdr, fakeGh(project.root));
	const directory = runDirectory(project.root, RUN_ID);
	const parked = `${directory}.closed`;
	let failAfterClose = false;
	let moved = false;
	const lifecycle = makeLifecycle(async (command, args, options) => {
		const result = await base(command, args, options);
		if (failAfterClose && command === "herdr" && args[0] === "tab" && args[1] === "close") {
			failAfterClose = false;
			await rename(directory, parked);
			moved = true;
		}
		return result;
	});
	let state = await advanceToFinalReview(project.root, lifecycle);
	state = await lifecycle.resume(project.root, reviewEvent(state, "final-check", "changes_requested", ["repair alpha"]));

	try {
		failAfterClose = true;
		await assert.rejects(lifecycle.resolve(project.root, "alpha", "Repair alpha."), /ENOENT/);
	} finally {
		if (moved) await rename(parked, directory);
	}
	state = await lifecycle.resolve(project.root, "alpha", "Repair alpha.");
	assert.equal(state.tasks["final-check"].status, "repairing");
	assert.ok(state.tasks["final-check"].worktree);
	assert.equal(herdr.tabs.size, 1);
});

test("resolving a blocked final repair retires its clean worktree and retains its branch", async (t) => {
	const project = await makeProject(t);
	const herdr = fakeHerdr();
	const lifecycle = makeLifecycle(combinedRunner(herdr, fakeGh(project.root)));
	let state = await advanceToFinalReview(project.root, lifecycle);
	state = await lifecycle.resume(project.root, reviewEvent(state, "final-check", "changes_requested", ["repair alpha"]));
	state = await lifecycle.resolve(project.root, "alpha", "Repair alpha.");
	const previous = state.tasks["final-check"];
	const worktree = previous.worktree!;
	const branch = previous.branch!;
	const tab = previous.tab_id!;

	state = await lifecycle.resume(project.root, event(state, "final-check", "implementer", "block_task", {
		reason: "first repair needs replacement", attempt: previous.attempts, review_round: (previous.review_rounds ?? 0) + 1,
	}));
	state = await lifecycle.resolve(project.root, "alpha", "Start a fresh repair.");

	assert.equal(state.tasks["final-check"].status, "repairing");
	assert.notEqual(state.tasks["final-check"].worktree, worktree);
	await assert.rejects(access(worktree));
	await git(project.root, "rev-parse", "--verify", branch);
	assert.equal(herdr.tabs.has(tab), false);
	assert.equal(herdr.tabs.size, 1);
});

test("resolving a blocked dirty final repair keeps its worktree and branch blocked", async (t) => {
	const project = await makeProject(t);
	const herdr = fakeHerdr();
	const lifecycle = makeLifecycle(combinedRunner(herdr, fakeGh(project.root)));
	let state = await advanceToFinalReview(project.root, lifecycle);
	state = await lifecycle.resume(project.root, reviewEvent(state, "final-check", "changes_requested", ["repair alpha"]));
	state = await lifecycle.resolve(project.root, "alpha", "Repair alpha.");
	const previous = state.tasks["final-check"];
	const worktree = previous.worktree!;
	const branch = previous.branch!;
	await writeFile(join(worktree, "unfinished.txt"), "keep me\n");

	state = await lifecycle.resume(project.root, event(state, "final-check", "implementer", "block_task", {
		reason: "first repair needs replacement", attempt: previous.attempts, review_round: (previous.review_rounds ?? 0) + 1,
	}));
	state = await lifecycle.resolve(project.root, "alpha", "Start a fresh repair.");

	assert.equal(state.phase, "blocked");
	assert.equal(state.tasks["final-check"].status, "blocked");
	assert.equal(state.tasks["final-check"].worktree, worktree);
	assert.equal(state.tasks["final-check"].branch, branch);
	assert.equal(await git(worktree, "status", "--porcelain"), "?? unfinished.txt");
	await git(project.root, "rev-parse", "--verify", branch);
	assert.equal(herdr.tabs.size, 0);
});

test("abort retains an unintegrated dirty final-gate repair branch", async (t) => {
	const project = await makeProject(t);
	const herdr = fakeHerdr();
	const gh = fakeGh(project.root);
	const lifecycle = makeLifecycle(combinedRunner(herdr, gh));
	let state = await advanceToFinalReview(project.root, lifecycle);
	state = await lifecycle.resume(project.root, reviewEvent(state, "final-check", "changes_requested", ["alpha owns this repair"]));
	state = await lifecycle.resolve(project.root, "alpha", "Repair alpha for the final check.");
	const repairWorktree = state.tasks["final-check"].worktree!;
	const branch = state.tasks["final-check"].branch!;
	await writeFile(join(repairWorktree, "unfinished.txt"), "keep me\n");

	state = await lifecycle.abort(project.root, "stop now");
	assert.equal(state.phase, "aborted");
	assert.equal(await git(repairWorktree, "status", "--porcelain"), "?? unfinished.txt");
	assert.equal(await git(project.root, "rev-parse", "--verify", branch), await git(repairWorktree, "rev-parse", "HEAD"));
});

test("abort cleans clean final and health repair resources while retaining their branches", async (t) => {
	const finalProject = await makeProject(t);
	const finalHerdr = fakeHerdr();
	const finalRunner = combinedRunner(finalHerdr, fakeGh(finalProject.root));
	const finalLifecycle = makeLifecycle(finalRunner);
	let final = await advanceToFinalReview(finalProject.root, finalLifecycle);
	final = await finalLifecycle.resume(finalProject.root, reviewEvent(final, "final-check", "changes_requested", ["repair alpha"]));
	final = await finalLifecycle.resolve(finalProject.root, "alpha", "Repair alpha.");
	const finalWorktree = final.tasks["final-check"].worktree!;
	const finalBranch = final.tasks["final-check"].branch!;

	final = await finalLifecycle.abort(finalProject.root, "stop clean final repair");
	assert.equal(final.phase, "aborted");
	assert.equal(final.cleanup_blocks, undefined);
	await assert.rejects(access(finalWorktree));
	await git(finalProject.root, "rev-parse", "--verify", finalBranch);
	assert.equal(finalHerdr.tabs.size, 0);
	assert.equal(await readActiveRunId(finalProject.root), undefined);

	const healthProject = await makeProject(t);
	const healthHerdr = fakeHerdr();
	const healthRunner = combinedRunner(healthHerdr, fakeGh(healthProject.root));
	const healthLifecycle = makeLifecycle(healthRunner);
	let health = await finishInitialRun(healthProject.root, healthLifecycle);
	health = await healthLifecycle.health(healthProject.root, RUN_ID);
	health = await healthLifecycle.health(healthProject.root, RUN_ID, healthEvent(health, {
		summary: "Repair one thread.", actionable: true, thread_ids: ["THREAD-1"], checks: [],
	}));
	const healthWorktree = health.health!.worktree!;
	const healthBranch = health.health!.branch!;

	health = await abortRun({ ...health, phase: "aborted" }, { runner: healthRunner, uuid: () => RUN_ID });
	assert.equal(health.phase, "aborted");
	assert.equal(health.cleanup_blocks, undefined);
	await assert.rejects(access(healthWorktree));
	await git(healthProject.root, "rev-parse", "--verify", healthBranch);
	assert.equal(healthHerdr.tabs.size, 0);
});

test("PR health records non-actionable triage without a coder or push", async (t) => {
	const project = await makeProject(t);
	const herdr = fakeHerdr();
	const gh = fakeGh(project.root);
	const lifecycle = makeLifecycle(combinedRunner(herdr, gh));
	let state = await finishInitialRun(project.root, lifecycle);
	const pushes = gh.gitPushes;

	state = await lifecycle.health(project.root, RUN_ID);
	assert.equal(state.health?.status, "triaging");
	state = await lifecycle.health(project.root, RUN_ID, healthEvent(state, {
		summary: "No unresolved review threads or failing checks.",
		actionable: false,
		thread_ids: [],
		checks: [{ name: "unit", link: "https://ci.example/unit", output: "passed" }],
	}));

	assert.equal(state.phase, "completed");
	assert.equal(state.health?.status, "completed");
	assert.equal(state.health?.checks?.[0]?.name, "unit");
	assert.equal(state.health?.coder_tab_id, undefined);
	assert.equal(gh.gitPushes, pushes);
	assert.equal(herdr.tabs.size, 0);
	assert.equal(await readActiveRunId(project.root), undefined);
});

test("public lifecycle owns actionable health through abort cleanup", async (t) => {
	const project = await makeProject(t);
	const herdr = fakeHerdr();
	const base = combinedRunner(herdr, fakeGh(project.root));
	let lockDuringHealthTabCreate: string | undefined;
	let lockDuringHealthWorktree: string | undefined;
	let lockDuringTabCleanup: string | undefined;
	const runner: CommandRunner = async (command, args, options) => {
		if (command === "herdr" && args[0] === "tab" && args[1] === "create") {
			lockDuringHealthTabCreate = await readActiveRunId(project.root);
		}
		if (command === "git" && args[0] === "worktree" && args[1] === "add") {
			lockDuringHealthWorktree = await readActiveRunId(project.root);
		}
		if (command === "herdr" && args[0] === "tab" && args[1] === "close") {
			lockDuringTabCleanup = await readActiveRunId(project.root);
		}
		return await base(command, args, options);
	};
	const lifecycle = makeLifecycle(runner);
	let state = await finishInitialRun(project.root, lifecycle);
	lockDuringHealthTabCreate = undefined;
	lockDuringHealthWorktree = undefined;
	lockDuringTabCleanup = undefined;

	state = await lifecycle.health(project.root, RUN_ID);
	assert.equal(await readActiveRunId(project.root), RUN_ID);
	assert.equal(lockDuringHealthTabCreate, RUN_ID);
	assert.equal((await lifecycle.status(project.root))?.health?.status, "triaging");
	state = await lifecycle.resume(project.root);
	assert.equal(state.health?.status, "triaging");
	assert.equal(await readActiveRunId(project.root), RUN_ID);
	state = await lifecycle.health(project.root, RUN_ID, healthEvent(state, {
		summary: "Repair one thread.", actionable: true, thread_ids: ["THREAD-1"], checks: [],
	}));
	const creates = herdr.calls.filter((call) => call.command === "herdr" && call.args[0] === "tab" && call.args[1] === "create");
	assert.ok(creates.every((call) => call.args[call.args.indexOf("--workspace") + 1] === "main-workspace"));
	const worktree = state.health!.worktree!;
	const branch = state.health!.branch!;
	assert.equal(lockDuringHealthWorktree, RUN_ID);
	assert.equal((await lifecycle.status(project.root))?.health?.status, "repairing");
	assert.equal(await readActiveRunId(project.root), RUN_ID);

	state = await lifecycle.abort(project.root, "stop actionable health");
	assert.equal(state.phase, "aborted");
	assert.equal(state.cleanup_blocks, undefined);
	assert.equal(lockDuringTabCleanup, RUN_ID);
	assert.equal(await readActiveRunId(project.root), undefined);
	await assert.rejects(access(worktree));
	await git(project.root, "rev-parse", "--verify", branch);
	assert.equal(herdr.tabs.size, 0);
});

test("no-action health completion recovers after its tab closes before state saves", async (t) => {
	const project = await makeProject(t);
	const herdr = fakeHerdr();
	const base = combinedRunner(herdr, fakeGh(project.root));
	const directory = runDirectory(project.root, RUN_ID);
	const parked = `${directory}.closed`;
	let failAfterClose = false;
	let moved = false;
	const lifecycle = makeLifecycle(async (command, args, options) => {
		const result = await base(command, args, options);
		if (failAfterClose && command === "herdr" && args[0] === "tab" && args[1] === "close") {
			failAfterClose = false;
			await rename(directory, parked);
			moved = true;
		}
		return result;
	});
	let state = await finishInitialRun(project.root, lifecycle);
	state = await lifecycle.health(project.root, RUN_ID);
	const event_ = healthEvent(state, {
		summary: "No unresolved review threads or failing checks.", actionable: false, thread_ids: [], checks: [],
	});

	try {
		failAfterClose = true;
		await assert.rejects(lifecycle.health(project.root, RUN_ID, event_), /ENOENT/);
	} finally {
		if (moved) await rename(parked, directory);
	}
	const stuck = await lifecycle.status(project.root, RUN_ID);
	assert.equal(stuck?.health?.status, "triaging");
	assert.equal(stuck?.health?.actionable, false);
	assert.ok(stuck?.health?.reviewer_tab_id);
	const prompts = herdr.calls.filter((call) => call.command === "herdr" && call.args[0] === "agent" && call.args[1] === "prompt").length;
	state = await lifecycle.health(project.root, RUN_ID);
	assert.equal(state.health?.status, "completed");
	assert.equal(herdr.tabs.size, 0);
	assert.equal(herdr.calls.filter((call) => call.command === "herdr" && call.args[0] === "agent" && call.args[1] === "prompt").length, prompts);
});

test("health triage reuses its tab after creation succeeds before state saves", async (t) => {
	const project = await makeProject(t);
	const herdr = fakeHerdr();
	const base = combinedRunner(herdr, fakeGh(project.root));
	const directory = runDirectory(project.root, RUN_ID);
	const parked = `${directory}.created`;
	let failAfterCreate = false;
	let moved = false;
	const runner: CommandRunner = async (command, args, options) => {
		const result = await base(command, args, options);
		if (failAfterCreate && command === "herdr" && args[0] === "tab" && args[1] === "create") {
			failAfterCreate = false;
			await rename(directory, parked);
			moved = true;
		}
		return result;
	};
	const lifecycle = makeLifecycle(runner);
	let state = await finishInitialRun(project.root, lifecycle);
	const creates = herdr.calls.filter((call) => call.command === "herdr" && call.args[0] === "tab" && call.args[1] === "create").length;

	try {
		failAfterCreate = true;
		await assert.rejects(lifecycle.health(project.root, RUN_ID), /ENOENT/);
	} finally {
		if (moved) await rename(parked, directory);
	}
	const stuck = await lifecycle.status(project.root, RUN_ID);
	assert.equal(stuck?.health?.status, "triaging");
	assert.equal(stuck?.health?.reviewer_tab_id, undefined);
	assert.equal(herdr.tabs.size, 1);

	state = await lifecycle.health(project.root, RUN_ID);
	const reviewerTab = state.health!.reviewer_tab_id!;
	assert.equal(herdr.tabs.size, 1);
	assert.equal(herdr.calls.filter((call) => call.command === "herdr" && call.args[0] === "tab" && call.args[1] === "create").length, creates + 1);
	state = await lifecycle.health(project.root, RUN_ID, healthEvent(state, {
		summary: "Nothing to repair.", actionable: false, thread_ids: [], checks: [],
	}));
	assert.equal(state.health?.status, "completed");
	assert.equal(herdr.calls.filter((call) => call.command === "herdr" && call.args[0] === "tab" && call.args[1] === "close" && call.args[2] === reviewerTab).length, 1);
});

test("health repair reuses its coder tab after creation succeeds before state saves", async (t) => {
	const project = await makeProject(t);
	const herdr = fakeHerdr();
	const base = combinedRunner(herdr, fakeGh(project.root));
	const directory = runDirectory(project.root, RUN_ID);
	const parked = `${directory}.created`;
	let failAfterCreate = false;
	let moved = false;
	const runner: CommandRunner = async (command, args, options) => {
		const result = await base(command, args, options);
		if (failAfterCreate && command === "herdr" && args[0] === "tab" && args[1] === "create") {
			failAfterCreate = false;
			await rename(directory, parked);
			moved = true;
		}
		return result;
	};
	const lifecycle = makeLifecycle(runner);
	let state = await finishInitialRun(project.root, lifecycle);
	state = await lifecycle.health(project.root, RUN_ID);
	const creates = herdr.calls.filter((call) => call.command === "herdr" && call.args[0] === "tab" && call.args[1] === "create").length;
	const event_ = healthEvent(state, {
		summary: "Repair one thread.", actionable: true, thread_ids: ["THREAD-1"], checks: [],
	});

	try {
		failAfterCreate = true;
		await assert.rejects(lifecycle.health(project.root, RUN_ID, event_), /ENOENT/);
	} finally {
		if (moved) await rename(parked, directory);
	}
	const stuck = await lifecycle.status(project.root, RUN_ID);
	assert.equal(stuck?.health?.status, "repairing");
	assert.equal(stuck?.health?.coder_tab_id, undefined);
	assert.equal(herdr.tabs.size, 2);

	state = await lifecycle.health(project.root, RUN_ID);
	const coderTab = state.health!.coder_tab_id!;
	assert.equal(herdr.tabs.size, 2);
	assert.equal(herdr.calls.filter((call) => call.command === "herdr" && call.args[0] === "tab" && call.args[1] === "create").length, creates + 1);
	state = await abortRun({ ...state, phase: "aborted" }, { runner, uuid: () => RUN_ID });
	assert.equal(state.phase, "aborted");
	assert.equal(herdr.calls.filter((call) => call.command === "herdr" && call.args[0] === "tab" && call.args[1] === "close" && call.args[2] === coderTab).length, 1);
});

test("health repair reattaches its retained branch after worktree removal", async (t) => {
	const project = await makeProject(t);
	const herdr = fakeHerdr();
	const lifecycle = makeLifecycle(combinedRunner(herdr, fakeGh(project.root)));
	let state = await finishInitialRun(project.root, lifecycle);
	state = await lifecycle.health(project.root, RUN_ID);
	state = await lifecycle.health(project.root, RUN_ID, healthEvent(state, {
		summary: "Repair one thread.", actionable: true, thread_ids: ["THREAD-1"], checks: [],
	}));
	const { worktree, branch } = state.health!;
	const head = await git(worktree!, "rev-parse", "HEAD");
	await git(project.root, "worktree", "remove", worktree!);

	state = await lifecycle.resume(project.root);
	assert.equal(await git(worktree!, "symbolic-ref", "--quiet", "--short", "HEAD"), branch);
	assert.equal(await git(worktree!, "rev-parse", "HEAD"), head);
	await lifecycle.abort(project.root, "test cleanup");
});

test("PR health fast-forwards, uses the same reviewer, pushes once, and resolves only fixed triaged threads", async (t) => {
	const project = await makeProject(t);
	const herdr = fakeHerdr();
	const gh = fakeGh(project.root);
	const lifecycle = makeLifecycle(combinedRunner(herdr, gh));
	let state = await finishInitialRun(project.root, lifecycle);
	const pushes = gh.gitPushes;

	state = await lifecycle.health(project.root, RUN_ID);
	const reviewer = state.health?.reviewer_agent;
	state = await lifecycle.health(project.root, RUN_ID, healthEvent(state, {
		summary: "One unresolved review thread and one failing check.",
		actionable: true,
		thread_ids: ["THREAD-1"],
		checks: [{ name: "integration", link: "https://ci.example/integration", output: "fails: expected repair" }],
	}));
	assert.equal(state.health?.status, "repairing");
	const repair = await commit(state.health!.worktree!, "health.txt", "healthy\n", "health repair");
	state = await lifecycle.health(project.root, RUN_ID, requestReviewEvent(state, "final-check", repair));
	assert.equal(state.health?.reviewer_agent, reviewer);
	state = await lifecycle.health(project.root, RUN_ID, healthReviewEvent(state, "approved", [], ["THREAD-1"]));

	assert.equal(state.health?.status, "completed");
	assert.deepEqual(state.health?.resolved_thread_ids, ["THREAD-1"]);
	assert.equal(gh.gitPushes, pushes + 1);
	assert.deepEqual(gh.resolved, ["THREAD-1"]);
	assert.equal(herdr.tabs.size, 0);
	assert.equal(await git(project.root, "show", "HEAD:health.txt"), "healthy");
});

test("a pre-existing PR with mismatched identity blocks before push", async (t) => {
	const project = await makeProject(t);
	const herdr = fakeHerdr();
	const gh = fakeGh(project.root, { base: "other" });
	const lifecycle = makeLifecycle(combinedRunner(herdr, gh));
	const state = await advanceToFinalReview(project.root, lifecycle);

	await assert.rejects(lifecycle.resume(project.root, reviewEvent(state, "final-check", "approved", [])), /mismatched head or base identity/);
	assert.equal(gh.gitPushes, 0);
});

test("envelope-less resume restarts missing final lifecycle roles with full instructions", async (t) => {
	const project = await makeProject(t);
	const herdr = fakeHerdr();
	const lifecycle = makeLifecycle(combinedRunner(herdr, fakeGh(project.root)));
	const prompt = (agent: string) => JSON.parse(herdr.calls.filter((call) => call.command === "herdr" && call.args[0] === "agent" && call.args[1] === "prompt" && call.args[2] === agent).at(-1)!.args[3]) as { instruction: string };
	let state = await advanceToFinalReview(project.root, lifecycle);
	const finalReviewer = state.tasks["final-check"].reviewer_agent!;
	herdr.live.delete(finalReviewer);
	const finalReviewerStarts = herdr.calls.filter((call) => call.command === "herdr" && call.args[0] === "agent" && call.args[1] === "start" && call.args[2] === finalReviewer).length;
	const finalReviewerPrompts = herdr.calls.filter((call) => call.command === "herdr" && call.args[0] === "agent" && call.args[1] === "prompt" && call.args[2] === finalReviewer).length;
	state = await lifecycle.resume(project.root);
	assert.equal(state.tasks["final-check"].status, "reviewing");
	assert.equal(herdr.calls.filter((call) => call.command === "herdr" && call.args[0] === "agent" && call.args[1] === "start" && call.args[2] === finalReviewer).length, finalReviewerStarts + 1);
	assert.equal(herdr.calls.filter((call) => call.command === "herdr" && call.args[0] === "agent" && call.args[1] === "prompt" && call.args[2] === finalReviewer).length, finalReviewerPrompts + 1);
	assert.match(prompt(finalReviewer).instruction, /^Read-only final check:/);
	state = await lifecycle.resume(project.root, reviewEvent(state, "final-check", "changes_requested", ["repair alpha"]));
	state = await lifecycle.resolve(project.root, "alpha", "Repair alpha.");

	const coder = state.tasks["final-check"].implementer_agent!;
	herdr.live.delete(coder);
	const coderStarts = herdr.calls.filter((call) => call.command === "herdr" && call.args[0] === "agent" && call.args[1] === "start" && call.args[2] === coder).length;
	const coderPrompts = herdr.calls.filter((call) => call.command === "herdr" && call.args[0] === "agent" && call.args[1] === "prompt" && call.args[2] === coder).length;
	state = await lifecycle.resume(project.root);
	assert.equal(state.tasks["final-check"].status, "repairing");
	assert.equal(herdr.calls.filter((call) => call.command === "herdr" && call.args[0] === "agent" && call.args[1] === "start" && call.args[2] === coder).length, coderStarts + 1);
	assert.equal(herdr.calls.filter((call) => call.command === "herdr" && call.args[0] === "agent" && call.args[1] === "prompt" && call.args[2] === coder).length, coderPrompts + 1);
	assert.match(prompt(coder).instruction, /^Implement the named final-gate repair/);

	const repair = await commit(state.tasks["final-check"].worktree!, "repair.txt", "fixed\n", "repair alpha");
	state = await lifecycle.resume(project.root, requestReviewEvent(state, "final-check", repair));
	const reviewer = state.tasks["final-check"].reviewer_agent!;
	herdr.live.delete(reviewer);
	const reviewerStarts = herdr.calls.filter((call) => call.command === "herdr" && call.args[0] === "agent" && call.args[1] === "start" && call.args[2] === reviewer).length;
	const reviewerPrompts = herdr.calls.filter((call) => call.command === "herdr" && call.args[0] === "agent" && call.args[1] === "prompt" && call.args[2] === reviewer).length;
	state = await lifecycle.resume(project.root);
	assert.equal(state.tasks["final-check"].status, "repair_reviewing");
	assert.equal(herdr.calls.filter((call) => call.command === "herdr" && call.args[0] === "agent" && call.args[1] === "start" && call.args[2] === reviewer).length, reviewerStarts + 1);
	assert.equal(herdr.calls.filter((call) => call.command === "herdr" && call.args[0] === "agent" && call.args[1] === "prompt" && call.args[2] === reviewer).length, reviewerPrompts + 1);
	assert.match(prompt(reviewer).instruction, /^Read-only review:/);
});

test("envelope-less resume nudges live final lifecycle roles and redelivers pending instructions", async (t) => {
	const project = await makeProject(t);
	const herdr = fakeHerdr();
	const lifecycle = makeLifecycle(combinedRunner(herdr, fakeGh(project.root)));
	const prompt = (agent: string) => JSON.parse(herdr.calls.filter((call) => call.command === "herdr" && call.args[0] === "agent" && call.args[1] === "prompt" && call.args[2] === agent).at(-1)!.args[3]) as Record<string, unknown> & { instruction: string };
	const starts = (agent: string) => herdr.calls.filter((call) => call.command === "herdr" && call.args[0] === "agent" && call.args[1] === "start" && call.args[2] === agent).length;
	let state = await advanceToFinalReview(project.root, lifecycle);

	const finalReviewer = state.tasks["final-check"].reviewer_agent!;
	const finalStarts = starts(finalReviewer);
	assert.equal(herdr.live.has(finalReviewer), true);
	state = await lifecycle.resume(project.root);
	assert.equal(starts(finalReviewer), finalStarts);
	assert.match(prompt(finalReviewer).instruction, /^Resend your latest final-check review event/);
	assert.equal(prompt(finalReviewer).type, "auto_dag_resend");
	assert.equal("issue" in prompt(finalReviewer), false);
	assert.equal(state.tasks["final-check"].reviewer_instruction_pending, undefined);
	await writeRunState(project.root, {
		...state,
		tasks: { ...state.tasks, "final-check": { ...state.tasks["final-check"], reviewer_instruction_pending: true } },
	}, () => RUN_ID);
	state = await lifecycle.resume(project.root);
	assert.match(prompt(finalReviewer).instruction, /^Read-only final check:/);
	assert.equal(prompt(finalReviewer).type, "auto_dag_final_check");
	assert.equal("issue" in prompt(finalReviewer), true);
	assert.equal(state.tasks["final-check"].reviewer_instruction_pending, undefined);

	state = await lifecycle.resume(project.root, reviewEvent(state, "final-check", "changes_requested", ["repair alpha"]));
	state = await lifecycle.resolve(project.root, "alpha", "Repair alpha.");
	const coder = state.tasks["final-check"].implementer_agent!;
	const coderStarts = starts(coder);
	assert.equal(herdr.live.has(coder), true);
	state = await lifecycle.resume(project.root);
	assert.equal(starts(coder), coderStarts);
	assert.match(prompt(coder).instruction, /^Resend your latest worker event/);
	assert.equal(prompt(coder).type, "auto_dag_resend");
	assert.equal("owner_issue" in prompt(coder), false);
	assert.equal(state.tasks["final-check"].implementer_instruction_pending, undefined);
	await writeRunState(project.root, {
		...state,
		tasks: { ...state.tasks, "final-check": { ...state.tasks["final-check"], implementer_instruction_pending: true } },
	}, () => RUN_ID);
	state = await lifecycle.resume(project.root);
	assert.match(prompt(coder).instruction, /^Implement the named final-gate repair/);
	assert.equal(prompt(coder).type, "auto_dag_final_repair");
	assert.equal("owner_issue" in prompt(coder), true);
	assert.equal(state.tasks["final-check"].implementer_instruction_pending, undefined);

	const repair = await commit(state.tasks["final-check"].worktree!, "repair.txt", "fixed\n", "repair alpha");
	state = await lifecycle.resume(project.root, requestReviewEvent(state, "final-check", repair));
	const reviewer = state.tasks["final-check"].reviewer_agent!;
	const reviewerStarts = starts(reviewer);
	assert.equal(herdr.live.has(reviewer), true);
	state = await lifecycle.resume(project.root);
	assert.equal(starts(reviewer), reviewerStarts);
	assert.match(prompt(reviewer).instruction, /^Resend your latest worker event/);
	assert.equal(prompt(reviewer).type, "auto_dag_resend");
	assert.equal("owner_issue" in prompt(reviewer), false);
	assert.equal(state.tasks["final-check"].reviewer_instruction_pending, undefined);
	await writeRunState(project.root, {
		...state,
		tasks: { ...state.tasks, "final-check": { ...state.tasks["final-check"], reviewer_instruction_pending: true } },
	}, () => RUN_ID);
	state = await lifecycle.resume(project.root);
	assert.match(prompt(reviewer).instruction, /^Read-only review:/);
	assert.equal(prompt(reviewer).type, "auto_dag_final_repair_review");
	assert.equal("owner_issue" in prompt(reviewer), true);
	assert.equal(state.tasks["final-check"].reviewer_instruction_pending, undefined);
});

test("PR lifecycle rejects a same-name agent on a different pane", async (t) => {
	const project = await makeProject(t);
	const herdr = fakeHerdr();
	const lifecycle = makeLifecycle(combinedRunner(herdr, fakeGh(project.root)));
	const state = await advanceToFinalReview(project.root, lifecycle);
	const agent = state.tasks["final-check"].reviewer_agent!;
	herdr.agentPanes.set(agent, "foreign-pane");

	await assert.rejects(lifecycle.resume(project.root), /name collision/);
});

test("final repair recovers an applied lifecycle-owned cherry-pick after a crash", async (t) => {
	const project = await makeProject(t);
	const herdr = fakeHerdr();
	const gh = fakeGh(project.root);
	const base = combinedRunner(herdr, gh);
	let crash = true;
	let picks = 0;
	const lifecycle = makeLifecycle(async (command, args, options) => {
		const result = await base(command, args, options);
		if (command === "git" && args[0] === "cherry-pick" && args[1] === "-x") {
			picks += 1;
			if (picks === 2 && crash) {
				crash = false;
				throw new Error("simulated crash after final repair cherry-pick");
			}
		}
		return result;
	});
	let state = await advanceToFinalReview(project.root, lifecycle);
	state = await lifecycle.resume(project.root, reviewEvent(state, "final-check", "changes_requested", ["repair alpha"]));
	state = await lifecycle.resolve(project.root, "alpha", "Repair alpha.");
	const repair = await commit(state.tasks["final-check"].worktree!, "repair.txt", "fixed\n", "repair alpha");
	state = await lifecycle.resume(project.root, requestReviewEvent(state, "final-check", repair));
	await assert.rejects(lifecycle.resume(project.root, reviewEvent(state, "final-check", "approved", [])), /simulated crash/);
	const stuck = await lifecycle.status(project.root, RUN_ID);
	assert.equal(stuck?.tasks["final-check"].status, "repair_applying");
	assert.equal(stuck?.tasks["final-check"].integration_intent, repair);

	state = await lifecycle.resume(project.root);
	assert.equal(state.tasks["final-check"].status, "reviewing");
	assert.equal(picks, 2);
	assert.equal(await git(project.root, "show", "HEAD:repair.txt"), "fixed");
});

test("final repair cleanup accepts resources already removed before its durable update", async (t) => {
	const project = await makeProject(t);
	const herdr = fakeHerdr();
	const base = combinedRunner(herdr, fakeGh(project.root));
	let interrupt = false;
	const removed = new Set<string>();
	const lifecycle = makeLifecycle(async (command, args, options) => {
		const result = await base(command, args, options);
		const resource = command === "herdr" && args[0] === "tab" && args[1] === "close"
			? "tab"
			: command === "git" && args[0] === "worktree" && args[1] === "remove"
				? "worktree"
				: command === "git" && args[0] === "branch" && args[1] === "-D" ? "branch" : undefined;
		if (interrupt && resource) {
			removed.add(resource);
			throw new Error(`simulated crash after final repair ${resource} removal`);
		}
		return result;
	});
	let state = await advanceToFinalReview(project.root, lifecycle);
	state = await lifecycle.resume(project.root, reviewEvent(state, "final-check", "changes_requested", ["repair alpha"]));
	state = await lifecycle.resolve(project.root, "alpha", "Repair alpha.");
	const worktree = state.tasks["final-check"].worktree!;
	const branch = state.tasks["final-check"].branch!;
	const repair = await commit(worktree, "repair.txt", "fixed\n", "repair alpha");
	state = await lifecycle.resume(project.root, requestReviewEvent(state, "final-check", repair));

	interrupt = true;
	state = await lifecycle.resume(project.root, reviewEvent(state, "final-check", "approved", []));

	assert.equal(state.phase, "execution");
	assert.equal(state.tasks["final-check"].status, "reviewing");
	interrupt = false;
	state = await lifecycle.resume(project.root, reviewEvent(state, "final-check", "approved", []));
	assert.equal(state.phase, "completed");
	assert.deepEqual([...removed].sort(), ["branch", "tab", "worktree"]);
	await assert.rejects(access(worktree));
	await assert.rejects(git(project.root, "rev-parse", "--verify", branch));
	assert.equal(herdr.tabs.size, 0);
});

test("aborted resume recognizes and aborts a conflicted lifecycle-owned final repair pick", async (t) => {
	const project = await makeProject(t);
	const herdr = fakeHerdr();
	const base = combinedRunner(herdr, fakeGh(project.root));
	let picks = 0;
	const lifecycle = makeLifecycle(async (command, args, options) => {
		if (command === "git" && args[0] === "cherry-pick" && args[1] === "-x" && ++picks === 2) {
			await writeFile(join(project.root, "conflict.txt"), "main\n");
			await git(project.root, "add", "conflict.txt");
			await git(project.root, "commit", "-m", "concurrent integration change");
		}
		return await base(command, args, options);
	});
	let state = await advanceToFinalReview(project.root, lifecycle);
	state = await lifecycle.resume(project.root, reviewEvent(state, "final-check", "changes_requested", ["repair alpha"]));
	state = await lifecycle.resolve(project.root, "alpha", "Repair alpha.");
	const branch = state.tasks["final-check"].branch!;
	const repair = await commit(state.tasks["final-check"].worktree!, "conflict.txt", "repair\n", "repair alpha");
	state = await lifecycle.resume(project.root, requestReviewEvent(state, "final-check", repair));
	await assert.rejects(lifecycle.resume(project.root, reviewEvent(state, "final-check", "approved", [])), /cherry-pick/);
	state = (await lifecycle.status(project.root, RUN_ID))!;
	await writeRunState(project.root, { ...state, phase: "aborted", abort_reason: "stop after conflict" }, () => RUN_ID);

	state = await lifecycle.resume(project.root);
	assert.equal(state.phase, "aborted");
	await assert.rejects(git(project.root, "rev-parse", "-q", "--verify", "CHERRY_PICK_HEAD"));
	assert.equal(await git(project.root, "rev-parse", "--verify", branch), repair);
});

test("post-push health cleanup accepts resources already removed before its durable update", async (t) => {
	const project = await makeProject(t);
	const herdr = fakeHerdr();
	const gh = fakeGh(project.root);
	const base = combinedRunner(herdr, gh);
	let interrupt = false;
	let lockDuringCleanup: string | undefined;
	const removed = new Set<string>();
	const lifecycle = makeLifecycle(async (command, args, options) => {
		const result = await base(command, args, options);
		const resource = command === "herdr" && args[0] === "tab" && args[1] === "close"
			? "tab"
			: command === "git" && args[0] === "worktree" && args[1] === "remove"
				? "worktree"
				: command === "git" && args[0] === "branch" && args[1] === "-D" ? "branch" : undefined;
		if (interrupt && resource) {
			lockDuringCleanup = await readActiveRunId(project.root);
			removed.add(resource);
			throw new Error(`simulated crash after health repair ${resource} removal`);
		}
		return result;
	});
	let state = await finishInitialRun(project.root, lifecycle);
	const pushes = gh.gitPushes;
	state = await lifecycle.health(project.root, RUN_ID);
	state = await lifecycle.health(project.root, RUN_ID, healthEvent(state, {
		summary: "Repair one thread.", actionable: true, thread_ids: ["THREAD-1"], checks: [],
	}));
	const worktree = state.health!.worktree!;
	const branch = state.health!.branch!;
	const repair = await commit(worktree, "health.txt", "healthy\n", "health repair");
	state = await lifecycle.health(project.root, RUN_ID, requestReviewEvent(state, "final-check", repair));

	interrupt = true;
	state = await lifecycle.health(project.root, RUN_ID, healthReviewEvent(state, "approved", [], ["THREAD-1"]));

	assert.equal(state.health?.status, "completed");
	assert.deepEqual([...removed].sort(), ["branch", "tab", "worktree"]);
	assert.equal(gh.gitPushes, pushes + 1);
	await assert.rejects(access(worktree));
	await assert.rejects(git(project.root, "rev-parse", "--verify", branch));
	assert.equal(herdr.tabs.size, 0);
	assert.equal(lockDuringCleanup, RUN_ID);
	assert.equal(await readActiveRunId(project.root), undefined);
});

test("delayed PR-health triage, review, and block events cannot block newer work", async (t) => {
	const project = await makeProject(t);
	const lifecycle = makeLifecycle(combinedRunner(fakeHerdr(), fakeGh(project.root)));
	let state = await finishInitialRun(project.root, lifecycle);

	state = await lifecycle.health(project.root, RUN_ID);
	const staleTriage = healthEvent(state, {
		summary: "First health pass.", actionable: false, thread_ids: [], checks: [],
	});
	const staleTriageBlock = event(state, "final-check", "reviewer", "block_task", {
		reason: "old triage blocker", attempt: state.health!.attempt, review_round: state.health!.review_round,
	});
	state = await lifecycle.health(project.root, RUN_ID, staleTriage);
	assert.equal(state.health?.status, "completed");

	state = await lifecycle.health(project.root, RUN_ID);
	assert.equal(state.health?.status, "triaging");
	assert.equal(state.health?.attempt, 2);
	state = await lifecycle.health(project.root, RUN_ID, staleTriage);
	state = await lifecycle.health(project.root, RUN_ID, staleTriageBlock);
	assert.equal(state.health?.status, "triaging");
	assert.equal(state.health?.attempt, 2);

	state = await lifecycle.health(project.root, RUN_ID, healthEvent(state, {
		summary: "Repair one thread.", actionable: true, thread_ids: ["THREAD-1"], checks: [],
	}));
	const repair = await commit(state.health!.worktree!, "health.txt", "healthy\n", "health repair");
	state = await lifecycle.health(project.root, RUN_ID, requestReviewEvent(state, "final-check", repair));
	const staleReview = healthReviewEvent(state, "blocked", ["old reviewer blocker"], []);
	state = await lifecycle.health(project.root, RUN_ID, healthReviewEvent(state, "changes_requested", ["revise it"], []));
	assert.equal(state.health?.status, "repairing");

	const oldRound = state.health!.review_round!;
	state = await lifecycle.health(project.root, RUN_ID, staleReview);
	state = await lifecycle.health(project.root, RUN_ID, event(state, "final-check", "reviewer", "block_task", {
		reason: "old reviewer blocker", attempt: state.health!.attempt, review_round: oldRound,
	}));
	state = await lifecycle.health(project.root, RUN_ID, event(state, "final-check", "implementer", "block_task", {
		reason: "old coder blocker", attempt: state.health!.attempt, review_round: oldRound,
	}));
	assert.equal(state.phase, "completed");
	assert.equal(state.health?.status, "repairing");
	state = await lifecycle.health(project.root, RUN_ID, event(state, "final-check", "implementer", "block_task", {
		reason: "current coder blocker", attempt: state.health!.attempt, review_round: oldRound + 1,
	}));
	assert.equal(state.health?.status, "blocked");
});

test("active health blocks before using an old-base repair when the PR head moves", async (t) => {
	const project = await makeProject(t);
	const herdr = fakeHerdr();
	const gh = fakeGh(project.root);
	const lifecycle = makeLifecycle(combinedRunner(herdr, gh));
	let state = await finishInitialRun(project.root, lifecycle);
	const pushes = gh.gitPushes;

	state = await lifecycle.health(project.root, RUN_ID);
	state = await lifecycle.health(project.root, RUN_ID, healthEvent(state, {
		summary: "Repair one thread.", actionable: true, thread_ids: ["THREAD-1"], checks: [],
	}));
	const before = await git(project.root, "rev-parse", "HEAD");
	await advanceRemote(t, project.remote);
	state = await lifecycle.health(project.root, RUN_ID);

	assert.equal(state.health?.status, "blocked");
	assert.equal(await git(project.root, "rev-parse", "HEAD"), before);
	assert.equal(gh.gitPushes, pushes);
});

test("health accepts repository commits without package config", async (t) => {
	const project = await makeProject(t);
	const lifecycle = makeLifecycle(combinedRunner(fakeHerdr(), fakeGh(project.root)));
	const state = await finishInitialRun(project.root, lifecycle);

	await advanceRemoteConfig(t, project.remote);
	const resumed = await lifecycle.health(project.root, RUN_ID);

	assert.equal(resumed.health?.status, "triaging");
	assert.notEqual(resumed.integration_head, state.integration_head);
});

test("health retries a persisted pre-merge fast-forward intent", async (t) => {
	const project = await makeProject(t);
	const base = combinedRunner(fakeHerdr(), fakeGh(project.root));
	let interrupt = true;
	let merges = 0;
	const runner: CommandRunner = async (command, args, options) => {
		if (command === "git" && args[0] === "merge" && args[1] === "--ff-only") {
			if (interrupt) {
				interrupt = false;
				throw new Error("simulated process exit before PR fast-forward");
			}
			merges += 1;
		}
		return await base(command, args, options);
	};
	const lifecycle = makeLifecycle(runner);
	const initial = await finishInitialRun(project.root, lifecycle);
	await advanceRemote(t, project.remote);
	const remote = await remoteHead(project.root, "dag");

	await assert.rejects(lifecycle.health(project.root, RUN_ID), /simulated process exit before PR fast-forward/);
	const stuck = await lifecycle.status(project.root, RUN_ID);
	assert.equal(await git(project.root, "rev-parse", "HEAD"), initial.integration_head);
	assert.equal(stuck?.health_fast_forward_intent?.expected_head, initial.integration_head);
	assert.equal(stuck?.health_fast_forward_intent?.remote_head, remote);
	assert.equal(stuck?.health_fast_forward_intent?.pr.head_oid, remote);

	const resumed = await makeLifecycle(runner).health(project.root, RUN_ID);
	assert.equal(resumed.integration_head, remote);
	assert.equal(resumed.health_fast_forward_intent, undefined);
	assert.equal(resumed.health?.status, "triaging");
	assert.equal(merges, 1);
});

test("health recovers a crashed PR fast-forward without merging twice", async (t) => {
	const project = await makeProject(t);
	const herdr = fakeHerdr();
	const gh = fakeGh(project.root);
	const base = combinedRunner(herdr, gh);
	let crash = true;
	let merges = 0;
	const runner: CommandRunner = async (command, args, options) => {
		const result = await base(command, args, options);
		if (command === "git" && args[0] === "merge" && args[1] === "--ff-only") {
			merges += 1;
			if (crash) {
				crash = false;
				throw new Error("simulated process exit after PR fast-forward");
			}
		}
		return result;
	};
	const lifecycle = makeLifecycle(runner);
	const initial = await finishInitialRun(project.root, lifecycle);
	await advanceRemote(t, project.remote);
	const remote = await remoteHead(project.root, "dag");

	await assert.rejects(lifecycle.health(project.root, RUN_ID), /simulated process exit/);
	const stuck = await lifecycle.status(project.root, RUN_ID);
	assert.equal(stuck?.phase, "completed");
	assert.equal(stuck?.integration_head, initial.integration_head);
	assert.equal(stuck?.health_fast_forward_intent?.expected_head, initial.integration_head);
	assert.equal(stuck?.health_fast_forward_intent?.remote_head, remote);
	assert.equal(await git(project.root, "rev-parse", "HEAD"), remote);

	const resumed = await makeLifecycle(runner).health(project.root, RUN_ID);
	assert.equal(resumed.phase, "completed");
	assert.equal(resumed.integration_head, remote);
	assert.equal(resumed.pr?.head_oid, remote);
	assert.equal(resumed.health_fast_forward_intent, undefined);
	assert.equal(resumed.health?.status, "triaging");
	assert.equal(merges, 1);
});

test("health blocks an ambiguous crashed PR fast-forward", async (t) => {
	const project = await makeProject(t);
	const base = combinedRunner(fakeHerdr(), fakeGh(project.root));
	let crash = true;
	let merges = 0;
	const runner: CommandRunner = async (command, args, options) => {
		const result = await base(command, args, options);
		if (command === "git" && args[0] === "merge" && args[1] === "--ff-only") {
			merges += 1;
			if (crash) {
				crash = false;
				throw new Error("simulated process exit after PR fast-forward");
			}
		}
		return result;
	};
	const lifecycle = makeLifecycle(runner);
	await finishInitialRun(project.root, lifecycle);
	await advanceRemote(t, project.remote);
	await assert.rejects(lifecycle.health(project.root, RUN_ID), /simulated process exit/);
	await commit(project.root, "external.txt", "external\n", "unexpected local head");

	await assert.rejects(makeLifecycle(runner).health(project.root, RUN_ID), /PR-health fast-forward recovery failed/);
	const blocked = await lifecycle.status(project.root, RUN_ID);
	assert.equal(blocked?.phase, "blocked");
	assert.match(typeof blocked?.block_reason === "string" ? blocked.block_reason : "", /did not leave the exact intended integration HEAD/);
	assert.equal(merges, 1);
});

test("health recovers a crashed repair pick and persists post-push cleanup before retrying it", async (t) => {
	const project = await makeProject(t);
	const herdr = fakeHerdr();
	const gh = fakeGh(project.root);
	const base = combinedRunner(herdr, gh);
	let crash = true;
	let failCleanup = false;
	let picks = 0;
	const lifecycle = makeLifecycle(async (command, args, options) => {
		if (command === "herdr" && args[0] === "tab" && args[1] === "close" && failCleanup) {
			failCleanup = false;
			return { code: 1, stdout: "", stderr: "simulated cleanup failure" };
		}
		const result = await base(command, args, options);
		if (command === "git" && args[0] === "cherry-pick" && args[1] === "-x") {
			picks += 1;
			if (picks === 2 && crash) {
				crash = false;
				throw new Error("simulated crash after health repair cherry-pick");
			}
		}
		return result;
	});
	let state = await finishInitialRun(project.root, lifecycle);
	const pushes = gh.gitPushes;

	state = await lifecycle.health(project.root, RUN_ID);
	state = await lifecycle.health(project.root, RUN_ID, healthEvent(state, {
		summary: "Repair one thread.", actionable: true, thread_ids: ["THREAD-1"], checks: [],
	}));
	const repair = await commit(state.health!.worktree!, "health.txt", "healthy\n", "health repair");
	state = await lifecycle.health(project.root, RUN_ID, requestReviewEvent(state, "final-check", repair));
	await assert.rejects(lifecycle.health(project.root, RUN_ID, healthReviewEvent(state, "approved", [], ["THREAD-1"])), /simulated crash/);
	const stuck = await lifecycle.status(project.root, RUN_ID);
	assert.equal(stuck?.health?.status, "applying");
	assert.equal(stuck?.health?.integration_intent, repair);

	state = await lifecycle.health(project.root, RUN_ID);
	assert.equal(state.health?.status, "completed");
	assert.equal(gh.gitPushes, pushes + 1);

	state = await lifecycle.health(project.root, RUN_ID);
	failCleanup = true;
	state = await lifecycle.health(project.root, RUN_ID, healthEvent(state, {
		summary: "Repair one thread again.", actionable: true, thread_ids: ["THREAD-2"], checks: [],
	}));
	const second = await commit(state.health!.worktree!, "health-2.txt", "healthy\n", "health repair 2");
	state = await lifecycle.health(project.root, RUN_ID, requestReviewEvent(state, "final-check", second));
	await assert.rejects(lifecycle.health(project.root, RUN_ID, healthReviewEvent(state, "approved", [], ["THREAD-2"])), /simulated cleanup failure/);
	const failed = await lifecycle.status(project.root, RUN_ID);
	assert.equal(failed?.health?.status, "post_push_cleanup");
	const pushed = gh.gitPushes;
	state = await lifecycle.health(project.root, RUN_ID);
	assert.equal(state.health?.status, "completed");
	assert.equal(gh.gitPushes, pushed);
});

async function finishInitialRun(root: string, lifecycle: CoreLifecycle): Promise<RunState> {
	let state = await advanceToFinalReview(root, lifecycle);
	state = await lifecycle.resume(root, reviewEvent(state, "final-check", "approved", []));
	return state;
}

async function advanceToFinalReview(root: string, lifecycle: CoreLifecycle): Promise<RunState> {
	let state = await lifecycle.start(root, "main-pane");
	const implementation = await commit(state.tasks.alpha.worktree!, "alpha.txt", "alpha\n", "alpha");
	state = await lifecycle.resume(root, requestReviewEvent(state, "alpha", implementation));
	state = await lifecycle.resume(root, reviewEvent(state, "alpha", "approved", []));
	assert.equal(state.tasks["final-check"].status, "reviewing");
	return state;
}

function makeLifecycle(runner: CommandRunner): CoreLifecycle {
	return createCoreLifecycle({
		runner,
		uuid: () => RUN_ID,
		now: () => "2026-08-09T00:00:00.000Z",
	});
}

function graph() {
	return {
		version: 1,
		status: "approved",
		id: "pr-lifecycle-test",
		title: "PR lifecycle test",
		goal: "Exercise final checks and retained PR health.",
		constraints: ["local"],
		issues: [
			{
				id: "alpha",
				title: "Alpha",
				role: "implementation",
				profile: "backend",
				purpose: "Implement alpha.",
				acceptance: ["alpha works"],
				testing: "npm test -- alpha",
				blocked_by: [],
			},
			{
				id: "final-check",
				title: "Final check",
				role: "final_check",
				profile: null,
				purpose: "Verify the integrated delivery.",
				acceptance: ["verified"],
				testing: "npm test -- final-check",
				blocked_by: ["alpha"],
			},
		],
	};
}

async function makeProject(t: TestContext): Promise<{ root: string; remote: string }> {
	const root = await mkdtemp(join(tmpdir(), "pi-auto-dag-pr-lifecycle-"));
	t.after(async () => { await rm(root, { recursive: true, force: true }); });
	await git(root, "init", "-b", "main");
	await git(root, "config", "user.email", "test@example.com");
	await git(root, "config", "user.name", "Test User");
	const profiles: Record<string, string> = {};
	for (const name of ["coder", "backend", "frontend", "reviewer"]) {
		profiles[name] = join(root, "profiles", name);
		await mkdir(profiles[name], { recursive: true });
	}
	const agentDir = await mkdtemp(join(tmpdir(), "pi-auto-dag-agent-"));
	t.after(async () => { await rm(agentDir, { recursive: true, force: true }); });
	await mkdir(join(agentDir, "config"), { recursive: true });
	await writeFile(join(agentDir, "config", "pi-auto-dag.json"), JSON.stringify({ version: 1, profiles, max_parallel_tasks: 1, max_review_rounds: 2 }));
	useAgentDir(t, agentDir);
	await writeFile(join(root, ".gitignore"), ".context/\n");
	await writeFile(join(root, "conflict.txt"), "base\n");
	await git(root, "add", ".");
	await git(root, "commit", "-m", "initial");
	const remote = await mkdtemp(join(tmpdir(), "pi-auto-dag-pr-origin-"));
	t.after(async () => { await rm(remote, { recursive: true, force: true }); });
	await git(root, "init", "--bare", remote);
	await git(root, "remote", "add", "origin", remote);
	await git(root, "push", "-u", "origin", "main");
	await git(root, "checkout", "-b", "dag");
	await mkdir(join(root, ".context", "issues"), { recursive: true });
	await writeFile(join(root, ".context", "issues", "graph.json"), JSON.stringify(graph()));
	return { root, remote };
}

function useAgentDir(t: TestContext, agentDir: string): void {
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	t.after(() => {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
	});
}

function reviewEvent(
	state: RunState,
	issueId: string,
	verdict: "approved" | "changes_requested" | "blocked",
	findings: string[],
	fixedThreadIds?: string[],
): string {
	const task = state.tasks[issueId];
	const command = state.graph.issues.find((issue) => issue.id === issueId)?.testing;
	if (!command) throw new Error(`Missing frozen command for ${issueId}`);
	return event(state, issueId, "reviewer", "submit_review", {
		commit: task.commit,
		attempt: task.attempts,
		review_round: task.review_rounds,
		command,
		exit_code: 0,
		verdict,
		findings,
		...(fixedThreadIds ? { fixed_thread_ids: fixedThreadIds } : {}),
	});
}

function requestReviewEvent(state: RunState, issueId: string, commit: string): string {
	const task = state.tasks[issueId];
	const health = state.health;
	return event(state, issueId, "implementer", "request_review", {
		commit,
		attempt: health?.status === "repairing" ? health.attempt : task.attempts,
		review_round: health?.status === "repairing" ? (health.review_round ?? 0) + 1 : (task.review_rounds ?? 0) + 1,
	});
}

function healthEvent(state: RunState, payload: Record<string, unknown>): string {
	const health = state.health!;
	return event(state, "final-check", "reviewer", "submit_health", {
		attempt: health.attempt,
		review_round: health.review_round,
		...payload,
	});
}

function healthReviewEvent(
	state: RunState,
	verdict: "approved" | "changes_requested" | "blocked",
	findings: string[],
	fixedThreadIds: string[],
): string {
	const health = state.health!;
	return event(state, "final-check", "reviewer", "submit_review", {
		commit: health.commit,
		attempt: health.attempt,
		review_round: health.review_round,
		command: state.graph.issues.find((issue) => issue.id === "final-check")!.testing,
		exit_code: 0,
		verdict,
		findings,
		fixed_thread_ids: fixedThreadIds,
	});
}

function event(state: RunState, issueId: string, role: "implementer" | "reviewer", type: string, payload: Record<string, unknown>): string {
	return JSON.stringify({ version: 1, type, run_id: state.run_id, issue_id: issueId, role, payload });
}

async function commit(cwd: string, file: string, content: string, subject: string): Promise<string> {
	await writeFile(join(cwd, file), content);
	await git(cwd, "add", file);
	await git(cwd, "commit", "-m", subject);
	return await git(cwd, "rev-parse", "HEAD");
}

async function advanceRemote(t: TestContext, remote: string): Promise<void> {
	const clone = await mkdtemp(join(tmpdir(), "pi-auto-dag-pr-advance-"));
	t.after(async () => { await rm(clone, { recursive: true, force: true }); });
	await execFile("git", ["clone", remote, clone]);
	await git(clone, "config", "user.email", "test@example.com");
	await git(clone, "config", "user.name", "Test User");
	await git(clone, "checkout", "dag");
	await commit(clone, "remote.txt", "remote\n", "advance PR head");
	await git(clone, "push", "origin", "dag");
}

async function advanceRemoteConfig(t: TestContext, remote: string): Promise<void> {
	const clone = await mkdtemp(join(tmpdir(), "pi-auto-dag-pr-config-"));
	t.after(async () => { await rm(clone, { recursive: true, force: true }); });
	await execFile("git", ["clone", remote, clone]);
	await git(clone, "config", "user.email", "test@example.com");
	await git(clone, "config", "user.name", "Test User");
	await git(clone, "checkout", "dag");
	await writeFile(join(clone, "repository-change.txt"), "changed\n");
	await git(clone, "add", "repository-change.txt");
	await git(clone, "commit", "-m", "change repository");
	await git(clone, "push", "origin", "dag");
}

function combinedRunner(herdr: ReturnType<typeof fakeHerdr>, gh: ReturnType<typeof fakeGh>): CommandRunner {
	return async (command, args, options) => {
		if (command === "herdr") return await herdr.runner(command, args, options);
		if (command === "gh") return await gh.runner(command, args);
		if (command === "git" && args[0] === "push") gh.gitPushes += 1;
		return await runCommand(command, args, options);
	};
}

function fakeGh(root: string, input: { base?: string } = {}) {
	let pr: { number: number; url: string; headRefName: string; baseRefName: string; body: string } | undefined = input.base
		? { number: 42, url: "https://example.test/pr/42", headRefName: "dag", baseRefName: input.base, body: "existing" }
		: undefined;
	const calls: string[][] = [];
	const resolved: string[] = [];
	const result = {
		calls,
		resolved,
		gitPushes: 0,
		get pr() { return pr; },
		count(action: string) { return calls.filter((args) => args.slice(0, 2).join(" ") === action).length; },
		async runner(_command: string, arguments_: readonly string[]) {
			const args = [...arguments_];
			calls.push(args);
			const oid = await remoteHead(root, pr?.headRefName ?? "dag");
			if (args.slice(0, 2).join(" ") === "pr list") {
				return success(pr ? [{ ...pr, headRefOid: oid }] : []);
			}
			if (args.slice(0, 2).join(" ") === "pr create") {
				pr ??= {
					number: 42,
					url: "https://example.test/pr/42",
					headRefName: args[args.indexOf("--head") + 1],
					baseRefName: args[args.indexOf("--base") + 1],
					body: args[args.indexOf("--body") + 1],
				};
				return { code: 0, stdout: `${pr.url}\n`, stderr: "" };
			}
			if (args.slice(0, 2).join(" ") === "pr view") {
				if (!pr) return { code: 1, stdout: "", stderr: "PR not found" };
				return success({ ...pr, headRefOid: oid, state: "OPEN" });
			}
			if (args.slice(0, 2).join(" ") === "api graphql") {
				resolved.push(args.find((arg) => arg.startsWith("threadId="))?.slice("threadId=".length) ?? "");
				return success({ data: { resolveReviewThread: { thread: { isResolved: true } } } });
			}
			return { code: 1, stdout: "", stderr: `Unexpected gh command: ${args.join(" ")}` };
		},
	};
	return result;
}

function success(value: unknown) {
	return { code: 0, stdout: JSON.stringify(value), stderr: "" };
}

async function git(cwd: string, ...args: string[]): Promise<string> {
	return (await execFile("git", args, { cwd })).stdout.trim();
}

async function remoteHead(root: string, branch: string): Promise<string> {
	try {
		const remote = await git(root, "ls-remote", "origin", `refs/heads/${branch}`);
		if (remote) return remote.split(/\s+/)[0];
	} catch {
		// The branch may not exist until the initial push.
	}
	return await git(root, "rev-parse", "HEAD");
}
