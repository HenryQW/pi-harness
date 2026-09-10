import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
	createHerdrHostRuntime,
	type HerdrHostRuntime,
	type HostProcessOptions,
	type HostProcessRunner,
} from "../src/herdr-runtime.ts";
import type { OperationContext, VerifiedImplementerLaunch } from "../src/runner.ts";
import type {
	AllocationIntent,
	AllocationKind,
	TaskAttempt,
	TaskRequest,
	WorkspaceIdentity,
} from "../src/schema.ts";

const TOKEN = "token-1234567890abcdef";
const WORKSPACE_ID = "workspace-owned";
const ROOT_TAB_ID = "tab-root";
const ROOT_PANE_ID = "pane-root";
const WORKER_TAB_ID = "tab-worker";
const WORKER_PANE_ID = "pane-worker";
const AGENT_NAME = `pi-orchestrator-${TOKEN}-agent`;
const WORKSPACE_LABEL = `pi-orchestrator-${TOKEN}-workspace`;
const WORKER_LABEL = `pi-orchestrator-${TOKEN}-worker`;
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

type Paths = { directory: string; root: string; repoRoot: string; worktree: string; leases: string };

async function paths(t: test.TestContext): Promise<Paths> {
	const directory = await mkdtemp(join(tmpdir(), "pi-orchestrator-herdr-"));
	t.after(async () => await rm(directory, { recursive: true, force: true }));
	const root = join(directory, "main");
	const repoRoot = join(directory, "repo");
	const worktree = join(directory, "worktree");
	const leases = join(directory, "leases");
	await Promise.all([mkdir(root), mkdir(repoRoot), mkdir(worktree)]);
	return { directory, root, repoRoot, worktree, leases };
}

let randomSequence = 0;

function runtime(
	paths: Paths,
	script: ScriptedProcess,
	inspectTaskCandidate: (input: unknown, operation: OperationContext) => Promise<WorkspaceIdentity> = async () => changedIdentity(),
): HerdrHostRuntime {
	return createHerdrHostRuntime({
		inspectTaskCandidate,
		runProcess: script.run,
		killProcess: () => {},
		delay: async () => {},
		now: () => 1_000,
		randomId: () => (++randomSequence).toString(16).padStart(32, "0"),
		env: { HERDR_ENV: "1", HERDR_PANE_ID: "pane-current" },
		leaseDirectory: paths.leases,
		lsofCommand: "lsof-test",
	});
}

