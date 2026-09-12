import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { CheckedGitRuntime } from "../src/git-runtime.ts";
import {
	createHerdrHostRuntime,
	type HerdrHostRuntime,
	type HostProcessOptions,
	type HostProcessRunner,
} from "../src/herdr-runtime.ts";
import type { InFlightTaskCandidateInspection, OperationContext, VerifiedImplementerLaunch } from "../src/runner.ts";
import type {
	AllocationIntent,
	AllocationKind,
	TaskAttempt,
	TaskRequest,
	WorkspaceIdentity,
} from "../src/schema.ts";

const TOKEN = "0123456789abcdef01234567";
const WORKSPACE_ID = "workspace-owned";
const ROOT_TAB_ID = "tab-root";
const ROOT_PANE_ID = "pane-root";
const WORKER_TAB_ID = "tab-worker";
const WORKER_PANE_ID = "pane-worker";
const AGENT_NAME = `o-${TOKEN}-agent`;
const WORKSPACE_LABEL = `pi-orchestrator-${TOKEN}-workspace`;
const WORKER_LABEL = `pi-orchestrator-${TOKEN}-worker`;
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
	modelClass: "fast",
	requirements: "Implement the exact task.",
	deliverable: "Commit the complete result.",
	dependsOn: [],
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
	const directory = await realpath(await mkdtemp(join(tmpdir(), "pi-orchestrator-herdr-")));
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
	return createHerdrHostRuntime({
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
			details: "prepared",
			status: "owned",
			resourceId: paths.worktree,
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

function owned(attempt: TaskAttempt): Partial<Record<AllocationKind, string>> {
	return Object.fromEntries(attempt.allocations
		.filter((intent) => intent.status === "owned" && intent.resourceId)
		.map((intent) => [intent.kind, intent.resourceId]));
}

function repositoryIdentityStep(paths: Paths, result: ProcessResult = { code: 0, stdout: `${paths.commonDirectory}\n`, stderr: "" }): Step {
	return {
		command: "git",
		args: ["rev-parse", "--path-format=absolute", "--git-common-dir"],
		result,
	};
}

async function plannedIntent(
	host: HerdrHostRuntime,
	attempt: TaskAttempt,
	kind: Exclude<AllocationKind, "worktree">,
	paths: Paths,
	script: ScriptedProcess,
): Promise<AllocationIntent> {
	if (kind === "workspace") script.push(repositoryIdentityStep(paths));
	const details = await host.planHostAllocation({ goal: GOAL, kind, task, attempt, owned: owned(attempt) }, context());
	const intent: AllocationIntent = {
		kind,
		generation: attempt.allocationGeneration,
		token: attempt.correlationToken,
		details,
		status: "allocating",
	};
	attempt.allocations.push(intent);
	return intent;
}

function addOwnedWorkspace(attempt: TaskAttempt, details: string): AllocationIntent {
	const intent: AllocationIntent = {
		kind: "workspace", generation: attempt.allocationGeneration, token: attempt.correlationToken, details,
		status: "owned", resourceId: WORKSPACE_ID, resources: { tabId: ROOT_TAB_ID, rootPaneId: ROOT_PANE_ID },
	};
	attempt.allocations.push(intent);
	return intent;
}

function addOwnedTab(attempt: TaskAttempt, details: string, leasePath: string): AllocationIntent {
	const intent: AllocationIntent = {
		kind: "worker_tab", generation: attempt.allocationGeneration, token: attempt.correlationToken, details,
		status: "owned", resourceId: WORKER_TAB_ID, resources: { rootPaneId: WORKER_PANE_ID, leasePath },
	};
	attempt.allocations.push(intent);
	return intent;
}

async function fullAttempt(paths: Paths, host: HerdrHostRuntime, script: ScriptedProcess): Promise<{ attempt: TaskAttempt; leasePath: string }> {
	const attempt = baseAttempt(paths);
	script.push(repositoryIdentityStep(paths));
	const workspaceDetails = await host.planHostAllocation({ goal: GOAL, kind: "workspace", task, attempt, owned: owned(attempt) }, context());
	addOwnedWorkspace(attempt, workspaceDetails);
	const tabDetails = await host.planHostAllocation({ goal: GOAL, kind: "worker_tab", task, attempt, owned: owned(attempt) }, context());
	const leasePath = (JSON.parse(tabDetails) as { leasePath: string }).leasePath;
	addOwnedTab(attempt, tabDetails, leasePath);
	const agentDetails = await host.planHostAllocation({ goal: GOAL, kind: "agent", task, attempt, owned: owned(attempt) }, context());
	const agentName = (JSON.parse(agentDetails) as { agentName: string }).agentName;
	attempt.allocations.push({
		kind: "agent", generation: attempt.allocationGeneration, token: attempt.correlationToken, details: agentDetails,
		status: "owned", resourceId: agentName, resources: { paneId: WORKER_PANE_ID },
	});
	return { attempt, leasePath };
}

async function plannedAgentName(paths: Paths, host: HerdrHostRuntime, token: string): Promise<string> {
	const attempt = baseAttempt(paths, token);
	addOwnedWorkspace(attempt, "persisted workspace details");
	addOwnedTab(attempt, "persisted worker-tab details", join(paths.leases, token, `${"a".repeat(32)}.lease`));
	const details = await host.planHostAllocation({ goal: GOAL, kind: "agent", task, attempt, owned: owned(attempt) }, context());
	return (JSON.parse(details) as { agentName: string }).agentName;
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

const launch: VerifiedImplementerLaunch = {
	key: "implementer/fast",
	role: "implementer",
	modelClass: "fast",
	model: "provider/model",
	thinkingLevel: "high",
	args: ["--model", "provider/model", "--append-system-prompt", "/private/implementer.prompt"],
	env: {},
	tools: ["read", "edit"],
	fingerprint: "f".repeat(64),
};

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
				attempt.allocations[0]!.resourceId = "relative-worktree";
				attempt.allocations[0]!.worktree!.path = "relative-worktree";
				attempt.allocations[0]!.worktree!.cwd = "relative-worktree";
			},
			error: /owned worktree ID must be an absolute path/,
		},
		{ name: "relative Main root", mutateAttempt: (attempt) => { attempt.allocations[0]!.worktree!.repoRoot = "relative-main"; }, error: /Main root must be an absolute path/ },
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
			await assert.rejects(host.planHostAllocation({
				goal: GOAL,
				kind: "workspace",
				task,
				attempt,
				owned: owned(attempt),
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

	await assert.rejects(host.planHostAllocation({
		goal: "g".repeat(32_000),
		kind: "workspace",
		task: oversizedTask,
		attempt,
		owned: owned(attempt),
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
		{ name: "legacy repository-root field", mutate: (details) => { details.repoRoot = details.herdrRepoRoot; delete details.herdrRepoRoot; }, error: /unsupported or missing fields/, expectsProbe: false },
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
			const details = JSON.parse(intent.details) as Record<string, unknown>;
			candidate.mutate?.(details);
			intent.details = JSON.stringify(details);
			const callsBeforeAllocation = script.calls.length;
			if (candidate.expectsProbe) script.push(repositoryIdentityStep(fixture, candidate.result));
			await assert.rejects(host.allocateHost({ intent, task, attempt }, context()), candidate.error);
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
	assert.equal((await host.allocateHost({ intent, task, attempt }, context())).outcome, "owned");
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
			const result = await host.allocateHost({ intent, task, attempt }, context());
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
	const workspaceDetails = JSON.parse(workspaceIntent.details) as Record<string, unknown>;
	assert.deepEqual(workspaceDetails, {
		kind: "workspace",
		label: WORKSPACE_LABEL,
		worktreeCwd: fixture.worktree,
		mainRoot: fixture.root,
		repoKey: await realpath(fixture.commonDirectory),
		herdrRepoRoot: await realpath(fixture.repoRoot),
		expectedWorktreeId: fixture.worktree,
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
	const workspace = await host.allocateHost({ intent: workspaceIntent, task, attempt }, context());
	assert.deepEqual(workspace, { outcome: "owned", resourceId: WORKSPACE_ID, resources: { tabId: ROOT_TAB_ID, rootPaneId: ROOT_PANE_ID } });
	assert.notEqual(fixture.root, fixture.repoRoot);
	assert.deepEqual(script.calls.slice(0, 3).map(({ command, options }) => [command, options.cwd]), [
		["git", fixture.root],
		["git", fixture.root],
		["herdr", fixture.repoRoot],
	]);
	Object.assign(workspaceIntent, { status: "owned", resourceId: WORKSPACE_ID, resources: workspace.outcome === "owned" ? workspace.resources : undefined });

	const tabIntent = await plannedIntent(host, attempt, "worker_tab", fixture, script);
	const tabDetails = JSON.parse(tabIntent.details) as { leasePath: string };
	script.push({
		command: "herdr",
		args: [
			"tab", "create", "--workspace", WORKSPACE_ID, "--cwd", fixture.worktree,
			"--label", WORKER_LABEL, "--env", `PI_ORCHESTRATOR_PROCESS_LEASE=${tabDetails.leasePath}`, "--no-focus",
		],
		result: success({
			type: "tab_created",
			tab: tabInfo({ pane_count: 1 }),
			root_pane: { pane_id: WORKER_PANE_ID, workspace_id: WORKSPACE_ID, tab_id: WORKER_TAB_ID, cwd: fixture.worktree, focused: false },
		}),
	});
	const tab = await host.allocateHost({ intent: tabIntent, task, attempt }, context());
	assert.deepEqual(tab, { outcome: "owned", resourceId: WORKER_TAB_ID, resources: { rootPaneId: WORKER_PANE_ID, leasePath: tabDetails.leasePath } });
	assert.equal((await stat(tabDetails.leasePath)).mode & 0o777, 0o600);
	Object.assign(tabIntent, { status: "owned", resourceId: WORKER_TAB_ID, resources: tab.outcome === "owned" ? tab.resources : undefined });

	const agentIntent = await plannedIntent(host, attempt, "agent", fixture, script);
	let verified = false;
	script.push(
		lsof(tabDetails.leasePath),
		...startablePaneSteps(fixture),
		{
			command: "herdr",
			args: (args) => {
				assert.equal(verified, true);
				assert.deepEqual(args, [
					"agent", "start", AGENT_NAME, "--kind", "pi", "--pane", WORKER_PANE_ID, "--",
					...launch.args,
				]);
				assert.ok(!args.includes("Implementer raw prompt must stay private"));
			},
			result: success({ type: "agent_started", agent: agentInfo("idle", true, { cwd: fixture.worktree }) }),
		},
	);
	const agent = await host.allocateHost({
		intent: agentIntent,
		task,
		attempt,
		verifyLaunch: async () => {
			assert.deepEqual(script.calls.slice(-3).map(({ command, args }) => [command, ...args]), [
				["lsof-test", "-nP", "-a", "-F", "p", "--", tabDetails.leasePath],
				["herdr", "pane", "get", WORKER_PANE_ID],
				["herdr", "pane", "process-info", "--pane", WORKER_PANE_ID],
			]);
			verified = true;
			return launch;
		},
	}, context());
	assert.deepEqual(agent, { outcome: "owned", resourceId: AGENT_NAME, resources: { paneId: WORKER_PANE_ID } });
	assert.equal(script.calls.some(({ command }) => command === "ps"), false, "fresh allocation must not inspect same-TTY shell helpers");
	script.done();
});

test("a native-invalid persisted agent name is rejected before startPiAgent", async (t) => {
	const fixture = await paths(t);
	const script = new ScriptedProcess();
	const host = runtime(fixture, script);
	const { attempt } = await fullAttempt(fixture, host, script);
	const intent = attempt.allocations.at(-1)!;
	intent.status = "allocating";
	delete intent.resourceId;
	const details = JSON.parse(intent.details) as { agentName: string };
	details.agentName = `O-${TOKEN}-agent`;
	intent.details = JSON.stringify(details);
	const callsBeforeAllocation = script.calls.length;
	let verifications = 0;

	await assert.rejects(host.allocateHost({
		intent,
		task,
		attempt,
		verifyLaunch: async () => { verifications += 1; return launch; },
	}, context()), /Agent allocation details drifted/);
	assert.equal(verifications, 0);
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
			let verifications = 0;
			assert.equal((await host.allocateHost({
				intent,
				task,
				attempt,
				verifyLaunch: async () => { verifications += 1; return launch; },
			}, context())).outcome, "owned");
			assert.equal(verifications, 1);
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
			let verifications = 0;
			await assert.rejects(host.allocateHost({
				intent,
				task,
				attempt,
				verifyLaunch: async () => { verifications += 1; return launch; },
			}, context()), /not empty and startable/);
			assert.equal(verifications, 0);
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
			const workspaceDetails = await host.planHostAllocation({ goal: GOAL, kind: "workspace", task, attempt, owned: owned(attempt) }, context());
			addOwnedWorkspace(attempt, workspaceDetails);
			const intent = await plannedIntent(host, attempt, "worker_tab", fixture, script);
			script.push({
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
			assert.equal((await host.allocateHost({ intent, task, attempt }, context())).outcome, "unknown");
			script.done();
		});
	}
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
	await assert.rejects(host.allocateHost({
		intent,
		task,
		attempt,
		verifyLaunch: async () => {
			assert.equal(script.calls.length, 4);
			throw new Error("Implementer extension fingerprint drifted");
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
	assert.deepEqual(await host.allocateHost({ intent, task, attempt, verifyLaunch: async () => launch }, context()), {
		outcome: "absent",
		failure: "herdr agent start failed: {\"error\":{\"code\":\"agent_pane_busy\"}}",
	});
	assert.equal(script.calls.filter(({ args }) => args[0] === "agent" && args[1] === "start").length, 1);
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
					const workspaceDetails = await host.planHostAllocation({ goal: GOAL, kind: "workspace", task, attempt, owned: owned(attempt) }, context());
					addOwnedWorkspace(attempt, workspaceDetails);
				}
				let leasePath: string | undefined;
				if (kind === "agent") {
					const tabDetails = await host.planHostAllocation({ goal: GOAL, kind: "worker_tab", task, attempt, owned: owned(attempt) }, context());
					leasePath = (JSON.parse(tabDetails) as { leasePath: string }).leasePath;
					addOwnedTab(attempt, tabDetails, leasePath);
					await privateLease(leasePath);
				}
				const intent = await plannedIntent(host, attempt, kind, fixture, script);
				if (kind === "worker_tab") leasePath = (JSON.parse(intent.details) as { leasePath: string }).leasePath;
				const malformed = boundary === "malformed-after-side-effect";
				if (kind === "agent") script.push(lsof(leasePath!), ...startablePaneSteps(fixture));
				if (kind === "workspace") script.push(repositoryIdentityStep(fixture));
				script.push({
					command: "herdr",
					args: () => {},
					...(malformed
						? { result: { code: 0, stdout: "{", stderr: "" } }
						: { error: new Error(boundary === "before-side-effect" ? "spawn failed" : "result lost") }),
				});
				if (malformed) {
					const result = await host.allocateHost({ intent, task, attempt, ...(kind === "agent" ? { verifyLaunch: async () => launch } : {}) }, context());
					assert.equal(result.outcome, "unknown");
				} else {
					await assert.rejects(host.allocateHost({ intent, task, attempt, ...(kind === "agent" ? { verifyLaunch: async () => launch } : {}) }, context()), /spawn failed|result lost/);
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
				const reconciled = await host.reconcileHostAllocation({ intent, task, attempt }, context());
				assert.equal(reconciled.outcome, exists ? "possible" : "absent");
				script.done();
			});
		}
	}
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
			const details = JSON.parse(intent.details) as Record<string, unknown>;
			candidate.mutate?.(details);
			intent.details = JSON.stringify(details);
			const callsBeforeReconciliation = script.calls.length;
			if (candidate.expectsProbe) script.push(repositoryIdentityStep(fixture, candidate.result));
			await assert.rejects(host.reconcileHostAllocation({ intent, task, attempt }, context()), candidate.error);
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
			await assert.rejects(host.reconcileHostAllocation({ intent, task, attempt }, context()), /does not match the exact saved repository identity/);
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
			assert.equal((await host.reconcileHostAllocation({ intent, task, attempt }, context())).outcome, outcome, name);
		}
	});

	await t.test("tab scope and lease holders fail closed", async () => {
		for (const [tabs, holder, outcome] of [
			[[{ tab_id: ROOT_TAB_ID, workspace_id: WORKSPACE_ID, label: "root" }], false, "absent"],
			[[{ tab_id: ROOT_TAB_ID, workspace_id: WORKSPACE_ID, label: "root" }, { tab_id: "tab-untagged", workspace_id: WORKSPACE_ID, label: "other" }], false, "possible"],
			[[{ tab_id: ROOT_TAB_ID, workspace_id: WORKSPACE_ID, label: WORKER_LABEL }], false, "possible"],
			[[{ tab_id: ROOT_TAB_ID, workspace_id: WORKSPACE_ID, label: "root" }], true, "possible"],
		] as const) {
			const script = new ScriptedProcess();
			const host = runtime(fixture, script);
			const attempt = baseAttempt(fixture);
			script.push(repositoryIdentityStep(fixture));
			const workspaceDetails = await host.planHostAllocation({ goal: GOAL, kind: "workspace", task, attempt, owned: owned(attempt) }, context());
			addOwnedWorkspace(attempt, workspaceDetails);
			const intent = await plannedIntent(host, attempt, "worker_tab", fixture, script);
			intent.status = "unknown";
			const leasePath = (JSON.parse(intent.details) as { leasePath: string }).leasePath;
			if (holder) await privateLease(leasePath);
			script.push({ command: "herdr", args: ["tab", "list", "--workspace", WORKSPACE_ID], result: success({ type: "tab_list", tabs }) });
			if (holder) script.push(lsof(leasePath, "p71\n"));
			assert.equal((await host.reconcileHostAllocation({ intent, task, attempt }, context())).outcome, outcome);
		}

		const script = new ScriptedProcess();
		const host = runtime(fixture, script);
		const attempt = baseAttempt(fixture);
		script.push(repositoryIdentityStep(fixture));
		const workspaceDetails = await host.planHostAllocation({ goal: GOAL, kind: "workspace", task, attempt, owned: owned(attempt) }, context());
		addOwnedWorkspace(attempt, workspaceDetails);
		const intent = await plannedIntent(host, attempt, "worker_tab", fixture, script);
		intent.status = "unknown";
		script.push({ command: "herdr", args: ["tab", "list", "--workspace", WORKSPACE_ID], result: success({
			type: "tab_list", tabs: [{ tab_id: ROOT_TAB_ID, workspace_id: "workspace-decoy", label: "root" }],
		}) });
		await assert.rejects(host.reconcileHostAllocation({ intent, task, attempt }, context()), /escaped.*workspace scope/);
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
			const intent = attempt.allocations.at(-1)!;
			intent.status = "unknown";
			delete intent.resourceId;
			await privateLease(leasePath);
			script.push(
				{ command: "herdr", args: ["agent", "list"], result: success({ type: "agent_list", agents }) },
				lsof(leasePath, holder ? "p83\n" : ""),
				...(outcome === "absent" ? [...startablePaneSteps(fixture), ttyInventory()] : []),
			);
			assert.equal((await host.reconcileHostAllocation({ intent, task, attempt }, context())).outcome, outcome);
			script.done();
		}
	});

	await t.test("agent absence requires the secure saved lease and a startable exact pane", async () => {
		const missingScript = new ScriptedProcess();
		const missingHost = runtime(fixture, missingScript);
		const missing = await fullAttempt(fixture, missingHost, missingScript);
		const missingIntent = missing.attempt.allocations.at(-1)!;
		missingIntent.status = "unknown";
		delete missingIntent.resourceId;
		assert.equal((await missingHost.reconcileHostAllocation({ intent: missingIntent, task, attempt: missing.attempt }, context())).outcome, "possible");
		assert.equal(missingScript.calls.length, 1);

		const partialScript = new ScriptedProcess();
		const partialHost = runtime(fixture, partialScript);
		const partial = await fullAttempt(fixture, partialHost, partialScript);
		const partialIntent = partial.attempt.allocations.at(-1)!;
		partialIntent.status = "unknown";
		delete partialIntent.resourceId;
		await privateLease(partial.leasePath);
		partialScript.push(
			{ command: "herdr", args: ["agent", "list"], result: success({ type: "agent_list", agents: [] }) },
			lsof(partial.leasePath),
			...startablePaneSteps(fixture, {
				foreground_process_group_id: 777,
				foreground_processes: [{ pid: 777, name: "node", cwd: fixture.worktree }],
			}),
		);
		assert.equal((await partialHost.reconcileHostAllocation({ intent: partialIntent, task, attempt: partial.attempt }, context())).outcome, "possible");
		partialScript.done();

		const backgroundScript = new ScriptedProcess();
		const backgroundHost = runtime(fixture, backgroundScript);
		const background = await fullAttempt(fixture, backgroundHost, backgroundScript);
		const backgroundIntent = background.attempt.allocations.at(-1)!;
		backgroundIntent.status = "unknown";
		delete backgroundIntent.resourceId;
		await privateLease(background.leasePath);
		backgroundScript.push(
			{ command: "herdr", args: ["agent", "list"], result: success({ type: "agent_list", agents: [] }) },
			lsof(background.leasePath),
			...startablePaneSteps(fixture),
			ttyInventory([501, 777]),
		);
		assert.equal(
			(await backgroundHost.reconcileHostAllocation({ intent: backgroundIntent, task, attempt: background.attempt }, context())).outcome,
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
			const inventoryIntent = inventory.attempt.allocations.at(-1)!;
			inventoryIntent.status = "unknown";
			delete inventoryIntent.resourceId;
			await privateLease(inventory.leasePath);
			inventoryScript.push(
				{ command: "herdr", args: ["agent", "list"], result: success({ type: "agent_list", agents: [] }) },
				lsof(inventory.leasePath),
				...startablePaneSteps(fixture),
				ttyInventory([], inventoryResult),
			);
			assert.equal(
				(await inventoryHost.reconcileHostAllocation({ intent: inventoryIntent, task, attempt: inventory.attempt }, context())).outcome,
				"possible",
				name,
			);
			assert.equal(inventoryScript.calls.filter(({ command }) => command === "ps").length, 1, name);
			inventoryScript.done();
		}

		const exclusiveScript = new ScriptedProcess();
		const exclusiveHost = runtime(fixture, exclusiveScript);
		const exclusive = await fullAttempt(fixture, exclusiveHost, exclusiveScript);
		const exclusiveIntent = exclusive.attempt.allocations.at(-1)!;
		exclusiveIntent.status = "unknown";
		delete exclusiveIntent.resourceId;
		await privateLease(exclusive.leasePath);
		exclusiveScript.push(
			{ command: "herdr", args: ["agent", "list"], result: success({ type: "agent_list", agents: [] }) },
			lsof(exclusive.leasePath),
			...startablePaneSteps(fixture),
			ttyInventory(),
		);
		assert.equal(
			(await exclusiveHost.reconcileHostAllocation({ intent: exclusiveIntent, task, attempt: exclusive.attempt }, context())).outcome,
			"absent",
		);
		assert.equal(exclusiveScript.calls.filter(({ command }) => command === "ps").length, 1);
		exclusiveScript.done();

		const malformedScript = new ScriptedProcess();
		const malformedHost = runtime(fixture, malformedScript);
		const malformed = await fullAttempt(fixture, malformedHost, malformedScript);
		const malformedIntent = malformed.attempt.allocations.at(-1)!;
		malformedIntent.status = "unknown";
		delete malformedIntent.resourceId;
		await privateLease(malformed.leasePath);
		malformedScript.push({ command: "herdr", args: ["agent", "list"], result: success({ type: "agent_list", agents: "ambiguous" }) });
		assert.equal((await malformedHost.reconcileHostAllocation({ intent: malformedIntent, task, attempt: malformed.attempt }, context())).outcome, "possible");
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
	const workspaceDetails = await host.planHostAllocation({ goal, kind: "workspace", task: nearLimitTask, attempt, owned: owned(attempt) }, context());
	addOwnedWorkspace(attempt, workspaceDetails);
	const tabDetails = await host.planHostAllocation({ goal, kind: "worker_tab", task: nearLimitTask, attempt, owned: owned(attempt) }, context());
	const leasePath = (JSON.parse(tabDetails) as { leasePath: string }).leasePath;
	addOwnedTab(attempt, tabDetails, leasePath);
	const agentDetails = await host.planHostAllocation({ goal, kind: "agent", task: nearLimitTask, attempt, owned: owned(attempt) }, context());
	attempt.allocations.push({
		kind: "agent", generation: 1, token: TOKEN, details: agentDetails,
		status: "owned", resourceId: AGENT_NAME,
	});

	const result = await host.runWorker({
		goal,
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
			assert.deepEqual(args.slice(4), ["--wait", "--until", "idle", "--until", "done", "--until", "blocked", "--timeout", "90000"]);
			assert.equal(options.timeoutMs, 90_000);
			assert.ok(options.timeoutMs > 30_000 && options.timeoutMs <= operation.deadline - 1_000);
		}, result: success({ type: "agent_prompted", agent: agentInfo("done", true, { cwd: fixture.worktree }) }) },
		{ command: "herdr", args: ["agent", "read", AGENT_NAME, "--source", "recent", "--lines", "80", "--format", "text"], result: { code: 0, stdout: "terminal diagnostic", stderr: "" } },
	);
	const result = await host.runWorker({ goal: GOAL, task, attempt, workerId: AGENT_NAME, kind: "initial", preCandidate: baseIdentity() }, operation);
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

test("normal prompt accepts a changed clean candidate from real in-flight Git inspection", async (t) => {
	const fixture = await paths(t);
	git(fixture.root, "init", "-q", "-b", "main");
	git(fixture.root, "config", "user.name", "Orchestrator Test");
	git(fixture.root, "config", "user.email", "orchestrator@example.com");
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
	const result = await host.runWorker({ goal: GOAL, task, attempt, workerId: AGENT_NAME, kind: "initial", preCandidate }, context());
	assert.equal(result.outcome, "candidate");
	assert.notEqual(result.outcome === "candidate" && result.candidate.head, preCandidate.head);
	script.done();
});

test("delivered stall uses real in-flight Git evidence until unchanged and dirty states become changed-clean", async (t) => {
	const fixture = await paths(t);
	git(fixture.root, "init", "-q", "-b", "main");
	git(fixture.root, "config", "user.name", "Orchestrator Test");
	git(fixture.root, "config", "user.email", "orchestrator@example.com");
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
				now += 1_000;
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
	const operation = { ...context(), deadline: 101_000, timeoutMs: 90_000 };
	const lifecycle = (status: "idle" | "done", timeoutMs: number): Step => ({
		command: "herdr",
		args: (args, options) => {
			assert.deepEqual(args.slice(-6), ["--until", "working", "--until", "unknown", "--timeout", String(timeoutMs)]);
			assert.equal(options.timeoutMs, timeoutMs);
			assert.ok(timeoutMs > 30_000 && timeoutMs <= operation.deadline - now);
		},
		result: success({ type: "agent_info", agent: agentInfo(status, true, { cwd: fixture.worktree }) }),
	});
	script.push(
		{ command: "herdr", args: () => {}, result: success({ type: "agent_info", agent: agentInfo("idle", true, { cwd: fixture.worktree }) }) },
		{ command: "herdr", args: (args, options) => {
			assert.equal(args.at(-1), "90000");
			assert.equal(options.timeoutMs, 90_000);
			now = 12_000;
		}, result: failure("agent_prompt_stalled") },
		lifecycle("idle", 89_000),
		lifecycle("done", 88_000),
		lifecycle("done", 87_000),
		{ command: "herdr", args: ["agent", "read", AGENT_NAME, "--source", "recent", "--lines", "80", "--format", "text"], result: { code: 0, stdout: "diagnostic", stderr: "" } },
	);
	const result = await host.runWorker({ goal: GOAL, task, attempt, workerId: AGENT_NAME, kind: "initial", preCandidate }, operation);
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
	const result = await host.runWorker({ goal: GOAL, task, attempt, workerId: AGENT_NAME, kind: "initial", preCandidate: baseIdentity() }, context());
	assert.equal(result.outcome, "blocked");
	assert.equal(inspections, 2);
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
			const result = await host.runWorker({ goal: GOAL, task, attempt, workerId: AGENT_NAME, kind: "initial", preCandidate: baseIdentity() }, context());
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
		const result = await host.runWorker({ goal: GOAL, task, attempt, workerId: AGENT_NAME, kind: "initial", preCandidate: baseIdentity() }, operation);
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
		const result = await host.runWorker({ goal: GOAL, task, attempt, workerId: AGENT_NAME, kind: "initial", preCandidate: baseIdentity() }, operation);
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
			const result = await host.runWorker({ goal: GOAL, task, attempt, workerId: AGENT_NAME, kind: "initial", preCandidate: baseIdentity() }, context());
			assert.equal(result.outcome, expected);
			assert.equal(script.calls.filter(({ args }) => args[1] === "prompt").length, prompts);
			script.done();
		});
	}
});

function terminationPrefix(fixture: Paths): Step[] {
	return [
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
	const host = createHerdrHostRuntime({
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
			const host = createHerdrHostRuntime({
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
	const host = createHerdrHostRuntime({
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
			const workspaceIntent = attempt.allocations.find(({ kind }) => kind === "workspace")!;
			const details = JSON.parse(workspaceIntent.details) as Record<string, unknown>;
			candidate.mutate?.(details);
			workspaceIntent.details = JSON.stringify(details);
			const callsBeforeCleanup = script.calls.length;
			if (candidate.expectsProbe) script.push(repositoryIdentityStep(fixture, candidate.result));
			assert.equal((await host.cleanupHost({ kind: "workspace", task, attempt }, context())).outcome, "blocked");
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
			const result = await host.cleanupHost({ kind: "workspace", task, attempt }, context());
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
	assert.deepEqual(await host.cleanupHost({ kind: "worker_tab", task, attempt }, context()), { outcome: "completed" });
	await assert.rejects(stat(leasePath), /ENOENT/);
	await assert.rejects(stat(dirname(leasePath)), /ENOENT/);
	attempt.cleanup[0]!.status = "completed";

	script.push(
		repositoryIdentityStep(fixture),
		{ command: "herdr", args: ["workspace", "get", WORKSPACE_ID], result: success({ type: "workspace_info", workspace: workspaceInfo(fixture) }) },
		{ command: "herdr", args: ["workspace", "get", WORKSPACE_ID], result: success({ type: "workspace_info", workspace: workspaceInfo(fixture) }) },
		{ command: "herdr", args: ["tab", "list", "--workspace", WORKSPACE_ID], result: success({ type: "tab_list", tabs: [
			{ tab_id: ROOT_TAB_ID, workspace_id: WORKSPACE_ID, label: "root", pane_count: 1 },
		] }) },
		{ command: "herdr", args: ["pane", "list", "--workspace", WORKSPACE_ID], result: success({ type: "pane_list", panes: [
			{ pane_id: ROOT_PANE_ID, tab_id: ROOT_TAB_ID, workspace_id: WORKSPACE_ID, agent: null },
		] }) },
		{ command: "herdr", args: ["workspace", "close", WORKSPACE_ID], result: success({ type: "ok" }) },
		{ command: "herdr", args: ["workspace", "get", WORKSPACE_ID], result: failure("workspace_not_found") },
	);
	assert.deepEqual(await host.cleanupHost({ kind: "workspace", task, attempt }, context()), { outcome: "completed" });
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
	assert.deepEqual(await absentHost.cleanupHost({ kind: "worker_tab", task, attempt: absentAttempt }, context()), { outcome: "absent" });
	await assert.rejects(stat(absent.leasePath), /ENOENT/);
	await assert.rejects(stat(dirname(absent.leasePath)), /ENOENT/);

	const blockedScript = new ScriptedProcess();
	const blockedHost = runtime(fixture, blockedScript);
	const blockedAttempt = (await fullAttempt(fixture, blockedHost, blockedScript)).attempt;
	blockedAttempt.termination = { status: "terminated", workerId: AGENT_NAME, candidate: changedIdentity() };
	assert.deepEqual(await blockedHost.cleanupHost({ kind: "workspace", task, attempt: blockedAttempt }, context()), {
		outcome: "blocked", failure: "Workspace cleanup must follow worker-tab reconciliation.",
	});
	assert.equal(blockedScript.calls.length, 1);
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

		const result = await host.cleanupHost({ kind: "worker_tab", task, attempt }, context());
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

		const result = await host.cleanupHost({ kind: "worker_tab", task, attempt }, context());
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

	assert.deepEqual(await host.cleanupHost({ kind: "worker_tab", task, attempt }, context()), { outcome: "absent" });
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
	const result = await host.cleanupHost({ kind: "worker_tab", task, attempt }, context());
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
		{ command: "herdr", args: ["tab", "list", "--workspace", WORKSPACE_ID], result: success({ type: "tab_list", tabs: [
			{ tab_id: ROOT_TAB_ID, workspace_id: WORKSPACE_ID, label: "root", pane_count: 1 },
			{ tab_id: "tab-decoy", workspace_id: WORKSPACE_ID, label: "decoy", pane_count: 1 },
		] }) },
		{ command: "herdr", args: ["pane", "list", "--workspace", WORKSPACE_ID], result: success({ type: "pane_list", panes: [
			{ pane_id: ROOT_PANE_ID, tab_id: ROOT_TAB_ID, workspace_id: WORKSPACE_ID, agent: null },
			{ pane_id: "pane-decoy", tab_id: "tab-decoy", workspace_id: WORKSPACE_ID, agent: null },
		] }) },
	);
	const decoy = await decoyHost.cleanupHost({ kind: "workspace", task, attempt: decoyAttempt }, context());
	assert.equal(decoy.outcome, "blocked");
	assert.ok(decoyScript.calls.every(({ args }) => !(args[0] === "workspace" && args[1] === "close")));
	decoyScript.done();
});
