import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { fakeHerdr } from "./support/fake-herdr.ts";
import { type CommandRunner, runCommand } from "../src/command.ts";
import { startLocalRun } from "../src/intake.ts";
import { createCoreLifecycle, type CoreLifecycle } from "../src/lifecycle.ts";
import { type RunState } from "../src/model.ts";
import { readActiveRunId, runDirectory } from "../src/state.ts";

const execFile = promisify(execFileCallback);
const RUN_ID = "33333333-3333-4333-8333-333333333333";
const ACTIVE_RUN_ID = "44444444-4444-4444-8444-444444444444";

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
	const workerPrompts = () => herdr.calls
		.filter((call) => call.command === "herdr" && call.args[0] === "agent" && call.args[1] === "prompt")
		.map((call) => JSON.parse(call.args[3]));
	const repairPrompt = workerPrompts().find((value) => value.type === "auto_dag_final_repair");
	assert.deepEqual(Object.keys(repairPrompt.owner_issue).sort(), ["acceptance", "id", "purpose", "testing", "title"]);
	const repairWorktree = state.tasks["final-check"].worktree!;
	assert.match(repairWorktree, /final-repair-alpha-1$/);
	const repair = await commit(repairWorktree, "repair.txt", "fixed\n", "repair alpha");
	state = await lifecycle.resume(project.root, requestReviewEvent(state, "final-check", repair));
	const repairReviewPrompt = workerPrompts().find((value) => value.type === "auto_dag_final_repair_review");
	assert.deepEqual(Object.keys(repairReviewPrompt.owner_issue).sort(), ["acceptance", "id", "purpose", "title"]);
	assert.equal(repairReviewPrompt.command, "npm test -- final-check");
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
	assert.equal(fullPrompt.command, "npm test -- final-check");
	assert.deepEqual(Object.keys(fullPrompt.issue).sort(), ["acceptance", "id", "purpose", "title"]);
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
		summary: "Two unresolved review threads and one failing check.",
		actionable: true,
		thread_ids: ["THREAD-1", "THREAD-2"],
		checks: [{ name: "integration", link: "https://ci.example/integration", output: "fails: expected repair" }],
	}));
	assert.equal(state.health?.status, "repairing");
	const repair = await commit(state.health!.worktree!, "health.txt", "healthy\n", "health repair");
	state = await lifecycle.health(project.root, RUN_ID, requestReviewEvent(state, "final-check", repair));
	assert.equal(state.health?.reviewer_agent, reviewer);
	state = await lifecycle.health(project.root, RUN_ID, healthReviewEvent(state, "approved", [], ["THREAD-1", "THREAD-2"]));

	assert.equal(state.health?.status, "completed");
	assert.deepEqual(state.health?.resolved_thread_ids, ["THREAD-1", "THREAD-2"]);
	assert.equal(gh.gitPushes, pushes + 1);
	assert.equal(gh.count("api graphql"), 1);
	assert.deepEqual(gh.resolved, ["THREAD-1", "THREAD-2"]);
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
				const ids = args
					.filter((arg) => /^threadId\d+=/.test(arg))
					.map((arg) => arg.slice(arg.indexOf("=") + 1));
				resolved.push(...ids);
				return success({
					data: Object.fromEntries(ids.map((id, index) => [`thread${index}`, { thread: { id, isResolved: true } }])),
				});
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
