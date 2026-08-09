import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { fakeHerdr } from "./support/fake-herdr.ts";
import { type CommandRunner } from "../src/command.ts";
import { startLocalRun } from "../src/intake.ts";
import { createCoreLifecycle, type CoreLifecycle } from "../src/lifecycle.ts";
import { type LocalIssue, type RunState } from "../src/model.ts";
import { childWorktreePath, parseWorkerEnvelope } from "../src/orchestration.ts";
import { writeRunState } from "../src/state.ts";

const execFile = promisify(execFileCallback);
const RUN_ID = "22222222-2222-4222-8222-222222222222";

test("resume rejects a recorded task tab from another workspace", async (t) => {
	const project = await makeProject(t, graph(["alpha"]), 1, 1);
	const herdr = fakeHerdr();
	const lifecycle = makeLifecycle(herdr.runner);
	const state = await lifecycle.start(project.root, "main-pane");
	const tab = herdr.tabs.get(state.tasks.alpha.tab_id!);
	assert.ok(tab);
	tab.workspace_id = "wrong-workspace";

	await assert.rejects(lifecycle.resume(project.root), /expected initiating workspace main-workspace/);
});

test("resume rejects a recorded reviewer pane from another workspace", async (t) => {
	const project = await makeProject(t, graph(["alpha"]), 1, 1);
	const herdr = fakeHerdr();
	const lifecycle = makeLifecycle(herdr.runner);
	let state = await lifecycle.start(project.root, "main-pane");
	const commit = await commitTask(state, "alpha", "alpha.txt", "alpha\n", "alpha");
	state = await lifecycle.resume(project.root, requestReviewEvent(state, "alpha", commit));
	const tab = herdr.tabs.get(state.tasks.alpha.tab_id!);
	assert.ok(tab);
	tab.workspace_id = "wrong-workspace";

	await assert.rejects(lifecycle.resume(project.root), /expected initiating workspace main-workspace/);
});

test("orchestration freezes a wave, refills slots, reviews once per pane, and integrates lexically", async (t) => {
	const project = await makeProject(t, graph(["alpha", "beta", "gamma"]), 1, 2);
	const herdr = fakeHerdr();
	const lifecycle = makeLifecycle(herdr.runner);
	let state = await lifecycle.start(project.root, "main-pane");

	assert.deepEqual(state.wave?.issue_ids, ["alpha", "beta"]);
	assert.equal(state.tasks.alpha.status, "implementing");
	assert.equal(state.tasks.alpha.activity_started_at, "2026-08-09T00:00:00.000Z");
	assert.equal(state.tasks.beta.status, "pending");
	assert.equal(state.tasks["final-check"].status, "pending");
	assert.equal(state.tasks.alpha.worktree, childWorktreePath(project.root, RUN_ID, "alpha"));
	await assert.rejects(readFile(join(state.tasks.alpha.worktree!, ".context")), /ENOENT/);

	const alpha = await commitTask(state, "alpha", "alpha.txt", "alpha\n", "alpha");
	const tabReads = herdr.count("tab list");
	const paneReads = herdr.count("pane list");
	state = await lifecycle.resume(project.root, requestReviewEvent(state, "alpha", alpha));
	assert.equal(herdr.count("tab list"), tabReads + 1);
	assert.equal(herdr.count("pane list"), paneReads + 1);
	assert.equal(state.tasks.alpha.status, "reviewing");
	assert.equal(state.tasks.alpha.activity_started_at, "2026-08-09T00:00:00.000Z");
	assert.match(reviewPrompts(herdr).at(-1)!, /npm test -- alpha/);
	assert.equal(herdr.count("pane split"), 1);

	state = await lifecycle.resume(project.root, reviewEvent(state, "alpha", "approved", []));
	assert.equal(state.tasks.alpha.status, "approved");
	assert.equal(state.tasks.beta.status, "implementing");
	await assert.rejects(readFile(join(project.root, "alpha.txt")), /ENOENT/);

	const beta = await commitTask(state, "beta", "beta.txt", "beta\n", "beta");
	state = await lifecycle.resume(project.root, requestReviewEvent(state, "beta", beta));
	state = await lifecycle.resume(project.root, reviewEvent(state, "beta", "approved", []));
	assert.equal(state.tasks.alpha.status, "completed");
	assert.equal(state.tasks.beta.status, "completed");
	assert.equal(state.tasks.gamma.status, "implementing");
	assert.deepEqual((await git(project.root, "log", "--format=%s", "-2")).split("\n"), ["beta", "alpha"]);

	const gamma = await commitTask(state, "gamma", "gamma.txt", "first\n", "gamma first");
	state = await lifecycle.resume(project.root, requestReviewEvent(state, "gamma", gamma));
	const reviewerPane = state.tasks.gamma.reviewer_pane;
	state = await lifecycle.resume(project.root, reviewEvent(state, "gamma", "changes_requested", ["rename it"]));
	assert.equal(state.tasks.gamma.status, "implementing");
	await writeFile(join(state.tasks.gamma.worktree!, "gamma.txt"), "second\n");
	await git(state.tasks.gamma.worktree!, "add", "gamma.txt");
	await git(state.tasks.gamma.worktree!, "commit", "--amend", "-m", "gamma amended");
	const amended = await git(state.tasks.gamma.worktree!, "rev-parse", "HEAD");
	state = await lifecycle.resume(project.root, requestReviewEvent(state, "gamma", amended));
	assert.equal(state.tasks.gamma.reviewer_pane, reviewerPane);
	assert.equal(state.tasks.gamma.review_rounds, 2);
	assert.equal(herdr.count("pane split"), 3);
	state = await lifecycle.resume(project.root, reviewEvent(state, "gamma", "approved", []));

	assert.deepEqual(Object.fromEntries(["alpha", "beta", "gamma"].map((id) => [id, state.tasks[id].status])), {
		alpha: "completed", beta: "completed", gamma: "completed",
	});
	assert.equal(state.tasks["final-check"].status, "reviewing");
	assert.equal(herdr.count("tab create"), 4);
	const creates = herdr.calls.filter((call) => call.command === "herdr" && call.args.slice(0, 2).join(" ") === "tab create");
	assert.ok(creates.every(({ args }) => args[args.indexOf("--workspace") + 1] === "main-workspace"));
	assert.equal(herdr.calls.some((call) => call.command !== "git" && call.command !== "herdr"), false);
});

test("wave completion rechecks local inputs before dispatching the next wave", async (t) => {
	const deliveryGraph = graph(["alpha", "beta", "gamma"]);
	const project = await makeProject(t, deliveryGraph, 2, 1);
	const herdr = fakeHerdr();
	let cherryPicks = 0;
	const runner: CommandRunner = async (command, arguments_, options) => {
		const result = await herdr.runner(command, arguments_, options);
		if (command === "git" && arguments_[0] === "cherry-pick" && arguments_[1] === "-x" && result.code === 0 && ++cherryPicks === 2) {
			await writeFile(join(project.root, ".context", "issues", "graph.json"), JSON.stringify({ ...deliveryGraph, title: "changed" }));
		}
		return result;
	};
	const lifecycle = makeLifecycle(runner);
	let state = await lifecycle.start(project.root, "main-pane");
	const alpha = await commitTask(state, "alpha", "alpha.txt", "alpha\n", "alpha");
	const beta = await commitTask(state, "beta", "beta.txt", "beta\n", "beta");
	state = await lifecycle.resume(project.root, requestReviewEvent(state, "alpha", alpha));
	state = await lifecycle.resume(project.root, requestReviewEvent(state, "beta", beta));
	state = await lifecycle.resume(project.root, reviewEvent(state, "alpha", "approved", []));
	await assert.rejects(lifecycle.resume(project.root, reviewEvent(state, "beta", "approved", [])), /Delivery Graph changed during the run/);

	const blocked = await lifecycle.status(project.root, RUN_ID);
	assert.equal(blocked?.phase, "blocked");
	assert.equal(blocked?.tasks.gamma.status, "pending");
	assert.equal(herdr.count("agent start"), 4);
});

test("a clean integration-head drift blocks resume before worker dispatch", async (t) => {
	const project = await makeProject(t, graph(["alpha"]), 1, 1);
	const herdr = fakeHerdr();
	const lifecycle = makeLifecycle(herdr.runner);
	await lifecycle.start(project.root, "main-pane");
	herdr.live.clear();
	const starts = herdr.count("agent start");
	await writeFile(join(project.root, "outside.txt"), "outside\n");
	await git(project.root, "add", "outside.txt");
	await git(project.root, "commit", "-m", "outside");

	await assert.rejects(lifecycle.resume(project.root), /Main integration HEAD changed/);
	const blocked = await lifecycle.status(project.root, RUN_ID);
	assert.equal(blocked?.phase, "blocked");
	assert.equal(herdr.count("agent start"), starts);
});

test("integration rechecks the expected head after review before cherry-picking", async (t) => {
	const project = await makeProject(t, graph(["alpha"]), 1, 1);
	const herdr = fakeHerdr();
	let injectDrift = false;
	let cherryPicks = 0;
	const runner: CommandRunner = async (command, arguments_, options) => {
		const result = await herdr.runner(command, arguments_, options);
		if (injectDrift && command === "git" && arguments_[0] === "rev-list" && arguments_[1] === "--count" && options.cwd === project.root) {
			injectDrift = false;
			await writeFile(join(project.root, "outside.txt"), "outside\n");
			await git(project.root, "add", "outside.txt");
			await git(project.root, "commit", "-m", "outside");
		}
		if (command === "git" && arguments_[0] === "cherry-pick" && arguments_[1] === "-x") cherryPicks += 1;
		return result;
	};
	const lifecycle = makeLifecycle(runner);
	let state = await lifecycle.start(project.root, "main-pane");
	const commit = await commitTask(state, "alpha", "alpha.txt", "alpha\n", "alpha");
	state = await lifecycle.resume(project.root, requestReviewEvent(state, "alpha", commit));
	injectDrift = true;

	await assert.rejects(lifecycle.resume(project.root, reviewEvent(state, "alpha", "approved", [])), /Main integration HEAD changed/);
	assert.equal(cherryPicks, 0);
});

test("a commit after cherry-pick is not recorded as the integration head", async (t) => {
	const project = await makeProject(t, graph(["alpha"]), 1, 1);
	const herdr = fakeHerdr();
	let workerCommit = "";
	const runner: CommandRunner = async (command, arguments_, options) => {
		const result = await herdr.runner(command, arguments_, options);
		if (command === "git" && arguments_[0] === "cherry-pick" && arguments_[1] === "-x" && result.code === 0) {
			await writeFile(join(project.root, "outside.txt"), "outside\n");
			await git(project.root, "add", "outside.txt");
			await git(project.root, "commit", "-m", `outside\n\n(cherry picked from commit ${workerCommit})`);
		}
		return result;
	};
	const lifecycle = makeLifecycle(runner);
	let state = await lifecycle.start(project.root, "main-pane");
	const expectedHead = state.integration_head;
	const commit = await commitTask(state, "alpha", "alpha.txt", "alpha\n", "alpha");
	workerCommit = commit;
	state = await lifecycle.resume(project.root, requestReviewEvent(state, "alpha", commit));

	await assert.rejects(lifecycle.resume(project.root, reviewEvent(state, "alpha", "approved", [])), /Main integration HEAD changed while applying/);
	const blocked = await lifecycle.status(project.root, RUN_ID);
	assert.equal(blocked?.integration_head, expectedHead);
	assert.notEqual(blocked?.integration_head, await git(project.root, "rev-parse", "HEAD"));
});

