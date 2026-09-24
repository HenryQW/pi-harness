import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { CheckedGitRuntime } from "../src/git-runtime.ts";
import {
	HerdrHostRuntime,
	workspaceLabel,
	type HostProcessOptions,
	type HostProcessRunner,
} from "../src/herdr-runtime.ts";
import type { InFlightTaskCandidateInspection, OperationContext, VerifiedLaunch } from "../src/runner.ts";
import type {
	AllocationKind,
	AgentAllocationIntent,
	AgentAllocationPlan,
	HostAllocationIntent,
	HostAllocationPlan,
	TaskAttempt,
	WorkerTabAllocationIntent,
	WorkerTabAllocationPlan,
	WorktreeAllocationIntent,
	WorkspaceAllocationIntent,
	WorkspaceAllocationPlan,
	TaskRequest,
	WorkspaceIdentity,
} from "../src/schema.ts";

const TOKEN = "0123456789abcdef01234567";
const REQUEST_ID = "deliver-request";
const WORKSPACE_ID = "workspace-owned";
const ROOT_TAB_ID = "tab-root";
const ROOT_PANE_ID = "pane-root";
const WORKER_TAB_ID = "tab-worker";
const WORKER_PANE_ID = "pane-worker";
const AGENT_NAME = `o-${TOKEN}-agent`;
const WORKSPACE_LABEL = workspaceLabel({ correlationToken: TOKEN });
const WORKER_LABEL = "implementer/fast";
const GOAL = "Deliver the complete checked request.";
const oid = (character: string): string => character.repeat(40);
const baseIdentity = (branch = "refs/heads/task-a"): WorkspaceIdentity => ({
	branch,
	head: oid("a"),
	index: oid("a"),
	tree: oid("a"),
});
const changedIdentity = (): WorkspaceIdentity => ({
	branch: "refs/heads/task-a",
	head: oid("b"),
	index: oid("b"),
	tree: oid("b"),
});

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

const task: TaskRequest = {
	id: "task-a",
	kind: "changeset",
	role: "implementer",
	modelClass: "fast",
	requirements: "Implement the exact task.",
	deliverable: "Commit the complete result.",
	dependsOn: [],
	contextFrom: [],
	checks: [{ command: "pnpm", args: ["test"] }],
};

const context = (): OperationContext => {
	const controller = new AbortController();
	return { signal: controller.signal, deadline: 20_000, timeoutMs: 19_000 };
};

function success(result: Record<string, unknown>): { code: number; stdout: string; stderr: string } {
	return { code: 0, stdout: JSON.stringify({ id: "request-1", result }), stderr: "" };
}

function failure(code: string, killed = false): { code: number; stdout: string; stderr: string; killed?: boolean } {
	return { code: killed ? 124 : 1, stdout: "", stderr: JSON.stringify({ error: { code } }), ...(killed ? { killed: true } : {}) };
}

type ProcessResult = Awaited<ReturnType<HostProcessRunner>>;
type ExpectedArgs = readonly string[] | ((args: readonly string[], options: HostProcessOptions) => void);
type Step = {
	command: string;
	args: ExpectedArgs;
	result?: ProcessResult;
	error?: Error;
};

class ScriptedProcess {
	readonly calls: Array<{ command: string; args: string[]; options: HostProcessOptions }> = [];
	readonly steps: Step[] = [];

	push(...steps: Step[]): void { this.steps.push(...steps); }

	readonly run: HostProcessRunner = async (command, args, options) => {
		this.calls.push({ command, args: [...args], options });
		const step = this.steps.shift();
		assert.ok(step, `unexpected process call: ${command} ${args.join(" ")}`);
		assert.equal(command, step.command);
		if (typeof step.args === "function") step.args(args, options);
		else assert.deepEqual(args, step.args);
		if (step.error) throw step.error;
		return step.result ?? { code: 0, stdout: "", stderr: "" };
	};

	done(): void { assert.deepEqual(this.steps, []); }
}

type Paths = { directory: string; root: string; repoRoot: string; commonDirectory: string; worktree: string; leases: string };

async function paths(t: test.TestContext): Promise<Paths> {
	const directory = await realpath(await mkdtemp(join(tmpdir(), "pi-subagent-herdr-")));
	t.after(async () => await rm(directory, { recursive: true, force: true }));
	const root = join(directory, "main");
	const repoRoot = join(directory, "repo");
	const commonDirectory = join(repoRoot, ".git");
	const worktree = join(directory, "worktree");
	const leases = join(directory, "leases");
	await Promise.all([mkdir(root), mkdir(commonDirectory, { recursive: true }), mkdir(worktree)]);
	return { directory, root, repoRoot, commonDirectory, worktree, leases };
}

let randomSequence = 0;

type TaskCandidateInput = { root: string; task: TaskRequest; attempt: TaskAttempt };

function runtime(
	paths: Paths,
	script: ScriptedProcess,
	inspectCandidate: (input: TaskCandidateInput, operation: OperationContext) => Promise<WorkspaceIdentity> = async () => changedIdentity(),
	timing: {
		delay?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
		now?: () => number;
		inspectInFlightTaskCandidate?: (input: TaskCandidateInput, operation: OperationContext) => Promise<InFlightTaskCandidateInspection>;
	} = {},
): HerdrHostRuntime {
	return new HerdrHostRuntime({
		inspectInFlightTaskCandidate: timing.inspectInFlightTaskCandidate ?? (async (input, operation) => ({
			candidate: await inspectCandidate(input, operation),
			clean: true,
			valid: true,
		})),
		runProcess: script.run,
		killProcess: () => {},
		delay: timing.delay ?? (async () => {}),
		now: timing.now ?? (() => 1_000),
		randomId: () => (++randomSequence).toString(16).padStart(32, "0"),
		env: { HERDR_ENV: "1", HERDR_PANE_ID: "pane-current" },
		leaseDirectory: paths.leases,
		lsofCommand: "lsof-test",
	});
}

function baseAttempt(paths: Paths, token = TOKEN): TaskAttempt {
	return {
		number: 1,
		waveNumber: 1,
		waveBase: baseIdentity("refs/heads/main"),
		correlationToken: token,
		allocationGeneration: 1,
		allocations: [{
			kind: "worktree",
			generation: 1,
			token,
			status: "owned",
			worktree: {
				path: paths.worktree,
				cwd: paths.worktree,
				branch: "task-a",
				repoRoot: paths.root,
				baseCommit: oid("a"),
			},
		}],
		prompts: [],
		cleanup: ["worker_tab", "workspace", "worktree", "branch"].map((kind) => ({
			kind: kind as "worker_tab" | "workspace" | "worktree" | "branch",
			status: "pending" as const,
		})),
	};
}

function repositoryIdentityStep(paths: Paths, result: ProcessResult = { code: 0, stdout: `${paths.commonDirectory}\n`, stderr: "" }): Step {
	return {
		command: "git",
		args: ["rev-parse", "--path-format=absolute", "--git-common-dir"],
		result,
	};
}

type HostKind = Exclude<AllocationKind, "worktree">;
type HostIntentOfKind<Kind extends HostKind> = Extract<HostAllocationIntent, { kind: Kind }>;

async function plannedIntent<Kind extends HostKind>(
	host: HerdrHostRuntime,
	attempt: TaskAttempt,
	kind: Kind,
	paths: Paths,
	script: ScriptedProcess,
): Promise<HostIntentOfKind<Kind>> {
	if (kind === "workspace") script.push(repositoryIdentityStep(paths));
	const plan = await host.planHostAllocation({ requestId: REQUEST_ID, goal: GOAL, kind, task, attempt }, context());
	assert.equal(plan.kind, kind);
	const intent = {
		...plan,
		generation: attempt.allocationGeneration,
		token: attempt.correlationToken,
		status: "allocating" as const,
	} as HostIntentOfKind<Kind>;
	attempt.allocations.push(intent);
	return intent;
}

function addOwnedWorkspace(attempt: TaskAttempt, plan: WorkspaceAllocationPlan): WorkspaceAllocationIntent {
	const intent: WorkspaceAllocationIntent = {
		...plan, generation: attempt.allocationGeneration, token: attempt.correlationToken,
		status: "owned", workspaceId: WORKSPACE_ID, rootTabId: ROOT_TAB_ID, rootPaneId: ROOT_PANE_ID,
	};
	attempt.allocations.push(intent);
	return intent;
}

function addOwnedTab(attempt: TaskAttempt, plan: WorkerTabAllocationPlan): WorkerTabAllocationIntent {
	const intent: WorkerTabAllocationIntent = {
		...plan, generation: attempt.allocationGeneration, token: attempt.correlationToken,
		status: "owned", tabId: WORKER_TAB_ID, paneId: WORKER_PANE_ID,
	};
	attempt.allocations.push(intent);
	return intent;
}

async function fullAttempt(paths: Paths, host: HerdrHostRuntime, script: ScriptedProcess): Promise<{ attempt: TaskAttempt; leasePath: string }> {
	const attempt = baseAttempt(paths);
	script.push(repositoryIdentityStep(paths));
	const workspacePlan = await host.planHostAllocation({ requestId: REQUEST_ID, goal: GOAL, kind: "workspace", task, attempt }, context()) as WorkspaceAllocationPlan;
	addOwnedWorkspace(attempt, workspacePlan);
	const tabPlan = await host.planHostAllocation({ requestId: REQUEST_ID, goal: GOAL, kind: "worker_tab", task, attempt }, context()) as WorkerTabAllocationPlan;
	const leasePath = tabPlan.leasePath;
	addOwnedTab(attempt, tabPlan);
	const agentPlan = await host.planHostAllocation({ requestId: REQUEST_ID, goal: GOAL, kind: "agent", task, attempt }, context()) as AgentAllocationPlan;
	attempt.allocations.push({
		...agentPlan, generation: attempt.allocationGeneration, token: attempt.correlationToken, status: "owned",
	});
	return { attempt, leasePath };
}

async function plannedAgentName(paths: Paths, host: HerdrHostRuntime, token: string): Promise<string> {
	const attempt = baseAttempt(paths, token);
	addOwnedWorkspace(attempt, {
		kind: "workspace", label: workspaceLabel(attempt), worktreeCwd: paths.worktree,
		mainRoot: paths.root, repoKey: await realpath(paths.commonDirectory), herdrRepoRoot: await realpath(paths.repoRoot),
	});
	addOwnedTab(attempt, {
		kind: "worker_tab", label: WORKER_LABEL, workspaceId: WORKSPACE_ID,
		workspaceRootTabId: ROOT_TAB_ID, workspaceRootPaneId: ROOT_PANE_ID, worktreeCwd: paths.worktree,
		leasePath: join(paths.leases, token, `${"a".repeat(32)}.lease`),
	});
	const agentPlan = await host.planHostAllocation({ requestId: REQUEST_ID, goal: GOAL, kind: "agent", task, attempt }, context()) as AgentAllocationPlan;
	return agentPlan.agentName;
}

async function privateLease(path: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	await writeFile(path, "", { mode: 0o600 });
	await chmod(path, 0o600);
}

function workspaceInfo(paths: Paths, overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		workspace_id: WORKSPACE_ID,
		label: WORKSPACE_LABEL,
		focused: false,
		worktree: { checkout_path: paths.worktree, repo_key: paths.commonDirectory, repo_root: paths.repoRoot },
		...overrides,
	};
}

function worktreeListResult(
	paths: Paths,
	worktrees: readonly Record<string, unknown>[],
	sourceOverrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		type: "worktree_list",
		source: {
			source_checkout_path: paths.worktree,
			repo_key: paths.commonDirectory,
			repo_root: paths.repoRoot,
			...sourceOverrides,
		},
		worktrees,
	};
}

function tabInfo(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return { tab_id: WORKER_TAB_ID, workspace_id: WORKSPACE_ID, label: WORKER_LABEL, focused: false, pane_count: 0, ...overrides };
}

function paneListStep(panes: Record<string, unknown>[]): Step {
	return {
		command: "herdr",
		args: ["pane", "list", "--workspace", WORKSPACE_ID],
		result: success({ type: "pane_list", panes }),
	};
}

function rootPanes(extra: Record<string, unknown>[] = []): Record<string, unknown>[] {
	return [{ pane_id: ROOT_PANE_ID, tab_id: ROOT_TAB_ID, workspace_id: WORKSPACE_ID }, ...extra];
}

function layoutSettleSteps(extra: Record<string, unknown>[] = []): Step[] {
	const panes = rootPanes(extra);
	return [paneListStep(panes), paneListStep(panes)];
}

function agentInfo(status = "idle", ready = true, overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		name: AGENT_NAME,
		pane_id: WORKER_PANE_ID,
		tab_id: WORKER_TAB_ID,
		workspace_id: WORKSPACE_ID,
		cwd: overrides.cwd ?? "",
		agent_status: status,
		interactive_ready: ready,
		...overrides,
	};
}

function schema(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	const method = (name: string, definition: string): Record<string, unknown> => ({
		properties: { method: { const: name }, params: { $ref: `#/schemas/request/$defs/${definition}` } },
	});
	return {
		protocol: 22,
		schemas: {
			request: {
				oneOf: [method("pane.close", "PaneClose"), method("pane.process_info", "PaneProcess"), method("tab.create", "TabCreate")],
				$defs: {
					PaneClose: { properties: { pane_id: { type: "string" } } },
					PaneProcess: { properties: { pane_id: { type: ["string", "null"] } } },
					TabCreate: { properties: { env: { type: "object", additionalProperties: { type: "string" } } } },
				},
			},
		},
		...overrides,
	};
}

const launch: VerifiedLaunch = {
	role: "implementer",
	modelClass: "fast",
	model: "provider/model",
	thinkingLevel: "high",
	args: [
		"--model", "provider/model",
		"--pi-subagent-role-mcps", "[\"codegraph\"]",
		"--append-system-prompt", "/private/implementer.prompt",
	],
	env: {},
	tools: ["read", "edit"],
};

function transientLaunch(cleanup: () => Promise<void> = async () => {}): {
	launch: VerifiedLaunch;
	cleanup(): Promise<void>;
} {
	return { launch, cleanup };
}

function lsof(path: string, stdout = "", code = stdout ? 0 : 1, pid?: number): Step {
	return {
		command: "lsof-test",
		args: ["-nP", "-a", ...(pid === undefined ? [] : ["-p", String(pid)]), "-F", "p", "--", path],
		result: { code, stdout, stderr: "" },
	};
}

function startablePaneSteps(
	paths: Paths,
	processOverrides: Record<string, unknown> = {},
	paneOverrides: Record<string, unknown> = {},
): Step[] {
	const shellPid = 501;
	return [
		{ command: "herdr", args: ["pane", "get", WORKER_PANE_ID], result: success({
			type: "pane_info",
			pane: {
				pane_id: WORKER_PANE_ID,
				tab_id: WORKER_TAB_ID,
				workspace_id: WORKSPACE_ID,
				cwd: paths.worktree,
				foreground_cwd: paths.worktree,
				agent: null,
				agent_status: "unknown",
				...paneOverrides,
			},
		}) },
		{ command: "herdr", args: ["pane", "process-info", "--pane", WORKER_PANE_ID], result: success({
			type: "pane_process_info",
			process_info: {
				pane_id: WORKER_PANE_ID,
				shell_pid: shellPid,
				foreground_process_group_id: shellPid,
				foreground_processes: [{ pid: shellPid, name: "zsh", cwd: paths.worktree }],
				...processOverrides,
			},
		}) },
	];
}

function ttyInventory(
	paneProcessIds: readonly number[] = [501],
	result?: ProcessResult,
): Step {
	return {
		command: "ps",
		args: ["-axo", "pid=,tty="],
		result: result ?? { code: 0, stdout: `1 ??\n${paneProcessIds.map((pid) => `${pid} ttys042`).join("\n")}\n`, stderr: "" },
	};
}

