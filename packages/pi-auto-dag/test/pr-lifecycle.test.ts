import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { fakeHerdr } from "./support/fake-herdr.ts";
import { createTestProfiles, testProfileConfig } from "./support/profiles.ts";
import { recordedGateEvidence, type CommandRunner, runCommand } from "../src/command.ts";
import { startLocalRun } from "../src/intake.ts";
import { createCoreLifecycle, type CoreLifecycle } from "../src/lifecycle.ts";
import { type RunState } from "../src/model.ts";
import { parseWorkerEnvelope } from "../src/orchestration.ts";
import { actionTicketPath, eventReceiptPath, readActionTicket, readWorkerReceipt, reviewId, writeWorkerReceipt } from "../src/review-ticket.ts";
import { readActiveRunId, recordAcceptedWorkerEvent, runDirectory, writeRunState } from "../src/state.ts";

const execFile = promisify(execFileCallback);
const RUN_ID = "33333333-3333-4333-8333-333333333333";
const ACTIVE_RUN_ID = "44444444-4444-4444-8444-444444444444";
const FINAL_GATE_COMMAND = "npm ci && npm test -- final-check && npm run typecheck";

test("the frozen final check prepares its disposable checkout and opens one exact integration PR", async (t) => {
	const project = await makeProject(t);
	await mkdir(join(project.root, ".local-tools"));
	await writeFile(join(project.root, ".local-tools", "ready"), "mutable\n");
	await mkdir(join(project.root, "node_modules"));
	await writeFile(join(project.root, "node_modules", "stale"), "mutable\n");
	const herdr = fakeHerdr({
		gate: (command, cwd) => {
			if (command === FINAL_GATE_COMMAND) {
				assert.throws(() => readFileSync(join(cwd!, ".local-tools", "ready"), "utf8"), /ENOENT/);
				assert.throws(() => readFileSync(join(cwd!, "node_modules", "stale"), "utf8"), /ENOENT/);
			}
			return { code: 0, stdout: `required gate passed: ${command}\n`, stderr: "" };
		},
	});
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
	const finalGate = herdr.calls.find((call) => call.command === "sh" && call.args[1] === FINAL_GATE_COMMAND);
	assert.match(finalGate?.cwd ?? "", /\/final-gate$/);
	assert.notEqual(finalGate?.cwd, project.root);
	await assert.rejects(readFile(finalGate!.cwd!, "utf8"), /ENOENT/);
});

test("final gate cleans ignored resources recovered into its retained worktree", async (t) => {
	const project = await makeProject(t);
	const herdr = fakeHerdr({
		gate: (command, cwd) => {
			if (command === FINAL_GATE_COMMAND) {
				assert.throws(() => readFileSync(join(cwd!, ".local-tools", "ready"), "utf8"), /ENOENT/);
				assert.throws(() => readFileSync(join(cwd!, ".local-tools", "obsolete"), "utf8"), /ENOENT/);
			}
			return { code: 0, stdout: `required gate passed: ${command}\n`, stderr: "" };
		},
	});
	const base = combinedRunner(herdr, fakeGh(project.root));
	let seeded = false;
	const runner: CommandRunner = async (command, args, options) => {
		const result = await base(command, args, options);
		const finalWorktree = command === "git" && args[0] === "worktree" && args[1] === "add"
			? args.find((argument) => argument.startsWith("/") && argument.endsWith("/final-gate"))
			: undefined;
		if (!seeded && finalWorktree) {
			seeded = true;
			await mkdir(join(finalWorktree, ".local-tools"));
			await writeFile(join(finalWorktree, ".local-tools", "ready"), "recovered\n");
			await writeFile(join(finalWorktree, ".local-tools", "obsolete"), "stale\n");
		}
		return result;
	};

	const state = await advanceToFinalReview(project.root, makeLifecycle(runner));

	assert.equal(state.tasks["final-check"].status, "reviewing");
	assert.equal(seeded, true);
});

test("final gate cannot erase changes created concurrently in main worktree", async (t) => {
	const project = await makeProject(t);
	const herdr = fakeHerdr();
	const base = combinedRunner(herdr, fakeGh(project.root));
	const runner: CommandRunner = async (command, args, options) => {
		if (command === "sh" && args[1] === FINAL_GATE_COMMAND) {
			await writeFile(join(project.root, "user-during-final-gate.txt"), "keep\n");
		}
		return await base(command, args, options);
	};

	const state = await advanceToFinalReview(project.root, makeLifecycle(runner));

	assert.equal(state.tasks["final-check"].status, "reviewing");
	assert.equal(await readFile(join(project.root, "user-during-final-gate.txt"), "utf8"), "keep\n");
});