test("integration revalidates approved work before recording its intent", async (t) => {
	const project = await makeProject(t, graph(["alpha", "beta"]), 2, 1);
	const herdr = fakeHerdr();
	let cherryPicks = 0;
	const runner: CommandRunner = async (command, arguments_, options) => {
		if (command === "git" && arguments_[0] === "cherry-pick" && arguments_[1] === "-x") cherryPicks += 1;
		return await herdr.runner(command, arguments_, options);
	};
	const lifecycle = makeLifecycle(runner);
	let state = await lifecycle.start(project.root, "main-pane");
	const alpha = await commitTask(state, "alpha", "alpha.txt", "alpha\n", "alpha");
	const beta = await commitTask(state, "beta", "beta.txt", "beta\n", "beta");
	state = await lifecycle.resume(project.root, requestReviewEvent(state, "alpha", alpha));
	state = await lifecycle.resume(project.root, requestReviewEvent(state, "beta", beta));
	state = await lifecycle.resume(project.root, reviewEvent(state, "alpha", "approved", []));
	await writeFile(join(state.tasks.alpha.worktree!, "late.txt"), "late\n");
	await git(state.tasks.alpha.worktree!, "add", "late.txt");
	await git(state.tasks.alpha.worktree!, "commit", "-m", "late");

	state = await lifecycle.resume(project.root, reviewEvent(state, "beta", "approved", []));
	assert.equal(state.phase, "blocked");
	assert.equal(state.tasks.alpha.status, "approved");
	assert.equal(state.tasks.alpha.integration_intent, undefined);
	assert.equal(cherryPicks, 0);
	assert.equal(await readFile(join(state.tasks.alpha.worktree!, "late.txt"), "utf8"), "late\n");
	await assert.rejects(readFile(join(project.root, "alpha.txt")), /ENOENT/);
});

test("initial state records the main pane before startup can be resumed", async (t) => {
	const project = await makeProject(t, graph(["alpha"]), 1, 1);
	const herdr = fakeHerdr();
	const state = await startLocalRun({
		mainWorktree: project.root,
		runner: herdr.runner,
		uuid: () => RUN_ID,
		now: () => "2026-08-09T00:00:00.000Z",
		mainPane: "main-pane",
		workspaceId: "main-workspace",
	});
	assert.equal(state.main_pane, "main-pane");
	assert.equal(state.workspace_id, "main-workspace");
	assert.equal((await readFile(join(project.root, ".context", "pi-auto-dag", "runs", RUN_ID, "state.json"), "utf8")).includes('"main_pane": "main-pane"'), true);

	const recovered = await makeLifecycle(herdr.runner).resume(project.root);
	assert.equal(recovered.main_pane, "main-pane");
	assert.equal(recovered.tasks.alpha.status, "implementing");
});

test("a cherry-pick conflict resets the same task and keeps its implementer and reviewer", async (t) => {
	const project = await makeProject(t, graph(["alpha", "beta"]), 2, 3, "base\n");
	const herdr = fakeHerdr();
	const lifecycle = makeLifecycle(herdr.runner);
	let state = await lifecycle.start(project.root, "main-pane");
	const originalImplementer = state.tasks.beta.implementer_agent;

	const alpha = await commitTask(state, "alpha", "shared.txt", "alpha\n", "alpha");
	const beta = await commitTask(state, "beta", "shared.txt", "beta\n", "beta");
	state = await lifecycle.resume(project.root, requestReviewEvent(state, "alpha", alpha));
	state = await lifecycle.resume(project.root, requestReviewEvent(state, "beta", beta));
	const originalReviewer = state.tasks.beta.reviewer_agent;
	state = await lifecycle.resume(project.root, reviewEvent(state, "alpha", "approved", []));
	state = await lifecycle.resume(project.root, reviewEvent(state, "beta", "approved", []));

	assert.equal(state.tasks.alpha.status, "completed");
	assert.equal(state.tasks.beta.status, "implementing");
	assert.equal(state.tasks.beta.attempts, 2);
	assert.equal(state.tasks.beta.implementer_agent, originalImplementer);
	assert.equal(state.tasks.beta.reviewer_agent, originalReviewer);
	assert.equal(await readFile(join(project.root, "shared.txt"), "utf8"), "alpha\n");
	assert.equal(await git(project.root, "status", "--porcelain"), "");
	assert.equal(herdr.count("tab create"), 2);
	assert.equal(herdr.count("pane split"), 2);
	herdr.live.delete(originalImplementer!);
	state = await lifecycle.resume(project.root);
	assert.match(JSON.parse(implementerPrompts(herdr).at(-1)!).instruction, /previous commit conflicted/);

	const replacement = await commitTask(state, "beta", "beta.txt", "replacement\n", "beta replacement");
	state = await lifecycle.resume(project.root, requestReviewEvent(state, "beta", replacement));
	assert.equal(herdr.count("pane split"), 2);
	state = await lifecycle.resume(project.root, reviewEvent(state, "beta", "approved", []));
	assert.equal(state.tasks.beta.status, "completed");
	assert.equal(await readFile(join(project.root, "beta.txt"), "utf8"), "replacement\n");
});

test("resume restarts a missing role in its recorded pane and retries cleanup blocks", async (t) => {
	const project = await makeProject(t, graph(["alpha"]), 1, 1);
	const herdr = fakeHerdr({ fail_tab_close: 1 });
	const lifecycle = makeLifecycle(herdr.runner);
	let state = await lifecycle.start(project.root, "main-pane");
	const worktree = state.tasks.alpha.worktree!;

	herdr.live.clear();
	state = await lifecycle.resume(project.root);
	assert.equal(state.tasks.alpha.status, "implementing");
	assert.equal(herdr.count("tab create"), 1);
	assert.equal(herdr.count("agent start"), 2);

	const commit = await commitTask(state, "alpha", "alpha.txt", "alpha\n", "alpha");
	state = await lifecycle.resume(project.root, requestReviewEvent(state, "alpha", commit));
	state = await lifecycle.resume(project.root, reviewEvent(state, "alpha", "approved", []));
	assert.equal(state.phase, "blocked");
	assert.equal(state.cleanup_blocks?.[0]?.operation, "tab");

	state = await lifecycle.resume(project.root);
	assert.equal(state.cleanup_blocks, undefined);
	assert.equal(state.tasks.alpha.tab_cleanup_done, true);
	assert.equal(state.tasks.alpha.worktree_cleanup_done, true);
	assert.equal(herdr.count("tab close"), 2);
	await assert.rejects(readFile(worktree), /ENOENT/);
});

test("cleanup retains a completed child changed after review", async (t) => {
	const project = await makeProject(t, graph(["alpha"]), 1, 1);
	const herdr = fakeHerdr({ fail_tab_close: 1 });
	const lifecycle = makeLifecycle(herdr.runner);
	let state = await lifecycle.start(project.root, "main-pane");
	const reviewed = await commitTask(state, "alpha", "alpha.txt", "alpha\n", "alpha");
	state = await lifecycle.resume(project.root, requestReviewEvent(state, "alpha", reviewed));
	state = await lifecycle.resume(project.root, reviewEvent(state, "alpha", "approved", []));
	assert.equal(state.tasks.alpha.status, "completed");
	assert.equal(state.cleanup_blocks?.[0]?.operation, "tab");
	const { branch, worktree } = state.tasks.alpha;
	await commitTask(state, "alpha", "late.txt", "late\n", "late worker commit");

	state = await lifecycle.resume(project.root);
	assert.equal(state.phase, "blocked");
	assert.equal(state.cleanup_blocks?.[0]?.operation, "worktree");
	assert.equal(state.tasks.alpha.tab_cleanup_done, true);
	assert.equal(state.tasks.alpha.worktree_cleanup_done, undefined);
	assert.equal(state.tasks.alpha.branch_cleanup_done, undefined);
	assert.match(await git(project.root, "branch", "--list", branch!), new RegExp(`${branch}$`));
	assert.equal(await readFile(join(worktree!, "late.txt"), "utf8"), "late\n");
});

test("cleanup does not delete a completed branch moved after its worktree is gone", async (t) => {
	const project = await makeProject(t, graph(["alpha"]), 1, 1);
	const herdr = fakeHerdr();
	let failBranchDelete = true;
	let branchDeletes = 0;
	const runner: CommandRunner = async (command, arguments_, options) => {
		if (command === "git" && arguments_[0] === "branch" && arguments_[1] === "-D") {
			branchDeletes += 1;
			if (failBranchDelete) {
				failBranchDelete = false;
				return { code: 1, stdout: "", stderr: "simulated branch-delete crash" };
			}
		}
		return await herdr.runner(command, arguments_, options);
	};
	const lifecycle = makeLifecycle(runner);
	let state = await lifecycle.start(project.root, "main-pane");
	const reviewed = await commitTask(state, "alpha", "alpha.txt", "alpha\n", "alpha");
	state = await lifecycle.resume(project.root, requestReviewEvent(state, "alpha", reviewed));
	state = await lifecycle.resume(project.root, reviewEvent(state, "alpha", "approved", []));
	assert.equal(state.cleanup_blocks?.[0]?.operation, "branch");
	assert.equal(state.tasks.alpha.worktree_cleanup_done, true);
	await git(project.root, "branch", "-f", state.tasks.alpha.branch!, state.source_commit);

	state = await lifecycle.resume(project.root);
	assert.equal(state.cleanup_blocks?.[0]?.operation, "branch");
	assert.match(String(state.cleanup_blocks?.[0]?.reason), /no longer points to its reviewed commit/);
	assert.equal(branchDeletes, 1);
	assert.equal(await git(project.root, "rev-parse", state.tasks.alpha.branch!), state.source_commit);
});

test("a worker block does not reconcile unrelated workers", async (t) => {
	const project = await makeProject(t, graph(["alpha", "beta"]), 2, 2);
	const herdr = fakeHerdr();
	const lifecycle = makeLifecycle(herdr.runner);
	const state = await lifecycle.start(project.root, "main-pane");

	herdr.live.clear();
	const starts = herdr.count("agent start");
	const prompts = herdr.count("agent prompt");
	const gets = herdr.count("agent get");
	const blocked = await lifecycle.resume(project.root, blockTaskEvent(state, "alpha", "implementer", "needs input"));
	assert.equal(blocked.tasks.alpha.status, "blocked");
	assert.equal(blocked.tasks.beta.status, "implementing");
	assert.equal(herdr.count("agent start"), starts);
	assert.equal(herdr.count("agent prompt"), prompts);
	assert.equal(herdr.count("agent get"), gets);
});