function baseAttempt(paths: Paths): TaskAttempt {
	return {
		number: 1,
		waveNumber: 1,
		waveBase: baseIdentity("refs/heads/main"),
		correlationToken: TOKEN,
		allocationGeneration: 1,
		allocations: [{
			kind: "worktree",
			generation: 1,
			token: TOKEN,
			details: "prepared",
			status: "owned",
			resourceId: paths.worktree,
			worktree: {
				path: paths.worktree,
				cwd: paths.worktree,
				branch: "task-a",
				repoRoot: paths.repoRoot,
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

async function plannedIntent(host: HerdrHostRuntime, attempt: TaskAttempt, kind: Exclude<AllocationKind, "worktree">): Promise<AllocationIntent> {
	const details = await host.planHostAllocation({ kind, task, attempt, owned: owned(attempt) }, context());
	const intent: AllocationIntent = {
		kind,
		generation: attempt.allocationGeneration,
		token: TOKEN,
		details,
		status: "allocating",
	};
	attempt.allocations.push(intent);
	return intent;
}

function addOwnedWorkspace(attempt: TaskAttempt, details: string): AllocationIntent {
	const intent: AllocationIntent = {
		kind: "workspace", generation: attempt.allocationGeneration, token: TOKEN, details,
		status: "owned", resourceId: WORKSPACE_ID, resources: { tabId: ROOT_TAB_ID, rootPaneId: ROOT_PANE_ID },
	};
	attempt.allocations.push(intent);
	return intent;
}

function addOwnedTab(attempt: TaskAttempt, details: string, leasePath: string): AllocationIntent {
	const intent: AllocationIntent = {
		kind: "worker_tab", generation: attempt.allocationGeneration, token: TOKEN, details,
		status: "owned", resourceId: WORKER_TAB_ID, resources: { rootPaneId: WORKER_PANE_ID, leasePath },
	};
	attempt.allocations.push(intent);
	return intent;
}

async function fullAttempt(paths: Paths, host: HerdrHostRuntime): Promise<{ attempt: TaskAttempt; leasePath: string }> {
	const attempt = baseAttempt(paths);
	const workspaceDetails = await host.planHostAllocation({ kind: "workspace", task, attempt, owned: owned(attempt) }, context());
	addOwnedWorkspace(attempt, workspaceDetails);
	const tabDetails = await host.planHostAllocation({ kind: "worker_tab", task, attempt, owned: owned(attempt) }, context());
	const leasePath = (JSON.parse(tabDetails) as { leasePath: string }).leasePath;
	addOwnedTab(attempt, tabDetails, leasePath);
	const agentDetails = await host.planHostAllocation({ kind: "agent", task, attempt, owned: owned(attempt) }, context());
	attempt.allocations.push({
		kind: "agent", generation: attempt.allocationGeneration, token: TOKEN, details: agentDetails,
		status: "owned", resourceId: AGENT_NAME, resources: { paneId: WORKER_PANE_ID },
	});
	return { attempt, leasePath };
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
		worktree: { checkout_path: paths.worktree, repo_root: paths.repoRoot },
		...overrides,
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

function startablePaneSteps(paths: Paths, processOverrides: Record<string, unknown> = {}): Step[] {
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

function preflightSteps(paths: Paths, schemaValue = schema(), status = "status: running\nversion: 0.9.0\nendpoint_compatible: yes\nprivate_protocol: 22\nprivate_protocol_compatible: yes\n"): Step[] {
	return [
		{ command: "herdr", args: ["--version"], result: { code: 0, stdout: "herdr 0.9.0\n", stderr: "" } },
		{ command: "herdr", args: ["status", "server"], result: { code: 0, stdout: status, stderr: "" } },
		{ command: "herdr", args: ["api", "schema", "--json"], result: { code: 0, stdout: JSON.stringify(schemaValue), stderr: "" } },
		{ command: "lsof-test", args: ["-v"], result: { code: 0, stdout: "lsof 4.99", stderr: "" } },
		{ command: "herdr", args: ["pane", "get", "pane-current"], result: success({ type: "pane_info", pane: { pane_id: "pane-current", workspace_id: "workspace-current" } }) },
		{ command: "herdr", args: ["workspace", "get", "workspace-current"], result: success({
			type: "workspace_info",
			workspace: { workspace_id: "workspace-current", worktree: { checkout_path: paths.root, repo_root: paths.root } },
		}) },
	];
}

test("preflight proves the Herdr 0.9/protocol-22 capability floor before allocation side effects", async (t) => {
	const fixture = await paths(t);
	const script = new ScriptedProcess();
	script.push(...preflightSteps(fixture));
	await runtime(fixture, script).preflightHost({ root: fixture.root }, context());
	script.done();
	assert.deepEqual(script.calls.map(({ command, args }) => [command, ...args]), [
		["herdr", "--version"],
		["herdr", "status", "server"],
		["herdr", "api", "schema", "--json"],
		["lsof-test", "-v"],
		["herdr", "pane", "get", "pane-current"],
		["herdr", "workspace", "get", "workspace-current"],
	]);

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
	] as const) {
		await t.test(name, async () => {
			const candidate = new ScriptedProcess();
			const steps = preflightSteps(fixture);
			mutate(steps);
			candidate.push(...steps);
			await assert.rejects(runtime(fixture, candidate).preflightHost({ root: fixture.root }, context()), error);
			assert.ok(candidate.calls.every(({ args }) => args[0] !== "worktree" && args[0] !== "tab" && args[0] !== "agent"));
		});
	}
});

test("allocation uses token-bound non-focused resources, a mode-0600 lease, and only verified safe Pi argv", async (t) => {
	const fixture = await paths(t);
	const script = new ScriptedProcess();
	const host = runtime(fixture, script);
	const attempt = baseAttempt(fixture);
	const workspaceIntent = await plannedIntent(host, attempt, "workspace");
	script.push({
		command: "herdr",
		args: ["worktree", "open", "--path", fixture.worktree, "--label", WORKSPACE_LABEL, "--no-focus"],
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
	Object.assign(workspaceIntent, { status: "owned", resourceId: WORKSPACE_ID, resources: workspace.outcome === "owned" ? workspace.resources : undefined });

	const tabIntent = await plannedIntent(host, attempt, "worker_tab");
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

	const agentIntent = await plannedIntent(host, attempt, "agent");
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
	script.done();
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
			const workspaceDetails = await host.planHostAllocation({ kind: "workspace", task, attempt, owned: owned(attempt) }, context());
			addOwnedWorkspace(attempt, workspaceDetails);
			const intent = await plannedIntent(host, attempt, "worker_tab");
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
	const { attempt, leasePath } = await fullAttempt(fixture, host);
	attempt.allocations.pop();
	const intent = await plannedIntent(host, attempt, "agent");
	await privateLease(leasePath);
	script.push(lsof(leasePath), ...startablePaneSteps(fixture));
	await assert.rejects(host.allocateHost({
		intent,
		task,
		attempt,
		verifyLaunch: async () => {
			assert.equal(script.calls.length, 3);
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
	const { attempt, leasePath } = await fullAttempt(fixture, host);
	attempt.allocations.pop();
	const intent = await plannedIntent(host, attempt, "agent");
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
					const workspaceDetails = await host.planHostAllocation({ kind: "workspace", task, attempt, owned: owned(attempt) }, context());
					addOwnedWorkspace(attempt, workspaceDetails);
				}
				let leasePath: string | undefined;
				if (kind === "agent") {
					const tabDetails = await host.planHostAllocation({ kind: "worker_tab", task, attempt, owned: owned(attempt) }, context());
					leasePath = (JSON.parse(tabDetails) as { leasePath: string }).leasePath;
					addOwnedTab(attempt, tabDetails, leasePath);
					await privateLease(leasePath);
				}
				const intent = await plannedIntent(host, attempt, kind);
				if (kind === "worker_tab") leasePath = (JSON.parse(intent.details) as { leasePath: string }).leasePath;
				const malformed = boundary === "malformed-after-side-effect";
				if (kind === "agent") script.push(lsof(leasePath!), ...startablePaneSteps(fixture));
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
					script.push({ command: "herdr", args: ["worktree", "list", "--cwd", fixture.worktree], result: success({
						type: "worktree_list",
						worktrees: [{ path: fixture.worktree, label: exists ? WORKSPACE_LABEL : "task-a", open_workspace_id: exists ? WORKSPACE_ID : null }],
					}) });
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
					}) }, lsof(leasePath!), ...(exists ? [] : startablePaneSteps(fixture)));
				}
				const reconciled = await host.reconcileHostAllocation({ intent, task, attempt }, context());
				assert.equal(reconciled.outcome, exists ? "possible" : "absent");
				script.done();
			});
		}
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
			const intent = await plannedIntent(host, attempt, "workspace");
			intent.status = "unknown";
			script.push({ command: "herdr", args: ["worktree", "list", "--cwd", fixture.worktree], result: success({ type: "worktree_list", worktrees }) });
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
			const workspaceDetails = await host.planHostAllocation({ kind: "workspace", task, attempt, owned: owned(attempt) }, context());
			addOwnedWorkspace(attempt, workspaceDetails);
			const intent = await plannedIntent(host, attempt, "worker_tab");
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
		const workspaceDetails = await host.planHostAllocation({ kind: "workspace", task, attempt, owned: owned(attempt) }, context());
		addOwnedWorkspace(attempt, workspaceDetails);
		const intent = await plannedIntent(host, attempt, "worker_tab");
		intent.status = "unknown";
		script.push({ command: "herdr", args: ["tab", "list", "--workspace", WORKSPACE_ID], result: success({
			type: "tab_list", tabs: [{ tab_id: ROOT_TAB_ID, workspace_id: "workspace-decoy", label: "root" }],
		}) });
		await assert.rejects(host.reconcileHostAllocation({ intent, task, attempt }, context()), /escaped.*workspace scope/);
	});

	await t.test("agent matches any saved identity field while unrelated agents are ignored", async () => {
		for (const [agents, holder, outcome] of [
			[[agentInfo("idle", true, { name: "decoy", pane_id: "pane-decoy", tab_id: "tab-decoy", cwd: fixture.worktree })], false, "absent"],
			[[agentInfo("idle", true, { pane_id: "pane-decoy", tab_id: "tab-decoy", cwd: fixture.worktree })], false, "possible"],
			[[agentInfo("idle", true, { name: "unnamed", cwd: fixture.worktree })], false, "possible"],
			[[], true, "possible"],
		] as const) {
			const script = new ScriptedProcess();
			const host = runtime(fixture, script);
			const { attempt, leasePath } = await fullAttempt(fixture, host);
			const intent = attempt.allocations.at(-1)!;
			intent.status = "unknown";
			delete intent.resourceId;
			await privateLease(leasePath);
			script.push(
				{ command: "herdr", args: ["agent", "list"], result: success({ type: "agent_list", agents }) },
				lsof(leasePath, holder ? "p83\n" : ""),
				...(outcome === "absent" ? startablePaneSteps(fixture) : []),
			);
			assert.equal((await host.reconcileHostAllocation({ intent, task, attempt }, context())).outcome, outcome);
			script.done();
		}
	});

	await t.test("agent absence requires the secure saved lease and a startable exact pane", async () => {
		const missingScript = new ScriptedProcess();
		const missingHost = runtime(fixture, missingScript);
		const missing = await fullAttempt(fixture, missingHost);
		const missingIntent = missing.attempt.allocations.at(-1)!;
		missingIntent.status = "unknown";
		delete missingIntent.resourceId;
		assert.equal((await missingHost.reconcileHostAllocation({ intent: missingIntent, task, attempt: missing.attempt }, context())).outcome, "possible");
		assert.equal(missingScript.calls.length, 0);

		const partialScript = new ScriptedProcess();
		const partialHost = runtime(fixture, partialScript);
		const partial = await fullAttempt(fixture, partialHost);
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

		const malformedScript = new ScriptedProcess();
		const malformedHost = runtime(fixture, malformedScript);
		const malformed = await fullAttempt(fixture, malformedHost);
		const malformedIntent = malformed.attempt.allocations.at(-1)!;
		malformedIntent.status = "unknown";
		delete malformedIntent.resourceId;
		await privateLease(malformed.leasePath);
		malformedScript.push({ command: "herdr", args: ["agent", "list"], result: success({ type: "agent_list", agents: "ambiguous" }) });
		assert.equal((await malformedHost.reconcileHostAllocation({ intent: malformedIntent, task, attempt: malformed.attempt }, context())).outcome, "possible");
		malformedScript.done();
	});
});