function currentWorkspaceResult(paths: Paths, worktreeOverrides: Record<string, unknown> = {}): ProcessResult {
	return success({
		type: "workspace_info",
		workspace: {
			workspace_id: "workspace-current",
			worktree: {
				checkout_path: paths.root,
				repo_key: paths.commonDirectory,
				repo_root: paths.repoRoot,
				...worktreeOverrides,
			},
		},
	});
}

function preflightSteps(paths: Paths, schemaValue = schema(), status = "status: running\nversion: 0.9.0\nendpoint_compatible: yes\nprivate_protocol: 22\nprivate_protocol_compatible: yes\n"): Step[] {
	return [
		{ command: "herdr", args: ["--version"], result: { code: 0, stdout: "herdr 0.9.0\n", stderr: "" } },
		{ command: "herdr", args: ["status", "server"], result: { code: 0, stdout: status, stderr: "" } },
		{ command: "herdr", args: ["api", "schema", "--json"], result: { code: 0, stdout: JSON.stringify(schemaValue), stderr: "" } },
		{ command: "lsof-test", args: ["-v"], result: { code: 0, stdout: "lsof 4.99", stderr: "" } },
		{ command: "herdr", args: ["pane", "get", "pane-current"], result: success({ type: "pane_info", pane: { pane_id: "pane-current", workspace_id: "workspace-current" } }) },
		{ command: "herdr", args: ["workspace", "get", "workspace-current"], result: currentWorkspaceResult(paths) },
		{
			command: "git",
			args: ["rev-parse", "--path-format=absolute", "--git-common-dir"],
			result: { code: 0, stdout: `${paths.commonDirectory}\n`, stderr: "" },
		},
	];
}

test("workspace labels stay short and opaque while worker tabs expose Role and model context", async (t) => {
	const fixture = await paths(t);
	const script = new ScriptedProcess();
	const host = runtime(fixture, script);
	const requestId = `request-${"r".repeat(72)}`;
	const labelledTask: TaskRequest = {
		...task,
		id: `task-${"t".repeat(75)}`,
		role: `implementation-${"w".repeat(40)}`,
	};
	const attempt = baseAttempt(fixture);
	script.push(repositoryIdentityStep(fixture));
	const workspace = await host.planHostAllocation({ requestId, goal: GOAL, kind: "workspace", task: labelledTask, attempt }, context()) as WorkspaceAllocationPlan;
	assert.equal(workspace.label, "234567");
	addOwnedWorkspace(attempt, workspace);
	const worker = await host.planHostAllocation({ requestId, goal: GOAL, kind: "worker_tab", task: labelledTask, attempt }, context()) as WorkerTabAllocationPlan;
	assert.equal(worker.label, `${labelledTask.role}/fast`);
	script.done();
});

test("every accepted correlation token maps to one exact native Herdr agent name", async (t) => {
	const fixture = await paths(t);
	const script = new ScriptedProcess();
	const host = runtime(fixture, script);
	const tokenCases = [
		[TOKEN, TOKEN],
		["abcdef0123456789", "abcdef0123456789"],
		...[
			"ABCDEF0123456789",
			"persisted_TOKEN_1",
			"a".repeat(25),
			"a".repeat(128),
		].map((token) => [token, createHash("sha256").update(token).digest("hex").slice(0, 24)]),
	] as const;

	for (const [token, segment] of tokenCases) {
		const expected = `o-${segment}-agent`;
		assert.equal(await plannedAgentName(fixture, host, token), expected);
		assert.equal(await plannedAgentName(fixture, host, token), expected, `mapping must be deterministic for ${token}`);
		assert.match(expected, /^[a-z][a-z0-9_-]{0,31}$/);
		assert.ok(expected.length <= 32);
	}
	assert.equal(await plannedAgentName(fixture, host, TOKEN), AGENT_NAME);
	assert.equal(AGENT_NAME.length, 32);

	for (const token of ["a".repeat(15), "a".repeat(129), "invalid_token_123!"]) {
		await assert.rejects(plannedAgentName(fixture, host, token), /correlation token is invalid/);
	}
	assert.equal(script.calls.length, 0);
});

test("preflight accepts linked Main only after Herdr capabilities and current-workspace identity", async (t) => {
	const fixture = await paths(t);
	const script = new ScriptedProcess();
	const operation = context();
	script.push(...preflightSteps(fixture));
	await runtime(fixture, script).preflightHost({ root: fixture.root }, operation);
	script.done();
	assert.notEqual(fixture.root, fixture.repoRoot);
	assert.deepEqual(script.calls.map(({ command, args }) => [command, ...args]), [
		["herdr", "--version"],
		["herdr", "status", "server"],
		["herdr", "api", "schema", "--json"],
		["lsof-test", "-v"],
		["herdr", "pane", "get", "pane-current"],
		["herdr", "workspace", "get", "workspace-current"],
		["git", "rev-parse", "--path-format=absolute", "--git-common-dir"],
	]);
	assert.deepEqual(script.calls.at(-1)!.options, {
		cwd: await realpath(fixture.root),
		signal: operation.signal,
		timeoutMs: operation.timeoutMs,
	});

	for (const [name, mutate, error] of [
		["old client", (steps: Step[]) => { steps[0]!.result!.stdout = "herdr 0.8.9\n"; }, /client version/],
		["prerelease client", (steps: Step[]) => { steps[0]!.result!.stdout = "herdr 0.9.0-beta.1\n"; }, /client version/],
		["incompatible endpoint", (steps: Step[]) => { steps[1]!.result!.stdout = "status: running\nversion: 0.9.0\nendpoint_compatible: no\nprivate_protocol: 22\nprivate_protocol_compatible: yes\n"; }, /server must be compatible/],
		["old protocol", (steps: Step[]) => { steps[1]!.result!.stdout = "status: running\nversion: 0.9.0\nendpoint_compatible: yes\nprivate_protocol: 21\nprivate_protocol_compatible: yes\n"; }, /protocol >=22/],
		["missing env capability", (steps: Step[]) => { steps[2]!.result = {
			code: 0,
			stdout: JSON.stringify(schema({
				schemas: { request: { oneOf: (schema().schemas as any).request.oneOf, $defs: {
					...(schema().schemas as any).request.$defs,
					TabCreate: { properties: { env: { type: "object", additionalProperties: { type: "number" } } } },
				} } },
			})),
			stderr: "",
		}; }, /env support/],
		["missing lsof", (steps: Step[]) => { steps[3]!.result = { code: 1, stdout: "", stderr: "missing" }; }, /Native lsof/],
		["malformed current workspace", (steps: Step[]) => { steps[5]!.result = success({ type: "wrong" }); }, /workspace response has the wrong type/],
	] as const) {
		await t.test(name, async () => {
			const candidate = new ScriptedProcess();
			const steps = preflightSteps(fixture);
			mutate(steps);
			candidate.push(...steps);
			await assert.rejects(runtime(fixture, candidate).preflightHost({ root: fixture.root }, context()), error);
			assert.equal(candidate.calls.some(({ command }) => command === "git"), false);
			assert.ok(candidate.calls.every(({ args }) => args[0] !== "worktree" && args[0] !== "tab" && args[0] !== "agent"));
		});
	}
});

test("preflight fails closed on mismatched Herdr and Git repository identity", async (t) => {
	const fixture = await paths(t);
	for (const [name, mutate, error, expectsGit] of [
		["checkout mismatch", (steps: Step[]) => { steps[5]!.result = currentWorkspaceResult(fixture, { checkout_path: fixture.worktree }); }, /checkout does not match/, false],
		["repo_key mismatch", (steps: Step[]) => { steps[5]!.result = currentWorkspaceResult(fixture, { repo_key: fixture.root }); }, /repo_key does not match/, true],
		["repo_root mismatch", (steps: Step[]) => { steps[5]!.result = currentWorkspaceResult(fixture, { repo_root: fixture.root }); }, /repo_root does not match/, true],
		["empty Git output", (steps: Step[]) => { steps[6]!.result = { code: 0, stdout: "", stderr: "" }; }, /malformed output/, true],
		["relative Git output", (steps: Step[]) => { steps[6]!.result = { code: 0, stdout: ".git\n", stderr: "" }; }, /malformed output/, true],
		["multiple Git outputs", (steps: Step[]) => { steps[6]!.result = { code: 0, stdout: `${fixture.commonDirectory}\n${fixture.commonDirectory}\n`, stderr: "" }; }, /malformed output/, true],
		["failed Git", (steps: Step[]) => { steps[6]!.result = { code: 1, stdout: "", stderr: "failure" }; }, /identity probe failed/, true],
		["killed Git", (steps: Step[]) => { steps[6]!.result = { code: 0, killed: true, stdout: `${fixture.commonDirectory}\n`, stderr: "" }; }, /identity probe failed/, true],
	] as const) {
		await t.test(name, async () => {
			const script = new ScriptedProcess();
			const steps = preflightSteps(fixture);
			mutate(steps);
			script.push(...steps);
			await assert.rejects(runtime(fixture, script).preflightHost({ root: fixture.root }, context()), error);
			const gitCalls = script.calls.filter(({ command }) => command === "git");
			assert.equal(gitCalls.length, expectsGit ? 1 : 0);
			if (expectsGit) assert.equal(script.calls.at(-1)!.command, "git");
			assert.ok(script.calls.every(({ args }) => args[0] !== "worktree" && args[0] !== "tab" && args[0] !== "agent"));
		});
	}
});

test("workspace identity planning rejects malformed, failed, killed, and non-primary common-directory evidence", async (t) => {
	const fixture = await paths(t);
	const cases: Array<{
		name: string;
		result?: ProcessResult;
		mutateAttempt?: (attempt: TaskAttempt) => void;
		error: RegExp;
	}> = [
		{
			name: "relative task checkout",
			mutateAttempt: (attempt) => {
				const worktree = attempt.allocations[0] as WorktreeAllocationIntent;
				worktree.worktree!.path = "relative-worktree";
				worktree.worktree!.cwd = "relative-worktree";
			},
			error: /owned worktree cwd must be an absolute path/,
		},
		{ name: "relative Main root", mutateAttempt: (attempt) => { (attempt.allocations[0] as WorktreeAllocationIntent).worktree!.repoRoot = "relative-main"; }, error: /Main root must be an absolute path/ },
		{ name: "empty output", result: { code: 0, stdout: "", stderr: "" }, error: /malformed output/ },
		{ name: "relative output", result: { code: 0, stdout: ".git\n", stderr: "" }, error: /malformed output/ },
		{ name: "multiple outputs", result: { code: 0, stdout: `${fixture.commonDirectory}\n${fixture.commonDirectory}\n`, stderr: "" }, error: /malformed output/ },
		{ name: "failed probe", result: { code: 1, stdout: "", stderr: "failed" }, error: /identity probe failed/ },
		{ name: "killed probe", result: { code: 0, killed: true, stdout: `${fixture.commonDirectory}\n`, stderr: "" }, error: /identity probe failed/ },
		{ name: "non-.git common directory", result: { code: 0, stdout: `${fixture.root}\n`, stderr: "" }, error: /real \.git directory/ },
	];
	for (const candidate of cases) {
		await t.test(candidate.name, async () => {
			const script = new ScriptedProcess();
			const host = runtime(fixture, script);
			const attempt = baseAttempt(fixture);
			candidate.mutateAttempt?.(attempt);
			if (candidate.result) script.push(repositoryIdentityStep(fixture, candidate.result));
			await assert.rejects(host.planHostAllocation({ requestId: REQUEST_ID,
				goal: GOAL,
				kind: "workspace",
				task,
				attempt,
			}, context()), candidate.error);
			assert.equal(attempt.allocations.length, 1);
			assert.ok(script.calls.every(({ command }) => command === "git"));
			script.done();
		});
	}
});

test("oversized initial assignment is rejected before workspace planning or host allocation", async (t) => {
	const fixture = await paths(t);
	const script = new ScriptedProcess();
	const host = runtime(fixture, script);
	const attempt = baseAttempt(fixture);
	const oversizedTask: TaskRequest = {
		...task,
		requirements: "r".repeat(32_000),
		deliverable: "d".repeat(32_000),
		checks: [{ command: "c".repeat(32_000), args: [] }],
	};

	await assert.rejects(host.planHostAllocation({ requestId: REQUEST_ID,
		goal: "g".repeat(32_000),
		kind: "workspace",
		task: oversizedTask,
		attempt,
	}, context()), /Worker assignment exceeds 98304 bytes/);
	assert.equal(attempt.allocations.length, 1);
	assert.equal(script.calls.length, 0);
});

test("workspace allocation revalidates strict persisted identity before Herdr creation", async (t) => {
	const fixture = await paths(t);
	const driftedRepoRoot = join(fixture.directory, "drifted-repo");
	const driftedCommonDirectory = join(driftedRepoRoot, ".git");
	await mkdir(driftedCommonDirectory, { recursive: true });
	const cases: Array<{
		name: string;
		mutate?: (details: Record<string, unknown>) => void;
		result?: ProcessResult;
		error: RegExp;
		expectsProbe: boolean;
	}> = [
		{ name: "relative persisted Main root", mutate: (details) => { details.mainRoot = "relative-main"; }, error: /Main root must be an absolute path/, expectsProbe: false },
		{ name: "legacy repository-root field", mutate: (details) => { details.repoRoot = details.herdrRepoRoot; delete details.herdrRepoRoot; }, error: /Herdr repository root must be a non-empty exact string/, expectsProbe: false },
		{ name: "drifted persisted Main root", mutate: (details) => { details.mainRoot = fixture.worktree; }, error: /drifted from the exact owned worktree/, expectsProbe: false },
		{ name: "drifted persisted repo key", mutate: (details) => { details.repoKey = driftedCommonDirectory; }, error: /no longer matches Git/, expectsProbe: true },
		{ name: "drifted persisted Herdr root", mutate: (details) => { details.herdrRepoRoot = driftedRepoRoot; }, error: /no longer matches Git/, expectsProbe: true },
		{ name: "drifted Git common directory", result: { code: 0, stdout: `${driftedCommonDirectory}\n`, stderr: "" }, error: /no longer matches Git/, expectsProbe: true },
		{ name: "malformed Git common directory", result: { code: 0, stdout: ".git\n", stderr: "" }, error: /malformed output/, expectsProbe: true },
		{ name: "failed Git common-directory probe", result: { code: 1, stdout: "", stderr: "failed" }, error: /identity probe failed/, expectsProbe: true },
		{ name: "killed Git common-directory probe", result: { code: 0, killed: true, stdout: `${fixture.commonDirectory}\n`, stderr: "" }, error: /identity probe failed/, expectsProbe: true },
	];
	for (const candidate of cases) {
		await t.test(candidate.name, async () => {
			const script = new ScriptedProcess();
			const host = runtime(fixture, script);
			const attempt = baseAttempt(fixture);
			const intent = await plannedIntent(host, attempt, "workspace", fixture, script);
			candidate.mutate?.(intent as unknown as Record<string, unknown>);
			const callsBeforeAllocation = script.calls.length;
			if (candidate.expectsProbe) script.push(repositoryIdentityStep(fixture, candidate.result));
			await assert.rejects(host.allocateHost({ requestId: REQUEST_ID, intent, task, attempt }, context()), candidate.error);
			const allocationCalls = script.calls.slice(callsBeforeAllocation);
			assert.equal(allocationCalls.length, candidate.expectsProbe ? 1 : 0);
			assert.ok(allocationCalls.every(({ command }) => command === "git"));
			script.done();
		});
	}
});