test("resume refuses a switched child branch before worker restart or prompt", async (t) => {
	const project = await makeProject(t, graph(["alpha"]), 1, 1);
	const herdr = fakeHerdr();
	const lifecycle = makeLifecycle(herdr.runner);
	const state = await lifecycle.start(project.root, "main-pane");
	herdr.live.clear();
	const starts = herdr.count("agent start");
	const prompts = herdr.count("agent prompt");
	await git(state.tasks.alpha.worktree!, "checkout", "-b", "wrong-worker-branch");

	await assert.rejects(lifecycle.resume(project.root), /child worktree branch changed/);
	assert.equal(herdr.count("agent start"), starts);
	assert.equal(herdr.count("agent prompt"), prompts);
});

test("resume refuses a switched reviewer branch before reviewer restart or prompt", async (t) => {
	const project = await makeProject(t, graph(["alpha"]), 1, 1);
	const herdr = fakeHerdr();
	const lifecycle = makeLifecycle(herdr.runner);
	let state = await lifecycle.start(project.root, "main-pane");
	const commit = await commitTask(state, "alpha", "alpha.txt", "alpha\n", "alpha");
	state = await lifecycle.resume(project.root, requestReviewEvent(state, "alpha", commit));
	herdr.live.clear();
	const starts = herdr.count("agent start");
	const prompts = herdr.count("agent prompt");
	await git(state.tasks.alpha.worktree!, "checkout", "-b", "wrong-reviewer-branch");

	await assert.rejects(lifecycle.resume(project.root), /child worktree branch changed/);
	assert.equal(herdr.count("agent start"), starts);
	assert.equal(herdr.count("agent prompt"), prompts);
});

test("simultaneous worker envelopes preserve both durable updates", async (t) => {
	const project = await makeProject(t, graph(["alpha", "beta"]), 2, 1);
	const herdr = fakeHerdr();
	let holdBoundary = false;
	let entered!: () => void;
	let release!: () => void;
	const boundaryEntered = new Promise<void>((done) => { entered = done; });
	const boundaryReleased = new Promise<void>((done) => { release = done; });
	const runner: CommandRunner = async (command, arguments_, options) => {
		if (
			holdBoundary
			&& command === "git"
			&& arguments_.join(" ") === "status --porcelain=v1 --untracked-files=all"
			&& options.cwd === project.root
		) {
			holdBoundary = false;
			entered();
			await boundaryReleased;
		}
		return await herdr.runner(command, arguments_, options);
	};
	const lifecycle = makeLifecycle(runner);
	const started = await lifecycle.start(project.root, "main-pane");

	holdBoundary = true;
	const alpha = lifecycle.resume(project.root, blockTaskEvent(started, "alpha", "implementer", "alpha blocked"));
	await boundaryEntered;
	const beta = lifecycle.resume(project.root, blockTaskEvent(started, "beta", "implementer", "beta blocked"));
	release();
	await Promise.all([alpha, beta]);

	const state = await lifecycle.status(project.root, RUN_ID);
	assert.equal(state?.tasks.alpha.status, "blocked");
	assert.equal(state?.tasks.beta.status, "blocked");
});

test("task blocks defer review dispatch and explicit recovery until resolved", async (t) => {
	const project = await makeProject(t, graph(["alpha", "beta"]), 2, 2);
	const herdr = fakeHerdr();
	const lifecycle = makeLifecycle(herdr.runner);
	let state = await lifecycle.start(project.root, "main-pane");
	const beta = await commitTask(state, "beta", "beta.txt", "beta\n", "beta");
	state = await lifecycle.resume(project.root, blockTaskEvent(state, "alpha", "implementer", "need direction"));
	const starts = herdr.count("agent start");
	const prompts = herdr.count("agent prompt");

	state = await lifecycle.resume(project.root, requestReviewEvent(state, "beta", beta));
	assert.equal(state.tasks.beta.status, "reviewing");
	assert.equal(state.tasks.beta.reviewer_instruction_pending, true);
	assert.equal(herdr.count("agent start"), starts);
	assert.equal(herdr.count("agent prompt"), prompts);

	herdr.live.clear();
	state = await lifecycle.resume(project.root);
	assert.equal(state.tasks.beta.reviewer_instruction_pending, true);
	assert.equal(herdr.count("agent start"), starts);
	assert.equal(herdr.count("agent prompt"), prompts);

	state = await lifecycle.resolve(project.root, "alpha", "Proceed with alpha.");
	assert.equal(state.tasks.beta.reviewer_instruction_pending, undefined);
	assert.equal(herdr.count("agent start"), starts + 2);
	assert.match(JSON.parse(reviewPrompts(herdr).at(-1)!).instruction, /Independently verify/);
});

test("task blocks defer revision dispatch until resolved", async (t) => {
	const project = await makeProject(t, graph(["alpha", "beta"]), 2, 2);
	const herdr = fakeHerdr();
	const lifecycle = makeLifecycle(herdr.runner);
	let state = await lifecycle.start(project.root, "main-pane");
	const beta = await commitTask(state, "beta", "beta.txt", "beta\n", "beta");
	state = await lifecycle.resume(project.root, requestReviewEvent(state, "beta", beta));
	state = await lifecycle.resume(project.root, blockTaskEvent(state, "alpha", "implementer", "need direction"));
	const starts = herdr.count("agent start");
	const prompts = herdr.count("agent prompt");

	state = await lifecycle.resume(project.root, reviewEvent(state, "beta", "changes_requested", ["fix it"]));
	assert.equal(state.tasks.beta.status, "implementing");
	assert.equal(state.tasks.beta.implementer_instruction_pending, true);
	assert.equal(herdr.count("agent start"), starts);
	assert.equal(herdr.count("agent prompt"), prompts);

	state = await lifecycle.resume(project.root);
	assert.equal(herdr.count("agent start"), starts);
	assert.equal(herdr.count("agent prompt"), prompts);

	state = await lifecycle.resolve(project.root, "alpha", "Proceed with alpha.");
	const revision = JSON.parse(implementerPrompts(herdr).at(-1)!);
	assert.equal(state.tasks.beta.implementer_instruction_pending, undefined);
	assert.equal(herdr.count("agent start"), starts);
	assert.match(revision.instruction, /Address the reviewer findings/);
	assert.deepEqual(revision.review_findings, ["fix it"]);
});

test("resume redelivers a pending instruction to a worker live after a prompt failure", async (t) => {
	const project = await makeProject(t, graph(["alpha"]), 1, 1);
	const herdr = fakeHerdr({ fail_agent_prompt: 1 });
	const lifecycle = makeLifecycle(herdr.runner);
	let state = await lifecycle.start(project.root, "main-pane");
	assert.equal(state.phase, "blocked");
	assert.equal(state.tasks.alpha.status, "implementing");
	assert.equal(herdr.count("agent start"), 1);

	state = await lifecycle.resume(project.root);
	assert.equal(state.tasks.alpha.status, "implementing");
	assert.equal(herdr.count("agent start"), 1);
	assert.match(JSON.parse(implementerPrompts(herdr).at(-1)!).instruction, /Implement this frozen Local Issue/);
});

test("review verdicts bind the commit, attempt, and review round", async (t) => {
	const project = await makeProject(t, graph(["alpha"]), 1, 3);
	const herdr = fakeHerdr();
	const lifecycle = makeLifecycle(herdr.runner);
	let state = await lifecycle.start(project.root, "main-pane");
	const first = await commitTask(state, "alpha", "alpha.txt", "first\n", "first");
	state = await lifecycle.resume(project.root, requestReviewEvent(state, "alpha", first));
	state = await lifecycle.resume(project.root, reviewEvent(state, "alpha", "changes_requested", ["change it"]));
	await writeFile(join(state.tasks.alpha.worktree!, "alpha.txt"), "second\n");
	await git(state.tasks.alpha.worktree!, "add", "alpha.txt");
	await git(state.tasks.alpha.worktree!, "commit", "--amend", "-m", "second");
	const second = await git(state.tasks.alpha.worktree!, "rev-parse", "HEAD");
	state = await lifecycle.resume(project.root, requestReviewEvent(state, "alpha", second));

	for (const payload of [
		{ commit: first, attempt: state.tasks.alpha.attempts, review_round: state.tasks.alpha.review_rounds },
		{ commit: state.tasks.alpha.commit, attempt: state.tasks.alpha.attempts + 1, review_round: state.tasks.alpha.review_rounds },
		{ commit: state.tasks.alpha.commit, attempt: state.tasks.alpha.attempts, review_round: state.tasks.alpha.review_rounds! - 1 },
	]) {
		state = await lifecycle.resume(project.root, event("alpha", "reviewer", "submit_review", { ...payload, command: "npm test -- alpha", exit_code: 0, verdict: "approved", findings: [] }));
		assert.equal(state.tasks.alpha.status, "reviewing");
		assert.equal(state.tasks.alpha.commit, second);
		assert.equal(state.tasks.alpha.review_rounds, 2);
	}
	for (const verdict of ["changes_requested", "blocked"] as const) {
		assert.throws(() => parseWorkerEnvelope(JSON.parse(event("alpha", "reviewer", "submit_review", {
			commit: second,
			attempt: state.tasks.alpha.attempts,
			review_round: state.tasks.alpha.review_rounds,
			command: "npm test -- alpha",
			exit_code: 0,
			verdict,
			findings: [],
		}))), /Non-approval review verdict requires findings/);
	}
});

test("review verdicts persist frozen command evidence and reject nonzero approvals", async (t) => {
	const project = await makeProject(t, graph(["alpha"]), 1, 1);
	const herdr = fakeHerdr();
	const lifecycle = makeLifecycle(herdr.runner);
	let state = await lifecycle.start(project.root, "main-pane");
	const commit = await commitTask(state, "alpha", "alpha.txt", "alpha\n", "alpha");
	state = await lifecycle.resume(project.root, requestReviewEvent(state, "alpha", commit));
	state = await lifecycle.resume(project.root, reviewEvent(state, "alpha", "approved", [], 1));

	assert.equal(state.tasks.alpha.status, "blocked");
	assert.equal(state.tasks.alpha.review_command, "npm test -- alpha");
	assert.equal(state.tasks.alpha.review_commit, commit);
	assert.equal(state.tasks.alpha.review_exit_code, 1);
	assert.match(String(state.tasks.alpha.block_reason), /approval requires exit code 0/);
});

