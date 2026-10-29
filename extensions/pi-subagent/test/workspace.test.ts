import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CheckedGitRuntime } from "../src/git-runtime.ts";
import { IntegrationGit } from "../src/integration-git.ts";
import { runProcess } from "../src/process.ts";
import type { CoordinatorRuntime, HostRuntime, OperationContext } from "../src/runner.ts";
import type { ExecutionPolicySnapshot } from "../src/schema.ts";
import { WorkspaceRunner, workspacePruneOwners } from "../src/workspace.ts";
import { parseWorkspaceRequest, type WorkspaceRequest, type WorkspaceState } from "../src/workspace-schema.ts";
import { resolveWorkspaceScope, workspaceInputPath } from "../src/workspace-scope.ts";

const git = (root: string, ...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const policy: ExecutionPolicySnapshot = { maxSubagents: 2, maxTurns: 10, childIdleMs: 10_000, childMaxMs: 60_000, maxCorrections: 1 };
async function fixture(t: test.TestContext, integration = new IntegrationGit(), work?: (paths: Readonly<Record<string, string>>, signal: AbortSignal) => Promise<void>) {
	const temp = await realpath(await mkdtemp(join(tmpdir(), "subagent-workspace-")));
	t.after(() => rm(temp, { recursive: true, force: true }));
	const root = join(temp, "workspace"), agentDir = join(temp, "agent"); await mkdir(root);
	const repositories = { service: join(root, "service"), client: join(root, "client") };
	for (const path of Object.values(repositories)) {
		await mkdir(path); git(path, "init", "-qb", "main");
		git(path, "config", "user.name", "Git Test"); git(path, "config", "user.email", "test@example.com"); git(path, "config", "commit.gpgsign", "false");
		await writeFile(join(path, "package.json"), JSON.stringify({ packageManager: JSON.parse(await readFile(new URL("../../../package.json", import.meta.url), "utf8")).packageManager, scripts: { test: 'node -e "if (!process.env.PI_SUBAGENT_REPOSITORIES) process.exit(2)"' } }));
		await writeFile(join(path, "file.txt"), "base\n"); git(path, "add", "."); git(path, "commit", "-qm", "base");
	}
	const input = join(root, "contract.txt"); await writeFile(input, "contract\n");
	const check = (repository: string) => ({ repository, command: process.execPath, args: ["-e", "const fs=require('node:fs'); const paths=JSON.parse(process.env.PI_SUBAGENT_REPOSITORIES); if(Object.keys(paths).length!==2)process.exit(3); for(const path of Object.values(paths))fs.readFileSync(path+'/file.txt'); fs.readFileSync(JSON.parse(process.env.PI_SUBAGENT_INPUTS).contract);"] });
	const request: WorkspaceRequest = { mode: "isolated", id: "set-change", goal: "Change both selected repositories.", repositories,
		tasks: [{ id: "change", kind: "changeset", role: "implementer", modelClass: "balanced", requirements: "Change the selected files.", deliverable: "Two clean committed candidates.", dependsOn: [], contextFrom: [], checks: [check("service"), check("client")], inputs: { contract: input } }], finalChecks: [check("service"), check("client")] };
	const inspector = new CheckedGitRuntime();
	const coordinator: CoordinatorRuntime = {
		now: Date.now, randomToken: () => "a".repeat(24),
		async preflight({ cwd }) { return { root: cwd, main: await inspector.inspectMainBase({ root: cwd }, { signal: new AbortController().signal }) }; },
		async acquireLaunch() { return { launch: { role: "implementer", modelClass: "balanced", model: "test/model", thinkingLevel: "high", args: [], env: {}, tools: [] }, async cleanup() {} }; },
	};
	let launches = 0, running = false;
	const host: HostRuntime = {
		async planHostAllocation({ kind, attempt }) {
			const info = attempt.allocations.find((item) => item.kind === "worktree")!;
			assert.equal(info.kind, "worktree"); const cwd = info.worktree!.cwd;
			if (kind === "workspace") return { kind, label: "workspace", worktreeCwd: cwd, mainRoot: repositories.service, repoKey: join(repositories.service, ".git"), herdrRepoRoot: repositories.service };
			if (kind === "worker_tab") return { kind, label: "worker", workspaceId: "workspace", workspaceRootTabId: "root-tab", workspaceRootPaneId: "root-pane", worktreeCwd: cwd, leasePath: join(agentDir, "lease") };
			return { kind, agentName: "agent", workspaceId: "workspace", tabId: "tab", paneId: "pane", worktreeCwd: cwd, leasePath: join(agentDir, "lease") };
		},
		async allocateHost({ intent, acquireLaunch }) {
			if (intent.kind === "workspace") return { kind: "workspace", outcome: "owned", workspaceId: "workspace", rootTabId: "root-tab", rootPaneId: "root-pane" };
			if (intent.kind === "worker_tab") return { kind: "worker_tab", outcome: "owned", tabId: "tab", paneId: "pane" };
			await (await acquireLaunch!()).cleanup(); launches++; running = true;
			return { kind: "agent", outcome: "owned" };
		},
		async runWorker({ workspacePaths, task, attempt }, { signal }) {
			assert.ok(workspacePaths);
			if (work) await work(workspacePaths, signal);
			else for (const path of Object.values(workspacePaths)) await commit(path, "changed\n");
			return { outcome: "candidate", candidate: (await inspector.inspectInFlightTaskCandidate({ root: repositories.service, task, attempt }, { signal })).candidate };
		},
		async reconcileHostAllocation({ intent }) { return { kind: intent.kind, outcome: "absent" }; },
		async reconcileWorkerTermination() { return { outcome: running ? "active" : "terminated" }; },
		async terminateWorker() { running = false; return { outcome: "terminated" }; },
		async cleanupHost() { return { outcome: "completed" }; },
	};
	const options = { coordinator, host: () => host, preflightHost: async () => {}, policy: () => policy, agentDir, integration,
		execute: async (command: string, args: string[], options: Parameters<typeof runProcess>[2]) => {
			// Exercise orchestration without a package manager creating install artifacts in fixtures.
			if (command === "pnpm") { assert.deepEqual(args, ["test"]); return await runProcess(process.execPath, ["-e", "if (!process.env.PI_SUBAGENT_REPOSITORIES) process.exit(2)"], options); }
			return await runProcess(command, args, options);
		} };
	return { root, request, repositories, input, agentDir, host, options, runner: new WorkspaceRunner(options), reload: () => new WorkspaceRunner(options), launches: () => launches, running: () => running };
}
async function commit(path: string, text: string) { await writeFile(join(path, "file.txt"), text); git(path, "add", "file.txt"); git(path, "commit", "-qm", "change"); }
async function staged(f: Awaited<ReturnType<typeof fixture>>) {
	let state = await f.runner.execute(f.request, f.root);
	assert.equal(state.status, "ready", state.failure ?? "");
	assert.equal(f.launches(), 1, "one worker owns the complete set");
	state = await f.runner.action({ id: f.request.id, action: "stage", expected: state.candidates }, f.root);
	assert.equal(state.status, "staged", state.failure ?? "");
	state = await f.runner.action({ id: f.request.id, action: "validate", expected: state.tips }, f.root);
	assert.equal(state.status, "validated", state.failure ?? "");
	return state;
}

test("one worker changes two repositories; exact full checks precede serial promotion and guarded cleanup", async (t) => {
	const f = await fixture(t);
	const state = await staged(f);
	assert.deepEqual(Object.keys(state.final!.before), ["service", "client"]);
	const incomplete = await f.runner.action({ id: f.request.id, action: "promote", expected: { service: state.tips!.service } }, f.root);
	assert.match(incomplete.failure!, /complete/);
	assert.equal(git(f.repositories.service, "rev-parse", "HEAD"), state.repositories.service!.base.head);
	const promoted = await f.runner.action({ id: f.request.id, action: "promote", expected: state.tips }, f.root);
	assert.equal(promoted.status, "promoted", promoted.failure ?? "");
	for (const [name, path] of Object.entries(f.repositories)) {
		assert.equal(git(path, "rev-parse", "HEAD"), state.tips![name]!.head);
		assert.equal(promoted.repositories[name]!.promotion!.status, "promoted");
	}
	assert.equal(await readFile(f.input, "utf8"), "contract\n");
	const cleaned = await f.runner.action({ id: f.request.id, action: "cleanup" }, f.root);
	assert.equal(cleaned.status, "cleaned", cleaned.failure ?? "");
	assert.equal((await f.runner.action({ id: f.request.id, action: "cleanup" }, f.root)).status, "cleaned");
});

test("dirty Main is preserved during worker execution and blocks every target before promotion", async (t) => {
	const f = await fixture(t);
	await writeFile(join(f.repositories.client, "unrelated.txt"), "keep\n");
	let state = await f.runner.execute(f.request, f.root);
	assert.equal(state.status, "ready", state.failure ?? "");
	state = await f.runner.action({ id: f.request.id, action: "stage", expected: state.candidates }, f.root);
	assert.equal(state.status, "ready", state.failure ?? "");
	assert.match(state.failure!, /dirty|not clean|changes/i);
	assert.equal(await readFile(join(f.repositories.client, "unrelated.txt"), "utf8"), "keep\n");
	await rm(join(f.repositories.client, "unrelated.txt"));
	state = await f.runner.action({ id: f.request.id, action: "stage", expected: state.candidates }, f.root);
	state = await f.runner.action({ id: f.request.id, action: "validate", expected: state.tips }, f.root);
	await writeFile(join(f.repositories.client, "unrelated.txt"), "keep again\n");
	state = await f.runner.action({ id: f.request.id, action: "promote", expected: state.tips }, f.root);
	assert.equal(state.status, "validated", state.failure ?? "");
	for (const [name, path] of Object.entries(f.repositories)) assert.equal(git(path, "rev-parse", "HEAD"), state.repositories[name]!.base.head);
	assert.equal(await readFile(join(f.repositories.client, "unrelated.txt"), "utf8"), "keep again\n");
});

test("native checks work without manifests or test scripts and require task and final coverage", async (t) => {
	const f = await fixture(t);
	await rm(join(f.repositories.service, "package.json"));
	git(f.repositories.service, "add", "package.json"); git(f.repositories.service, "commit", "-qm", "remove manifest");
	await writeFile(join(f.repositories.client, "package.json"), JSON.stringify({ name: "no-test-script" }));
	git(f.repositories.client, "add", "package.json"); git(f.repositories.client, "commit", "-qm", "remove test script");
	f.request.tasks[0]!.checks = f.request.finalChecks = Object.keys(f.repositories).map((repository) => ({ repository, command: "git", args: ["diff", "--check"] }));
	assert.throws(() => parseWorkspaceRequest({ ...f.request, finalChecks: [f.request.finalChecks[0]] }), /Final checks are missing/);
	assert.throws(() => parseWorkspaceRequest({ ...f.request, tasks: [{ ...f.request.tasks[0], checks: [f.request.tasks[0]!.checks[0]] }] }), /Task checks are missing/);
	const state = await staged(f);
	assert.equal(state.repositories.service!.testScript, undefined);
	assert.equal(state.repositories.client!.testScript, undefined);
	assert.deepEqual(state.final!.results.map(({ repository }) => repository), ["service", "client"]);
});

test("pnpm checks pin the committed script instead of dirty Main", async (t) => {
	const f = await fixture(t);
	f.request.tasks[0]!.checks.push({ repository: "client", command: "pnpm", args: ["test"] });
	const manifest = join(f.repositories.client, "package.json");
	await writeFile(manifest, JSON.stringify({ scripts: { test: "echo dirty" } }));
	const state = await f.runner.execute(f.request, f.root);
	assert.equal(state.status, "ready", state.failure ?? "");
	assert.notEqual(state.repositories.client!.testScript, "echo dirty");
	assert.match(await readFile(manifest, "utf8"), /echo dirty/);
});

test("a worker cannot replace a pnpm test script with dirty Main's version", async (t) => {
	const f = await fixture(t, new IntegrationGit(), async (paths) => {
		await writeFile(join(paths.client!, "package.json"), JSON.stringify({ scripts: { test: "echo dirty" } }));
		git(paths.client!, "add", "package.json"); git(paths.client!, "commit", "-qm", "change test script");
	});
	f.request.tasks[0]!.checks.push({ repository: "client", command: "pnpm", args: ["run", "test"] });
	await writeFile(join(f.repositories.client, "package.json"), JSON.stringify({ scripts: { test: "echo dirty" } }));
	const state = await f.runner.execute(f.request, f.root);
	assert.equal(state.status, "attention"); assert.match(state.failure!, /test script changed/);
});

test("cleanup resumes after a later repository fails", async (t) => {
	let calls = 0;
	class InterruptedCleanup extends IntegrationGit {
		override async release(...args: Parameters<IntegrationGit["release"]>) {
			if (++calls === 5) return { outcome: "blocked" as const, failure: "cleanup blocked" };
			return await super.release(...args);
		}
	}
	const f = await fixture(t, new InterruptedCleanup());
	let state = await staged(f);
	state = await f.runner.action({ id: f.request.id, action: "promote", expected: state.tips }, f.root);
	assert.equal(state.status, "promoted", state.failure ?? "");
	state = await f.runner.action({ id: f.request.id, action: "cleanup" }, f.root);
	assert.equal(state.status, "promoted"); assert.match(state.failure!, /cleanup blocked/);
	state = await f.reload().action({ id: f.request.id, action: "cleanup" }, f.root);
	assert.equal(state.status, "cleaned", state.failure ?? "");
});

test("a lost promotion response is reconciled without replay or rollback; remaining targets need an explicit action", async (t) => {
	let calls = 0;
	class Interrupted extends IntegrationGit {
		override async promote(...args: Parameters<IntegrationGit["promote"]>) {
			const result = await super.promote(...args); calls++;
			if (calls === 1 && result.outcome === "ready") throw new Error("lost response after first repository moved");
			return result;
		}
	}
	const f = await fixture(t, new Interrupted());
	let state = await staged(f);
	state = await f.runner.action({ id: f.request.id, action: "promote", expected: state.tips }, f.root);
	assert.equal(state.status, "partial"); assert.equal(state.repositories.service!.promotion!.status, "promoting");
	assert.equal(git(f.repositories.client, "rev-parse", "HEAD"), state.repositories.client!.base.head);
	const reloaded = f.reload();
	state = await reloaded.action({ id: f.request.id, action: "promote", expected: state.tips }, f.root);
	assert.match(state.failure!, /Reconcile/); assert.equal(calls, 1);
	state = await reloaded.action({ id: f.request.id, action: "reconcile" }, f.root);
	assert.equal(state.status, "partial", state.failure ?? ""); assert.equal(state.repositories.service!.promotion!.status, "promoted");
	assert.equal(calls, 1);
	state = await reloaded.action({ id: f.request.id, action: "promote", expected: state.tips }, f.root);
	assert.equal(state.status, "promoted", state.failure ?? ""); assert.equal(calls, 2);
});

test("unchanged members remain in checks and prune ownership; changed root inputs stop promotion", async (t) => {
	const f = await fixture(t, new IntegrationGit(), async (paths) => await commit(paths.client!, "changed client\n"));
	const state = await staged(f);
	assert.equal(state.repositories.service!.stage, "unchanged");
	const owners = await workspacePruneOwners(Object.values(f.repositories), f.agentDir);
	const worktree = state.repositories.service!.attempt.allocations.find((item) => item.kind === "worktree")!;
	assert.equal(worktree.kind, "worktree");
	assert.ok(owners.some((owner) => owner.text?.includes(worktree.worktree!.path)));
	await writeFile(f.input, "new contract\n");
	const blocked = await f.runner.action({ id: f.request.id, action: "promote", expected: state.tips }, f.root);
	assert.match(blocked.failure!, /input changed/);
	for (const [name, path] of Object.entries(f.repositories)) assert.equal(git(path, "rev-parse", "HEAD"), state.repositories[name]!.base.head);
	assert.equal(await readFile(f.input, "utf8"), "new contract\n", "inputs are never restored or promoted");
});

test("cancellation stops the task-wide worker and retains every repository allocation", async (t) => {
	let started!: () => void; const start = new Promise<void>((resolve) => { started = resolve; });
	const f = await fixture(t, new IntegrationGit(), async (_paths, signal) => {
		started(); await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
	});
	const controller = new AbortController();
	const run = f.runner.execute(f.request, f.root, controller.signal);
	await start; controller.abort();
	const state = await run;
	assert.equal(state.status, "aborted"); assert.equal(f.running(), false);
	for (const repo of Object.values(state.repositories)) {
		const intent = repo.attempt.allocations.find((item) => item.kind === "worktree")!;
		assert.equal(intent.kind, "worktree"); assert.equal(await realpath(intent.worktree!.path), intent.worktree!.path);
	}
	assert.equal((await f.reload().status(f.root, f.request.id)).status, "aborted");
});

test("selection rejects aliases, unselected Git input sources, and unsupported graph shapes before effects", async (t) => {
	const f = await fixture(t);
	const alias = join(f.root, "alias"); await symlink(f.repositories.service, alias);
	await assert.rejects(resolveWorkspaceScope(f.root, { service: alias }), /canonical/);
	await assert.rejects(resolveWorkspaceScope(f.repositories.service, f.repositories), /non-Git/);
	const scope = await resolveWorkspaceScope(f.root, { service: f.repositories.service });
	await assert.rejects(workspaceInputPath(scope, join(f.repositories.client, "file.txt")), /Git repository/);
	assert.throws(() => parseWorkspaceRequest({ ...f.request, tasks: [...f.request.tasks, ...f.request.tasks] }), /one changeset/);
	assert.throws(() => parseWorkspaceRequest({ ...f.request, finalJudgment: { role: "reviewer", modelClass: "balanced", criterion: "Review" } }), /judgment/);
	assert.equal(f.launches(), 0);
});

test("worker deadlines retain exact failure and termination evidence, release leases, and permit recovery", async (t) => {
	const f = await fixture(t);
	f.options.coordinator.now = () => 1_000;
	let started!: () => void;
	const start = new Promise<void>((resolve) => { started = resolve; });
	let operation!: OperationContext;
	let prompts = 0;
	f.host.runWorker = async (input, context) => {
		prompts++;
		assert.equal(input.idleMs, policy.childIdleMs);
		operation = context;
		started();
		return await new Promise((_resolve, reject) => context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true }));
	};
	const terminate = f.host.terminateWorker.bind(f.host);
	let uncertain = true;
	f.host.terminateWorker = async (input, context) => {
		const saved = await f.reload().status(f.root, f.request.id);
		const attempt = saved.repositories.service!.attempt;
		assert.equal(attempt.prompts[0]!.status, "ambiguous");
		assert.match(attempt.prompts[0]!.failure!, /deadline/);
		assert.equal(attempt.termination!.workerId, input.workerId);
		assert.equal(attempt.termination!.status, "terminating");
		assert.equal(context.signal.aborted, false, "termination has its own safety budget");
		if (uncertain) return { outcome: "unknown", failure: "exact stop not yet proved" };
		return await terminate(input, context);
	};
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const run = f.runner.execute(f.request, f.root);
	await start;
	assert.equal(operation.deadline, 1_000 + policy.childMaxMs);
	assert.equal(operation.timeoutMs, policy.childMaxMs);
	t.mock.timers.tick(policy.childMaxMs);
	let state = await run;
	assert.equal(state.status, "attention");
	assert.match(state.failure!, /deadline.*\nTermination: exact stop not yet proved/);
	assert.equal(operation.signal.aborted, true);
	assert.equal(state.repositories.service!.attempt.termination!.status, "unknown");
	assert.equal(state.preliminary, undefined);
	assert.equal(f.running(), true);
	uncertain = false;
	state = await f.reload().action({ id: f.request.id, action: "abort" }, f.root);
	assert.equal(state.status, "aborted", state.failure ?? "");
	assert.equal(state.repositories.service!.attempt.termination!.status, "terminated");
	assert.equal(f.running(), false);
	assert.equal(prompts, 1, "recovery never replays the uncertain prompt");
	for (const repo of Object.values(state.repositories)) {
		const allocation = repo.attempt.allocations.find((item) => item.kind === "worktree")!;
		assert.equal(allocation.kind, "worktree");
		assert.equal(await realpath(allocation.worktree!.path), allocation.worktree!.path);
	}
});

