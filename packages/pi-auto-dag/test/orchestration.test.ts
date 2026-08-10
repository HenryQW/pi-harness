import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { fakeHerdr } from "./support/fake-herdr.ts";
import { createTestProfiles, testProfileConfig } from "./support/profiles.ts";
import { type CommandRunner } from "../src/command.ts";
import { createCoreLifecycle, type CoreLifecycle } from "../src/lifecycle.ts";
import { type RunState } from "../src/model.ts";
import { childWorktreePath, parseWorkerEnvelope } from "../src/orchestration.ts";
import { writeRunState } from "../src/state.ts";

const execFile = promisify(execFileCallback);
const RUN_ID = "22222222-2222-4222-8222-222222222222";

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
	const implementerPrompt = JSON.parse(implementerPrompts(herdr).at(-1)!);
	assert.deepEqual(implementerPrompt.delivery, { goal: "Exercise native orchestration.", constraints: ["local"], non_goals: [] });
	assert.deepEqual(Object.keys(implementerPrompt.issue).sort(), ["acceptance", "id", "purpose", "testing", "title"]);

	const alpha = await commitTask(state, "alpha", "alpha.txt", "alpha\n", "alpha");
	const tabReads = herdr.count("tab list");
	const paneReads = herdr.count("pane list");
	state = await lifecycle.resume(project.root, requestReviewEvent(state, "alpha", alpha));
	assert.equal(herdr.count("tab list"), tabReads + 1);
	assert.equal(herdr.count("pane list"), paneReads + 1);
	assert.equal(state.tasks.alpha.status, "reviewing");
	assert.equal(state.tasks.alpha.activity_started_at, "2026-08-09T00:00:00.000Z");
	const reviewPrompt = JSON.parse(reviewPrompts(herdr).at(-1)!);
	assert.deepEqual(reviewPrompt.delivery, implementerPrompt.delivery);
	assert.equal(reviewPrompt.type, "auto_dag_review");
	assert.equal(reviewPrompt.kind, "implementation");
	assert.deepEqual(reviewPrompt.gate, {
		command: "npm test -- alpha",
		commit: alpha,
		exit_code: 0,
		output: {
			stdout: { excerpt: "required gate passed: npm test -- alpha\n", bytes: Buffer.byteLength("required gate passed: npm test -- alpha\n"), truncated: false },
			stderr: { excerpt: "", bytes: 0, truncated: false },
		},
	});
	for (const key of ["run_id", "attempt", "review_round", "required_gate", "command", "commit"]) assert.equal(key in reviewPrompt, false);
	assert.equal(reviewPrompt.base, state.tasks.alpha.wave_base);
	assert.deepEqual(Object.keys(reviewPrompt.issue).sort(), ["acceptance", "id", "purpose", "title"]);
	assert.equal("testing" in reviewPrompt, false);
	assert.equal(herdr.count("pane split"), 1);
	const gateCall = herdr.calls.findIndex((call) => call.command === "sh");
	const reviewDispatch = herdr.calls.findIndex((call) => call.command === "herdr" && call.args.slice(0, 2).join(" ") === "agent prompt" && call.args[2].endsWith("-r"));
	assert.ok(gateCall >= 0 && gateCall < reviewDispatch);

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
	assert.equal(herdr.calls.some((call) => !["git", "herdr", "sh", process.execPath].includes(call.command)), false);
});