test("review verdicts reject a command other than the frozen command", async (t) => {
	const project = await makeProject(t, graph(["alpha"]), 1, 1);
	const herdr = fakeHerdr();
	const lifecycle = makeLifecycle(herdr.runner);
	let state = await lifecycle.start(project.root, "main-pane");
	const commit = await commitTask(state, "alpha", "alpha.txt", "alpha\n", "alpha");
	state = await lifecycle.resume(project.root, requestReviewEvent(state, "alpha", commit));
	state = await lifecycle.resume(project.root, reviewEvent(state, "alpha", "approved", [], 0, "npm test -- substituted"));

	assert.equal(state.tasks.alpha.status, "blocked");
	assert.equal(state.tasks.alpha.review_command, "npm test -- substituted");
	assert.match(String(state.tasks.alpha.block_reason), /frozen testing command/);
});

test("review revisions need a new SHA after changes requested", async (t) => {
	const project = await makeProject(t, graph(["alpha"]), 1, 3);
	const herdr = fakeHerdr();
	const lifecycle = makeLifecycle(herdr.runner);
	let state = await lifecycle.start(project.root, "main-pane");
	const first = await commitTask(state, "alpha", "alpha.txt", "first\n", "first");
	const stale = requestReviewEvent(state, "alpha", first);
	state = await lifecycle.resume(project.root, stale);
	state = await lifecycle.resume(project.root, reviewEvent(state, "alpha", "changes_requested", ["change it"]));
	const revision = JSON.parse(implementerPrompts(herdr).at(-1)!);
	assert.equal(revision.type, "auto_dag_task_update");
	assert.equal("issue" in revision, false);
	assert.equal("worktree" in revision, false);
	assert.match(revision.instruction, /Address the reviewer findings/);
	assert.deepEqual(revision.review_findings, ["change it"]);
	const rejected = requestReviewEvent(state, "alpha", first);

	state = await lifecycle.resume(project.root);
	const resumed = JSON.parse(implementerPrompts(herdr).at(-1)!);
	assert.equal(resumed.type, "auto_dag_resend");
	assert.equal("issue" in resumed, false);
	assert.equal("worktree" in resumed, false);
	assert.equal(resumed.attempt, state.tasks.alpha.attempts);
	assert.equal(resumed.review_round, 2);
	state = await lifecycle.resume(project.root, stale);
	assert.equal(state.tasks.alpha.status, "implementing");
	assert.equal(state.tasks.alpha.review_rounds, 1);
	state = await lifecycle.resume(project.root, rejected);
	assert.equal(state.tasks.alpha.status, "implementing");
	assert.equal(state.tasks.alpha.review_rounds, 1);

	await writeFile(join(state.tasks.alpha.worktree!, "alpha.txt"), "second\n");
	await git(state.tasks.alpha.worktree!, "add", "alpha.txt");
	await git(state.tasks.alpha.worktree!, "commit", "--amend", "-m", "second");
	const second = await git(state.tasks.alpha.worktree!, "rev-parse", "HEAD");
	state = await lifecycle.resume(project.root, requestReviewEvent(state, "alpha", second));
	assert.equal(state.tasks.alpha.status, "reviewing");
	assert.equal(state.tasks.alpha.review_rounds, 2);
});

test("resolved blocked work restarts its revision with durable context", async (t) => {
	const project = await makeProject(t, graph(["alpha"]), 1, 3);
	const herdr = fakeHerdr();
	const lifecycle = makeLifecycle(herdr.runner);
	let state = await lifecycle.start(project.root, "main-pane");
	const commit = await commitTask(state, "alpha", "alpha.txt", "alpha\n", "alpha");
	state = await lifecycle.resume(project.root, requestReviewEvent(state, "alpha", commit));
	state = await lifecycle.resume(project.root, reviewEvent(state, "alpha", "changes_requested", ["fix validation"]));
	state = await lifecycle.resume(project.root, blockTaskEvent(state, "alpha", "implementer", "need direction"));
	assert.equal(state.tasks.alpha.status, "blocked");
	const starts = herdr.count("agent start");

	state = await lifecycle.resolve(project.root, "alpha", "Use the approved validation rule.");
	const prompt = JSON.parse(implementerPrompts(herdr).at(-1)!);
	assert.equal(state.tasks.alpha.status, "implementing");
	assert.equal(state.tasks.alpha.pending_action, "revision");
	assert.equal(herdr.count("agent start"), starts);
	assert.match(prompt.instruction, /Address the reviewer findings/);
	assert.deepEqual(prompt.review_findings, ["fix validation"]);
	assert.equal(prompt.resolution, "Use the approved validation rule.");
});

test("resolve sends a full instruction to an already live task", async (t) => {
	const project = await makeProject(t, graph(["alpha"]), 1, 1);
	const herdr = fakeHerdr();
	const lifecycle = makeLifecycle(herdr.runner);
	let state = await lifecycle.start(project.root, "main-pane");
	const starts = herdr.count("agent start");

	state = await lifecycle.resolve(project.root, "alpha", "Use the approved approach.");
	const prompt = JSON.parse(implementerPrompts(herdr).at(-1)!);
	assert.equal(state.phase, "execution");
	assert.equal(herdr.count("agent start"), starts);
	assert.match(prompt.instruction, /Implement this frozen Local Issue/);
	assert.equal(prompt.resolution, "Use the approved approach.");
});

test("a valid review request after an implementer prompt crash is not rejected as starting", async (t) => {
	const project = await makeProject(t, graph(["alpha"]), 1, 1);
	const herdr = fakeHerdr({ fail_agent_prompt: 1 });
	const lifecycle = makeLifecycle(herdr.runner);
	let state = await lifecycle.start(project.root, "main-pane");
	assert.equal(state.tasks.alpha.status, "implementing");
	const commit = await commitTask(state, "alpha", "alpha.txt", "alpha\n", "alpha");

	state = await lifecycle.resume(project.root, requestReviewEvent(state, "alpha", commit));
	assert.equal(state.tasks.alpha.status, "reviewing");
});

test("resume delivers a pending implementer instruction after its agent starts before a crash", async (t) => {
	const project = await makeProject(t, graph(["alpha"]), 1, 1);
	const herdr = fakeHerdr();
	let crashAfterStart = true;
	const runner: CommandRunner = async (command, arguments_, options) => {
		const result = await herdr.runner(command, arguments_, options);
		if (crashAfterStart && command === "herdr" && arguments_.slice(0, 2).join(" ") === "agent start") {
			crashAfterStart = false;
			return { code: 1, stdout: "", stderr: "simulated post-start crash" };
		}
		return result;
	};
	const lifecycle = makeLifecycle(runner);
	let state = await lifecycle.start(project.root, "main-pane");
	assert.equal(state.phase, "blocked");
	assert.equal(state.tasks.alpha.implementer_instruction_pending, true);
	assert.equal(herdr.count("agent prompt"), 0);
	const starts = herdr.count("agent start");

	state = await lifecycle.resume(project.root);
	const prompt = JSON.parse(implementerPrompts(herdr).at(-1)!);
	assert.equal(state.tasks.alpha.implementer_instruction_pending, undefined);
	assert.equal(herdr.count("agent start"), starts);
	assert.match(prompt.instruction, /Implement this frozen Local Issue/);
});

test("resume delivers a pending reviewer instruction after its agent starts before a crash", async (t) => {
	const project = await makeProject(t, graph(["alpha"]), 1, 1);
	const herdr = fakeHerdr();
	let crashReviewerStart = false;
	const runner: CommandRunner = async (command, arguments_, options) => {
		const result = await herdr.runner(command, arguments_, options);
		if (crashReviewerStart && command === "herdr" && arguments_.slice(0, 2).join(" ") === "agent start" && arguments_[2].endsWith("-r")) {
			crashReviewerStart = false;
			return { code: 1, stdout: "", stderr: "simulated post-start crash" };
		}
		return result;
	};
	const lifecycle = makeLifecycle(runner);
	let state = await lifecycle.start(project.root, "main-pane");
	const commit = await commitTask(state, "alpha", "alpha.txt", "alpha\n", "alpha");
	crashReviewerStart = true;
	state = await lifecycle.resume(project.root, requestReviewEvent(state, "alpha", commit));
	assert.equal(state.phase, "blocked");
	assert.equal(state.tasks.alpha.reviewer_instruction_pending, true);
	assert.equal(reviewPrompts(herdr).length, 0);
	const starts = herdr.count("agent start");

	state = await lifecycle.resume(project.root);
	const prompt = JSON.parse(reviewPrompts(herdr).at(-1)!);
	assert.equal(state.tasks.alpha.reviewer_instruction_pending, undefined);
	assert.equal(herdr.count("agent start"), starts);
	assert.match(prompt.instruction, /Independently verify/);
});

test("mismatched and late block_task envelopes cannot regress work", async (t) => {
	const project = await makeProject(t, graph(["alpha"]), 1, 1);
	const herdr = fakeHerdr();
	const lifecycle = makeLifecycle(herdr.runner);
	let state = await lifecycle.start(project.root, "main-pane");
	const wrongAttempt = event("alpha", "implementer", "block_task", {
		reason: "wrong attempt",
		attempt: state.tasks.alpha.attempts + 1,
		review_round: 1,
	});
	const wrongRound = event("alpha", "implementer", "block_task", {
		reason: "wrong round",
		attempt: state.tasks.alpha.attempts,
		review_round: 2,
	});
	state = await lifecycle.resume(project.root, wrongAttempt);
	state = await lifecycle.resume(project.root, wrongRound);
	assert.equal(state.tasks.alpha.status, "implementing");
	const staleImplementer = blockTaskEvent(state, "alpha", "implementer", "too late");
	const commit = await commitTask(state, "alpha", "alpha.txt", "alpha\n", "alpha");
	state = await lifecycle.resume(project.root, requestReviewEvent(state, "alpha", commit));
	const staleReviewer = blockTaskEvent(state, "alpha", "reviewer", "too late");

	state = await lifecycle.resume(project.root, staleImplementer);
	assert.equal(state.tasks.alpha.status, "reviewing");
	state = await lifecycle.resume(project.root, reviewEvent(state, "alpha", "approved", []));
	assert.equal(state.tasks.alpha.status, "completed");
	state = await lifecycle.resume(project.root, staleReviewer);
	assert.equal(state.tasks.alpha.status, "completed");
	assert.notEqual(state.phase, "blocked");
});

test("reviewer block resolution starts a fresh bounded review round", async (t) => {
	const project = await makeProject(t, graph(["alpha"]), 1, 2);
	const herdr = fakeHerdr();
	const lifecycle = makeLifecycle(herdr.runner);
	let state = await lifecycle.start(project.root, "main-pane");
	const commit = await commitTask(state, "alpha", "alpha.txt", "alpha\n", "alpha");
	state = await lifecycle.resume(project.root, requestReviewEvent(state, "alpha", commit));
	const staleRound = reviewEvent(state, "alpha", "approved", []);
	state = await lifecycle.resume(project.root, reviewEvent(state, "alpha", "blocked", ["need policy"]));

	state = await lifecycle.resolve(project.root, "alpha", "Use the approved policy.");
	assert.equal(state.tasks.alpha.status, "reviewing");
	assert.equal(state.tasks.alpha.review_rounds, 2);
	state = await lifecycle.resume(project.root, staleRound);
	assert.equal(state.tasks.alpha.status, "reviewing");
	assert.equal(state.tasks.alpha.review_rounds, 2);
	state = await lifecycle.resume(project.root, reviewEvent(state, "alpha", "blocked", ["still blocked"]));

	state = await lifecycle.resolve(project.root, "alpha", "Try again.");
	assert.equal(state.phase, "blocked");
	assert.equal(state.tasks.alpha.status, "blocked");
	assert.match(String(state.tasks.alpha.block_reason), /Review rounds exceed configured maximum of 2/);
});