test("nonzero final gate blocks before reviewer and approved retry reruns the same integration commit", async (t) => {
	const project = await makeProject(t, { maxReviews: 1 });
	let failFinalGate = true;
	const herdr = fakeHerdr({ gate: (command) => command === FINAL_GATE_COMMAND && failFinalGate
		? { code: 1, stdout: "", stderr: "dependency unavailable\n" }
		: { code: 0, stdout: `required gate passed: ${command}\n`, stderr: "" } });
	const lifecycle = makeLifecycle(combinedRunner(herdr, fakeGh(project.root)));
	let state = await lifecycle.start(project.root, "main-pane");
	const implementation = await commit(state.tasks.alpha.worktree!, "alpha.txt", "alpha\n", "alpha");
	state = await lifecycle.resume(project.root, requestReviewEvent(state, "alpha", implementation));
	state = await lifecycle.resume(project.root, reviewEvent(state, "alpha", "approved", []));

	assert.equal(state.phase, "blocked");
	assert.equal(state.tasks["final-check"].status, "blocked");
	assert.equal(state.tasks["final-check"].review_exit_code, 1);
	assert.equal(state.tasks["final-check"].reviewer_pane, undefined);
	const finalCommit = state.tasks["final-check"].commit;
	const failedEvidence = recordedGateEvidence(state.tasks["final-check"], finalCommit!)!;
	const reviewerStarts = herdr.calls.filter((call) => call.command === "herdr" && call.args.slice(0, 2).join(" ") === "agent start" && call.args[2].endsWith("-r")).length;

	await assert.rejects(
		lifecycle.resolve(project.root, "final-check", "Dependency restored; rerun frozen gate."),
		/must use auto_dag_retry_gate/,
	);
	assert.deepEqual(recordedGateEvidence((await lifecycle.status(project.root))!.tasks["final-check"], finalCommit!), failedEvidence);

	failFinalGate = false;
	state = await lifecycle.retryGate(project.root, "Dependency restored; rerun frozen gate.", failedEvidence);
	assert.equal(state.phase, "execution");
	assert.equal(state.tasks["final-check"].status, "reviewing");
	assert.equal(state.tasks["final-check"].commit, finalCommit);
	assert.equal(state.tasks["final-check"].review_commit, finalCommit);
	assert.equal(state.tasks["final-check"].review_exit_code, 0);
	assert.equal(herdr.calls.filter((call) => call.command === "sh" && call.args[1] === FINAL_GATE_COMMAND).length, 2);
	assert.equal(herdr.calls.filter((call) => call.command === "herdr" && call.args.slice(0, 2).join(" ") === "agent start" && call.args[2].endsWith("-r")).length, reviewerStarts + 1);
});

test("user-approved infrastructure retry archives persisted final-gate evidence after runtime reload", async (t) => {
	const project = await makeProject(t);
	let dependenciesProvisioned = false;
	const herdr = fakeHerdr({ gate: (command) => command === FINAL_GATE_COMMAND && !dependenciesProvisioned
		? { code: 1, stdout: "", stderr: "ERR_MODULE_NOT_FOUND: dependency provisioning failed\n" }
		: { code: 0, stdout: `required gate passed: ${command}\n`, stderr: "" } });
	const baseRunner = combinedRunner(herdr, fakeGh(project.root));
	const runnerCalls: Array<{ command: string; args: readonly string[] }> = [];
	const runner: CommandRunner = async (command, args, options) => {
		runnerCalls.push({ command, args: [...args] });
		return await baseRunner(command, args, options);
	};
	let state = await makeLifecycle(runner).start(project.root, "main-pane");
	const implementation = await commit(state.tasks.alpha.worktree!, "alpha.txt", "alpha\n", "alpha");
	state = await makeLifecycle(runner).resume(project.root, requestReviewEvent(state, "alpha", implementation));
	state = await makeLifecycle(runner).resume(project.root, reviewEvent(state, "alpha", "approved", []));
	const finalCommit = state.integration_head;
	const oldEvidence = recordedGateEvidence(state.tasks["final-check"], finalCommit)!;
	const persisted = {
		...state,
		tasks: { ...state.tasks, "final-check": { ...state.tasks["final-check"], commit: undefined } },
	};
	await writeRunState(project.root, persisted, () => "persisted-failure");
	await assert.rejects(
		makeLifecycle(runner).resolve(project.root, "final-check", "Infrastructure failure; retry exact gate."),
		/must use auto_dag_retry_gate/,
	);

	dependenciesProvisioned = true;
	const updatedRuntime = makeLifecycle(runner);
	await assert.rejects(
		updatedRuntime.retryGate(project.root, "Runtime dependency provisioning restored.", { ...oldEvidence, commit: "replacement" }),
		/evidence changed during infrastructure retry approval/,
	);
	assert.equal((await updatedRuntime.status(project.root))?.tasks["final-check"].review_exit_code, 1);
	state = await updatedRuntime.retryGate(project.root, "Runtime dependency provisioning restored.", oldEvidence);

	assert.equal(state.phase, "execution");
	assert.equal(state.tasks["final-check"].status, "reviewing");
	assert.equal(state.tasks["final-check"].review_command, FINAL_GATE_COMMAND);
	assert.equal(state.tasks["final-check"].review_commit, finalCommit);
	assert.equal(state.tasks["final-check"].review_exit_code, 0);
	assert.deepEqual(state.tasks["final-check"].required_gate_invalidations, [{
		invalidated_at: "2026-08-09T00:00:00.000Z",
		reason: "Runtime dependency provisioning restored.",
		evidence: oldEvidence,
	}]);
	const gateCalls = herdr.calls.filter((call) => call.command === "sh" && call.args[0] === "-c" && call.args[1] === FINAL_GATE_COMMAND);
	assert.equal(gateCalls.length, 2);
	assert.ok(gateCalls.every((call) => call.cwd?.endsWith("/final-gate")));
	const finalWorktreeBuilds = runnerCalls.filter((call) => call.command === "git"
		&& call.args[0] === "worktree" && call.args[1] === "add" && call.args.some((arg) => arg.endsWith("/final-gate")));
	assert.equal(finalWorktreeBuilds.length, 2);
});