test("workspace allocation from primary Main still uses the primary repository cwd", async (t) => {
	const fixture = await paths(t);
	const primary = { ...fixture, root: fixture.repoRoot };
	const script = new ScriptedProcess();
	const host = runtime(primary, script);
	const attempt = baseAttempt(primary);
	const intent = await plannedIntent(host, attempt, "workspace", primary, script);
	script.push(repositoryIdentityStep(primary), {
		command: "herdr",
		args: ["worktree", "open", "--cwd", primary.repoRoot, "--path", primary.worktree, "--label", WORKSPACE_LABEL, "--no-focus"],
		result: success({
			type: "worktree_opened",
			already_open: false,
			workspace: workspaceInfo(primary),
			tab: { tab_id: ROOT_TAB_ID, workspace_id: WORKSPACE_ID, focused: false },
			root_pane: { pane_id: ROOT_PANE_ID, workspace_id: WORKSPACE_ID, tab_id: ROOT_TAB_ID, focused: false },
			worktree: { path: primary.worktree },
		}),
	});
	assert.equal((await host.allocateHost({ requestId: REQUEST_ID, intent, task, attempt }, context())).outcome, "owned");
	assert.deepEqual(script.calls.map(({ command, options }) => [command, options.cwd]), [
		["git", primary.root],
		["git", primary.root],
		["herdr", primary.repoRoot],
	]);
	script.done();
});

test("workspace open evidence must bind the exact checkout, repo key, and primary root before adoption", async (t) => {
	const fixture = await paths(t);
	for (const [name, worktree] of [
		["checkout", { checkout_path: fixture.root, repo_key: fixture.commonDirectory, repo_root: fixture.repoRoot }],
		["repo key", { checkout_path: fixture.worktree, repo_key: fixture.root, repo_root: fixture.repoRoot }],
		["repo root", { checkout_path: fixture.worktree, repo_key: fixture.commonDirectory, repo_root: fixture.root }],
	] as const) {
		await t.test(name, async () => {
			const script = new ScriptedProcess();
			const host = runtime(fixture, script);
			const attempt = baseAttempt(fixture);
			const intent = await plannedIntent(host, attempt, "workspace", fixture, script);
			script.push(repositoryIdentityStep(fixture), {
				command: "herdr",
				args: ["worktree", "open", "--cwd", fixture.repoRoot, "--path", fixture.worktree, "--label", WORKSPACE_LABEL, "--no-focus"],
				result: success({
					type: "worktree_opened",
					already_open: false,
					workspace: workspaceInfo(fixture, { worktree }),
					tab: { tab_id: ROOT_TAB_ID, workspace_id: WORKSPACE_ID, focused: false },
					root_pane: { pane_id: ROOT_PANE_ID, workspace_id: WORKSPACE_ID, tab_id: ROOT_TAB_ID, focused: false },
					worktree: { path: fixture.worktree },
				}),
			});
			const result = await host.allocateHost({ requestId: REQUEST_ID, intent, task, attempt }, context());
			assert.equal(result.outcome, "unknown");
			assert.match(result.outcome === "unknown" ? result.failure : "", /does not prove the exact non-focused checkout and repository/);
			assert.equal(script.calls.filter(({ command, args }) => command === "herdr" && args[0] === "worktree" && args[1] === "open").length, 1);
			script.done();
		});
	}
});

test("allocation uses token-bound non-focused resources, a mode-0600 lease, and only verified safe Pi argv", async (t) => {
	const fixture = await paths(t);
	const script = new ScriptedProcess();
	const host = runtime(fixture, script);
	const attempt = baseAttempt(fixture);
	const workspaceIntent = await plannedIntent(host, attempt, "workspace", fixture, script);
	assert.deepEqual({
		kind: workspaceIntent.kind,
		label: workspaceIntent.label,
		worktreeCwd: workspaceIntent.worktreeCwd,
		mainRoot: workspaceIntent.mainRoot,
		repoKey: workspaceIntent.repoKey,
		herdrRepoRoot: workspaceIntent.herdrRepoRoot,
	}, {
		kind: "workspace",
		label: WORKSPACE_LABEL,
		worktreeCwd: fixture.worktree,
		mainRoot: fixture.root,
		repoKey: await realpath(fixture.commonDirectory),
		herdrRepoRoot: await realpath(fixture.repoRoot),
	});
	script.push(repositoryIdentityStep(fixture), {
		command: "herdr",
		args: (args, options) => {
			assert.deepEqual(args, ["worktree", "open", "--cwd", fixture.repoRoot, "--path", fixture.worktree, "--label", WORKSPACE_LABEL, "--no-focus"]);
			assert.equal(options.cwd, fixture.repoRoot);
		},

		result: success({
			type: "worktree_opened", already_open: false,
			workspace: workspaceInfo(fixture),
			tab: { tab_id: ROOT_TAB_ID, workspace_id: WORKSPACE_ID, focused: false },
			root_pane: { pane_id: ROOT_PANE_ID, workspace_id: WORKSPACE_ID, tab_id: ROOT_TAB_ID, focused: false },
			worktree: { path: fixture.worktree },
		}),
	});
	const workspace = await host.allocateHost({ requestId: REQUEST_ID, intent: workspaceIntent, task, attempt }, context());
	assert.deepEqual(workspace, { kind: "workspace", outcome: "owned", workspaceId: WORKSPACE_ID, rootTabId: ROOT_TAB_ID, rootPaneId: ROOT_PANE_ID });
	assert.notEqual(fixture.root, fixture.repoRoot);
	assert.deepEqual(script.calls.slice(0, 3).map(({ command, options }) => [command, options.cwd]), [
		["git", fixture.root],
		["git", fixture.root],
		["herdr", fixture.repoRoot],
	]);
	assert.equal(workspace.outcome, "owned");
	Object.assign(workspaceIntent, {
		status: "owned", workspaceId: workspace.workspaceId, rootTabId: workspace.rootTabId, rootPaneId: workspace.rootPaneId,
	});

	const tabIntent = await plannedIntent(host, attempt, "worker_tab", fixture, script);
	const tabDetails = { leasePath: tabIntent.leasePath };
	script.push(...layoutSettleSteps(), {
		command: "herdr",
		args: [
			"tab", "create", "--workspace", WORKSPACE_ID, "--cwd", fixture.worktree,
			"--label", WORKER_LABEL, "--env", `PI_SUBAGENT_PROCESS_LEASE=${tabDetails.leasePath}`, "--no-focus",
		],
		result: success({
			type: "tab_created",
			tab: tabInfo({ pane_count: 1 }),
			root_pane: { pane_id: WORKER_PANE_ID, workspace_id: WORKSPACE_ID, tab_id: WORKER_TAB_ID, cwd: fixture.worktree, focused: false },
		}),
	});
	const tab = await host.allocateHost({ requestId: REQUEST_ID, intent: tabIntent, task, attempt }, context());
	assert.deepEqual(tab, { kind: "worker_tab", outcome: "owned", tabId: WORKER_TAB_ID, paneId: WORKER_PANE_ID });
	assert.equal((await stat(tabDetails.leasePath)).mode & 0o777, 0o600);
	assert.equal(tab.outcome, "owned");
	Object.assign(tabIntent, { status: "owned", tabId: tab.tabId, paneId: tab.paneId });

	const agentIntent = await plannedIntent(host, attempt, "agent", fixture, script);
	let acquired = false;
	let cleanups = 0;
	script.push(
		lsof(tabDetails.leasePath),
		...startablePaneSteps(fixture),
		{
			command: "herdr",
			args: (args) => {
				assert.equal(acquired, true);
				assert.deepEqual(args, [
					"agent", "start", AGENT_NAME, "--kind", "pi", "--pane", WORKER_PANE_ID, "--",
					...launch.args,
				]);
				assert.ok(args.includes("--pi-subagent-role-mcps"));
				assert.ok(!args.includes("Role prompt must stay private"));
			},
			result: success({ type: "agent_started", agent: agentInfo("idle", true, { cwd: fixture.worktree }) }),
		},
	);
	const agent = await host.allocateHost({ requestId: REQUEST_ID,
		intent: agentIntent,
		task,
		attempt,
		acquireLaunch: async () => {
			assert.deepEqual(script.calls.slice(-3).map(({ command, args }) => [command, ...args]), [
				["lsof-test", "-nP", "-a", "-F", "p", "--", tabDetails.leasePath],
				["herdr", "pane", "get", WORKER_PANE_ID],
				["herdr", "pane", "process-info", "--pane", WORKER_PANE_ID],
			]);
			acquired = true;
			return transientLaunch(async () => { cleanups += 1; });
		},
	}, context());
	assert.deepEqual(agent, { kind: "agent", outcome: "owned" });
	assert.equal(cleanups, 1);
	assert.equal(script.calls.some(({ command }) => command === "ps"), false, "fresh allocation must not inspect same-TTY shell helpers");
	script.done();
});

test("agent allocation accepts the task's explicit Role and rejects launch mismatches", async (t) => {
	const roleTask: TaskRequest = { ...task, role: "release manager" };
	const cases: Array<{
		name: string;
		launchRole: string;
		env?: Record<string, string>;
		error?: RegExp;
	}> = [
		{ name: "matching non-implementer Role", launchRole: roleTask.role },
		{ name: "mismatched Role", launchRole: "implementer", error: /wrong Role/ },
		{ name: "caller Role environment", launchRole: roleTask.role, env: { CALLER_SECRET: "forbidden" }, error: /must not receive caller Role environment variables/ },
	];

	for (const candidate of cases) {
		await t.test(candidate.name, async (t) => {
			const fixture = await paths(t);
			const script = new ScriptedProcess();
			const host = runtime(fixture, script);
			const { attempt, leasePath } = await fullAttempt(fixture, host, script);
			attempt.allocations.pop();
			const intent = await plannedIntent(host, attempt, "agent", fixture, script);
			await privateLease(leasePath);
			script.push(
				lsof(leasePath),
				...startablePaneSteps(fixture),
				...(candidate.error ? [] : [{
					command: "herdr",
					args: () => {},
					result: success({ type: "agent_started", agent: agentInfo("idle", true, { cwd: fixture.worktree }) }),
				}]),
			);
			let cleanups = 0;
			const allocated = host.allocateHost({ requestId: REQUEST_ID,
				intent,
				task: roleTask,
				attempt,
				acquireLaunch: async () => {
					assert.deepEqual(script.calls.slice(-3).map(({ command, args }) => [command, ...args]), [
						["lsof-test", "-nP", "-a", "-F", "p", "--", leasePath],
						["herdr", "pane", "get", WORKER_PANE_ID],
						["herdr", "pane", "process-info", "--pane", WORKER_PANE_ID],
					]);
					return {
						launch: { ...launch, role: candidate.launchRole, env: candidate.env ?? {} },
						cleanup: async () => { cleanups += 1; },
					};
				},
			}, context());
			if (candidate.error) await assert.rejects(allocated, candidate.error);
			else assert.deepEqual(await allocated, { kind: "agent", outcome: "owned" });
			assert.equal(cleanups, 1);
			assert.equal(script.calls.filter(({ args }) => args[0] === "agent" && args[1] === "start").length, candidate.error ? 0 : 1);
			script.done();
		});
	}
});

test("a native-invalid persisted agent name is rejected before startPiAgent", async (t) => {
	const fixture = await paths(t);
	const script = new ScriptedProcess();
	const host = runtime(fixture, script);
	const { attempt } = await fullAttempt(fixture, host, script);
	const intent = attempt.allocations.at(-1) as AgentAllocationIntent;
	intent.status = "allocating";
	intent.agentName = `O-${TOKEN}-agent`;
	const callsBeforeAllocation = script.calls.length;
	let acquisitions = 0;

	await assert.rejects(host.allocateHost({ requestId: REQUEST_ID,
		intent,
		task,
		attempt,
		acquireLaunch: async () => { acquisitions += 1; return transientLaunch(); },
	}, context()), /Agent allocation plan drifted/);
	assert.equal(acquisitions, 0);
	assert.equal(script.calls.length, callsBeforeAllocation);
	script.done();
});

test("agent start accepts only omitted or null agent as an empty pane", async (t) => {
	const fixture = await paths(t);
	for (const [name, agent] of [
		["omitted", undefined],
		["null", null],
	] as const) {
		await t.test(name, async () => {
			const script = new ScriptedProcess();
			const host = runtime(fixture, script);
			const { attempt, leasePath } = await fullAttempt(fixture, host, script);
			attempt.allocations.pop();
			const intent = await plannedIntent(host, attempt, "agent", fixture, script);
			await privateLease(leasePath);
			script.push(
				lsof(leasePath),
				...startablePaneSteps(fixture, {}, { agent }),
				{
					command: "herdr",
					args: () => {},
					result: success({ type: "agent_started", agent: agentInfo("idle", true, { cwd: fixture.worktree }) }),
				},
			);
			let acquisitions = 0;
			assert.equal((await host.allocateHost({ requestId: REQUEST_ID,
				intent,
				task,
				attempt,
				acquireLaunch: async () => { acquisitions += 1; return transientLaunch(); },
			}, context())).outcome, "owned");
			assert.equal(acquisitions, 1);
			assert.equal(script.calls.filter(({ args }) => args[0] === "agent" && args[1] === "start").length, 1);
			script.done();
		});
	}

	for (const [name, agent] of [
		["empty string", ""],
		["object", {}],
	] as const) {
		await t.test(name, async () => {
			const script = new ScriptedProcess();
			const host = runtime(fixture, script);
			const { attempt, leasePath } = await fullAttempt(fixture, host, script);
			attempt.allocations.pop();
			const intent = await plannedIntent(host, attempt, "agent", fixture, script);
			await privateLease(leasePath);
			script.push(lsof(leasePath), ...startablePaneSteps(fixture, {}, { agent }).slice(0, 1));
			let acquisitions = 0;
			await assert.rejects(host.allocateHost({ requestId: REQUEST_ID,
				intent,
				task,
				attempt,
				acquireLaunch: async () => { acquisitions += 1; return transientLaunch(); },
			}, context()), /not empty and startable/);
			assert.equal(acquisitions, 0);
			assert.equal(script.calls.some(({ args }) => args[0] === "agent" && args[1] === "start"), false);
			script.done();
		});
	}
});

test("worker-tab ownership rejects workspace-root aliases, multipane tabs, and mismatched panes", async (t) => {
	const fixture = await paths(t);
	for (const [name, tabOverrides, paneOverrides] of [
		["root tab alias", { tab_id: ROOT_TAB_ID }, { tab_id: ROOT_TAB_ID }],
		["root pane alias", {}, { pane_id: ROOT_PANE_ID }],
		["multiple panes", { pane_count: 2 }, {}],
		["mismatched pane", {}, { tab_id: "tab-decoy" }],
	] as const) {
		await t.test(name, async () => {
			const script = new ScriptedProcess();
			const host = runtime(fixture, script);
			const attempt = baseAttempt(fixture);
			script.push(repositoryIdentityStep(fixture));
			const workspaceDetails = await host.planHostAllocation({ requestId: REQUEST_ID, goal: GOAL, kind: "workspace", task, attempt }, context()) as WorkspaceAllocationPlan;
			addOwnedWorkspace(attempt, workspaceDetails);
			const intent = await plannedIntent(host, attempt, "worker_tab", fixture, script);
			script.push(...layoutSettleSteps(), {
				command: "herdr",
				args: () => {},
				result: success({
					type: "tab_created",
					tab: tabInfo({ pane_count: 1, ...tabOverrides }),
					root_pane: {
						pane_id: WORKER_PANE_ID,
						workspace_id: WORKSPACE_ID,
						tab_id: WORKER_TAB_ID,
						cwd: fixture.worktree,
						focused: false,
						...paneOverrides,
					},
				}),
			});
			assert.equal((await host.allocateHost({ requestId: REQUEST_ID, intent, task, attempt }, context())).outcome, "unknown");
			script.done();
		});
	}
});