test("resolve waits for every task block before reopening the run", async (t) => {
	const project = await makeProject(t, graph(["alpha", "beta"]), 2, 1);
	const herdr = fakeHerdr();
	const lifecycle = makeLifecycle(herdr.runner);
	let state = await lifecycle.start(project.root, "main-pane");
	state = await lifecycle.resume(project.root, blockTaskEvent(state, "alpha", "implementer", "alpha needs direction"));
	state = await lifecycle.resume(project.root, blockTaskEvent(state, "beta", "implementer", "beta needs direction"));

	state = await lifecycle.resolve(project.root, "alpha", "Proceed with alpha.");
	assert.equal(state.phase, "blocked");
	assert.equal(state.tasks.alpha.status, "implementing");
	assert.equal(state.tasks.beta.status, "blocked");

	state = await lifecycle.resolve(project.root, "beta", "Proceed with beta.");
	assert.equal(state.phase, "execution");
	assert.equal(state.tasks.beta.status, "implementing");
});

test("resolve waits for cleanup and rejects terminal runs", async (t) => {
	const project = await makeProject(t, graph(["alpha"]), 1, 1);
	const herdr = fakeHerdr({ fail_tab_close: 1 });
	const lifecycle = makeLifecycle(herdr.runner);
	let state = await lifecycle.start(project.root, "main-pane");
	state = await lifecycle.resume(project.root, blockTaskEvent(state, "alpha", "implementer", "need direction"));
	const blocked: RunState = {
		...state,
		cleanup_blocks: [{ issue_id: "alpha", operation: "tab", reason: "tab busy" }],
	};
	await writeRunState(project.root, blocked, () => RUN_ID);

	state = await lifecycle.resolve(project.root, "alpha", "Proceed.");
	assert.equal(state.phase, "blocked");
	assert.equal(state.cleanup_blocks?.length, 1);
	state = await lifecycle.resume(project.root);
	assert.equal(state.phase, "execution");
	assert.equal(state.cleanup_blocks, undefined);

	for (const phase of ["aborted", "completed"] as const) {
		await writeRunState(project.root, { ...state, phase }, () => RUN_ID);
		await assert.rejects(lifecycle.resolve(project.root, "alpha", "ignored"), new RegExp(`Cannot resolve a ${phase} run`));
	}
});

test("resolving a reviewer block resumes its review with the resolution", async (t) => {
	const project = await makeProject(t, graph(["alpha"]), 1, 2);
	const herdr = fakeHerdr();
	const lifecycle = makeLifecycle(herdr.runner);
	let state = await lifecycle.start(project.root, "main-pane");
	const commit = await commitTask(state, "alpha", "alpha.txt", "alpha\n", "alpha");
	state = await lifecycle.resume(project.root, requestReviewEvent(state, "alpha", commit));
	const starts = herdr.count("agent start");
	state = await lifecycle.resume(project.root, reviewEvent(state, "alpha", "blocked", ["need policy"]));
	assert.equal(state.tasks.alpha.blocked_role, "reviewer");

	state = await lifecycle.resolve(project.root, "alpha", "Use the approved policy.");
	const prompt = JSON.parse(reviewPrompts(herdr).at(-1)!);
	assert.equal(state.tasks.alpha.status, "reviewing");
	assert.equal(herdr.count("agent start"), starts);
	assert.match(prompt.instruction, /Independently verify/);
	assert.deepEqual(prompt.review_findings, ["need policy"]);
	assert.equal(prompt.resolution, "Use the approved policy.");
});

test("explicit resume while reviewing restarts only the reviewer", async (t) => {
	const project = await makeProject(t, graph(["alpha"]), 1, 3);
	const herdr = fakeHerdr();
	const lifecycle = makeLifecycle(herdr.runner);
	let state = await lifecycle.start(project.root, "main-pane");
	const commit = await commitTask(state, "alpha", "alpha.txt", "alpha\n", "alpha");
	state = await lifecycle.resume(project.root, requestReviewEvent(state, "alpha", commit));
	const attempts = state.tasks.alpha.attempts;
	const reviewer = state.tasks.alpha.reviewer_agent!;
	const starts = herdr.count("agent start");

	herdr.live.clear();
	state = await lifecycle.resume(project.root);
	assert.equal(state.tasks.alpha.attempts, attempts);
	assert.equal(herdr.count("agent start"), starts + 1);

	state = await lifecycle.resume(project.root);
	assert.equal(state.tasks.alpha.attempts, attempts);
	const resend = JSON.parse(reviewPrompts(herdr).at(-1)!);
	assert.equal(resend.type, "auto_dag_resend");
	assert.equal("issue" in resend, false);
	assert.equal("worktree" in resend, false);
	herdr.live.delete(reviewer);
	state = await lifecycle.resume(project.root);
	assert.equal(state.tasks.alpha.attempts, attempts);
	assert.equal(herdr.count("agent start"), starts + 2);
});

test("resume reuses a live agent on its recorded pane without incrementing attempts", async (t) => {
	const project = await makeProject(t, graph(["alpha"]), 1, 1);
	const herdr = fakeHerdr();
	const lifecycle = makeLifecycle(herdr.runner);
	const state = await lifecycle.start(project.root, "main-pane");
	const attempts = state.tasks.alpha.attempts;
	const starts = herdr.count("agent start");

	const resumed = await lifecycle.resume(project.root);
	assert.equal(resumed.tasks.alpha.attempts, attempts);
	assert.equal(herdr.count("agent start"), starts);
});

test("agent_name_taken after an absent preflight reuses the expected pane", async (t) => {
	const project = await makeProject(t, graph(["alpha"]), 1, 1);
	const herdr = fakeHerdr();
	let race = false;
	const runner: CommandRunner = async (command, arguments_, options) => {
		if (race && command === "herdr" && arguments_[0] === "agent" && arguments_[1] === "start") {
			race = false;
			await herdr.runner(command, arguments_, options);
			return { code: 1, stdout: JSON.stringify({ error: { code: "agent_name_taken" } }), stderr: "" };
		}
		return await herdr.runner(command, arguments_, options);
	};
	const lifecycle = makeLifecycle(runner);
	let state = await lifecycle.start(project.root, "main-pane");
	const agent = state.tasks.alpha.implementer_agent!;
	const attempts = state.tasks.alpha.attempts;
	const starts = herdr.count("agent start");
	herdr.live.delete(agent);
	race = true;

	state = await lifecycle.resume(project.root);
	assert.equal(state.tasks.alpha.attempts, attempts);
	assert.equal(herdr.count("agent start"), starts + 1);
	assert.equal(state.tasks.alpha.status, "implementing");
});

test("resume rejects a same-name agent on a different pane", async (t) => {
	const project = await makeProject(t, graph(["alpha"]), 1, 1);
	const herdr = fakeHerdr();
	const lifecycle = makeLifecycle(herdr.runner);
	const state = await lifecycle.start(project.root, "main-pane");
	herdr.agentPanes.set(state.tasks.alpha.implementer_agent!, "foreign-pane");

	await assert.rejects(lifecycle.resume(project.root), /name collision/);
	assert.equal(herdr.count("agent start"), 1);
});

test("cleanup retries completed work with incomplete flags even without cleanup blocks", async (t) => {
	const project = await makeProject(t, graph(["alpha"]), 1, 1);
	const herdr = fakeHerdr();
	const lifecycle = makeLifecycle(herdr.runner);
	let state = await lifecycle.start(project.root, "main-pane");
	const commit = await commitTask(state, "alpha", "alpha.txt", "alpha\n", "alpha");
	state = await lifecycle.resume(project.root, requestReviewEvent(state, "alpha", commit));
	state = await lifecycle.resume(project.root, reviewEvent(state, "alpha", "approved", []));
	assert.equal(state.tasks.alpha.status, "completed");
	assert.equal(state.tasks.alpha.branch_cleanup_done, true);

	const stale: RunState = {
		...state,
		phase: "execution",
		cleanup_blocks: undefined,
		tasks: {
			...state.tasks,
			alpha: {
				...state.tasks.alpha,
				tab_cleanup_done: false,
				worktree_cleanup_done: false,
				branch_cleanup_done: false,
			},
		},
	};
	await writeRunState(project.root, stale, () => RUN_ID);
	state = await lifecycle.resume(project.root);
	assert.equal(state.cleanup_blocks, undefined);
	assert.equal(state.tasks.alpha.tab_cleanup_done, true);
	assert.equal(state.tasks.alpha.worktree_cleanup_done, true);
	assert.equal(state.tasks.alpha.branch_cleanup_done, true);
	assert.equal(herdr.count("tab close"), 1);
	assert.equal(await git(project.root, "branch", "--list", state.tasks.alpha.branch!), "");
});

test("cleanup probe failures remain blocked until absence is confirmed", async (t) => {
	const project = await makeProject(t, graph(["alpha"]), 1, 1);
	const herdr = fakeHerdr();
	let stage: "tab" | "worktree" | "branch" | undefined;
	let branch = "";
	const runner: CommandRunner = async (command, arguments_, options) => {
		const action = arguments_.slice(0, 2).join(" ");
		if (stage === "tab" && command === "herdr" && action === "tab close") {
			await herdr.runner(command, arguments_, options);
			return { code: 1, stdout: "", stderr: "tab close crashed after side effect" };
		}
		if (stage === "tab" && command === "herdr" && action === "tab get") throw new Error("tab absence probe crashed");
		if (stage === "worktree" && command === "git" && action === "worktree remove") {
			await herdr.runner(command, arguments_, options);
			return { code: 1, stdout: "", stderr: "worktree remove crashed after side effect" };
		}
		if (stage === "worktree" && command === "git" && action === "worktree list") throw new Error("worktree absence probe crashed");
		if (stage === "branch" && command === "git" && action === "branch -D") {
			await herdr.runner(command, arguments_, options);
			return { code: 1, stdout: "", stderr: "branch delete crashed after side effect" };
		}
		if (stage === "branch" && command === "git" && arguments_[0] === "show-ref" && arguments_.at(-1) === `refs/heads/${branch}`) {
			throw new Error("branch absence probe crashed");
		}
		return await herdr.runner(command, arguments_, options);
	};
	const lifecycle = makeLifecycle(runner);
	let state = await lifecycle.start(project.root, "main-pane");
	branch = state.tasks.alpha.branch!;
	const commit = await commitTask(state, "alpha", "alpha.txt", "alpha\n", "alpha");
	state = await lifecycle.resume(project.root, requestReviewEvent(state, "alpha", commit));
	stage = "tab";
	state = await lifecycle.resume(project.root, reviewEvent(state, "alpha", "approved", []));
	assert.equal(state.phase, "blocked");
	assert.equal(state.cleanup_blocks?.[0]?.operation, "tab");
	assert.equal(state.tasks.alpha.tab_cleanup_done, undefined);

	stage = "worktree";
	state = await lifecycle.resume(project.root);
	assert.equal(state.phase, "blocked");
	assert.equal(state.cleanup_blocks?.[0]?.operation, "worktree");
	assert.equal(state.tasks.alpha.tab_cleanup_done, true);
	assert.equal(state.tasks.alpha.worktree_cleanup_done, undefined);

	stage = "branch";
	state = await lifecycle.resume(project.root);
	assert.equal(state.phase, "blocked");
	assert.equal(state.cleanup_blocks?.[0]?.operation, "branch");
	assert.equal(state.tasks.alpha.worktree_cleanup_done, true);
	assert.equal(state.tasks.alpha.branch_cleanup_done, undefined);

	stage = undefined;
	state = await lifecycle.resume(project.root);
	assert.equal(state.phase, "execution");
	assert.equal(state.cleanup_blocks, undefined);
	assert.equal(state.tasks.alpha.branch_cleanup_done, true);
});