for (const check of [
	{ command: "pnpm", args: ["--silent", "test"] },
	{ command: "/usr/local/bin/pnpm", args: ["test"] },
	{ command: process.execPath, args: ["-e", "process.exit(0)"] },
]) test(`committed test scripts stay pinned for ${check.command} ${check.args.join(" ")}`, async (t) => {
	const f = await fixture(t, new IntegrationGit(), async (paths) => {
		await writeFile(join(paths.client!, "package.json"), JSON.stringify({ scripts: { test: "echo changed" } }));
		git(paths.client!, "add", "package.json"); git(paths.client!, "commit", "-qm", "replace test script");
	});
	f.request.tasks[0]!.checks = Object.keys(f.repositories).map((repository) => ({ ...check, repository }));
	await writeFile(join(f.repositories.client, "package.json"), JSON.stringify({ scripts: { test: "echo changed" } }));
	const committed = JSON.parse(git(f.repositories.client, "show", "HEAD:package.json")).scripts.test;
	f.options.execute = async () => assert.fail("changed pinned scripts must block every check command");
	const state = await f.runner.execute(f.request, f.root);
	assert.equal(state.repositories.client!.testScript, committed);
	assert.equal(state.status, "attention");
	assert.match(state.failure!, /test script changed: client/);
	assert.equal((await f.reload().status(f.root, f.request.id)).failure, state.failure);
	assert.equal(JSON.parse(await readFile(join(f.repositories.client, "package.json"), "utf8")).scripts.test, "echo changed");
});