test("wave completion rechecks local inputs before dispatching the next wave", async (t) => {
	const deliveryGraph = graph(["alpha", "beta", "gamma"]);
	const project = await makeProject(t, deliveryGraph, 2, 1);
	const herdr = fakeHerdr();
	let cherryPicks = 0;
	const runner: CommandRunner = async (command, arguments_, options) => {
		const result = await herdr.runner(command, arguments_, options);
		if (command === "git" && arguments_[0] === "cherry-pick" && arguments_[1] === "-x" && result.code === 0 && ++cherryPicks === 2) {
			await writeFile(join(project.root, ".context", "issues", "graph.json"), JSON.stringify({ ...deliveryGraph, goal: "changed" }));
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

test("advancing the remote default branch does not block resume", async (t) => {
	const project = await makeProject(t, graph(["alpha"]), 1, 1);
	await git(project.root, "update-ref", "refs/remotes/origin/main", "HEAD");
	await git(project.root, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
	const herdr = fakeHerdr();
	const lifecycle = makeLifecycle(herdr.runner);
	const state = await lifecycle.start(project.root, "main-pane");
	const remote = await git(project.root, "commit-tree", `${state.integration_head}^{tree}`, "-p", state.integration_head, "-m", "remote advance");
	await git(project.root, "update-ref", "refs/remotes/origin/main", remote);

	const resumed = await lifecycle.resume(project.root);
	assert.equal(resumed.phase, "execution");
	assert.equal(resumed.integration_head, state.integration_head);
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
	const prompt = JSON.parse(reviewPrompts(herdr).at(-1)!);
	assert.match(prompt.instruction, /Auto DAG already verified/);
	assert.doesNotMatch(prompt.instruction, /Independently verify/);
});

test("review requests canonicalize abbreviated commits and reject wrong revisions", async (t) => {
	const project = await makeProject(t, graph(["alpha", "beta"]), 2, 1);
	const herdr = fakeHerdr();
	const lifecycle = makeLifecycle(herdr.runner);
	let state = await lifecycle.start(project.root, "main-pane");
	const alpha = await commitTask(state, "alpha", "alpha.txt", "alpha\n", "alpha");
	await commitTask(state, "beta", "beta.txt", "beta\n", "beta");

	state = await lifecycle.resume(project.root, requestReviewEvent(state, "alpha", alpha.slice(0, 7)));
	assert.equal(state.tasks.alpha.status, "reviewing");
	assert.equal(state.tasks.alpha.commit, alpha);

	state = await lifecycle.resume(project.root, requestReviewEvent(state, "beta", alpha));
	assert.equal(state.tasks.beta.status, "blocked");
	assert.match(String(state.tasks.beta.block_reason), /requested commit is not worktree HEAD/);

	state = await lifecycle.resolve(project.root, "beta", "Retry with the current worktree commit.");
	state = await lifecycle.resume(project.root, requestReviewEvent(state, "beta", "not-a-commit"));
	assert.equal(state.tasks.beta.status, "blocked");
	assert.match(String(state.tasks.beta.block_reason), /git rev-parse --verify not-a-commit\^\{commit\} failed:/);
});

test("review submissions contain only reviewer-owned verdict data", () => {
	for (const key of ["commit", "attempt", "review_round", "command", "exit_code", "fixed_thread_ids"]) {
		assert.throws(() => parseWorkerEnvelope(JSON.parse(event("alpha", "reviewer", "submit_review", {
			verdict: "approved",
			findings: [],
			[key]: key === "command" || key === "commit" ? "value" : 1,
		}))), new RegExp(`Unknown worker envelope submit_review payload setting: ${key}`));
	}
	for (const verdict of ["changes_requested", "blocked"] as const) {
		assert.throws(() => parseWorkerEnvelope(JSON.parse(event("alpha", "reviewer", "submit_review", {
			verdict,
			findings: [],
		}))), /Non-approval review verdict requires findings/);
	}
});

test("Auto DAG persists required-gate evidence and rejects nonzero approvals", async (t) => {
	const project = await makeProject(t, graph(["alpha"]), 1, 1);
	const herdr = fakeHerdr({ gate: () => ({ code: 1, stdout: "failed output\n", stderr: "failure details\n" }) });
	const lifecycle = makeLifecycle(herdr.runner);
	let state = await lifecycle.start(project.root, "main-pane");
	const commit = await commitTask(state, "alpha", "alpha.txt", "alpha\n", "alpha");
	state = await lifecycle.resume(project.root, requestReviewEvent(state, "alpha", commit));

	assert.equal(state.tasks.alpha.review_command, "npm test -- alpha");
	assert.equal(state.tasks.alpha.review_commit, commit);
	assert.equal(state.tasks.alpha.review_exit_code, 1);
	assert.equal(state.tasks.alpha.review_stdout, "failed output\n");
	assert.equal(state.tasks.alpha.review_stderr, "failure details\n");
	state = await lifecycle.resume(project.root, reviewEvent(state, "alpha", "approved", []));
	assert.equal(state.tasks.alpha.status, "blocked");
	assert.match(String(state.tasks.alpha.block_reason), /approval requires exit code 0/);
});

test("review handoff bounds gate output and retains exact full output", async (t) => {
	const project = await makeProject(t, graph(["alpha"]), 1, 1);
	const stdout = `start\n${"x".repeat(10_000)}\nend\n`;
	const herdr = fakeHerdr({ gate: () => ({ code: 0, stdout, stderr: "" }) });
	const lifecycle = makeLifecycle(herdr.runner);
	let state = await lifecycle.start(project.root, "main-pane");
	const commit = await commitTask(state, "alpha", "alpha.txt", "alpha\n", "alpha");
	state = await lifecycle.resume(project.root, requestReviewEvent(state, "alpha", commit));
	const prompt = JSON.parse(reviewPrompts(herdr).at(-1)!);
	const output = prompt.gate.output.stdout;

	assert.equal(state.tasks.alpha.review_stdout, stdout);
	assert.equal(output.truncated, true);
	assert.equal(output.bytes, Buffer.byteLength(stdout));
	assert.ok(output.excerpt.length < stdout.length);
	assert.equal(await readFile(output.full_output.path, "utf8"), stdout);
	assert.match(output.full_output.sha256, /^[0-9a-f]{64}$/);
});

test("Auto DAG executes frozen command text unchanged in clean task worktree", async (t) => {
	const deliveryGraph = graph(["alpha"]);
	deliveryGraph.issues[0].testing = "  printf 'one  two\\n'  ";
	const project = await makeProject(t, deliveryGraph, 1, 1);
	let received: { command: string; cwd?: string } | undefined;
	const herdr = fakeHerdr({ gate: (command, cwd) => {
		received = { command, cwd };
		return { code: 0, stdout: "one  two\n", stderr: "" };
	} });
	const lifecycle = makeLifecycle(herdr.runner);
	let state = await lifecycle.start(project.root, "main-pane");
	const commit = await commitTask(state, "alpha", "alpha.txt", "alpha\n", "alpha");
	state = await lifecycle.resume(project.root, requestReviewEvent(state, "alpha", commit));

	assert.deepEqual(received, { command: "  printf 'one  two\\n'  ", cwd: state.tasks.alpha.worktree });
	assert.deepEqual(herdr.calls.find((call) => call.command === "sh")?.args, ["-c", "  printf 'one  two\\n'  "]);
	assert.equal(state.tasks.alpha.review_command, "  printf 'one  two\\n'  ");
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

test("reviewer block resolution starts a fresh bounded review round with same commit evidence", async (t) => {
	const project = await makeProject(t, graph(["alpha"]), 1, 2);
	const herdr = fakeHerdr();
	const lifecycle = makeLifecycle(herdr.runner);
	let state = await lifecycle.start(project.root, "main-pane");
	const commit = await commitTask(state, "alpha", "alpha.txt", "alpha\n", "alpha");
	state = await lifecycle.resume(project.root, requestReviewEvent(state, "alpha", commit));
	state = await lifecycle.resume(project.root, reviewEvent(state, "alpha", "blocked", ["need policy"]));
	const gateRuns = herdr.calls.filter((call) => call.command === "sh").length;

	state = await lifecycle.resolve(project.root, "alpha", "Use the approved policy.");
	assert.equal(state.tasks.alpha.status, "reviewing");
	assert.equal(state.tasks.alpha.review_rounds, 2);
	assert.equal(herdr.calls.filter((call) => call.command === "sh").length, gateRuns);
	const update = JSON.parse(reviewPrompts(herdr).at(-1)!);
	assert.equal(update.type, "auto_dag_review_update");
	assert.deepEqual(update.prior_findings, ["need policy"]);
	for (const key of ["delivery", "issue", "worktree", "base", "instruction", "run_id", "attempt", "review_round"]) assert.equal(key in update, false);
	state = await lifecycle.resume(project.root, reviewEvent(state, "alpha", "blocked", ["still blocked"]));

	state = await lifecycle.resolve(project.root, "alpha", "Try again.");
	assert.equal(state.phase, "blocked");
	assert.equal(state.tasks.alpha.status, "blocked");
	assert.match(String(state.tasks.alpha.block_reason), /Review rounds exceed configured maximum of 2/);
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

function makeLifecycle(runner: CommandRunner, delay?: (milliseconds: number) => Promise<void>): CoreLifecycle {
	return createCoreLifecycle({
		runner,
		uuid: () => RUN_ID,
		now: () => "2026-08-09T00:00:00.000Z",
		delay,
	});
}

function graph(ids: string[]) {
	return {
		status: "approved",
		id: "orchestration-test",
		goal: "Exercise native orchestration.",
		constraints: ["local"],
		non_goals: [],
		issues: ids.map((id, index) => ({
			id,
			title: id,
			profile: "backend",
			objective: `Build ${id}.`,
			acceptance: [id],
			testing: `npm test -- ${id}`,
			depends_on: index === 2 ? [ids[0], ids[1]] : [],
		})),
		final_check: { acceptance: ["verified"], testing: "npm test" },
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
	await createTestProfiles(root);
	const agentDir = await mkdtemp(join(tmpdir(), "pi-auto-dag-agent-"));
	t.after(async () => { await rm(agentDir, { recursive: true, force: true }); });
	await mkdir(join(agentDir, "config"), { recursive: true });
	await writeFile(join(agentDir, "config", "pi-auto-dag.json"), JSON.stringify(testProfileConfig(root, {
		maxParallel,
		maxReviews,
	})));
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
	_state: RunState,
	issueId: string,
	verdict: "approved" | "changes_requested" | "blocked",
	findings: string[],
): string {
	return event(issueId, "reviewer", "submit_review", { verdict, findings });
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