test("abort discovers an owned tab from its provisioning identity", async (t) => {
	const project = await makeProject(t, graph(["alpha"]), 1, 1);
	const herdr = fakeHerdr();
	const lifecycle = makeLifecycle(herdr.runner);
	let state = await lifecycle.start(project.root, "main-pane");
	const tabId = state.tasks.alpha.tab_id!;
	herdr.tabs.set("foreign-tab", { tab_id: "foreign-tab", label: state.tasks.alpha.implementer_provisioning_id!, workspace_id: "foreign-workspace" });
	herdr.panes.set("foreign-pane", { pane_id: "foreign-pane", tab_id: "foreign-tab" });
	await writeRunState(project.root, {
		...state,
		tasks: { ...state.tasks, alpha: { ...state.tasks.alpha, tab_id: undefined, tab_cleanup_done: false } },
	}, () => RUN_ID);

	state = await lifecycle.abort(project.root);
	assert.equal(state.phase, "aborted");
	assert.equal(state.tasks.alpha.tab_cleanup_done, true);
	assert.equal(herdr.tabs.has(tabId), false);
	assert.equal(herdr.tabs.has("foreign-tab"), true);
	assert.equal(herdr.count("tab close"), 1);
});

test("aborted resume cleans active resources but retains an unintegrated branch", async (t) => {
	const project = await makeProject(t, graph(["alpha"]), 1, 1);
	const herdr = fakeHerdr();
	const lifecycle = makeLifecycle(herdr.runner);
	let state = await lifecycle.start(project.root, "main-pane");
	const { tab_id: tabId, worktree, branch } = state.tasks.alpha;
	await writeRunState(project.root, { ...state, phase: "aborted" }, () => RUN_ID);

	state = await lifecycle.resume(project.root);
	assert.equal(state.phase, "aborted");
	assert.equal(state.tasks.alpha.tab_cleanup_done, true);
	assert.equal(state.tasks.alpha.worktree_cleanup_done, true);
	assert.equal(state.tasks.alpha.branch_cleanup_done, undefined);
	assert.equal(herdr.tabs.has(tabId!), false);
	await assert.rejects(readFile(worktree!), /ENOENT/);
	assert.equal(await git(project.root, "branch", "--list", branch!), branch);
	await assert.rejects(lifecycle.status(project.root), /No active pi-auto-dag run/);
});

test("abort and aborted resume clean owned work on a switched or detached integration branch", async (t) => {
	for (const mode of ["switched", "detached"] as const) {
		const project = await makeProject(t, graph(["alpha"]), 1, 1);
		const herdr = fakeHerdr({ fail_tab_close: 1 });
		const lifecycle = makeLifecycle(herdr.runner);
		let state = await lifecycle.start(project.root, "main-pane");
		const { tab_id: tabId, worktree, branch } = state.tasks.alpha;
		const starts = herdr.count("agent start");
		const prompts = herdr.count("agent prompt");
		if (mode === "switched") await git(project.root, "checkout", "-b", "other-integration");
		else await git(project.root, "checkout", "--detach");

		state = await lifecycle.abort(project.root, "stop safely");
		assert.equal(state.phase, "aborted");
		assert.equal(state.cleanup_blocks?.[0]?.operation, "tab");
		assert.equal(herdr.tabs.has(tabId!), true);

		state = await lifecycle.resume(project.root, "{not json");
		assert.equal(state.phase, "aborted");
		assert.equal(herdr.tabs.has(tabId!), false);
		assert.equal(herdr.count("agent start"), starts);
		assert.equal(herdr.count("agent prompt"), prompts);
		await assert.rejects(readFile(worktree!), /ENOENT/);
		assert.match(await git(project.root, "branch", "--list", branch!), new RegExp(`${branch}$`));
		assert.equal(await git(project.root, "branch", "--show-current"), mode === "switched" ? "other-integration" : "");
		await assert.rejects(lifecycle.status(project.root), /No active pi-auto-dag run/);
	}
});

test("resume recognizes a cherry-pick applied before its completion state save", async (t) => {
	const project = await makeProject(t, graph(["alpha"]), 1, 1);
	const herdr = fakeHerdr();
	let failAfterPick = false;
	let cherryPicks = 0;
	const runner: CommandRunner = async (command, arguments_, options) => {
		if (failAfterPick && command === "git" && arguments_[0] === "rev-parse" && arguments_[1] === "HEAD" && options.cwd === project.root) {
			failAfterPick = false;
			return { code: 1, stdout: "", stderr: "simulated commit-state crash" };
		}
		const result = await herdr.runner(command, arguments_, options);
		if (command === "git" && arguments_[0] === "cherry-pick" && arguments_[1] === "-x" && result.code === 0) {
			cherryPicks += 1;
			failAfterPick = true;
		}
		return result;
	};
	const lifecycle = makeLifecycle(runner);
	let state = await lifecycle.start(project.root, "main-pane");
	const commit = await commitTask(state, "alpha", "alpha.txt", "alpha\n", "alpha");
	state = await lifecycle.resume(project.root, requestReviewEvent(state, "alpha", commit));
	await assert.rejects(lifecycle.resume(project.root, reviewEvent(state, "alpha", "approved", [])), /simulated commit-state crash/);

	state = await lifecycle.resume(project.root);
	assert.equal(state.tasks.alpha.status, "completed");
	assert.equal(state.tasks.alpha.integration_intent, undefined);
	assert.equal(state.integration_head, await git(project.root, "rev-parse", "HEAD"));
	assert.equal(cherryPicks, 1);
	assert.equal((await git(project.root, "log", "--format=%s", "-1")), "alpha");
});

test("recovery refuses a cherry-pick on a switched integration branch", async (t) => {
	const project = await makeProject(t, graph(["alpha"]), 1, 1);
	const herdr = fakeHerdr();
	let failAfterPick = false;
	const runner: CommandRunner = async (command, arguments_, options) => {
		if (failAfterPick && command === "git" && arguments_[0] === "rev-parse" && arguments_[1] === "HEAD" && options.cwd === project.root) {
			failAfterPick = false;
			return { code: 1, stdout: "", stderr: "simulated commit-state crash" };
		}
		const result = await herdr.runner(command, arguments_, options);
		if (command === "git" && arguments_[0] === "cherry-pick" && arguments_[1] === "-x" && result.code === 0) failAfterPick = true;
		return result;
	};
	const lifecycle = makeLifecycle(runner);
	let state = await lifecycle.start(project.root, "main-pane");
	const commit = await commitTask(state, "alpha", "alpha.txt", "alpha\n", "alpha");
	state = await lifecycle.resume(project.root, requestReviewEvent(state, "alpha", commit));
	await assert.rejects(lifecycle.resume(project.root, reviewEvent(state, "alpha", "approved", [])), /simulated commit-state crash/);
	const crashed = await lifecycle.status(project.root, RUN_ID);
	assert.ok(crashed);
	await git(project.root, "checkout", "-b", "other-integration");

	await assert.rejects(lifecycle.resume(project.root), /Main integration branch changed from dag to other-integration/);
	const blocked = await lifecycle.status(project.root, RUN_ID);
	assert.ok(blocked);
	assert.equal(blocked.tasks.alpha.status, "approved");
	assert.equal(blocked.tasks.alpha.integration_intent, commit);
	assert.match(await git(project.root, "branch", "--list", blocked.tasks.alpha.branch!), new RegExp(`${blocked.tasks.alpha.branch}$`));
	await readFile(join(blocked.tasks.alpha.worktree!, "alpha.txt"));

	await git(project.root, "checkout", "dag");
	state = await lifecycle.resume(project.root);
	assert.equal(state.tasks.alpha.status, "completed");
});

test("a clean integration-head reset after integration blocks the next boundary", async (t) => {
	const project = await makeProject(t, graph(["alpha"]), 1, 1);
	const herdr = fakeHerdr();
	const lifecycle = makeLifecycle(herdr.runner);
	let state = await lifecycle.start(project.root, "main-pane");
	const originalHead = state.integration_head;
	const commit = await commitTask(state, "alpha", "alpha.txt", "alpha\n", "alpha");
	state = await lifecycle.resume(project.root, requestReviewEvent(state, "alpha", commit));
	state = await lifecycle.resume(project.root, reviewEvent(state, "alpha", "approved", []));
	assert.notEqual(state.integration_head, originalHead);
	await git(project.root, "reset", "--hard", originalHead);

	await assert.rejects(lifecycle.resume(project.root), /Main integration HEAD changed/);
	assert.equal((await lifecycle.status(project.root, RUN_ID))?.phase, "blocked");
});

test("resume aborts a recorded cherry-pick conflict before the clean-boundary check", async (t) => {
	const project = await makeProject(t, graph(["alpha", "beta"]), 2, 2, "base\n");
	const herdr = fakeHerdr();
	let beta = "";
	let interruptRecovery = false;
	const runner: CommandRunner = async (command, arguments_, options) => {
		if (interruptRecovery && command === "git" && arguments_.join(" ") === "rev-parse -q --verify CHERRY_PICK_HEAD") {
			interruptRecovery = false;
			return { code: 2, stdout: "", stderr: "simulated recovery interruption" };
		}
		const result = await herdr.runner(command, arguments_, options);
		if (command === "git" && arguments_[0] === "cherry-pick" && arguments_[1] === "-x" && arguments_[2] === beta && result.code !== 0) {
			interruptRecovery = true;
		}
		return result;
	};
	const lifecycle = makeLifecycle(runner);
	let state = await lifecycle.start(project.root, "main-pane");
	const alpha = await commitTask(state, "alpha", "shared.txt", "alpha\n", "alpha");
	beta = await commitTask(state, "beta", "shared.txt", "beta\n", "beta");
	state = await lifecycle.resume(project.root, requestReviewEvent(state, "alpha", alpha));
	state = await lifecycle.resume(project.root, requestReviewEvent(state, "beta", beta));
	state = await lifecycle.resume(project.root, reviewEvent(state, "alpha", "approved", []));
	await assert.rejects(lifecycle.resume(project.root, reviewEvent(state, "beta", "approved", [])), /simulated recovery interruption/);

	state = await lifecycle.resume(project.root);
	assert.equal(state.phase, "execution");
	assert.equal(state.tasks.beta.status, "implementing");
	assert.equal(state.tasks.beta.pending_action, "replacement");
	assert.equal(await git(project.root, "status", "--porcelain"), "");
});