test("prompt submission follows exact readiness and accepts only a changed clean committed candidate", async (t) => {
	const fixture = await paths(t);
	const script = new ScriptedProcess();
	let inspections = 0;
	const host = runtime(fixture, script, async () => { inspections += 1; return changedIdentity(); });
	const { attempt } = await fullAttempt(fixture, host);
	script.push(
		{ command: "herdr", args: ["agent", "wait", AGENT_NAME, "--until", "idle", "--until", "done", "--until", "blocked", "--until", "unknown", "--timeout", "19000"], result: success({ type: "agent_info", agent: agentInfo("idle", true, { cwd: fixture.worktree }) }) },
		{ command: "herdr", args: (args) => {
			assert.deepEqual(args.slice(0, 3), ["agent", "prompt", AGENT_NAME]);
			assert.match(args[3]!, /Task: task-a/);
			assert.match(args[3]!, new RegExp(fixture.worktree.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
			assert.deepEqual(args.slice(4), ["--wait", "--until", "idle", "--until", "done", "--until", "blocked", "--timeout", "19000"]);
		}, result: success({ type: "agent_prompted", agent: agentInfo("done", true, { cwd: fixture.worktree }) }) },
		{ command: "herdr", args: ["agent", "read", AGENT_NAME, "--source", "recent", "--lines", "80", "--format", "text"], result: { code: 0, stdout: "terminal diagnostic", stderr: "" } },
	);
	const result = await host.runWorker({ task, attempt, workerId: AGENT_NAME, kind: "initial", preCandidate: baseIdentity() }, context());
	assert.equal(result.outcome, "candidate");
	assert.equal(inspections, 1);
	assert.equal(script.calls.filter(({ args }) => args[1] === "prompt").length, 1);
	script.done();
});

test("delivered agent_prompt_stalled is never resent and requires a changed clean candidate", async (t) => {
	const fixture = await paths(t);
	for (const [name, candidate, outcome] of [
		["changed", changedIdentity(), "candidate"],
		["unchanged", baseIdentity(), "unknown"],
		["dirty", { ...changedIdentity(), index: oid("c") }, "unknown"],
	] as const) {
		await t.test(name, async () => {
			const script = new ScriptedProcess();
			const host = runtime(fixture, script, async () => candidate);
			const { attempt } = await fullAttempt(fixture, host);
			script.push(
				{ command: "herdr", args: () => {}, result: success({ type: "agent_info", agent: agentInfo("idle", true, { cwd: fixture.worktree }) }) },
				{ command: "herdr", args: () => {}, result: failure("agent_prompt_stalled") },
				{ command: "herdr", args: () => {}, result: success({ type: "agent_info", agent: agentInfo("done", true, { cwd: fixture.worktree }) }) },
				{ command: "herdr", args: () => {}, result: { code: 0, stdout: "diagnostic", stderr: "" } },
			);
			const result = await host.runWorker({ task, attempt, workerId: AGENT_NAME, kind: "initial", preCandidate: baseIdentity() }, context());
			assert.equal(result.outcome, outcome);
			assert.equal(script.calls.filter(({ args }) => args[1] === "prompt").length, 1);
			script.done();
		});
	}
});

test("blocked, unknown, timeout, malformed, missing, and interrupted agent paths fail closed", async (t) => {
	const fixture = await paths(t);
	for (const [name, steps, expected, prompts] of [
		["blocked before prompt", [
			{ command: "herdr", args: () => {}, result: success({ type: "agent_info", agent: agentInfo("blocked", true, { cwd: fixture.worktree }) }) },
			{ command: "herdr", args: () => {}, result: { code: 0, stdout: "blocked", stderr: "" } },
		], "blocked", 0],
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
			script.push(...steps);
			const host = runtime(fixture, script);
			const { attempt } = await fullAttempt(fixture, host);
			const result = await host.runWorker({ task, attempt, workerId: AGENT_NAME, kind: "initial", preCandidate: baseIdentity() }, context());
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
	const { attempt, leasePath } = await fullAttempt(fixture, base);
	await privateLease(leasePath);
	const host = createHerdrHostRuntime({
		inspectTaskCandidate: async () => changedIdentity(),
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
			const { attempt, leasePath } = await fullAttempt(fixture, seed);
			await privateLease(leasePath);
			const host = createHerdrHostRuntime({
				inspectTaskCandidate: async () => changedIdentity(), runProcess: script.run,
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
	const { attempt, leasePath } = await fullAttempt(fixture, seed);
	await privateLease(leasePath);
	script.push(...terminationPrefix(fixture), {
		command: "lsof-test", args: ["-nP", "-a", "-F", "p", "--", leasePath],
		result: { code: 2, stdout: "", stderr: "ambiguous" },
	});
	const host = createHerdrHostRuntime({
		inspectTaskCandidate: async () => changedIdentity(), runProcess: script.run,
		killProcess: (pid) => { kills.push(pid); }, delay: async () => {}, now: () => 1_000,
		env: {}, leaseDirectory: fixture.leases, lsofCommand: "lsof-test",
	});
	assert.equal((await host.terminateWorker({ task, attempt, workerId: AGENT_NAME, candidate: changedIdentity() }, context())).outcome, "unknown");
	assert.deepEqual(kills, []);
});

test("cleanup closes only exact saved tab then workspace IDs and reports absent or blocked accurately", async (t) => {
	const fixture = await paths(t);
	const script = new ScriptedProcess();
	const host = runtime(fixture, script);
	const { attempt } = await fullAttempt(fixture, host);
	attempt.termination = { status: "terminated", workerId: AGENT_NAME, candidate: changedIdentity(), at: 1_000 };

	script.push(
		{ command: "herdr", args: ["pane", "get", WORKER_PANE_ID], result: failure("pane_not_found") },
		{ command: "herdr", args: ["workspace", "get", WORKSPACE_ID], result: success({ type: "workspace_info", workspace: workspaceInfo(fixture) }) },
		{ command: "herdr", args: ["tab", "get", WORKER_TAB_ID], result: success({ type: "tab_info", tab: tabInfo() }) },
		{ command: "herdr", args: ["tab", "close", WORKER_TAB_ID], result: success({ type: "ok" }) },
		{ command: "herdr", args: ["tab", "get", WORKER_TAB_ID], result: failure("tab_not_found") },
	);
	assert.deepEqual(await host.cleanupHost({ kind: "worker_tab", task, attempt }, context()), { outcome: "completed" });
	attempt.cleanup[0]!.status = "completed";

	script.push(
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
	const absentAttempt = (await fullAttempt(fixture, absentHost)).attempt;
	absentAttempt.termination = { status: "terminated", workerId: AGENT_NAME, candidate: changedIdentity() };
	absentScript.push(
		{ command: "herdr", args: ["pane", "get", WORKER_PANE_ID], result: failure("pane_not_found") },
		{ command: "herdr", args: ["workspace", "get", WORKSPACE_ID], result: failure("workspace_not_found") },
	);
	assert.deepEqual(await absentHost.cleanupHost({ kind: "worker_tab", task, attempt: absentAttempt }, context()), { outcome: "absent" });

	const blockedScript = new ScriptedProcess();
	const blockedHost = runtime(fixture, blockedScript);
	const blockedAttempt = (await fullAttempt(fixture, blockedHost)).attempt;
	blockedAttempt.termination = { status: "terminated", workerId: AGENT_NAME, candidate: changedIdentity() };
	assert.deepEqual(await blockedHost.cleanupHost({ kind: "workspace", task, attempt: blockedAttempt }, context()), {
		outcome: "blocked", failure: "Workspace cleanup must follow worker-tab reconciliation.",
	});
	assert.equal(blockedScript.calls.length, 0);
});

test("cleanup refuses mismatched or decoy resources and ambiguous close responses", async (t) => {
	const fixture = await paths(t);
	const script = new ScriptedProcess();
	const host = runtime(fixture, script);
	const { attempt } = await fullAttempt(fixture, host);
	attempt.termination = { status: "terminated", workerId: AGENT_NAME, candidate: changedIdentity() };
	script.push(
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
	const decoyAttempt = (await fullAttempt(fixture, decoyHost)).attempt;
	decoyAttempt.termination = { status: "terminated", workerId: AGENT_NAME, candidate: changedIdentity() };
	decoyAttempt.cleanup[0]!.status = "completed";
	decoyScript.push(
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