test("worker tab waits for a stable host pane layout before create", async (t) => {
	const fixture = await paths(t);
	const script = new ScriptedProcess();
	const host = runtime(fixture, script);
	const attempt = baseAttempt(fixture);
	script.push(repositoryIdentityStep(fixture));
	const workspaceDetails = await host.planHostAllocation({ requestId: REQUEST_ID, goal: GOAL, kind: "workspace", task, attempt }, context()) as WorkspaceAllocationPlan;
	addOwnedWorkspace(attempt, workspaceDetails);
	const intent = await plannedIntent(host, attempt, "worker_tab", fixture, script);
	const pluginPane = { pane_id: "pane-plugin", tab_id: "tab-plugin", workspace_id: WORKSPACE_ID };
	script.push(
		paneListStep(rootPanes()),
		paneListStep(rootPanes([pluginPane])),
		paneListStep(rootPanes([pluginPane])),
		{
			command: "herdr",
			args: [
				"tab", "create", "--workspace", WORKSPACE_ID, "--cwd", fixture.worktree,
				"--label", WORKER_LABEL, "--env", `PI_SUBAGENT_PROCESS_LEASE=${intent.leasePath}`, "--no-focus",
			],
			result: success({
				type: "tab_created",
				tab: tabInfo({ pane_count: 1 }),
				root_pane: { pane_id: WORKER_PANE_ID, workspace_id: WORKSPACE_ID, tab_id: WORKER_TAB_ID, cwd: fixture.worktree, focused: false },
			}),
		},
	);
	assert.deepEqual(await host.allocateHost({ requestId: REQUEST_ID, intent, task, attempt }, context()), {
		kind: "worker_tab",
		outcome: "owned",
		tabId: WORKER_TAB_ID,
		paneId: WORKER_PANE_ID,
	});
	assert.deepEqual(script.calls.filter(({ args }) => args[0] === "pane" && args[1] === "list").map(({ args }) => args), [
		["pane", "list", "--workspace", WORKSPACE_ID],
		["pane", "list", "--workspace", WORKSPACE_ID],
		["pane", "list", "--workspace", WORKSPACE_ID],
	]);
	script.done();
});

test("last-moment launch resource drift blocks start after lease and pane proofs", async (t) => {
	const fixture = await paths(t);
	const script = new ScriptedProcess();
	const host = runtime(fixture, script);
	const { attempt, leasePath } = await fullAttempt(fixture, host, script);
	attempt.allocations.pop();
	const intent = await plannedIntent(host, attempt, "agent", fixture, script);
	await privateLease(leasePath);
	script.push(lsof(leasePath), ...startablePaneSteps(fixture));
	await assert.rejects(host.allocateHost({ requestId: REQUEST_ID,
		intent,
		task,
		attempt,
		acquireLaunch: async () => {
			assert.equal(script.calls.length, 4);
			throw new Error("Role extension fingerprint drifted");
		},
	}, context()), /fingerprint drifted/);
	assert.ok(script.calls.every(({ args }) => !(args[0] === "agent" && args[1] === "start")));
	script.done();
});

test("agent pane contention is never retried by the non-idempotent start helper", async (t) => {
	const fixture = await paths(t);
	const script = new ScriptedProcess();
	const host = runtime(fixture, script);
	const { attempt, leasePath } = await fullAttempt(fixture, host, script);
	attempt.allocations.pop();
	const intent = await plannedIntent(host, attempt, "agent", fixture, script);
	await privateLease(leasePath);
	script.push(lsof(leasePath), ...startablePaneSteps(fixture), { command: "herdr", args: () => {}, result: failure("agent_pane_busy") });
	let cleanups = 0;
	assert.deepEqual(await host.allocateHost({ requestId: REQUEST_ID,
		intent,
		task,
		attempt,
		acquireLaunch: async () => transientLaunch(async () => { cleanups += 1; }),
	}, context()), {
		kind: "agent",
		outcome: "absent",
		failure: "herdr agent start failed: {\"error\":{\"code\":\"agent_pane_busy\"}}",
	});
	assert.equal(cleanups, 1);
	assert.equal(script.calls.filter(({ args }) => args[0] === "agent" && args[1] === "start").length, 1);
	script.done();
});

test("aborted agent start still cleans its acquired Role launch", async (t) => {
	const fixture = await paths(t);
	const script = new ScriptedProcess();
	const host = runtime(fixture, script);
	const { attempt, leasePath } = await fullAttempt(fixture, host, script);
	attempt.allocations.pop();
	const intent = await plannedIntent(host, attempt, "agent", fixture, script);
	await privateLease(leasePath);
	const controller = new AbortController();
	const operationContext: OperationContext = {
		signal: controller.signal,
		deadline: 20_000,
		timeoutMs: 19_000,
	};
	let cleanups = 0;
	script.push(
		lsof(leasePath),
		...startablePaneSteps(fixture),
		{
			command: "herdr",
			args: () => controller.abort(new Error("start aborted")),
			result: failure("aborted", true),
		},
	);
	const result = await host.allocateHost({ requestId: REQUEST_ID,
		intent,
		task,
		attempt,
		acquireLaunch: async () => transientLaunch(async () => { cleanups += 1; }),
	}, operationContext);
	assert.equal(result.outcome, "unknown");
	assert.equal(cleanups, 1);
	script.done();
});

test("every allocation crash window reconciles without adoption or duplicate creation", async (t) => {
	const fixture = await paths(t);
	for (const kind of ["workspace", "worker_tab", "agent"] as const) {
		for (const boundary of ["before-side-effect", "lost-after-side-effect", "malformed-after-side-effect"] as const) {
			await t.test(`${kind}: ${boundary}`, async () => {
				const script = new ScriptedProcess();
				const host = runtime(fixture, script);
				const attempt = baseAttempt(fixture);
				if (kind !== "workspace") {
					script.push(repositoryIdentityStep(fixture));
					const workspaceDetails = await host.planHostAllocation({ requestId: REQUEST_ID, goal: GOAL, kind: "workspace", task, attempt }, context()) as WorkspaceAllocationPlan;
					addOwnedWorkspace(attempt, workspaceDetails);
				}
				let leasePath: string | undefined;
				if (kind === "agent") {
					const tabDetails = await host.planHostAllocation({ requestId: REQUEST_ID, goal: GOAL, kind: "worker_tab", task, attempt }, context()) as WorkerTabAllocationPlan;
					leasePath = tabDetails.leasePath;
					addOwnedTab(attempt, tabDetails);
					await privateLease(leasePath);
				}
				const intent = await plannedIntent(host, attempt, kind, fixture, script);
				if (intent.kind === "worker_tab") leasePath = intent.leasePath;
				const malformed = boundary === "malformed-after-side-effect";
				if (kind === "agent") script.push(lsof(leasePath!), ...startablePaneSteps(fixture));
				if (kind === "workspace") script.push(repositoryIdentityStep(fixture));
				if (kind === "worker_tab" && boundary !== "before-side-effect") script.push(...layoutSettleSteps());
				script.push({
					command: "herdr",
					args: () => {},
					...(malformed
						? { result: { code: 0, stdout: "{", stderr: "" } }
						: { error: new Error(boundary === "before-side-effect" ? "spawn failed" : "result lost") }),
				});
				if (malformed) {
					const result = await host.allocateHost({ requestId: REQUEST_ID, intent, task, attempt, ...(kind === "agent" ? { acquireLaunch: async () => transientLaunch() } : {}) }, context());
					assert.equal(result.outcome, "unknown");
				} else {
					await assert.rejects(host.allocateHost({ requestId: REQUEST_ID, intent, task, attempt, ...(kind === "agent" ? { acquireLaunch: async () => transientLaunch() } : {}) }, context()), /spawn failed|result lost/);
				}
				intent.status = "unknown";
				const exists = boundary !== "before-side-effect";
				if (kind === "workspace") {
					script.push(
						repositoryIdentityStep(fixture),
						{ command: "herdr", args: ["worktree", "list", "--cwd", fixture.worktree], result: success(worktreeListResult(fixture, [
							{ path: fixture.worktree, label: exists ? WORKSPACE_LABEL : "task-a", open_workspace_id: exists ? WORKSPACE_ID : null },
						])) },
					);
				} else if (kind === "worker_tab") {
					script.push({ command: "herdr", args: ["tab", "list", "--workspace", WORKSPACE_ID], result: success({
						type: "tab_list",
						tabs: [
							{ tab_id: ROOT_TAB_ID, workspace_id: WORKSPACE_ID, label: "root" },
							...(exists ? [{ tab_id: WORKER_TAB_ID, workspace_id: WORKSPACE_ID, label: WORKER_LABEL }] : []),
						],
					}) }, lsof(leasePath!));
				} else {
					script.push({ command: "herdr", args: ["agent", "list"], result: success({
						type: "agent_list",
						agents: exists ? [agentInfo("idle", true, { cwd: fixture.worktree })] : [],
					}) }, lsof(leasePath!), ...(exists ? [] : [...startablePaneSteps(fixture), ttyInventory()]));
				}
				const reconciled = await host.reconcileHostAllocation({ requestId: REQUEST_ID, intent, task, attempt }, context());
				assert.equal(reconciled.outcome, exists ? "possible" : "absent");
				script.done();
			});
		}
	}
});

test("workspace reconciliation accepts the exact legacy v2 label", async (t) => {
	const fixture = await paths(t);
	const script = new ScriptedProcess();
	const host = runtime(fixture, script);
	const attempt = baseAttempt(fixture);
	const intent = await plannedIntent(host, attempt, "workspace", fixture, script);
	intent.status = "unknown";
	intent.label = `${REQUEST_ID}/${task.id}#${attempt.number}`;
	script.push(
		repositoryIdentityStep(fixture),
		{
			command: "herdr",
			args: ["worktree", "list", "--cwd", fixture.worktree],
			result: success(worktreeListResult(fixture, [{ path: fixture.worktree, label: "task-a", open_workspace_id: null }])),
		},
	);
	assert.equal((await host.reconcileHostAllocation({ requestId: REQUEST_ID, intent, task, attempt }, context())).outcome, "absent");
	script.done();
});

test("unknown workspace reconciliation revalidates persisted Git identity before Herdr evidence", async (t) => {
	const fixture = await paths(t);
	const driftedRepoRoot = join(fixture.directory, "reconcile-drifted-repo");
	const driftedCommonDirectory = join(driftedRepoRoot, ".git");
	await mkdir(driftedCommonDirectory, { recursive: true });
	const cases: Array<{
		name: string;
		mutate?: (details: Record<string, unknown>) => void;
		result?: ProcessResult;
		error: RegExp;
		expectsProbe: boolean;
	}> = [
		{ name: "drifted Main root", mutate: (details) => { details.mainRoot = fixture.worktree; }, error: /drifted from the exact owned worktree/, expectsProbe: false },
		{ name: "drifted repo key", mutate: (details) => { details.repoKey = driftedCommonDirectory; }, error: /no longer matches Git/, expectsProbe: true },
		{ name: "drifted Herdr root", mutate: (details) => { details.herdrRepoRoot = driftedRepoRoot; }, error: /no longer matches Git/, expectsProbe: true },
		{ name: "drifted common directory", result: { code: 0, stdout: `${driftedCommonDirectory}\n`, stderr: "" }, error: /no longer matches Git/, expectsProbe: true },
		{ name: "malformed common directory", result: { code: 0, stdout: ".git\n", stderr: "" }, error: /malformed output/, expectsProbe: true },
		{ name: "failed common-directory probe", result: { code: 1, stdout: "", stderr: "failed" }, error: /identity probe failed/, expectsProbe: true },
		{ name: "killed common-directory probe", result: { code: 0, killed: true, stdout: `${fixture.commonDirectory}\n`, stderr: "" }, error: /identity probe failed/, expectsProbe: true },
	];
	for (const candidate of cases) {
		await t.test(candidate.name, async () => {
			const script = new ScriptedProcess();
			const host = runtime(fixture, script);
			const attempt = baseAttempt(fixture);
			const intent = await plannedIntent(host, attempt, "workspace", fixture, script);
			intent.status = "unknown";
			candidate.mutate?.(intent as unknown as Record<string, unknown>);
			const callsBeforeReconciliation = script.calls.length;
			if (candidate.expectsProbe) script.push(repositoryIdentityStep(fixture, candidate.result));
			await assert.rejects(host.reconcileHostAllocation({ requestId: REQUEST_ID, intent, task, attempt }, context()), candidate.error);
			const reconciliationCalls = script.calls.slice(callsBeforeReconciliation);
			assert.equal(reconciliationCalls.length, candidate.expectsProbe ? 1 : 0);
			assert.ok(reconciliationCalls.every(({ command }) => command === "git"));
			script.done();
		});
	}
});

test("unknown workspace reconciliation rejects mismatched checkout and repository list evidence", async (t) => {
	const fixture = await paths(t);
	for (const [name, sourceOverrides] of [
		["checkout", { source_checkout_path: fixture.root }],
		["repo key", { repo_key: fixture.root }],
		["repo root", { repo_root: fixture.root }],
	] as const) {
		await t.test(name, async () => {
			const script = new ScriptedProcess();
			const host = runtime(fixture, script);
			const attempt = baseAttempt(fixture);
			const intent = await plannedIntent(host, attempt, "workspace", fixture, script);
			intent.status = "unknown";
			script.push(
				repositoryIdentityStep(fixture),
				{
					command: "herdr",
					args: ["worktree", "list", "--cwd", fixture.worktree],
					result: success(worktreeListResult(fixture, [], sourceOverrides)),
				},
			);
			await assert.rejects(host.reconcileHostAllocation({ requestId: REQUEST_ID, intent, task, attempt }, context()), /does not match the exact saved repository identity/);
			assert.equal(script.calls.at(-1)!.options.cwd, fixture.repoRoot);
			assert.ok(script.calls.every(({ args }) => args[1] !== "open" && args[1] !== "close"));
			script.done();
		});
	}
});