test("a task block defers recorded conflict replacement until resolved", async (t) => {
	const project = await makeProject(t, graph(["alpha", "beta"]), 2, 2, "base\n");
	const herdr = fakeHerdr();
	let beta = "";
	let interruptRecovery = false;
	const runner: CommandRunner = async (command, arguments_, options) => {
		if (interruptRecovery && command === "git" && arguments_.join(" ") === "rev-parse -q --verify CHERRY_PICK_HEAD") {
			interruptRecovery = false;
			return { code: 2, stdout: "", stderr: "simulated recovery interruption" };
		}
		const result = await herdr.runner(command, arguments_, options);
		if (command === "git" && arguments_[0] === "cherry-pick" && arguments_[1] === "-x" && arguments_[2] === beta && result.code !== 0) {
			interruptRecovery = true;
		}
		return result;
	};
	const lifecycle = makeLifecycle(runner);
	let state = await lifecycle.start(project.root, "main-pane");
	const alpha = await commitTask(state, "alpha", "shared.txt", "alpha\n", "alpha");
	beta = await commitTask(state, "beta", "shared.txt", "beta\n", "beta");
	state = await lifecycle.resume(project.root, requestReviewEvent(state, "alpha", alpha));
	state = await lifecycle.resume(project.root, requestReviewEvent(state, "beta", beta));
	state = await lifecycle.resume(project.root, reviewEvent(state, "alpha", "approved", []));
	await assert.rejects(lifecycle.resume(project.root, reviewEvent(state, "beta", "approved", [])), /simulated recovery interruption/);
	const crashed = await lifecycle.status(project.root, RUN_ID);
	assert.ok(crashed);
	await writeRunState(project.root, {
		...crashed,
		tasks: {
			...crashed.tasks,
			"final-check": { ...crashed.tasks["final-check"], status: "blocked", block_reason: "hold replacement" },
		},
	}, () => RUN_ID);
	const starts = herdr.count("agent start");

	state = await lifecycle.resume(project.root);
	assert.equal(state.phase, "blocked");
	assert.equal(state.tasks.beta.pending_action, "replacement");
	assert.equal(state.tasks.beta.implementer_instruction_pending, true);
	assert.equal(herdr.count("agent start"), starts);

	state = await lifecycle.resolve(project.root, "final-check", "Continue.");
	assert.equal(state.tasks.beta.implementer_instruction_pending, undefined);
	assert.match(JSON.parse(implementerPrompts(herdr).at(-1)!).instruction, /previous commit conflicted/);
});

test("merge commits are rejected before a review can start", async (t) => {
	const project = await makeProject(t, graph(["alpha"]), 1, 1);
	const herdr = fakeHerdr();
	const lifecycle = makeLifecycle(herdr.runner);
	let state = await lifecycle.start(project.root, "main-pane");
	const worktree = state.tasks.alpha.worktree!;
	await git(worktree, "checkout", "-b", "review-side");
	await writeFile(join(worktree, "side.txt"), "side\n");
	await git(worktree, "add", "side.txt");
	await git(worktree, "commit", "-m", "side");
	await git(worktree, "checkout", state.tasks.alpha.branch!);
	await writeFile(join(worktree, "main.txt"), "main\n");
	await git(worktree, "add", "main.txt");
	await git(worktree, "commit", "-m", "main");
	await git(worktree, "merge", "--no-ff", "review-side", "-m", "merge");
	const merge = await git(worktree, "rev-parse", "HEAD");

	state = await lifecycle.resume(project.root, requestReviewEvent(state, "alpha", merge));
	assert.equal(state.tasks.alpha.status, "blocked");
	assert.match(String(state.tasks.alpha.block_reason), /must not be a merge commit/);
});

test("review requests reject a child context created after startup", async (t) => {
	const project = await makeProject(t, graph(["alpha"]), 1, 1);
	const herdr = fakeHerdr();
	const lifecycle = makeLifecycle(herdr.runner);
	let state = await lifecycle.start(project.root, "main-pane");
	const commit = await commitTask(state, "alpha", "alpha.txt", "alpha\n", "alpha");
	await mkdir(join(state.tasks.alpha.worktree!, ".context"));

	state = await lifecycle.resume(project.root, requestReviewEvent(state, "alpha", commit));
	assert.equal(state.tasks.alpha.status, "blocked");
	assert.match(String(state.tasks.alpha.block_reason), /child worktree must not contain .context/);
	assert.equal(herdr.count("pane split"), 0);
});

test("review requests reject a child worktree switched off its recorded branch", async (t) => {
	const project = await makeProject(t, graph(["alpha"]), 1, 1);
	const herdr = fakeHerdr();
	const lifecycle = makeLifecycle(herdr.runner);
	let state = await lifecycle.start(project.root, "main-pane");
	const commit = await commitTask(state, "alpha", "alpha.txt", "alpha\n", "alpha");
	await git(state.tasks.alpha.worktree!, "checkout", "-b", "other-review-branch");

	state = await lifecycle.resume(project.root, requestReviewEvent(state, "alpha", commit));
	assert.equal(state.tasks.alpha.status, "blocked");
	assert.match(String(state.tasks.alpha.block_reason), /child worktree branch changed/);
	assert.equal(herdr.count("pane split"), 0);
});

test("review verdicts reject a child context created after dispatch", async (t) => {
	const project = await makeProject(t, graph(["alpha"]), 1, 1);
	const herdr = fakeHerdr();
	const lifecycle = makeLifecycle(herdr.runner);
	let state = await lifecycle.start(project.root, "main-pane");
	const commit = await commitTask(state, "alpha", "alpha.txt", "alpha\n", "alpha");
	state = await lifecycle.resume(project.root, requestReviewEvent(state, "alpha", commit));
	await mkdir(join(state.tasks.alpha.worktree!, ".context"));

	state = await lifecycle.resume(project.root, reviewEvent(state, "alpha", "approved", []));
	assert.equal(state.tasks.alpha.status, "blocked");
	assert.equal(state.tasks.alpha.blocked_role, "reviewer");
	assert.match(String(state.tasks.alpha.block_reason), /child worktree must not contain .context/);
});

test("review verdicts reject a detached child worktree", async (t) => {
	const project = await makeProject(t, graph(["alpha"]), 1, 1);
	const herdr = fakeHerdr();
	const lifecycle = makeLifecycle(herdr.runner);
	let state = await lifecycle.start(project.root, "main-pane");
	const commit = await commitTask(state, "alpha", "alpha.txt", "alpha\n", "alpha");
	state = await lifecycle.resume(project.root, requestReviewEvent(state, "alpha", commit));
	await git(state.tasks.alpha.worktree!, "checkout", "--detach");

	state = await lifecycle.resume(project.root, reviewEvent(state, "alpha", "approved", []));
	assert.equal(state.tasks.alpha.status, "blocked");
	assert.equal(state.tasks.alpha.blocked_role, "reviewer");
	assert.match(String(state.tasks.alpha.block_reason), /child worktree is detached/);
});

test("a dirty child worktree is preserved instead of reset after a cherry-pick conflict", async (t) => {
	const project = await makeProject(t, graph(["alpha", "beta"]), 2, 2, "base\n");
	const herdr = fakeHerdr();
	let beta = "";
	let betaWorktree = "";
	const runner: CommandRunner = async (command, arguments_, options) => {
		if (command === "git" && arguments_[0] === "cherry-pick" && arguments_[1] === "-x" && arguments_[2] === beta) {
			await writeFile(join(betaWorktree, "preserve.txt"), "keep me\n");
		}
		return await herdr.runner(command, arguments_, options);
	};
	const lifecycle = makeLifecycle(runner);
	let state = await lifecycle.start(project.root, "main-pane");
	const alpha = await commitTask(state, "alpha", "shared.txt", "alpha\n", "alpha");
	betaWorktree = state.tasks.beta.worktree!;
	beta = await commitTask(state, "beta", "shared.txt", "beta\n", "beta");
	state = await lifecycle.resume(project.root, requestReviewEvent(state, "alpha", alpha));
	state = await lifecycle.resume(project.root, requestReviewEvent(state, "beta", beta));
	state = await lifecycle.resume(project.root, reviewEvent(state, "alpha", "approved", []));
	state = await lifecycle.resume(project.root, reviewEvent(state, "beta", "approved", []));

	assert.equal(state.phase, "blocked");
	assert.equal(state.tasks.beta.status, "approved");
	assert.equal(state.tasks.beta.attempts, 1);
	assert.equal(await readFile(join(betaWorktree, "preserve.txt"), "utf8"), "keep me\n");
	assert.notEqual(await git(betaWorktree, "status", "--porcelain"), "");
});

test("conflict replacement checks a recovered child worktree before reset", async (t) => {
	const project = await makeProject(t, graph(["alpha", "beta"]), 2, 2, "base\n");
	const herdr = fakeHerdr();
	let beta = "";
	let betaWorktree = "";
	let resets = 0;
	const runner: CommandRunner = async (command, arguments_, options) => {
		if (command === "git" && arguments_[0] === "cherry-pick" && arguments_[1] === "-x" && arguments_[2] === beta) {
			await mkdir(join(betaWorktree, ".context"));
		}
		if (command === "git" && arguments_.join(" ") === "reset --hard" && options.cwd === betaWorktree) resets += 1;
		return await herdr.runner(command, arguments_, options);
	};
	const lifecycle = makeLifecycle(runner);
	let state = await lifecycle.start(project.root, "main-pane");
	const alpha = await commitTask(state, "alpha", "shared.txt", "alpha\n", "alpha");
	betaWorktree = state.tasks.beta.worktree!;
	beta = await commitTask(state, "beta", "shared.txt", "beta\n", "beta");
	state = await lifecycle.resume(project.root, requestReviewEvent(state, "alpha", alpha));
	state = await lifecycle.resume(project.root, requestReviewEvent(state, "beta", beta));
	state = await lifecycle.resume(project.root, reviewEvent(state, "alpha", "approved", []));
	await assert.rejects(lifecycle.resume(project.root, reviewEvent(state, "beta", "approved", [])), /child worktree must not contain .context/);

	const blocked = await lifecycle.status(project.root, RUN_ID);
	assert.equal(blocked?.tasks.beta.status, "approved");
	assert.equal(blocked?.tasks.beta.attempts, 1);
	assert.equal(resets, 0);
});