test("failed final gate accepts an exact command amendment on same integration commit", async (t) => {
	const project = await makeProject(t, { maxReviews: 1 });
	const replacement = `bootstrap && ${FINAL_GATE_COMMAND}`;
	const herdr = fakeHerdr({ gate: (command) => command === FINAL_GATE_COMMAND
		? { code: 1, stdout: "", stderr: "dependency bootstrap missing\n" }
		: { code: 0, stdout: `required gate passed: ${command}\n`, stderr: "" } });
	const lifecycle = makeLifecycle(combinedRunner(herdr, fakeGh(project.root)));
	let state = await lifecycle.start(project.root, "main-pane");
	const implementation = await commit(state.tasks.alpha.worktree!, "alpha.txt", "alpha\n", "alpha");
	state = await lifecycle.resume(project.root, requestReviewEvent(state, "alpha", implementation));
	state = await lifecycle.resume(project.root, reviewEvent(state, "alpha", "approved", []));
	const finalCommit = state.tasks["final-check"].commit!;
	const failedEvidence = recordedGateEvidence(state.tasks["final-check"], finalCommit)!;

	state = await lifecycle.resolve(project.root, "final-check", "Bootstrap dependencies in clean final worktree.", {
		replacement_command: replacement,
		expected_run_id: state.run_id,
		expected_command: FINAL_GATE_COMMAND,
		expected_commit: finalCommit,
		expected_evidence: failedEvidence,
	});

	assert.equal(state.phase, "execution");
	assert.equal(state.graph.final_check.testing, FINAL_GATE_COMMAND);
	assert.equal(state.tasks["final-check"].review_command, replacement);
	assert.equal(state.tasks["final-check"].review_commit, finalCommit);
	assert.equal(state.tasks["final-check"].review_exit_code, 0);
	assert.deepEqual(state.gate_command_amendments, [{
		issue_id: "final-check",
		previous_command: FINAL_GATE_COMMAND,
		replacement_command: replacement,
		failed_commit: finalCommit,
		reason: "Bootstrap dependencies in clean final worktree.",
		approved_at: "2026-08-09T00:00:00.000Z",
	}]);
	assert.equal(herdr.calls.filter((call) => call.command === "sh" && call.args[1] === FINAL_GATE_COMMAND).length, 1);
	assert.equal(herdr.calls.filter((call) => call.command === "sh" && call.args[1] === replacement).length, 1);
	const prompt = herdr.calls
		.filter((call) => call.command === "herdr" && call.args.slice(0, 2).join(" ") === "agent prompt")
		.map((call) => JSON.parse(call.args[3]))
		.find((value) => value.kind === "final_check");
	assert.deepEqual(prompt.context.gate_command_amendments, state.gate_command_amendments);
	state = await lifecycle.resume(project.root, reviewEvent(state, "final-check", "changes_requested", ["Repair it."]));
	state = await lifecycle.resolve(project.root, "alpha", "Repair alpha for final check.");
	const repairPrompt = herdr.calls
		.filter((call) => call.command === "herdr" && call.args.slice(0, 2).join(" ") === "agent prompt")
		.map((call) => JSON.parse(call.args[3]))
		.reverse()
		.find((value) => value.type === "auto_dag_final_repair");
	assert.deepEqual(repairPrompt.required_gate, { command: replacement, amendments: state.gate_command_amendments });
});

test("infrastructure retry reruns the amended final gate command", async (t) => {
	const project = await makeProject(t, { maxReviews: 1 });
	const replacement = `bootstrap && ${FINAL_GATE_COMMAND}`;
	let infrastructureFixed = false;
	const herdr = fakeHerdr({ gate: (command) => command === replacement
		? infrastructureFixed
			? { code: 0, stdout: "required gate passed\n", stderr: "" }
			: { code: 1, stdout: "", stderr: "dependency bootstrap failed\n" }
		: command === FINAL_GATE_COMMAND
			? { code: 1, stdout: "", stderr: "dependency bootstrap missing\n" }
			: { code: 0, stdout: "required gate passed\n", stderr: "" } });
	const lifecycle = makeLifecycle(combinedRunner(herdr, fakeGh(project.root)));
	let state = await lifecycle.start(project.root, "main-pane");
	const implementation = await commit(state.tasks.alpha.worktree!, "alpha.txt", "alpha\n", "alpha");
	state = await lifecycle.resume(project.root, requestReviewEvent(state, "alpha", implementation));
	state = await lifecycle.resume(project.root, reviewEvent(state, "alpha", "approved", []));
	const finalCommit = state.integration_head;
	const failedEvidence = recordedGateEvidence(state.tasks["final-check"], finalCommit)!;

	state = await lifecycle.resolve(project.root, "final-check", "Use checkout bootstrap command.", {
		replacement_command: replacement,
		expected_run_id: state.run_id,
		expected_command: FINAL_GATE_COMMAND,
		expected_commit: finalCommit,
		expected_evidence: failedEvidence,
	});
	const failedAmendedGate = recordedGateEvidence(state.tasks["final-check"], finalCommit)!;
	assert.equal(state.phase, "blocked");
	assert.equal(failedAmendedGate.command, replacement);

	infrastructureFixed = true;
	state = await lifecycle.retryGate(project.root, "Bootstrap service restored.", failedAmendedGate);

	assert.equal(state.tasks["final-check"].review_command, replacement);
	assert.equal(state.tasks["final-check"].review_exit_code, 0);
	assert.deepEqual(state.tasks["final-check"].required_gate_invalidations?.at(-1)?.evidence, failedAmendedGate);
	assert.equal(herdr.calls.filter((call) => call.command === "sh" && call.args[1] === replacement).length, 2);
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
	assert.deepEqual(calls, [["git", "rev-parse", "--show-toplevel"]]);
	assert.equal(await git(project.root, "rev-parse", "HEAD"), head);
	assert.equal(await readFile(historicalPath, "utf8"), historicalState);
	assert.equal(await readFile(activePath, "utf8"), activeState);
});