test("unknown allocation reconciliation blocks partial, mismatched, duplicate, and lease-held resources but ignores out-of-scope decoys", async (t) => {
	const fixture = await paths(t);

	await t.test("workspace decoys are ignored while token, open, and duplicate matches block", async () => {
		for (const [name, worktrees, outcome] of [
			["decoy", [
				{ path: fixture.worktree, label: "task-a", open_workspace_id: null },
				{ path: join(fixture.directory, "decoy"), label: "decoy", open_workspace_id: "workspace-decoy" },
			], "absent"],
			["untagged open", [{ path: fixture.worktree, label: "other", open_workspace_id: "workspace-unknown" }], "possible"],
			["token only", [
				{ path: fixture.worktree, label: "task-a", open_workspace_id: null },
				{ path: join(fixture.directory, "other"), label: WORKSPACE_LABEL, open_workspace_id: null },
			], "possible"],
			["duplicate parent", [
				{ path: fixture.worktree, label: "task-a", open_workspace_id: null },
				{ path: fixture.worktree, label: "other", open_workspace_id: null },
			], "possible"],
		] as const) {
			const script = new ScriptedProcess();
			const host = runtime(fixture, script);
			const attempt = baseAttempt(fixture);
			const intent = await plannedIntent(host, attempt, "workspace", fixture, script);
			intent.status = "unknown";
			script.push(
				repositoryIdentityStep(fixture),
				{ command: "herdr", args: ["worktree", "list", "--cwd", fixture.worktree], result: success(worktreeListResult(fixture, worktrees)) },
			);
			assert.equal((await host.reconcileHostAllocation({ requestId: REQUEST_ID, intent, task, attempt }, context())).outcome, outcome, name);
		}
	});

	await t.test("tab scope and lease holders fail closed", async () => {
		for (const [tabs, holder, outcome] of [
			[[{ tab_id: ROOT_TAB_ID, workspace_id: WORKSPACE_ID, label: "root" }], false, "absent"],
			[[{ tab_id: ROOT_TAB_ID, workspace_id: WORKSPACE_ID, label: "root" }, { tab_id: "tab-untagged", workspace_id: WORKSPACE_ID, label: "other" }], false, "absent"],
			[[{ tab_id: ROOT_TAB_ID, workspace_id: WORKSPACE_ID, label: WORKER_LABEL }], false, "possible"],
			[[{ tab_id: ROOT_TAB_ID, workspace_id: WORKSPACE_ID, label: "root" }], true, "possible"],
		] as const) {
			const script = new ScriptedProcess();
			const host = runtime(fixture, script);
			const attempt = baseAttempt(fixture);
			script.push(repositoryIdentityStep(fixture));
			const workspaceDetails = await host.planHostAllocation({ requestId: REQUEST_ID, goal: GOAL, kind: "workspace", task, attempt }, context()) as WorkspaceAllocationPlan;
			addOwnedWorkspace(attempt, workspaceDetails);
			const intent = await plannedIntent(host, attempt, "worker_tab", fixture, script);
			intent.status = "unknown";
			const leasePath = intent.leasePath;
			if (holder) await privateLease(leasePath);
			script.push({ command: "herdr", args: ["tab", "list", "--workspace", WORKSPACE_ID], result: success({ type: "tab_list", tabs }) });
			if (holder) script.push(lsof(leasePath, "p71\n"));
			assert.equal((await host.reconcileHostAllocation({ requestId: REQUEST_ID, intent, task, attempt }, context())).outcome, outcome);
		}

		const script = new ScriptedProcess();
		const host = runtime(fixture, script);
		const attempt = baseAttempt(fixture);
		script.push(repositoryIdentityStep(fixture));
		const workspaceDetails = await host.planHostAllocation({ requestId: REQUEST_ID, goal: GOAL, kind: "workspace", task, attempt }, context()) as WorkspaceAllocationPlan;
		addOwnedWorkspace(attempt, workspaceDetails);
		const intent = await plannedIntent(host, attempt, "worker_tab", fixture, script);
		intent.status = "unknown";
		script.push({ command: "herdr", args: ["tab", "list", "--workspace", WORKSPACE_ID], result: success({
			type: "tab_list", tabs: [{ tab_id: ROOT_TAB_ID, workspace_id: "workspace-decoy", label: "root" }],
		}) });
		await assert.rejects(host.reconcileHostAllocation({ requestId: REQUEST_ID, intent, task, attempt }, context()), /escaped.*workspace scope/);
	});

	await t.test("agent orphan lookup matches exact saved names and parent IDs while ignoring near-name decoys", async () => {
		for (const [agents, holder, outcome] of [
			[[agentInfo("idle", true, { name: "decoy", pane_id: "pane-decoy", tab_id: "tab-decoy", cwd: fixture.worktree })], false, "absent"],
			[[agentInfo("idle", true, { name: `${AGENT_NAME}-decoy`, pane_id: "pane-decoy", tab_id: "tab-decoy", cwd: fixture.worktree })], false, "absent"],
			[[agentInfo("idle", true, { pane_id: "pane-decoy", tab_id: "tab-decoy", cwd: fixture.worktree })], false, "possible"],
			[[agentInfo("idle", true, { name: "unnamed", cwd: fixture.worktree })], false, "possible"],
			[[], true, "possible"],
		] as const) {
			const script = new ScriptedProcess();
			const host = runtime(fixture, script);
			const { attempt, leasePath } = await fullAttempt(fixture, host, script);
			const intent = attempt.allocations.at(-1) as AgentAllocationIntent;
			intent.status = "unknown";
			await privateLease(leasePath);
			script.push(
				{ command: "herdr", args: ["agent", "list"], result: success({ type: "agent_list", agents }) },
				lsof(leasePath, holder ? "p83\n" : ""),
				...(outcome === "absent" ? [...startablePaneSteps(fixture), ttyInventory()] : []),
			);
			assert.equal((await host.reconcileHostAllocation({ requestId: REQUEST_ID, intent, task, attempt }, context())).outcome, outcome);
			script.done();
		}
	});

	await t.test("agent absence requires the secure saved lease and a startable exact pane", async () => {
		const missingScript = new ScriptedProcess();
		const missingHost = runtime(fixture, missingScript);
		const missing = await fullAttempt(fixture, missingHost, missingScript);
		const missingIntent = missing.attempt.allocations.at(-1) as AgentAllocationIntent;
		missingIntent.status = "unknown";
		assert.equal((await missingHost.reconcileHostAllocation({ requestId: REQUEST_ID, intent: missingIntent, task, attempt: missing.attempt }, context())).outcome, "possible");
		assert.equal(missingScript.calls.length, 1);

		const partialScript = new ScriptedProcess();
		const partialHost = runtime(fixture, partialScript);
		const partial = await fullAttempt(fixture, partialHost, partialScript);
		const partialIntent = partial.attempt.allocations.at(-1) as AgentAllocationIntent;
		partialIntent.status = "unknown";
		await privateLease(partial.leasePath);
		partialScript.push(
			{ command: "herdr", args: ["agent", "list"], result: success({ type: "agent_list", agents: [] }) },
			lsof(partial.leasePath),
			...startablePaneSteps(fixture, {
				foreground_process_group_id: 777,
				foreground_processes: [{ pid: 777, name: "node", cwd: fixture.worktree }],
			}),
		);
		assert.equal((await partialHost.reconcileHostAllocation({ requestId: REQUEST_ID, intent: partialIntent, task, attempt: partial.attempt }, context())).outcome, "possible");
		partialScript.done();

		const backgroundScript = new ScriptedProcess();
		const backgroundHost = runtime(fixture, backgroundScript);
		const background = await fullAttempt(fixture, backgroundHost, backgroundScript);
		const backgroundIntent = background.attempt.allocations.at(-1) as AgentAllocationIntent;
		backgroundIntent.status = "unknown";
		await privateLease(background.leasePath);
		backgroundScript.push(
			{ command: "herdr", args: ["agent", "list"], result: success({ type: "agent_list", agents: [] }) },
			lsof(background.leasePath),
			...startablePaneSteps(fixture),
			ttyInventory([501, 777]),
		);
		assert.equal(
			(await backgroundHost.reconcileHostAllocation({ requestId: REQUEST_ID, intent: backgroundIntent, task, attempt: background.attempt }, context())).outcome,
			"possible",
			"an unregistered background Pi on the exact pane must block retry even while its shell is idle",
		);
		assert.equal(backgroundScript.calls.filter(({ command }) => command === "ps").length, 1);
		backgroundScript.done();

		for (const [name, inventoryResult] of [
			["malformed inventory", { code: 0, stdout: "unsupported inventory", stderr: "" }],
			["failed inventory", { code: 1, stdout: "", stderr: "failed" }],
			["killed inventory", { code: 124, killed: true, stdout: "501 ttys042\n", stderr: "" }],
			["detached shell TTY", { code: 0, stdout: "1 ??\n501 ?\n", stderr: "" }],
		] as const) {
			const inventoryScript = new ScriptedProcess();
			const inventoryHost = runtime(fixture, inventoryScript);
			const inventory = await fullAttempt(fixture, inventoryHost, inventoryScript);
			const inventoryIntent = inventory.attempt.allocations.at(-1) as AgentAllocationIntent;
			inventoryIntent.status = "unknown";
			await privateLease(inventory.leasePath);
			inventoryScript.push(
				{ command: "herdr", args: ["agent", "list"], result: success({ type: "agent_list", agents: [] }) },
				lsof(inventory.leasePath),
				...startablePaneSteps(fixture),
				ttyInventory([], inventoryResult),
			);
			assert.equal(
				(await inventoryHost.reconcileHostAllocation({ requestId: REQUEST_ID, intent: inventoryIntent, task, attempt: inventory.attempt }, context())).outcome,
				"possible",
				name,
			);
			assert.equal(inventoryScript.calls.filter(({ command }) => command === "ps").length, 1, name);
			inventoryScript.done();
		}

		const exclusiveScript = new ScriptedProcess();
		const exclusiveHost = runtime(fixture, exclusiveScript);
		const exclusive = await fullAttempt(fixture, exclusiveHost, exclusiveScript);
		const exclusiveIntent = exclusive.attempt.allocations.at(-1) as AgentAllocationIntent;
		exclusiveIntent.status = "unknown";
		await privateLease(exclusive.leasePath);
		exclusiveScript.push(
			{ command: "herdr", args: ["agent", "list"], result: success({ type: "agent_list", agents: [] }) },
			lsof(exclusive.leasePath),
			...startablePaneSteps(fixture),
			ttyInventory(),
		);
		assert.equal(
			(await exclusiveHost.reconcileHostAllocation({ requestId: REQUEST_ID, intent: exclusiveIntent, task, attempt: exclusive.attempt }, context())).outcome,
			"absent",
		);
		assert.equal(exclusiveScript.calls.filter(({ command }) => command === "ps").length, 1);
		exclusiveScript.done();

		const malformedScript = new ScriptedProcess();
		const malformedHost = runtime(fixture, malformedScript);
		const malformed = await fullAttempt(fixture, malformedHost, malformedScript);
		const malformedIntent = malformed.attempt.allocations.at(-1) as AgentAllocationIntent;
		malformedIntent.status = "unknown";
		await privateLease(malformed.leasePath);
		malformedScript.push({ command: "herdr", args: ["agent", "list"], result: success({ type: "agent_list", agents: "ambiguous" }) });
		assert.equal((await malformedHost.reconcileHostAllocation({ requestId: REQUEST_ID, intent: malformedIntent, task, attempt: malformed.attempt }, context())).outcome, "possible");
		malformedScript.done();
	});
});

test("correction oversize uses the authoritative formatter and is definitively not prompted", async (t) => {
	const fixture = await paths(t);
	const script = new ScriptedProcess();
	const host = runtime(fixture, script);
	const goal = "g".repeat(4_000);
	const nearLimitTask: TaskRequest = {
		...task,
		requirements: "r".repeat(32_000),
		deliverable: "d".repeat(32_000),
		checks: [{ command: "c".repeat(22_000), args: [] }],
	};
	const attempt = baseAttempt(fixture);
	script.push(repositoryIdentityStep(fixture));
	const workspaceDetails = await host.planHostAllocation({ requestId: REQUEST_ID, goal, kind: "workspace", task: nearLimitTask, attempt }, context()) as WorkspaceAllocationPlan;
	addOwnedWorkspace(attempt, workspaceDetails);
	const tabDetails = await host.planHostAllocation({ requestId: REQUEST_ID, goal, kind: "worker_tab", task: nearLimitTask, attempt }, context()) as WorkerTabAllocationPlan;
	const leasePath = tabDetails.leasePath;
	addOwnedTab(attempt, tabDetails);
	const agentDetails = await host.planHostAllocation({ requestId: REQUEST_ID, goal, kind: "agent", task: nearLimitTask, attempt }, context()) as AgentAllocationPlan;
	attempt.allocations.push({
		...agentDetails, generation: 1, token: TOKEN, status: "owned",
	});

	const result = await host.runWorker({
		goal,
		contexts: [],
		task: nearLimitTask,
		attempt,
		workerId: AGENT_NAME,
		kind: "correction",
		preCandidate: baseIdentity(),
		failure: "f".repeat(8 * 1024),
	}, context());
	assert.equal(result.outcome, "not_prompted");
	assert.match(result.diagnostic, /assignment was not submitted.*exceeds 98304 bytes/i);
	assert.equal(script.calls.filter(({ command }) => command === "herdr").length, 0);
	script.done();
});

test("worker prompts preserve ordered upstream task data and reject oversized full assignments", async (t) => {
	const fixture = await paths(t);
	const script = new ScriptedProcess();
	const host = runtime(fixture, script);
	const { attempt } = await fullAttempt(fixture, host, script);
	const contexts = [
		{ taskId: "second", text: "Second result.\nKeep this exact line." },
		{ taskId: "first", text: "First result." },
	];
	const contextualTask: TaskRequest = { ...task, contextFrom: ["second", "first"] };
	const oversizedOutput = "x".repeat(96 * 1024 - Buffer.byteLength("Context from task oversized:\n"));
	const callsBeforeOversize = script.calls.length;
	const oversized = await host.runWorker({
		goal: GOAL,
		contexts: [{ taskId: "oversized", text: oversizedOutput }],
		task: { ...task, contextFrom: ["oversized"] },
		attempt,
		workerId: AGENT_NAME,
		kind: "initial",
		preCandidate: baseIdentity(),
	}, context());
	assert.equal(oversized.outcome, "not_prompted");
	assert.match(oversized.diagnostic, /Worker assignment exceeds 98304 bytes/);
	assert.equal(script.calls.length, callsBeforeOversize);

	const expectedAssignment = [
		"Task: task-a",
		"Goal:",
		GOAL,
		`Worktree: ${fixture.worktree}`,
		"Integrated dependencies: none",
		"",
		"Requirements:",
		"Implement the exact task.",
		"",
		"Deliverable:",
		"Commit the complete result.",
		"",
		"Upstream task data:",
		"Context from task second:",
		"Second result.\nKeep this exact line.",
		"",
		"Context from task first:",
		"First result.",
		"",
		"Required checks (direct command/argv):",
		'{"command":"pnpm","args":["test"]}',
		"",
		"Work only in the exact worktree above. Commit the complete result and leave that worktree clean.",
	].join("\n");
	script.push(
		{ command: "herdr", args: () => {}, result: success({ type: "agent_info", agent: agentInfo("idle", true, { cwd: fixture.worktree }) }) },
		{ command: "herdr", args: (args) => {
			assert.deepEqual(args.slice(0, 3), ["agent", "prompt", AGENT_NAME]);
			assert.equal(args[3], expectedAssignment);
		}, result: success({ type: "agent_prompted", agent: agentInfo("done", true, { cwd: fixture.worktree }) }) },
		{ command: "herdr", args: ["agent", "read", AGENT_NAME, "--source", "recent", "--lines", "80", "--format", "text"], result: { code: 0, stdout: "done", stderr: "" } },
	);
	const result = await host.runWorker({
		goal: GOAL,
		contexts,
		task: contextualTask,
		attempt,
		workerId: AGENT_NAME,
		kind: "initial",
		preCandidate: baseIdentity(),
	}, context());
	assert.equal(result.outcome, "candidate");
	script.done();
});