test("conflict replacement rejects a child worktree detached after review validation", async (t) => {
	const project = await makeProject(t, graph(["alpha", "beta"]), 2, 2, "base\n");
	const herdr = fakeHerdr();
	let beta = "";
	let betaWorktree = "";
	let betaPickFailures = 0;
	let cherryPickAborts = 0;
	let resets = 0;
	const runner: CommandRunner = async (command, arguments_, options) => {
		const result = await herdr.runner(command, arguments_, options);
		if (command === "git" && arguments_[0] === "cherry-pick" && arguments_[1] === "-x" && arguments_[2] === beta && result.code !== 0) {
			betaPickFailures += 1;
			await git(betaWorktree, "checkout", "--detach");
		}
		if (command === "git" && arguments_.join(" ") === "cherry-pick --abort" && result.code === 0) cherryPickAborts += 1;
		if (command === "git" && arguments_.join(" ") === "reset --hard" && options.cwd === betaWorktree) resets += 1;
		return result;
	};
	const lifecycle = makeLifecycle(runner);
	let state = await lifecycle.start(project.root, "main-pane");
	const alpha = await commitTask(state, "alpha", "shared.txt", "alpha\n", "alpha");
	betaWorktree = state.tasks.beta.worktree!;
	beta = await commitTask(state, "beta", "shared.txt", "beta\n", "beta");
	state = await lifecycle.resume(project.root, requestReviewEvent(state, "alpha", alpha));
	state = await lifecycle.resume(project.root, requestReviewEvent(state, "beta", beta));
	state = await lifecycle.resume(project.root, reviewEvent(state, "alpha", "approved", []));

	await assert.rejects(lifecycle.resume(project.root, reviewEvent(state, "beta", "approved", [])), /child worktree is detached/);
	const blocked = await lifecycle.status(project.root, RUN_ID);
	assert.equal(blocked?.tasks.beta.status, "approved");
	assert.equal(blocked?.tasks.beta.attempts, 1);
	assert.equal(betaPickFailures, 1);
	assert.equal(cherryPickAborts, 1);
	assert.equal(resets, 0);
});

test("resume discovers a tab created before its state save", async (t) => {
	const project = await makeProject(t, graph(["alpha"]), 1, 1);
	const herdr = fakeHerdr({ crash_after_tab_create: 1 });
	const lifecycle = makeLifecycle(herdr.runner);
	let state = await lifecycle.start(project.root, "main-pane");
	assert.equal(state.phase, "blocked");
	assert.equal(state.tasks.alpha.status, "starting");
	assert.equal(state.tasks.alpha.implementer_provisioning_id, `auto-dag:${RUN_ID}:alpha:implementer`);
	assert.equal(herdr.count("tab create"), 1);

	state = await lifecycle.resume(project.root);
	assert.equal(state.phase, "execution");
	assert.equal(state.tasks.alpha.status, "implementing");
	assert.equal(state.tasks.alpha.tab_id, "tab-1");
	assert.equal(state.tasks.alpha.implementer_pane, "pane-1");
	assert.equal(herdr.count("tab create"), 1);
	assert.match(JSON.parse(implementerPrompts(herdr).at(-1)!).instruction, /Implement this frozen Local Issue/);
});

test("resume discovers a reviewer pane split before its state save", async (t) => {
	const project = await makeProject(t, graph(["alpha"]), 1, 1);
	const herdr = fakeHerdr({ crash_after_pane_split: 1 });
	const lifecycle = makeLifecycle(herdr.runner);
	let state = await lifecycle.start(project.root, "main-pane");
	const commit = await commitTask(state, "alpha", "alpha.txt", "alpha\n", "alpha");
	state = await lifecycle.resume(project.root, requestReviewEvent(state, "alpha", commit));
	assert.equal(state.phase, "blocked");
	assert.equal(state.tasks.alpha.status, "reviewing");
	assert.equal(state.tasks.alpha.reviewer_provisioning_id, `auto-dag:${RUN_ID}:alpha:reviewer`);
	assert.equal(state.tasks.alpha.reviewer_pane, undefined);
	assert.equal(herdr.count("pane split"), 1);

	state = await lifecycle.resume(project.root);
	assert.equal(state.phase, "execution");
	assert.equal(state.tasks.alpha.status, "reviewing");
	assert.equal(state.tasks.alpha.reviewer_pane, "pane-2");
	assert.equal(herdr.count("pane split"), 1);
	assert.match(JSON.parse(reviewPrompts(herdr).at(-1)!).instruction, /Independently verify/);
});

test("structured agent_pane_busy retries with delay and plain text does not", async (t) => {
	const project = await makeProject(t, graph(["alpha"]), 1, 1);
	const herdr = fakeHerdr({ busy_starts: 4 });
	const delays: number[] = [];
	const lifecycle = makeLifecycle(herdr.runner, async (milliseconds) => { delays.push(milliseconds); });
	const state = await lifecycle.start(project.root, "main-pane");
	assert.equal(state.tasks.alpha.status, "implementing");
	assert.equal(herdr.count("agent start"), 5);
	assert.deepEqual(delays, [250, 250, 250, 250]);

	const exhaustedProject = await makeProject(t, graph(["alpha"]), 1, 1);
	const exhaustedHerdr = fakeHerdr({ busy_starts: 5 });
	const exhaustedDelays: number[] = [];
	const exhausted = await makeLifecycle(exhaustedHerdr.runner, async (milliseconds) => { exhaustedDelays.push(milliseconds); }).start(exhaustedProject.root, "main-pane");
	assert.equal(exhausted.phase, "blocked");
	assert.equal(exhaustedHerdr.count("agent start"), 5);
	assert.deepEqual(exhaustedDelays, [250, 250, 250, 250]);

	const plainProject = await makeProject(t, graph(["alpha"]), 1, 1);
	const plainHerdr = fakeHerdr({ plain_busy_starts: 1 });
	const plainDelays: number[] = [];
	const plainLifecycle = makeLifecycle(plainHerdr.runner, async (milliseconds) => { plainDelays.push(milliseconds); });
	const plain = await plainLifecycle.start(plainProject.root, "main-pane");
	assert.equal(plain.phase, "blocked");
	assert.equal(plainHerdr.count("agent start"), 1);
	assert.deepEqual(plainDelays, []);
});

function makeLifecycle(runner: CommandRunner, delay?: (milliseconds: number) => Promise<void>): CoreLifecycle {
	return createCoreLifecycle({
		runner,
		uuid: () => RUN_ID,
		now: () => "2026-08-09T00:00:00.000Z",
		delay,
	});
}

function graph(ids: string[]) {
	const issues: LocalIssue[] = ids.map((id, index) => ({
		id,
		title: id,
		role: "implementation",
		profile: "backend",
		purpose: `Build ${id}.`,
		acceptance: [id],
		testing: `npm test -- ${id}`,
		blocked_by: index === 2 ? [ids[0], ids[1]] : [],
	}));
	issues.push({
		id: "final-check",
		title: "Final check",
		role: "final_check",
		profile: null,
		purpose: "Verify.",
		acceptance: ["verified"],
		testing: "npm test",
		blocked_by: ids,
	});
	return {
		version: 1,
		status: "approved",
		id: "orchestration-test",
		title: "Orchestration test",
		goal: "Exercise native orchestration.",
		constraints: ["local"],
		issues,
	};
}

async function makeProject(
	t: TestContext,
	deliveryGraph: ReturnType<typeof graph>,
	maxParallel: number,
	maxReviews: number,
	shared?: string,
): Promise<{ root: string }> {
	const root = await mkdtemp(join(tmpdir(), "pi-auto-dag-orchestration-"));
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
	await writeFile(join(agentDir, "config", "pi-auto-dag.json"), JSON.stringify({
		version: 1,
		profiles,
		max_parallel_tasks: maxParallel,
		max_review_rounds: maxReviews,
	}));
	useAgentDir(t, agentDir);
	await writeFile(join(root, ".gitignore"), ".context/\n");
	if (shared !== undefined) await writeFile(join(root, "shared.txt"), shared);
	await git(root, "add", ".");
	await git(root, "commit", "-m", "initial");
	await git(root, "checkout", "-b", "dag");
	await mkdir(join(root, ".context", "issues"), { recursive: true });
	await writeFile(join(root, ".context", "issues", "graph.json"), JSON.stringify(deliveryGraph));
	return { root };
}

function useAgentDir(t: TestContext, agentDir: string): void {
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	t.after(() => {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
	});
}

async function commitTask(state: RunState, issueId: string, file: string, content: string, subject: string): Promise<string> {
	const worktree = state.tasks[issueId].worktree!;
	await writeFile(join(worktree, file), content);
	await git(worktree, "add", file);
	await git(worktree, "commit", "-m", subject);
	return await git(worktree, "rev-parse", "HEAD");
}

function event(issueId: string, role: "implementer" | "reviewer", type: string, payload: Record<string, unknown>): string {
	return JSON.stringify({ version: 1, type, run_id: RUN_ID, issue_id: issueId, role, payload });
}

function reviewEvent(
	state: RunState,
	issueId: string,
	verdict: "approved" | "changes_requested" | "blocked",
	findings: string[],
	exitCode = 0,
	command = state.graph.issues.find((issue) => issue.id === issueId)?.testing,
): string {
	const task = state.tasks[issueId];
	if (!command) throw new Error(`No testing command for ${issueId}`);
	return event(issueId, "reviewer", "submit_review", {
		commit: task.commit,
		attempt: task.attempts,
		review_round: task.review_rounds,
		command,
		exit_code: exitCode,
		verdict,
		findings,
	});
}

function requestReviewEvent(state: RunState, issueId: string, commit: string): string {
	const task = state.tasks[issueId];
	return event(issueId, "implementer", "request_review", {
		commit,
		attempt: task.attempts,
		review_round: (task.review_rounds ?? 0) + 1,
	});
}

function blockTaskEvent(state: RunState, issueId: string, role: "implementer" | "reviewer", reason: string): string {
	const task = state.tasks[issueId];
	return event(issueId, role, "block_task", {
		reason,
		attempt: task.attempts,
		review_round: role === "implementer" ? (task.review_rounds ?? 0) + 1 : task.review_rounds,
	});
}

function reviewPrompts(herdr: ReturnType<typeof fakeHerdr>): string[] {
	return herdr.calls
		.filter((call) => call.command === "herdr" && call.args.slice(0, 2).join(" ") === "agent prompt" && call.args[2].endsWith("-r"))
		.map((call) => call.args[3]);
}

function implementerPrompts(herdr: ReturnType<typeof fakeHerdr>): string[] {
	return herdr.calls
		.filter((call) => call.command === "herdr" && call.args.slice(0, 2).join(" ") === "agent prompt" && call.args[2].endsWith("-i"))
		.map((call) => call.args[3]);
}

async function git(cwd: string, ...args: string[]): Promise<string> {
	return (await execFile("git", args, { cwd })).stdout.trim();
}