test("a nonzero final gate remains recoverable through its completed owner", async (t) => {
	const project = await makeProject(t);
	let failFinalGate = true;
	const herdr = fakeHerdr({ gate: (command) => failFinalGate && command === FINAL_GATE_COMMAND
		? { code: 1, stdout: "", stderr: "final dependency unavailable\n" }
		: { code: 0, stdout: `required gate passed: ${command}\n`, stderr: "" } });
	const lifecycle = makeLifecycle(combinedRunner(herdr, fakeGh(project.root)));
	let state = await lifecycle.start(project.root, "main-pane");
	const implementation = await commit(state.tasks.alpha.worktree!, "alpha.txt", "alpha\n", "alpha");
	state = await lifecycle.resume(project.root, requestReviewEvent(state, "alpha", implementation));
	state = await lifecycle.resume(project.root, reviewEvent(state, "alpha", "approved", []));

	assert.equal(state.phase, "blocked");
	assert.equal(state.tasks["final-check"].status, "blocked");
	assert.equal(state.tasks["final-check"].review_exit_code, 1);
	assert.equal(state.tasks["final-check"].final_gate_head, state.integration_head);

	failFinalGate = false;
	state = await lifecycle.resolve(project.root, "alpha", "Repair alpha or gate setup for final verification.");
	assert.equal(state.phase, "execution");
	assert.equal(state.tasks["final-check"].status, "repairing");
	assert.equal(state.tasks["final-check"].repair_issue_id, "alpha");

	const repair = state.tasks["final-check"];
	state = await lifecycle.resume(project.root, event(state, "final-check", "implementer", "block_task", {
		reason: "repair worker unavailable", attempt: repair.attempts, review_round: (repair.review_rounds ?? 0) + 1,
	}));
	const failedEvidence = recordedGateEvidence(state.tasks["final-check"], state.integration_head)!;
	await assert.rejects(
		lifecycle.retryGate(project.root, "Retry gate setup.", failedEvidence),
		/Final Check repair is active/,
	);
	assert.equal((await lifecycle.status(project.root))!.tasks["final-check"].status, "blocked");
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
	assert.deepEqual(repairPrompt.delivery, { goal: "Exercise final checks and retained PR health.", constraints: ["local"], non_goals: [] });
	assert.deepEqual(Object.keys(repairPrompt.owner_issue).sort(), ["acceptance", "id", "purpose", "testing", "title"]);
	const repairWorktree = state.tasks["final-check"].worktree!;
	assert.match(repairWorktree, /final-repair-alpha-1$/);
	const repair = await commit(repairWorktree, "repair.txt", "fixed\n", "repair alpha");
	state = await lifecycle.resume(project.root, requestReviewEvent(state, "final-check", repair));
	const repairReviewPrompt = workerPrompts().find((value) => value.type === "auto_dag_review" && value.kind === "final_repair");
	assert.deepEqual(Object.keys(repairReviewPrompt.context.owner_issue).sort(), ["acceptance", "id", "purpose", "title"]);
	assert.deepEqual(Object.keys(repairReviewPrompt.issue).sort(), ["acceptance", "id", "purpose", "title"]);
	assert.deepEqual(repairReviewPrompt.gate, {
		command: FINAL_GATE_COMMAND,
		commit: repair,
		exit_code: 0,
		output: {
			stdout: { excerpt: `required gate passed: ${FINAL_GATE_COMMAND}\n`, bytes: Buffer.byteLength(`required gate passed: ${FINAL_GATE_COMMAND}\n`), truncated: false },
			stderr: { excerpt: "", bytes: 0, truncated: false },
		},
	});
	for (const key of ["run_id", "attempt", "review_round", "required_gate", "command", "commit"]) assert.equal(key in repairReviewPrompt, false);
	state = await lifecycle.resume(project.root, reviewEvent(state, "final-check", "approved", []));
	assert.equal(state.tasks["final-check"].status, "reviewing");
	assert.equal(await git(project.root, "show", "HEAD:repair.txt"), "fixed");
	const finalReviewer = state.tasks["final-check"].reviewer_agent!;
	const prompts = () => herdr.calls
		.filter((call) => call.command === "herdr" && call.args[0] === "agent" && call.args[1] === "prompt" && call.args[2] === finalReviewer)
		.map((call) => JSON.parse(call.args[3]));
	const fullPrompt = prompts().find((value) => value.type === "auto_dag_review" && value.kind === "final_check");
	assert.equal(fullPrompt.gate.command, FINAL_GATE_COMMAND);
	assert.equal(fullPrompt.gate.commit, state.integration_head);
	assert.equal(fullPrompt.gate.exit_code, 0);
	assert.equal(fullPrompt.worktree, project.root);
	assert.equal("command" in fullPrompt, false);
	assert.deepEqual(fullPrompt.delivery, repairPrompt.delivery);
	assert.deepEqual(Object.keys(fullPrompt.issue).sort(), ["acceptance", "id", "purpose", "title"]);
	for (const key of ["run_id", "attempt", "review_round", "required_gate"]) assert.equal(key in fullPrompt, false);
	state = await lifecycle.resume(project.root);
	assert.deepEqual(prompts().at(-1), { type: "auto_dag_resend" });

	state = await lifecycle.resume(project.root, reviewEvent(state, "final-check", "approved", []));
	assert.equal(state.phase, "completed");
	assert.equal(gh.count("pr create"), 1);
	const creates = herdr.calls.filter((call) => call.command === "herdr" && call.args[0] === "tab" && call.args[1] === "create");
	assert.ok(creates.every((call) => call.args[call.args.indexOf("--workspace") + 1] === "main-workspace"));
	await assert.rejects(git(project.root, "rev-parse", "--verify", "pi-auto-dag/33333333-3333-4333-8333-333333333333/final-repair/alpha/1"));
});