test("initial and correction prompts include the exact request goal", async (t) => {
	const fixture = await paths(t);
	const script = new ScriptedProcess();
	let inspections = 0;
	const host = runtime(fixture, script, async () => { inspections += 1; return changedIdentity(); });
	const { attempt } = await fullAttempt(fixture, host, script);
	const operation = { ...context(), deadline: 101_000, timeoutMs: 90_000 };
	script.push(
		{ command: "herdr", args: (args, options) => {
			assert.equal(args.at(-1), "30000");
			assert.equal(options.timeoutMs, 30_000);
		}, result: success({ type: "agent_info", agent: agentInfo("idle", true, { cwd: fixture.worktree }) }) },
		{ command: "herdr", args: (args, options) => {
			assert.deepEqual(args.slice(0, 3), ["agent", "prompt", AGENT_NAME]);
			assert.match(args[3]!, /Task: task-a/);
			assert.ok(args[3]!.includes(`Goal:\n${GOAL}\nWorktree:`));
			assert.ok(!args[3]!.includes("Correction failure:"));
			assert.match(args[3]!, new RegExp(fixture.worktree.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
			assert.deepEqual(args.slice(4), ["--wait", "--until", "working", "--until", "done", "--until", "blocked", "--timeout", "30000"]);
			assert.equal(options.timeoutMs, 30_000);
			assert.ok(options.timeoutMs <= 30_000 && options.timeoutMs <= operation.deadline - 1_000);
		}, result: success({ type: "agent_prompted", agent: agentInfo("working", false, { cwd: fixture.worktree }) }) },
		{ command: "herdr", args: (args) => assert.deepEqual(args.slice(0, 3), ["agent", "wait", AGENT_NAME]), result: success({ type: "agent_info", agent: agentInfo("done", true, { cwd: fixture.worktree }) }) },
		{ command: "herdr", args: ["agent", "read", AGENT_NAME, "--source", "recent", "--lines", "80", "--format", "text"], result: { code: 0, stdout: "terminal diagnostic", stderr: "" } },
	);
	const result = await host.runWorker({ goal: GOAL, contexts: [], task, attempt, workerId: AGENT_NAME, kind: "initial", preCandidate: baseIdentity() }, operation);
	assert.equal(result.outcome, "candidate");
	assert.equal(inspections, 1);

	script.push(
		{ command: "herdr", args: () => {}, result: success({ type: "agent_info", agent: agentInfo("done", true, { cwd: fixture.worktree }) }) },
		{ command: "herdr", args: (args) => {
			assert.deepEqual(args.slice(0, 3), ["agent", "prompt", AGENT_NAME]);
			assert.ok(args[3]!.includes(`Goal:\n${GOAL}\nWorktree:`));
			assert.ok(args[3]!.includes("Correction failure:\nA declared check failed."));
		}, result: success({ type: "agent_prompted", agent: agentInfo("done", true, { cwd: fixture.worktree }) }) },
		{ command: "herdr", args: ["agent", "read", AGENT_NAME, "--source", "recent", "--lines", "80", "--format", "text"], result: { code: 0, stdout: "corrected", stderr: "" } },
	);
	const correction = await host.runWorker({
		goal: GOAL,
		contexts: [],
		task,
		attempt,
		workerId: AGENT_NAME,
		kind: "correction",
		preCandidate: baseIdentity(),
		failure: "A declared check failed.",
	}, operation);
	assert.equal(correction.outcome, "candidate");
	assert.equal(inspections, 2);
	assert.equal(script.calls.filter(({ args }) => args[1] === "prompt").length, 2);
	script.done();
});

test("normal prompt treats transient compaction idle and dirty Git state as in flight until changed-clean", async (t) => {
	const fixture = await paths(t);
	const script = new ScriptedProcess();
	const delays: number[] = [];
	const inspections: InFlightTaskCandidateInspection[] = [
		{ candidate: baseIdentity(), clean: true, valid: true },
		{ candidate: { ...changedIdentity(), index: oid("c") }, clean: false, valid: true },
		{ candidate: changedIdentity(), clean: true, valid: true },
	];
	const host = runtime(fixture, script, async () => changedIdentity(), {
		delay: async (milliseconds) => { delays.push(milliseconds); },
		inspectInFlightTaskCandidate: async () => inspections.shift() ?? assert.fail("unexpected candidate inspection"),
	});
	const { attempt } = await fullAttempt(fixture, host, script);
	script.push(
		{ command: "herdr", args: () => {}, result: success({ type: "agent_info", agent: agentInfo("idle", true, { cwd: fixture.worktree }) }) },
		{ command: "herdr", args: () => {}, result: success({ type: "agent_prompted", agent: agentInfo("idle", true, { cwd: fixture.worktree }) }) },
		{ command: "herdr", args: () => {}, result: success({ type: "agent_info", agent: agentInfo("working", true, { cwd: fixture.worktree }) }) },
		{ command: "herdr", args: () => {}, result: success({ type: "agent_info", agent: agentInfo("done", true, { cwd: fixture.worktree }) }) },
		{ command: "herdr", args: ["agent", "read", AGENT_NAME, "--source", "recent", "--lines", "80", "--format", "text"], result: { code: 0, stdout: "committed after compaction", stderr: "" } },
	);

	const result = await host.runWorker({
		goal: GOAL,
		contexts: [],
		task,
		attempt,
		workerId: AGENT_NAME,
		kind: "initial",
		preCandidate: baseIdentity(),
	}, context());

	assert.equal(result.outcome, "candidate");
	assert.equal(result.outcome === "candidate" && result.candidate.head, oid("b"));
	assert.equal(inspections.length, 0);
	assert.deepEqual(delays, [250]);
	assert.equal(script.calls.filter(({ args }) => args[1] === "prompt").length, 1);
	script.done();
});

test("normal prompt blocks a definitively settled no-op without polling", async (t) => {
	const fixture = await paths(t);
	const script = new ScriptedProcess();
	const delays: number[] = [];
	const host = runtime(fixture, script, async () => changedIdentity(), {
		delay: async (milliseconds) => { delays.push(milliseconds); },
		inspectInFlightTaskCandidate: async () => ({ candidate: baseIdentity(), clean: true, valid: true }),
	});
	const { attempt } = await fullAttempt(fixture, host, script);
	script.push(
		{ command: "herdr", args: () => {}, result: success({ type: "agent_info", agent: agentInfo("idle", true, { cwd: fixture.worktree }) }) },
		{ command: "herdr", args: () => {}, result: success({ type: "agent_prompted", agent: agentInfo("done", true, { cwd: fixture.worktree }) }) },
		{ command: "herdr", args: () => {}, result: success({ type: "agent_info", agent: agentInfo("done", true, { cwd: fixture.worktree }) }) },
		{ command: "herdr", args: ["agent", "read", AGENT_NAME, "--source", "recent", "--lines", "80", "--format", "text"], result: { code: 0, stdout: "no-op", stderr: "" } },
	);

	const result = await host.runWorker({ goal: GOAL, contexts: [], task, attempt, workerId: AGENT_NAME, kind: "initial", preCandidate: baseIdentity() }, context());
	assert.equal(result.outcome, "blocked");
	assert.deepEqual(delays, []);
	script.done();
});

test("normal prompt accepts a changed clean candidate from real in-flight Git inspection", async (t) => {
	const fixture = await paths(t);
	git(fixture.root, "init", "-q", "-b", "main");
	git(fixture.root, "config", "user.name", "Subagent Test");
	git(fixture.root, "config", "user.email", "subagent@example.com");
	await writeFile(join(fixture.root, "base.txt"), "base\n");
	git(fixture.root, "add", "base.txt");
	git(fixture.root, "commit", "-qm", "base");
	await rm(fixture.worktree, { recursive: true });
	git(fixture.root, "worktree", "add", "-q", "-b", "task-a", fixture.worktree);

	const script = new ScriptedProcess();
	const gitRuntime = new CheckedGitRuntime();
	const host = runtime(fixture, script, async () => changedIdentity(), {
		inspectInFlightTaskCandidate: gitRuntime.inspectInFlightTaskCandidate.bind(gitRuntime),
	});
	const { attempt } = await fullAttempt(fixture, host, script);
	const waveBase = await gitRuntime.inspectMain({ root: fixture.root }, context());
	attempt.waveBase = waveBase;
	const worktree = attempt.allocations.find((intent) => intent.kind === "worktree")!.worktree!;
	worktree.baseCommit = waveBase.head;
	worktree.repoRoot = fixture.root;
	const preCandidate = await gitRuntime.inspectTaskCandidate({ root: fixture.root, task, attempt }, context());
	await writeFile(join(fixture.worktree, "candidate.txt"), "candidate\n");
	git(fixture.worktree, "add", "candidate.txt");
	git(fixture.worktree, "commit", "-qm", "candidate");

	script.push(
		{ command: "herdr", args: () => {}, result: success({ type: "agent_info", agent: agentInfo("idle", true, { cwd: fixture.worktree }) }) },
		{ command: "herdr", args: () => {}, result: success({ type: "agent_prompted", agent: agentInfo("done", true, { cwd: fixture.worktree }) }) },
		{ command: "herdr", args: ["agent", "read", AGENT_NAME, "--source", "recent", "--lines", "80", "--format", "text"], result: { code: 0, stdout: "done", stderr: "" } },
	);
	const result = await host.runWorker({ goal: GOAL, contexts: [], task, attempt, workerId: AGENT_NAME, kind: "initial", preCandidate }, context());
	assert.equal(result.outcome, "candidate");
	assert.notEqual(result.outcome === "candidate" && result.candidate.head, preCandidate.head);
	script.done();
});

test("delivered prompt remains observable past 30 minutes until real Git evidence becomes changed-clean", async (t) => {
	const fixture = await paths(t);
	git(fixture.root, "init", "-q", "-b", "main");
	git(fixture.root, "config", "user.name", "Subagent Test");
	git(fixture.root, "config", "user.email", "subagent@example.com");
	await writeFile(join(fixture.root, "base.txt"), "base\n");
	git(fixture.root, "add", "base.txt");
	git(fixture.root, "commit", "-qm", "base");
	await rm(fixture.worktree, { recursive: true });
	git(fixture.root, "worktree", "add", "-q", "-b", "task-a", fixture.worktree);

	const script = new ScriptedProcess();
	const gitRuntime = new CheckedGitRuntime();
	let now = 1_000;
	const delays: number[] = [];
	const host = runtime(
		fixture,
		script,
		gitRuntime.inspectTaskCandidate.bind(gitRuntime),
		{
			now: () => now,
			inspectInFlightTaskCandidate: gitRuntime.inspectInFlightTaskCandidate.bind(gitRuntime),
			delay: async (milliseconds) => {
				delays.push(milliseconds);
				now += 31 * 60_000;
				if (delays.length === 1) {
					await writeFile(join(fixture.worktree, "candidate.txt"), "dirty\n");
				} else {
					git(fixture.worktree, "add", "candidate.txt");
					git(fixture.worktree, "commit", "-qm", "candidate");
				}
			},
		},
	);
	const { attempt } = await fullAttempt(fixture, host, script);
	const waveBase = await gitRuntime.inspectMain({ root: fixture.root }, context());
	attempt.waveBase = waveBase;
	const worktree = attempt.allocations.find((intent) => intent.kind === "worktree")!.worktree!;
	worktree.baseCommit = waveBase.head;
	worktree.repoRoot = fixture.root;
	const preCandidate = await gitRuntime.inspectTaskCandidate({ root: fixture.root, task, attempt }, context());
	const operation: OperationContext = { signal: new AbortController().signal };
	const lifecycle = (status: "idle" | "done", timeoutMs: number): Step => ({
		command: "herdr",
		args: (args, options) => {
			assert.deepEqual(args.slice(-6), ["--until", "working", "--until", "unknown", "--timeout", String(timeoutMs)]);
			assert.equal(options.timeoutMs, timeoutMs);
			assert.ok(timeoutMs <= 30_000);
		},
		result: success({ type: "agent_info", agent: agentInfo(status, true, { cwd: fixture.worktree }) }),
	});
	script.push(
		{ command: "herdr", args: () => {}, result: success({ type: "agent_info", agent: agentInfo("idle", true, { cwd: fixture.worktree }) }) },
		{ command: "herdr", args: (args, options) => {
			assert.equal(args.at(-1), "30000");
			assert.equal(options.timeoutMs, 30_000);
			now = 12_000;
		}, result: failure("agent_prompt_stalled") },
		lifecycle("idle", 30_000),
		lifecycle("done", 30_000),
		lifecycle("done", 30_000),
		{ command: "herdr", args: ["agent", "read", AGENT_NAME, "--source", "recent", "--lines", "80", "--format", "text"], result: { code: 0, stdout: "diagnostic", stderr: "" } },
	);
	const result = await host.runWorker({ goal: GOAL, contexts: [], task, attempt, workerId: AGENT_NAME, kind: "initial", preCandidate }, operation);
	assert.equal(result.outcome, "candidate");
	assert.notEqual(result.outcome === "candidate" && result.candidate.head, preCandidate.head);
	assert.deepEqual(delays, [250, 250]);
	assert.equal(script.calls.filter(({ args }) => args[1] === "prompt").length, 1);
	script.done();
});

test("delivered stall treats working dirty state as transient and exact blocked as blocked", async (t) => {
	const fixture = await paths(t);
	const script = new ScriptedProcess();
	const delays: number[] = [];
	let inspections = 0;
	const host = runtime(
		fixture,
		script,
		async () => changedIdentity(),
		{
			delay: async (milliseconds) => { delays.push(milliseconds); },
			inspectInFlightTaskCandidate: async () => {
				inspections += 1;
				return { candidate: { ...changedIdentity(), index: oid("c") }, clean: false, valid: true };
			},
		},
	);
	const { attempt } = await fullAttempt(fixture, host, script);
	script.push(
		{ command: "herdr", args: () => {}, result: success({ type: "agent_info", agent: agentInfo("idle", true, { cwd: fixture.worktree }) }) },
		{ command: "herdr", args: () => {}, result: failure("agent_prompt_stalled") },
		{ command: "herdr", args: () => {}, result: success({ type: "agent_info", agent: agentInfo("working", true, { cwd: fixture.worktree }) }) },
		{ command: "herdr", args: () => {}, result: success({ type: "agent_info", agent: agentInfo("blocked", true, { cwd: fixture.worktree }) }) },
		{ command: "herdr", args: () => {}, result: { code: 0, stdout: "blocked", stderr: "" } },
	);
	const result = await host.runWorker({ goal: GOAL, contexts: [], task, attempt, workerId: AGENT_NAME, kind: "initial", preCandidate: baseIdentity() }, context());
	assert.equal(result.outcome, "blocked");
	assert.equal(inspections, 1);
	assert.deepEqual(delays, [250]);
	assert.equal(script.calls.filter(({ args }) => args[1] === "prompt").length, 1);
	script.done();
});

test("delivered stall fails closed on missing, malformed, mismatched, or uninspectable evidence", async (t) => {
	const fixture = await paths(t);
	for (const [name, lifecycle, inspectionFailure] of [
		["missing agent", failure("agent_not_found"), undefined],
		["malformed lifecycle", { code: 0, stdout: "{", stderr: "" }, undefined],
		["mismatched agent", success({ type: "agent_info", agent: agentInfo("idle", true, { name: "agent-decoy", cwd: fixture.worktree }) }), undefined],
		["candidate inspection failure", success({ type: "agent_info", agent: agentInfo("idle", true, { cwd: fixture.worktree }) }), new Error("inspection failed")],
	] as const) {
		await t.test(name, async () => {
			const script = new ScriptedProcess();
			const host = runtime(fixture, script, async () => changedIdentity(), {
				inspectInFlightTaskCandidate: async () => {
					if (inspectionFailure) throw inspectionFailure;
					return { candidate: changedIdentity(), clean: true, valid: true };
				},
			});
			const { attempt } = await fullAttempt(fixture, host, script);
			script.push(
				{ command: "herdr", args: () => {}, result: success({ type: "agent_info", agent: agentInfo("idle", true, { cwd: fixture.worktree }) }) },
				{ command: "herdr", args: () => {}, result: failure("agent_prompt_stalled") },
				{ command: "herdr", args: () => {}, result: lifecycle },
			);
			const result = await host.runWorker({ goal: GOAL, contexts: [], task, attempt, workerId: AGENT_NAME, kind: "initial", preCandidate: baseIdentity() }, context());
			assert.equal(result.outcome, "unknown");
			assert.equal(script.calls.filter(({ args }) => args[1] === "prompt").length, 1);
			script.done();
		});
	}
});

test("delivered stall polling is interrupted by its request deadline or abort signal", async (t) => {
	const fixture = await paths(t);

	await t.test("deadline", async () => {
		const script = new ScriptedProcess();
		let now = 1_000;
		const host = runtime(
			fixture,
			script,
			async () => changedIdentity(),
			{
				now: () => now,
				delay: async () => { now = 5_000; },
				inspectInFlightTaskCandidate: async () => ({ candidate: baseIdentity(), clean: true, valid: true }),
			},
		);
		const { attempt } = await fullAttempt(fixture, host, script);
		const operation = { ...context(), deadline: 5_000, timeoutMs: 4_000 };
		script.push(
			{ command: "herdr", args: () => {}, result: success({ type: "agent_info", agent: agentInfo("idle", true, { cwd: fixture.worktree }) }) },
			{ command: "herdr", args: () => {}, result: failure("agent_prompt_stalled") },
			{ command: "herdr", args: () => {}, result: success({ type: "agent_info", agent: agentInfo("idle", true, { cwd: fixture.worktree }) }) },
		);
		const result = await host.runWorker({ goal: GOAL, contexts: [], task, attempt, workerId: AGENT_NAME, kind: "initial", preCandidate: baseIdentity() }, operation);
		assert.equal(result.outcome, "interrupted");
		assert.equal(script.calls.filter(({ args }) => args[1] === "prompt").length, 1);
		script.done();
	});

	await t.test("abort", async () => {
		const script = new ScriptedProcess();
		const controller = new AbortController();
		const host = runtime(
			fixture,
			script,
			async () => changedIdentity(),
			{
				delay: async (_milliseconds, signal) => { controller.abort(); signal.throwIfAborted(); },
				inspectInFlightTaskCandidate: async () => ({ candidate: changedIdentity(), clean: false, valid: true }),
			},
		);
		const { attempt } = await fullAttempt(fixture, host, script);
		const operation: OperationContext = { signal: controller.signal, deadline: 20_000, timeoutMs: 19_000 };
		script.push(
			{ command: "herdr", args: () => {}, result: success({ type: "agent_info", agent: agentInfo("idle", true, { cwd: fixture.worktree }) }) },
			{ command: "herdr", args: () => {}, result: failure("agent_prompt_stalled") },
			{ command: "herdr", args: () => {}, result: success({ type: "agent_info", agent: agentInfo("working", true, { cwd: fixture.worktree }) }) },
		);
		const result = await host.runWorker({ goal: GOAL, contexts: [], task, attempt, workerId: AGENT_NAME, kind: "initial", preCandidate: baseIdentity() }, operation);
		assert.equal(result.outcome, "interrupted");
		assert.equal(script.calls.filter(({ args }) => args[1] === "prompt").length, 1);
		script.done();
	});
});

test("blocked, unknown, timeout, malformed, missing, and interrupted agent paths fail closed", async (t) => {
	const fixture = await paths(t);
	for (const [name, steps, expected, prompts] of [
		["blocked before prompt", [
			{ command: "herdr", args: () => {}, result: success({ type: "agent_info", agent: agentInfo("blocked", true, { cwd: fixture.worktree }) }) },
			{ command: "herdr", args: () => {}, result: { code: 0, stdout: "blocked", stderr: "" } },
		], "not_prompted", 0],
		["unknown before prompt", [{ command: "herdr", args: () => {}, result: success({ type: "agent_info", agent: agentInfo("unknown", true, { cwd: fixture.worktree }) }) }], "unknown", 0],
		["not interactively ready", [{ command: "herdr", args: () => {}, result: success({ type: "agent_info", agent: agentInfo("idle", false, { cwd: fixture.worktree }) }) }], "unknown", 0],
		["missing agent", [{ command: "herdr", args: () => {}, result: failure("agent_not_found") }], "unknown", 0],
		["malformed wait", [{ command: "herdr", args: () => {}, result: { code: 0, stdout: "{", stderr: "" } }], "unknown", 0],
		["prompt timeout", [
			{ command: "herdr", args: () => {}, result: success({ type: "agent_info", agent: agentInfo("idle", true, { cwd: fixture.worktree }) }) },
			{ command: "herdr", args: () => {}, result: failure("timeout") },
		], "unknown", 1],
		["prompt interrupted", [
			{ command: "herdr", args: () => {}, result: success({ type: "agent_info", agent: agentInfo("idle", true, { cwd: fixture.worktree }) }) },
			{ command: "herdr", args: () => {}, result: failure("agent_prompt_stalled", true) },
		], "interrupted", 1],
		["malformed prompt", [
			{ command: "herdr", args: () => {}, result: success({ type: "agent_info", agent: agentInfo("idle", true, { cwd: fixture.worktree }) }) },
			{ command: "herdr", args: () => {}, result: { code: 0, stdout: "{", stderr: "" } },
		], "unknown", 1],
		["blocked after prompt", [
			{ command: "herdr", args: () => {}, result: success({ type: "agent_info", agent: agentInfo("idle", true, { cwd: fixture.worktree }) }) },
			{ command: "herdr", args: () => {}, result: success({ type: "agent_prompted", agent: agentInfo("blocked", true, { cwd: fixture.worktree }) }) },
			{ command: "herdr", args: () => {}, result: { code: 0, stdout: "blocked", stderr: "" } },
		], "blocked", 1],
	] as const) {
		await t.test(name, async () => {
			const script = new ScriptedProcess();
			const host = runtime(fixture, script);
			const { attempt } = await fullAttempt(fixture, host, script);
			script.push(...steps);
			const result = await host.runWorker({ goal: GOAL, contexts: [], task, attempt, workerId: AGENT_NAME, kind: "initial", preCandidate: baseIdentity() }, context());
			assert.equal(result.outcome, expected);
			assert.equal(script.calls.filter(({ args }) => args[1] === "prompt").length, prompts);
			script.done();
		});
	}
});

function terminationPrefix(fixture: Paths): Step[] {
	return [
		{ command: "herdr", args: ["agent", "list"], result: success({
			type: "agent_list",
			agents: [agentInfo("idle", true, { cwd: fixture.worktree })],
		}) },
		{ command: "herdr", args: ["pane", "process-info", "--pane", WORKER_PANE_ID], result: success({
			type: "pane_process_info",
			process_info: { pane_id: WORKER_PANE_ID, foreground_processes: [{ pid: 999, name: "pi", cmdline: "secret must not be logged" }] },
		}) },
		{ command: "herdr", args: ["pane", "close", WORKER_PANE_ID], result: success({ type: "ok" }) },
		{ command: "herdr", args: ["pane", "get", WORKER_PANE_ID], result: failure("pane_not_found") },
	];
}

test("termination closes only the saved pane and rechecks every exact lease PID before bounded TERM/KILL", async (t) => {
	const fixture = await paths(t);
	const script = new ScriptedProcess();
	const kills: Array<[number, NodeJS.Signals]> = [];
	const delays: number[] = [];
	const base = runtime(fixture, script);
	const { attempt, leasePath } = await fullAttempt(fixture, base, script);
	await privateLease(leasePath);
	const host = new HerdrHostRuntime({
		inspectInFlightTaskCandidate: async () => ({ candidate: changedIdentity(), clean: true, valid: true }),
		runProcess: script.run,
		killProcess: (pid, signal) => { kills.push([pid, signal]); },
		delay: async (milliseconds) => { delays.push(milliseconds); },
		now: () => 1_000,
		env: { HERDR_ENV: "1", HERDR_PANE_ID: "pane-current" },
		leaseDirectory: fixture.leases,
		lsofCommand: "lsof-test",
	});
	script.push(
		...terminationPrefix(fixture),
		lsof(leasePath, "p101\np202\n"),
		lsof(leasePath, "p101\n", 0, 101),
		lsof(leasePath, "", 1, 202),
		lsof(leasePath, "p101\n"),
		lsof(leasePath, "p101\n", 0, 101),
		lsof(leasePath),
		lsof(leasePath),
	);
	assert.deepEqual(await host.terminateWorker({ task, attempt, workerId: AGENT_NAME, candidate: changedIdentity() }, context()), { outcome: "terminated" });
	assert.deepEqual(kills, [[101, "SIGTERM"], [101, "SIGKILL"]]);
	assert.deepEqual(delays, [250, 100, 50]);
	assert.ok(!JSON.stringify(script.calls).includes("secret must not be logged"));
	script.done();
});

test("termination refuses a stale pane that no longer belongs to the exact saved agent", async (t) => {
	const fixture = await paths(t);
	const script = new ScriptedProcess();
	const seed = runtime(fixture, script);
	const { attempt, leasePath } = await fullAttempt(fixture, seed, script);
	await privateLease(leasePath);
	const host = new HerdrHostRuntime({
		inspectInFlightTaskCandidate: async () => ({ candidate: changedIdentity(), clean: true, valid: true }),
		runProcess: script.run,
		killProcess: () => {}, delay: async () => {}, now: () => 1_000,
		env: {}, leaseDirectory: fixture.leases, lsofCommand: "lsof-test",
	});
	script.push({ command: "herdr", args: ["agent", "list"], result: success({
		type: "agent_list",
		agents: [agentInfo("idle", true, { cwd: fixture.worktree, name: "replacement-agent" })],
	}) });
	const result = await host.terminateWorker({ task, attempt, workerId: AGENT_NAME, candidate: changedIdentity() }, context());
	assert.equal(result.outcome, "unknown");
	assert.ok(!script.calls.some(({ args }) => args[0] === "pane" && args[1] === "close"));
	script.done();
});

test("termination reconciliation proves exact active or absent worker state", async (t) => {
	for (const expected of ["active", "terminated"] as const) {
		await t.test(expected, async (t) => {
			const fixture = await paths(t);
			const script = new ScriptedProcess();
			const seed = runtime(fixture, script);
			const { attempt, leasePath } = await fullAttempt(fixture, seed, script);
			await privateLease(leasePath);
			const delays: number[] = [];
			const host = new HerdrHostRuntime({
				inspectInFlightTaskCandidate: async () => ({ candidate: changedIdentity(), clean: true, valid: true }),
				runProcess: script.run,
				killProcess: () => {},
				delay: async (milliseconds) => { delays.push(milliseconds); },
				now: () => 1_000,
				env: {},
				leaseDirectory: fixture.leases,
				lsofCommand: "lsof-test",
			});
			script.push({ command: "herdr", args: ["agent", "list"], result: success({
				type: "agent_list",
				agents: expected === "active" ? [agentInfo("idle", true, { cwd: fixture.worktree })] : [],
			}) });
			if (expected === "active") {
				script.push(
					{ command: "herdr", args: ["pane", "get", WORKER_PANE_ID], result: success({ type: "pane_info", pane: { pane_id: WORKER_PANE_ID } }) },
					{ command: "herdr", args: ["pane", "process-info", "--pane", WORKER_PANE_ID], result: success({
						type: "pane_process_info", process_info: { pane_id: WORKER_PANE_ID, foreground_processes: [] },
					}) },
				);
			} else {
				script.push(
					{ command: "herdr", args: ["pane", "get", WORKER_PANE_ID], result: failure("pane_not_found") },
					lsof(leasePath),
					lsof(leasePath),
				);
			}
			assert.deepEqual(await host.reconcileWorkerTermination({
				task, attempt, workerId: AGENT_NAME, candidate: changedIdentity(),
			}, context()), { outcome: expected });
			assert.deepEqual(delays, expected === "terminated" ? [50] : []);
			script.done();
		});
	}
});

test("termination quarantines ambiguity, late holders, and survivors without signaling unrelated PIDs", async (t) => {
	const fixture = await paths(t);
	for (const [name, suffix, expectedKills] of [
		["late holder breaks two-empty proof", [lsof("LEASE"), lsof("LEASE", "p303\n")], []],
		["survivor after KILL", [
			lsof("LEASE", "p101\n"), lsof("LEASE", "p101\n", 0, 101), lsof("LEASE", "p101\n"),
			lsof("LEASE", "p101\n", 0, 101), lsof("LEASE", "p101\n"),
		], [[101, "SIGTERM"], [101, "SIGKILL"]]],
	] as const) {
		await t.test(name, async () => {
			const script = new ScriptedProcess();
			const kills: Array<[number, NodeJS.Signals]> = [];
			const seed = runtime(fixture, script);
			const { attempt, leasePath } = await fullAttempt(fixture, seed, script);
			await privateLease(leasePath);
			const host = new HerdrHostRuntime({
				inspectInFlightTaskCandidate: async () => ({ candidate: changedIdentity(), clean: true, valid: true }),
				runProcess: script.run,
				killProcess: (pid, signal) => { kills.push([pid, signal]); }, delay: async () => {}, now: () => 1_000,
				env: {}, leaseDirectory: fixture.leases, lsofCommand: "lsof-test",
			});
			script.push(...terminationPrefix(fixture), ...suffix.map((step) => ({
				...step,
				args: Array.isArray(step.args) ? step.args.map((value) => value === "LEASE" ? leasePath : value) : step.args,
			})));
			const result = await host.terminateWorker({ task, attempt, workerId: AGENT_NAME, candidate: changedIdentity() }, context());
			assert.equal(result.outcome, "unknown");
			assert.deepEqual(kills, expectedKills);
			script.done();
		});
	}

	const script = new ScriptedProcess();
	const kills: number[] = [];
	const seed = runtime(fixture, script);
	const { attempt, leasePath } = await fullAttempt(fixture, seed, script);
	await privateLease(leasePath);
	script.push(...terminationPrefix(fixture), {
		command: "lsof-test", args: ["-nP", "-a", "-F", "p", "--", leasePath],
		result: { code: 2, stdout: "", stderr: "ambiguous" },
	});
	const host = new HerdrHostRuntime({
		inspectInFlightTaskCandidate: async () => ({ candidate: changedIdentity(), clean: true, valid: true }),
		runProcess: script.run,
		killProcess: (pid) => { kills.push(pid); }, delay: async () => {}, now: () => 1_000,
		env: {}, leaseDirectory: fixture.leases, lsofCommand: "lsof-test",
	});
	assert.equal((await host.terminateWorker({ task, attempt, workerId: AGENT_NAME, candidate: changedIdentity() }, context())).outcome, "unknown");
	assert.deepEqual(kills, []);
});

test("workspace cleanup revalidates persisted Git identity before any Herdr inspection or mutation", async (t) => {
	const fixture = await paths(t);
	const driftedRepoRoot = join(fixture.directory, "cleanup-drifted-repo");
	const driftedCommonDirectory = join(driftedRepoRoot, ".git");
	await mkdir(driftedCommonDirectory, { recursive: true });
	const cases: Array<{
		name: string;
		mutate?: (details: Record<string, unknown>) => void;
		result?: ProcessResult;
		expectsProbe: boolean;
	}> = [
		{ name: "drifted Main root", mutate: (details) => { details.mainRoot = fixture.worktree; }, expectsProbe: false },
		{ name: "drifted repo key", mutate: (details) => { details.repoKey = driftedCommonDirectory; }, expectsProbe: true },
		{ name: "drifted Herdr root", mutate: (details) => { details.herdrRepoRoot = driftedRepoRoot; }, expectsProbe: true },
		{ name: "drifted common directory", result: { code: 0, stdout: `${driftedCommonDirectory}\n`, stderr: "" }, expectsProbe: true },
		{ name: "malformed common directory", result: { code: 0, stdout: ".git\n", stderr: "" }, expectsProbe: true },
		{ name: "failed common-directory probe", result: { code: 1, stdout: "", stderr: "failed" }, expectsProbe: true },
		{ name: "killed common-directory probe", result: { code: 0, killed: true, stdout: `${fixture.commonDirectory}\n`, stderr: "" }, expectsProbe: true },
	];
	for (const candidate of cases) {
		await t.test(candidate.name, async () => {
			const script = new ScriptedProcess();
			const host = runtime(fixture, script);
			const { attempt } = await fullAttempt(fixture, host, script);
			attempt.termination = { status: "terminated", workerId: AGENT_NAME, candidate: changedIdentity() };
			attempt.cleanup[0]!.status = "completed";
			const workspaceIntent = attempt.allocations.find(({ kind }) => kind === "workspace") as WorkspaceAllocationIntent;
			candidate.mutate?.(workspaceIntent as unknown as Record<string, unknown>);
			const callsBeforeCleanup = script.calls.length;
			if (candidate.expectsProbe) script.push(repositoryIdentityStep(fixture, candidate.result));
			assert.equal((await host.cleanupHost({ requestId: REQUEST_ID, kind: "workspace", task, attempt }, context())).outcome, "blocked");
			const cleanupCalls = script.calls.slice(callsBeforeCleanup);
			assert.equal(cleanupCalls.length, candidate.expectsProbe ? 1 : 0);
			assert.ok(cleanupCalls.every(({ command }) => command === "git"));
			script.done();
		});
	}
});

test("workspace cleanup rejects mismatched checkout and repository evidence before close", async (t) => {
	const fixture = await paths(t);
	for (const [name, worktree] of [
		["checkout", { checkout_path: fixture.root, repo_key: fixture.commonDirectory, repo_root: fixture.repoRoot }],
		["repo key", { checkout_path: fixture.worktree, repo_key: fixture.root, repo_root: fixture.repoRoot }],
		["repo root", { checkout_path: fixture.worktree, repo_key: fixture.commonDirectory, repo_root: fixture.root }],
	] as const) {
		await t.test(name, async () => {
			const script = new ScriptedProcess();
			const host = runtime(fixture, script);
			const { attempt } = await fullAttempt(fixture, host, script);
			attempt.termination = { status: "terminated", workerId: AGENT_NAME, candidate: changedIdentity() };
			attempt.cleanup[0]!.status = "completed";
			script.push(
				repositoryIdentityStep(fixture),
				{ command: "herdr", args: ["workspace", "get", WORKSPACE_ID], result: success({
					type: "workspace_info",
					workspace: workspaceInfo(fixture, { worktree }),
				}) },
			);
			const result = await host.cleanupHost({ requestId: REQUEST_ID, kind: "workspace", task, attempt }, context());
			assert.equal(result.outcome, "blocked");
			assert.match(result.outcome === "blocked" ? result.failure : "", /no longer matches its owned label, checkout, and repository/);
			assert.equal(script.calls.at(-1)!.options.cwd, fixture.repoRoot);
			assert.ok(script.calls.every(({ args }) => !(args[0] === "workspace" && args[1] === "close")));
			script.done();
		});
	}
});

test("cleanup closes only exact saved tab then workspace IDs and reports absent or blocked accurately", async (t) => {
	const fixture = await paths(t);
	const script = new ScriptedProcess();
	const host = runtime(fixture, script);
	const { attempt, leasePath } = await fullAttempt(fixture, host, script);
	attempt.termination = { status: "terminated", workerId: AGENT_NAME, candidate: changedIdentity(), at: 1_000 };
	await privateLease(leasePath);

	script.push(
		repositoryIdentityStep(fixture),
		{ command: "herdr", args: ["pane", "get", WORKER_PANE_ID], result: failure("pane_not_found") },
		{ command: "herdr", args: ["workspace", "get", WORKSPACE_ID], result: success({ type: "workspace_info", workspace: workspaceInfo(fixture) }) },
		{ command: "herdr", args: ["tab", "get", WORKER_TAB_ID], result: success({ type: "tab_info", tab: tabInfo() }) },
		{ command: "herdr", args: ["tab", "close", WORKER_TAB_ID], result: success({ type: "ok" }) },
		{ command: "herdr", args: ["tab", "get", WORKER_TAB_ID], result: failure("tab_not_found") },
		lsof(leasePath),
		lsof(leasePath),
		{ command: "herdr", args: ["pane", "get", WORKER_PANE_ID], result: failure("pane_not_found") },
		{ command: "herdr", args: ["tab", "get", WORKER_TAB_ID], result: failure("tab_not_found") },
	);
	assert.deepEqual(await host.cleanupHost({ requestId: REQUEST_ID, kind: "worker_tab", task, attempt }, context()), { outcome: "completed" });
	await assert.rejects(stat(leasePath), /ENOENT/);
	await assert.rejects(stat(dirname(leasePath)), /ENOENT/);
	attempt.cleanup[0]!.status = "completed";

	script.push(
		repositoryIdentityStep(fixture),
		{ command: "herdr", args: ["workspace", "get", WORKSPACE_ID], result: success({ type: "workspace_info", workspace: workspaceInfo(fixture) }) },
		{ command: "herdr", args: ["workspace", "get", WORKSPACE_ID], result: success({ type: "workspace_info", workspace: workspaceInfo(fixture) }) },
		{ command: "herdr", args: ["workspace", "close", WORKSPACE_ID], result: success({ type: "ok" }) },
		{ command: "herdr", args: ["workspace", "get", WORKSPACE_ID], result: failure("workspace_not_found") },
	);
	assert.deepEqual(await host.cleanupHost({ requestId: REQUEST_ID, kind: "workspace", task, attempt }, context()), { outcome: "completed" });
	assert.ok(script.calls.every(({ args }) => !args.includes("workspace-decoy") && !args.includes("tab-decoy")));
	script.done();

	const absentScript = new ScriptedProcess();
	const absentHost = runtime(fixture, absentScript);
	const absent = await fullAttempt(fixture, absentHost, absentScript);
	const absentAttempt = absent.attempt;
	absentAttempt.termination = { status: "terminated", workerId: AGENT_NAME, candidate: changedIdentity() };
	await privateLease(absent.leasePath);
	absentScript.push(
		repositoryIdentityStep(fixture),
		{ command: "herdr", args: ["pane", "get", WORKER_PANE_ID], result: failure("pane_not_found") },
		{ command: "herdr", args: ["workspace", "get", WORKSPACE_ID], result: failure("workspace_not_found") },
		{ command: "herdr", args: ["tab", "get", WORKER_TAB_ID], result: failure("tab_not_found") },
		lsof(absent.leasePath),
		lsof(absent.leasePath),
		{ command: "herdr", args: ["pane", "get", WORKER_PANE_ID], result: failure("pane_not_found") },
		{ command: "herdr", args: ["tab", "get", WORKER_TAB_ID], result: failure("tab_not_found") },
	);
	assert.deepEqual(await absentHost.cleanupHost({ requestId: REQUEST_ID, kind: "worker_tab", task, attempt: absentAttempt }, context()), { outcome: "absent" });
	await assert.rejects(stat(absent.leasePath), /ENOENT/);
	await assert.rejects(stat(dirname(absent.leasePath)), /ENOENT/);

	const blockedScript = new ScriptedProcess();
	const blockedHost = runtime(fixture, blockedScript);
	const blockedAttempt = (await fullAttempt(fixture, blockedHost, blockedScript)).attempt;
	blockedAttempt.termination = { status: "terminated", workerId: AGENT_NAME, candidate: changedIdentity() };
	assert.deepEqual(await blockedHost.cleanupHost({ requestId: REQUEST_ID, kind: "workspace", task, attempt: blockedAttempt }, context()), {
		outcome: "blocked", failure: "Workspace cleanup must follow worker-tab reconciliation.",
	});
	assert.equal(blockedScript.calls.length, 1);
});

test("lease cleanup preserves artifacts on schema-valid persisted identity drift", async (t) => {
	const cases: Array<{
		name: string;
		failure: RegExp;
		drift: (intent: WorkerTabAllocationIntent, paths: Paths, leasePath: string) => string;
	}> = [
		{
			name: "worker-tab token differs from the attempt token",
			failure: /allocation intent does not match the task attempt/,
			drift: (intent, paths) => {
				const token = "fedcba9876543210fedcba98";
				const leasePath = join(paths.leases, token, `${"e".repeat(32)}.lease`);
				intent.token = token;
				intent.label = `pi-subagent-${token}-worker`;
				intent.leasePath = leasePath;
				return leasePath;
			},
		},
	];

	for (const candidate of cases) {
		await t.test(candidate.name, async (t) => {
			const fixture = await paths(t);
			const script = new ScriptedProcess();
			const host = runtime(fixture, script);
			const { attempt, leasePath } = await fullAttempt(fixture, host, script);
			attempt.termination = { status: "terminated", workerId: AGENT_NAME, candidate: changedIdentity() };
			const tabIntent = attempt.allocations.find((intent) => intent.kind === "worker_tab") as WorkerTabAllocationIntent;
			const artifactPath = candidate.drift(tabIntent, fixture, leasePath);
			await privateLease(artifactPath);
			const callsBeforeCleanup = script.calls.length;
			script.push(
				repositoryIdentityStep(fixture),
				{ command: "herdr", args: ["pane", "get", WORKER_PANE_ID], result: failure("pane_not_found") },
				{ command: "herdr", args: ["workspace", "get", WORKSPACE_ID], result: failure("workspace_not_found") },
				{ command: "herdr", args: ["tab", "get", WORKER_TAB_ID], result: failure("tab_not_found") },
				lsof(artifactPath),
				lsof(artifactPath),
				{ command: "herdr", args: ["pane", "get", WORKER_PANE_ID], result: failure("pane_not_found") },
				{ command: "herdr", args: ["tab", "get", WORKER_TAB_ID], result: failure("tab_not_found") },
			);

			const result = await host.cleanupHost({ requestId: REQUEST_ID, kind: "worker_tab", task, attempt }, context());
			assert.equal(result.outcome, "blocked");
			assert.match(result.outcome === "blocked" ? result.failure : "", candidate.failure);
			assert.ok((await stat(artifactPath)).isFile());
			assert.ok((await stat(dirname(artifactPath))).isDirectory());
			assert.equal(script.calls.length, callsBeforeCleanup);
		});
	}
});

test("lease cleanup preserves artifacts when holders or exact resource absence are uncertain", async (t) => {
	await t.test("late holder", async (t) => {
		const fixture = await paths(t);
		const script = new ScriptedProcess();
		const host = runtime(fixture, script);
		const { attempt, leasePath } = await fullAttempt(fixture, host, script);
		attempt.termination = { status: "terminated", workerId: AGENT_NAME, candidate: changedIdentity() };
		await privateLease(leasePath);
		script.push(
			repositoryIdentityStep(fixture),
			{ command: "herdr", args: ["pane", "get", WORKER_PANE_ID], result: failure("pane_not_found") },
			{ command: "herdr", args: ["workspace", "get", WORKSPACE_ID], result: success({ type: "workspace_info", workspace: workspaceInfo(fixture) }) },
			{ command: "herdr", args: ["tab", "get", WORKER_TAB_ID], result: failure("tab_not_found") },
			lsof(leasePath),
			lsof(leasePath, "p303\n"),
		);

		const result = await host.cleanupHost({ requestId: REQUEST_ID, kind: "worker_tab", task, attempt }, context());
		assert.equal(result.outcome, "blocked");
		assert.match(result.outcome === "blocked" ? result.failure : "", /two consecutive cleanup scans/);
		assert.ok((await stat(leasePath)).isFile());
		assert.ok((await stat(dirname(leasePath))).isDirectory());
		script.done();
	});

	await t.test("ambiguous tab absence", async (t) => {
		const fixture = await paths(t);
		const script = new ScriptedProcess();
		const host = runtime(fixture, script);
		const { attempt, leasePath } = await fullAttempt(fixture, host, script);
		attempt.termination = { status: "terminated", workerId: AGENT_NAME, candidate: changedIdentity() };
		await privateLease(leasePath);
		script.push(
			repositoryIdentityStep(fixture),
			{ command: "herdr", args: ["pane", "get", WORKER_PANE_ID], result: failure("pane_not_found") },
			{ command: "herdr", args: ["workspace", "get", WORKSPACE_ID], result: success({ type: "workspace_info", workspace: workspaceInfo(fixture) }) },
			{ command: "herdr", args: ["tab", "get", WORKER_TAB_ID], result: failure("tab_not_found") },
			lsof(leasePath),
			lsof(leasePath),
			{ command: "herdr", args: ["pane", "get", WORKER_PANE_ID], result: failure("pane_not_found") },
			{ command: "herdr", args: ["tab", "get", WORKER_TAB_ID], result: failure("timeout") },
		);

		const result = await host.cleanupHost({ requestId: REQUEST_ID, kind: "worker_tab", task, attempt }, context());
		assert.equal(result.outcome, "blocked");
		assert.match(result.outcome === "blocked" ? result.failure : "", /tab presence is ambiguous/);
		assert.ok((await stat(leasePath)).isFile());
		assert.ok((await stat(dirname(leasePath))).isDirectory());
		script.done();
	});
});

test("lease cleanup removes the token directory only when it is empty", async (t) => {
	const fixture = await paths(t);
	const script = new ScriptedProcess();
	const host = runtime(fixture, script);
	const { attempt, leasePath } = await fullAttempt(fixture, host, script);
	attempt.termination = { status: "terminated", workerId: AGENT_NAME, candidate: changedIdentity() };
	await privateLease(leasePath);
	const retained = join(dirname(leasePath), "retained.txt");
	await writeFile(retained, "unrelated artifact\n", { mode: 0o600 });
	script.push(
		repositoryIdentityStep(fixture),
		{ command: "herdr", args: ["pane", "get", WORKER_PANE_ID], result: failure("pane_not_found") },
		{ command: "herdr", args: ["workspace", "get", WORKSPACE_ID], result: failure("workspace_not_found") },
		{ command: "herdr", args: ["tab", "get", WORKER_TAB_ID], result: failure("tab_not_found") },
		lsof(leasePath),
		lsof(leasePath),
		{ command: "herdr", args: ["pane", "get", WORKER_PANE_ID], result: failure("pane_not_found") },
		{ command: "herdr", args: ["tab", "get", WORKER_TAB_ID], result: failure("tab_not_found") },
	);

	assert.deepEqual(await host.cleanupHost({ requestId: REQUEST_ID, kind: "worker_tab", task, attempt }, context()), { outcome: "absent" });
	await assert.rejects(stat(leasePath), /ENOENT/);
	assert.ok((await stat(retained)).isFile());
	assert.ok((await stat(dirname(leasePath))).isDirectory());
	script.done();
});

test("cleanup refuses mismatched or decoy resources and ambiguous close responses", async (t) => {
	const fixture = await paths(t);
	const script = new ScriptedProcess();
	const host = runtime(fixture, script);
	const { attempt } = await fullAttempt(fixture, host, script);
	attempt.termination = { status: "terminated", workerId: AGENT_NAME, candidate: changedIdentity() };
	script.push(
		repositoryIdentityStep(fixture),
		{ command: "herdr", args: ["pane", "get", WORKER_PANE_ID], result: failure("pane_not_found") },
		{ command: "herdr", args: ["workspace", "get", WORKSPACE_ID], result: success({ type: "workspace_info", workspace: workspaceInfo(fixture) }) },
		{ command: "herdr", args: ["tab", "get", WORKER_TAB_ID], result: success({ type: "tab_info", tab: tabInfo({ workspace_id: "workspace-decoy" }) }) },
	);
	const result = await host.cleanupHost({ requestId: REQUEST_ID, kind: "worker_tab", task, attempt }, context());
	assert.equal(result.outcome, "blocked");
	assert.match(result.outcome === "blocked" ? result.failure : "", /no longer matches/);
	assert.ok(script.calls.every(({ args }) => !(args[0] === "tab" && args[1] === "close")));
	script.done();

	const decoyScript = new ScriptedProcess();
	const decoyHost = runtime(fixture, decoyScript);
	const decoyAttempt = (await fullAttempt(fixture, decoyHost, decoyScript)).attempt;
	decoyAttempt.termination = { status: "terminated", workerId: AGENT_NAME, candidate: changedIdentity() };
	decoyAttempt.cleanup[0]!.status = "completed";
	decoyScript.push(
		repositoryIdentityStep(fixture),
		{ command: "herdr", args: ["workspace", "get", WORKSPACE_ID], result: success({ type: "workspace_info", workspace: workspaceInfo(fixture) }) },
		{ command: "herdr", args: ["workspace", "get", WORKSPACE_ID], result: success({ type: "workspace_info", workspace: workspaceInfo(fixture) }) },
		{ command: "herdr", args: ["workspace", "close", WORKSPACE_ID], result: success({ type: "ok" }) },
		{ command: "herdr", args: ["workspace", "get", WORKSPACE_ID], result: failure("workspace_not_found") },
	);
	assert.deepEqual(await decoyHost.cleanupHost({ requestId: REQUEST_ID, kind: "workspace", task, attempt: decoyAttempt }, context()), { outcome: "completed" });
	decoyScript.done();
});