test("nonzero final-repair gate blocks its reviewer and resolution reruns the same repair commit", async (t) => {
	const project = await makeProject(t);
	let failRepairGate = true;
	const herdr = fakeHerdr({ gate: (command, cwd) => failRepairGate && cwd?.includes("final-repair")
		? { code: 1, stdout: "", stderr: "repair dependency unavailable\n" }
		: { code: 0, stdout: `required gate passed: ${command}\n`, stderr: "" } });
	const lifecycle = makeLifecycle(combinedRunner(herdr, fakeGh(project.root)));
	const repairReviewPrompts = () => herdr.calls
		.filter((call) => call.command === "herdr" && call.args.slice(0, 2).join(" ") === "agent prompt")
		.map((call) => JSON.parse(call.args[3]))
		.filter((prompt) => prompt.type === "auto_dag_review" && prompt.kind === "final_repair");
	let state = await advanceToFinalReview(project.root, lifecycle);
	state = await lifecycle.resume(project.root, reviewEvent(state, "final-check", "changes_requested", ["repair alpha"]));
	state = await lifecycle.resolve(project.root, "alpha", "Repair alpha.");
	const repair = await commit(state.tasks["final-check"].worktree!, "repair.txt", "fixed\n", "repair alpha");
	state = await lifecycle.resume(project.root, requestReviewEvent(state, "final-check", repair));

	assert.equal(state.phase, "blocked");
	assert.equal(state.tasks["final-check"].status, "repair_reviewing");
	assert.equal(state.tasks["final-check"].review_exit_code, 1);
	assert.equal(repairReviewPrompts().length, 0);
	const stuckTab = state.tasks["final-check"].tab_id;

	failRepairGate = false;
	state = await lifecycle.resolve(project.root, "final-check", "Dependency restored; rerun repair gate.");
	assert.equal(state.phase, "execution");
	assert.equal(state.tasks["final-check"].status, "repair_reviewing");
	assert.equal(state.tasks["final-check"].commit, repair);
	assert.equal(state.tasks["final-check"].review_commit, repair);
	assert.equal(state.tasks["final-check"].review_exit_code, 0);
	assert.notEqual(state.tasks["final-check"].tab_id, stuckTab);
	assert.equal(herdr.tabs.has(stuckTab!), false);
	assert.equal(herdr.calls.filter((call) => call.command === "sh" && call.cwd?.includes("final-repair")).length, 2);
	assert.equal(repairReviewPrompts().length, 1);
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

test("PR health accepted triage resumes repair before recovering receipt", async (t) => {
	const project = await makeProject(t);
	const herdr = fakeHerdr();
	const gh = fakeGh(project.root);
	const lifecycle = makeLifecycle(combinedRunner(herdr, gh));
	let state = await finishInitialRun(project.root, lifecycle);
	state = await lifecycle.health(project.root, RUN_ID);
	const message = healthEvent(state, {
		summary: "One unresolved review thread.",
		actionable: true,
		thread_ids: ["THREAD-1"],
		checks: [],
	});
	const envelope = JSON.parse(message);
	await writeRunState(project.root, {
		...recordAcceptedWorkerEvent(state, parseWorkerEnvelope(envelope)),
		health: {
			...state.health!,
			summary: "One unresolved review thread.",
			actionable: true,
			thread_ids: ["THREAD-1"],
			checks: [],
		},
	}, () => "recover-health");
	const prompts = herdr.count("agent prompt");

	state = await lifecycle.health(project.root, RUN_ID, message);

	assert.equal(state.health?.status, "repairing");
	assert.ok(state.health?.coder_pane);
	assert.equal(herdr.count("agent prompt"), prompts + 1);
	assert.equal((await readWorkerReceipt(envelope.receipt_path))?.status, "accepted");
});

test("PR health recovers ticket rotation after a durable rejection", async (t) => {
	const project = await makeProject(t);
	const herdr = fakeHerdr();
	const lifecycle = makeLifecycle(combinedRunner(herdr, fakeGh(project.root)));
	let state = await finishInitialRun(project.root, lifecycle);
	state = await lifecycle.health(project.root, RUN_ID);
	const ticketPath = actionTicketPath(project.root, RUN_ID, "final-check", "pr_health", "reviewer");
	const current = await readActionTicket(ticketPath);
	const submission = {
		...JSON.parse(healthEvent(state, {
			summary: "No unresolved review threads or failing checks.",
			actionable: false,
			thread_ids: [],
			checks: [],
		})),
		event_id: current.event_id,
		receipt_path: current.receipt_path,
	};
	await writeWorkerReceipt(current.receipt_path, { event_id: current.event_id, status: "rejected", reason: "interrupted health rejection" });

	await assert.rejects(lifecycle.health(project.root, RUN_ID, JSON.stringify(submission)), /interrupted health rejection/);
	const replacement = await readActionTicket(ticketPath);
	assert.notEqual(replacement.event_id, current.event_id);
	state = await lifecycle.health(project.root, RUN_ID, JSON.stringify({
		...submission,
		event_id: replacement.event_id,
		receipt_path: replacement.receipt_path,
	}));

	assert.equal(state.health?.status, "completed");
	assert.equal((await readWorkerReceipt(replacement.receipt_path))?.status, "accepted");
});

test("blocked PR health recovers accepted receipts and rejects fresh events", async (t) => {
	const project = await makeProject(t);
	const herdr = fakeHerdr();
	const lifecycle = makeLifecycle(combinedRunner(herdr, fakeGh(project.root)));
	let state = await finishInitialRun(project.root, lifecycle);
	state = await lifecycle.health(project.root, RUN_ID);
	const message = event(state, "final-check", "reviewer", "block_task", { reason: "Reviewer dependency unavailable." }, undefined, {
		attempt: state.health!.attempt,
		review_round: state.health!.review_round,
	});
	const envelope = JSON.parse(message);
	await writeRunState(project.root, {
		...recordAcceptedWorkerEvent(state, parseWorkerEnvelope(envelope)),
		health: { ...state.health!, status: "blocked", blocked_role: "reviewer", summary: "Reviewer dependency unavailable." },
	}, () => "blocked-health");

	state = await lifecycle.health(project.root, RUN_ID, message);
	assert.equal(state.health?.status, "blocked");
	assert.equal((await readWorkerReceipt(envelope.receipt_path))?.status, "accepted");

	const fresh = {
		...envelope,
		event_id: "fresh-blocked-health-event",
		receipt_path: eventReceiptPath(project.root, RUN_ID, "fresh-blocked-health-event"),
	};
	await assert.rejects(lifecycle.health(project.root, RUN_ID, JSON.stringify(fresh)), /Reviewer dependency unavailable/);
	assert.equal((await readWorkerReceipt(fresh.receipt_path))?.status, "rejected");
});

test("nonzero PR-health repair gate blocks before reviewer dispatch and reruns the same commit", async (t) => {
	const project = await makeProject(t);
	let failHealthGate = false;
	const herdr = fakeHerdr({ gate: (command) => failHealthGate
		? { code: 1, stdout: "", stderr: "health gate failed\n" }
		: { code: 0, stdout: `required gate passed: ${command}\n`, stderr: "" } });
	const lifecycle = makeLifecycle(combinedRunner(herdr, fakeGh(project.root)));
	let state = await finishInitialRun(project.root, lifecycle);
	state = await lifecycle.health(project.root, RUN_ID);
	state = await lifecycle.health(project.root, RUN_ID, healthEvent(state, {
		summary: "Repair required.",
		actionable: true,
		thread_ids: ["THREAD-1"],
		checks: [{ name: "integration", link: "https://ci.example/integration", output: "failed" }],
	}));
	const repair = await commit(state.health!.worktree!, "health.txt", "healthy\n", "health repair");
	failHealthGate = true;
	state = await lifecycle.health(project.root, RUN_ID, requestReviewEvent(state, "final-check", repair));

	assert.equal(state.health?.status, "blocked");
	assert.equal(state.health?.review_commit, repair);
	assert.equal(state.health?.review_exit_code, 1);
	const repairReviewPrompts = () => herdr.calls
		.filter((call) => call.command === "herdr" && call.args.slice(0, 2).join(" ") === "agent prompt")
		.map((call) => JSON.parse(call.args[3]))
		.filter((prompt) => prompt.kind === "pr_health_repair");
	assert.equal(repairReviewPrompts().length, 0);
	const worktree = state.health?.worktree;
	const gateRuns = herdr.calls.filter((call) => call.command === "sh" && call.cwd === worktree).length;

	failHealthGate = false;
	state = await lifecycle.health(project.root, RUN_ID);
	assert.equal(state.health?.status, "reviewing");
	assert.equal(state.health?.commit, repair);
	assert.equal(state.health?.review_commit, repair);
	assert.equal(state.health?.review_exit_code, 0);
	assert.equal(herdr.calls.filter((call) => call.command === "sh" && call.cwd === worktree).length, gateRuns + 1);
	assert.equal(repairReviewPrompts().length, 1);
});

test("failed health gate restarts triage when PR head advances", async (t) => {
	const project = await makeProject(t);
	let failHealthGate = false;
	const herdr = fakeHerdr({ gate: (command) => failHealthGate
		? { code: 1, stdout: "", stderr: "health gate failed\n" }
		: { code: 0, stdout: `required gate passed: ${command}\n`, stderr: "" } });
	const lifecycle = makeLifecycle(combinedRunner(herdr, fakeGh(project.root)));
	let state = await finishInitialRun(project.root, lifecycle);
	state = await lifecycle.health(project.root, RUN_ID);
	state = await lifecycle.health(project.root, RUN_ID, healthEvent(state, {
		summary: "Repair required.", actionable: true, thread_ids: ["THREAD-1"], checks: [],
	}));
	const oldWorktree = state.health!.worktree!;
	const repair = await commit(oldWorktree, "health.txt", "healthy\n", "health repair");
	failHealthGate = true;
	state = await lifecycle.health(project.root, RUN_ID, requestReviewEvent(state, "final-check", repair));
	const gateRuns = herdr.calls.filter((call) => call.command === "sh" && call.cwd === oldWorktree).length;
	await advanceRemote(t, project.remote);

	state = await lifecycle.health(project.root, RUN_ID);

	assert.equal(state.health?.status, "triaging");
	assert.equal(state.health?.attempt, 2);
	assert.equal(state.health?.head, state.integration_head);
	assert.equal(state.health_history?.at(-1)?.review_exit_code, 1);
	assert.equal(herdr.calls.filter((call) => call.command === "sh" && call.cwd === oldWorktree).length, gateRuns);
	await assert.rejects(readFile(join(oldWorktree, "health.txt")), /ENOENT/);
});

test("PR health fast-forwards, uses amended final gate, pushes once, and resolves only fixed triaged threads", async (t) => {
	const project = await makeProject(t);
	const herdr = fakeHerdr();
	const gh = fakeGh(project.root);
	const lifecycle = makeLifecycle(combinedRunner(herdr, gh));
	let state = await finishInitialRun(project.root, lifecycle);
	const replacement = `bootstrap && ${FINAL_GATE_COMMAND}`;
	state = {
		...state,
		gate_command_amendments: [{
			issue_id: "final-check",
			previous_command: FINAL_GATE_COMMAND,
			replacement_command: replacement,
			failed_commit: state.integration_head,
			reason: "Bootstrap clean gates.",
			approved_at: "2026-08-09T00:00:00.000Z",
		}],
	};
	await writeRunState(project.root, state);
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
	const repairPrompt = herdr.calls
		.filter((call) => call.command === "herdr" && call.args.slice(0, 2).join(" ") === "agent prompt")
		.map((call) => JSON.parse(call.args[3]))
		.reverse()
		.find((value) => value.type === "auto_dag_pr_health_repair");
	assert.deepEqual(repairPrompt.required_gate, { command: replacement, amendments: state.gate_command_amendments });
	const repair = await commit(state.health!.worktree!, "health.txt", "healthy\n", "health repair");
	state = await lifecycle.health(project.root, RUN_ID, requestReviewEvent(state, "final-check", repair));
	assert.equal(state.health?.reviewer_agent, reviewer);
	assert.equal(state.health?.review_commit, repair);
	assert.equal(state.health?.review_command, replacement);
	assert.equal(state.health?.review_exit_code, 0);
	const reviewPrompt = herdr.calls
		.filter((call) => call.command === "herdr" && call.args[0] === "agent" && call.args[1] === "prompt" && call.args[2] === reviewer)
		.map((call) => JSON.parse(call.args[3]))
		.reverse()
		.find((value) => value.type === "auto_dag_review");
	assert.equal(reviewPrompt.kind, "pr_health_repair");
	assert.deepEqual(reviewPrompt.context.triage.thread_ids, ["THREAD-1", "THREAD-2"]);
	assert.deepEqual(reviewPrompt.context.gate_command_amendments, state.gate_command_amendments);
	assert.equal(reviewPrompt.gate.commit, repair);
	for (const key of ["run_id", "attempt", "review_round", "required_gate"]) assert.equal(key in reviewPrompt, false);
	state = await lifecycle.health(project.root, RUN_ID, healthReviewEvent(state, "approved", ["THREAD-1", "THREAD-2"]));

	assert.equal(state.health?.status, "completed");
	assert.deepEqual(state.health?.resolved_thread_ids, ["THREAD-1", "THREAD-2"]);
	assert.equal(gh.gitPushes, pushes + 1);
	assert.equal(gh.count("api graphql"), 1);
	assert.deepEqual(gh.resolved, ["THREAD-1", "THREAD-2"]);
	assert.equal(herdr.tabs.size, 0);
	assert.equal(await git(project.root, "show", "HEAD:health.txt"), "healthy");
});

test("accepted final approval recovers after PR push failure", async (t) => {
	const project = await makeProject(t);
	const herdr = fakeHerdr();
	const gh = fakeGh(project.root);
	const base = combinedRunner(herdr, gh);
	let failPush = true;
	const runner: CommandRunner = async (command, args, options) => {
		if (failPush && command === "git" && args[0] === "push") return { code: 1, stdout: "", stderr: "push unavailable" };
		return await base(command, args, options);
	};
	const lifecycle = makeLifecycle(runner);
	let state = await advanceToFinalReview(project.root, lifecycle);
	const message = reviewEvent(state, "final-check", "approved", []);
	const envelope = JSON.parse(message);

	await assert.rejects(lifecycle.resume(project.root, message), /push unavailable/);
	assert.equal(await readWorkerReceipt(envelope.receipt_path), undefined);

	failPush = false;
	state = await lifecycle.resume(project.root, message);
	assert.equal(state.phase, "completed");
	assert.equal((await readWorkerReceipt(envelope.receipt_path))?.status, "accepted");
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
	await assert.rejects(lifecycle.health(project.root, RUN_ID, healthReviewEvent(state, "approved", ["THREAD-1"])), /simulated crash/);
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
	await assert.rejects(lifecycle.health(project.root, RUN_ID, healthReviewEvent(state, "approved", ["THREAD-2"])), /simulated cleanup failure/);
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
		status: "approved",
		id: "pr-lifecycle-test",
		goal: "Exercise final checks and retained PR health.",
		constraints: ["local"],
		non_goals: [],
		issues: [
			{
				id: "alpha",
				title: "Alpha",
				profile: "backend",
				objective: "Implement alpha.",
				acceptance: ["alpha works"],
				testing: "npm test -- alpha",
				depends_on: [],
			},
		],
		final_check: { acceptance: ["verified"], testing: FINAL_GATE_COMMAND },
	};
}

async function makeProject(t: TestContext, options: { maxReviews?: number } = {}): Promise<{ root: string; remote: string }> {
	const root = await mkdtemp(join(tmpdir(), "pi-auto-dag-pr-lifecycle-"));
	t.after(async () => { await rm(root, { recursive: true, force: true }); });
	await git(root, "init", "-b", "main");
	await git(root, "config", "user.email", "test@example.com");
	await git(root, "config", "user.name", "Test User");
	await createTestProfiles(root);
	const agentDir = await mkdtemp(join(tmpdir(), "pi-auto-dag-agent-"));
	t.after(async () => { await rm(agentDir, { recursive: true, force: true }); });
	await mkdir(join(agentDir, "config"), { recursive: true });
	await writeFile(join(agentDir, "config", "pi-auto-dag.json"), JSON.stringify(testProfileConfig(root, { maxParallel: 1, maxReviews: options.maxReviews ?? 2 })));
	useAgentDir(t, agentDir);
	await writeFile(join(root, ".gitignore"), ".context/\n.local-tools/\nnode_modules/\n");
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
): string {
	const task = state.tasks[issueId];
	return event(state, issueId, "reviewer", "submit_review", { verdict, findings }, reviewId({
		run_id: state.run_id,
		kind: issueId !== "final-check" ? "implementation" : task.status === "repair_reviewing" ? "final_repair" : "final_check",
		issue_id: issueId,
		commit: task.commit!,
		attempt: task.attempts,
		review_round: task.review_rounds!,
	}), {
		attempt: task.attempts,
		review_round: task.review_rounds!,
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
): string {
	const health = state.health!;
	return event(state, "final-check", "reviewer", "submit_review", { verdict, findings }, reviewId({
		run_id: state.run_id,
		kind: "pr_health_repair",
		issue_id: "final-check",
		commit: health.commit!,
		attempt: health.attempt!,
		review_round: health.review_round!,
	}), {
		attempt: health.attempt!,
		review_round: health.review_round!,
		commit: health.commit,
	});
}

function event(
	state: RunState,
	issueId: string,
	role: "implementer" | "reviewer",
	type: string,
	payload: Record<string, unknown>,
	review_id?: string,
	metadata: { attempt?: number; review_round?: number; commit?: string } = {},
): string {
	const eventPayload = { ...payload };
	const attempt = metadata.attempt ?? Number(eventPayload.attempt ?? 1);
	const review_round = metadata.review_round ?? Number(eventPayload.review_round ?? 1);
	const commit = metadata.commit ?? (typeof eventPayload.commit === "string" ? eventPayload.commit : undefined);
	delete eventPayload.attempt;
	delete eventPayload.review_round;
	if (type === "request_review") delete eventPayload.commit;
	const suffix = commit ? `-${commit.slice(0, 12).replace(/[^A-Za-z0-9_-]/g, "_")}` : "";
	const event_id = `${type}-${issueId}-${attempt}-${review_round}${suffix}`;
	return JSON.stringify({
		version: 1,
		type,
		run_id: state.run_id,
		issue_id: issueId,
		role,
		event_id,
		attempt,
		review_round,
		receipt_path: eventReceiptPath(state.main_worktree, state.run_id, event_id),
		...(review_id ? { review_id } : {}),
		...(type === "request_review" ? { commit } : {}),
		payload: eventPayload,
	});
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
		if (command === "herdr" || command === "sh") return await herdr.runner(command, args, options);
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
