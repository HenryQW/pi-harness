import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { defineTool, withFileMutationQueue, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { commandFailure, commandOutput, runCommand, type CommandRunner } from "./command.ts";
import type { DeliveryGraph, LocalIssue, ResolvedProfile, WorkerEnvelope } from "./model.ts";
import { planningReviewPath, PLANNING_REVIEW_TOOL, writePlanningReviewPass } from "./planning-review.ts";
import { array, nonEmptyString, object, oneOf } from "./validate.ts";

export type WorkerRole = "implementer" | "reviewer";

export const WORKER_TOOLS = {
	request_review: "auto_dag_request_review",
	submit_review: "auto_dag_submit_review",
	submit_health: "auto_dag_submit_health",
	block_task: "auto_dag_block_task",
} as const;

export type WorkerEvent = keyof typeof WORKER_TOOLS;

export const WORKER_ROLE_EVENTS: Record<WorkerRole, WorkerEvent[]> = {
	implementer: ["request_review", "block_task"],
	reviewer: ["submit_review", "submit_health", "block_task"],
};

export interface WorkerLaunchInput {
	role: WorkerRole;
	events?: WorkerEvent[];
	profile: ResolvedProfile;
	run_id: string;
	issue_id: string;
	main_pane: string;
}

export interface WorkerLaunch {
	env: Record<string, string>;
	args: string[];
}

export const WORKER_EXTENSION_PATH = fileURLToPath(new URL("../extensions/worker.ts", import.meta.url));

/** Profile owns baseline Pi resources; Auto DAG adds only its worker adapter and phase tools. */
export function createWorkerLaunch(input: WorkerLaunchInput): WorkerLaunch {
	const role = parseWorkerRole(input.role);
	const events = parseWorkerEvents(input.events ?? WORKER_ROLE_EVENTS[role], role);
	return {
		env: {
			PI_CODING_AGENT_DIR: nonEmptyString(input.profile.agent_dir, "worker profile agent_dir"),
			PI_AUTO_DAG_WORKER_ROLE: role,
			PI_AUTO_DAG_WORKER_EVENTS: events.join(","),
			PI_AUTO_DAG_RUN_ID: nonEmptyString(input.run_id, "worker run_id"),
			PI_AUTO_DAG_ISSUE_ID: nonEmptyString(input.issue_id, "worker issue_id"),
			PI_AUTO_DAG_MAIN_PANE: nonEmptyString(input.main_pane, "worker main_pane"),
		},
		args: profileLaunchArgs(input.profile, events.map((event) => WORKER_TOOLS[event])),
	};
}

export function createPlanningReviewLaunch(profile: ResolvedProfile, mainWorktree: string): WorkerLaunch {
	return {
		env: {
			PI_CODING_AGENT_DIR: nonEmptyString(profile.agent_dir, "planning reviewer profile agent_dir"),
			PI_AUTO_DAG_PLANNING_ROOT: nonEmptyString(mainWorktree, "planning reviewer main worktree"),
		},
		args: profileLaunchArgs(profile, [PLANNING_REVIEW_TOOL]),
	};
}

function profileLaunchArgs(profile: ResolvedProfile, addedTools: string[]): string[] {
	return [
		"--offline",
		"--no-skills",
		...profile.skills.flatMap((path) => ["--skill", nonEmptyString(path, `profile ${profile.id} skill path`)]),
		"--extension",
		WORKER_EXTENSION_PATH,
		"--tools",
		[...new Set([...profile.tools, ...addedTools])].join(","),
	];
}

interface WorkerEnvironment {
	role: WorkerRole;
	events: WorkerEvent[];
	run_id: string;
	issue_id: string;
	main_pane: string;
}

export function workerEnvironment(environment: NodeJS.ProcessEnv): WorkerEnvironment {
	const role = parseWorkerRole(environment.PI_AUTO_DAG_WORKER_ROLE);
	return {
		role,
		events: parseWorkerEvents(environment.PI_AUTO_DAG_WORKER_EVENTS?.split(",") ?? WORKER_ROLE_EVENTS[role], role),
		run_id: nonEmptyString(environment.PI_AUTO_DAG_RUN_ID, "PI_AUTO_DAG_RUN_ID"),
		issue_id: nonEmptyString(environment.PI_AUTO_DAG_ISSUE_ID, "PI_AUTO_DAG_ISSUE_ID"),
		main_pane: nonEmptyString(environment.PI_AUTO_DAG_MAIN_PANE, "PI_AUTO_DAG_MAIN_PANE"),
	};
}

export async function sendWorkerEnvelope(
	worker: WorkerEnvironment,
	type: WorkerEvent,
	payload: Record<string, unknown>,
	runner: CommandRunner = runCommand,
	cwd = process.cwd(),
): Promise<WorkerEnvelope> {
	if (!worker.events.includes(type)) {
		throw new Error(`${worker.role} worker cannot send ${type}`);
	}
	const envelope: WorkerEnvelope = {
		version: 1,
		type,
		run_id: worker.run_id,
		issue_id: worker.issue_id,
		role: worker.role,
		payload,
	};
	await commandOutput(runner, "herdr", ["agent", "prompt", worker.main_pane, JSON.stringify(envelope)], cwd);
	return envelope;
}

export interface WorkerExtensionOptions {
	environment?: NodeJS.ProcessEnv;
	runner?: CommandRunner;
	cwd?: string;
}

export function createWorkerExtension(options: WorkerExtensionOptions = {}) {
	return (pi: ExtensionAPI) => {
		const environment = options.environment ?? process.env;
		const runWorkerValues = [
			environment.PI_AUTO_DAG_WORKER_ROLE,
			environment.PI_AUTO_DAG_RUN_ID,
			environment.PI_AUTO_DAG_ISSUE_ID,
			environment.PI_AUTO_DAG_MAIN_PANE,
		];
		if (environment.PI_AUTO_DAG_PLANNING_ROOT !== undefined) {
			if (runWorkerValues.some((value) => value !== undefined)) throw new Error("Planning reviewer cannot also be a run worker");
			registerPlanningReviewTool(pi, nonEmptyString(environment.PI_AUTO_DAG_PLANNING_ROOT, "PI_AUTO_DAG_PLANNING_ROOT"));
			return;
		}
		if (runWorkerValues.every((value) => value === undefined)) return;
		const worker = workerEnvironment(environment);
		const runner = options.runner ?? runCommand;
		const cwd = options.cwd ?? process.cwd();
		for (const type of worker.events) registerWorkerTool(pi, worker, type, runner, cwd);
	};
}

function registerPlanningReviewTool(pi: ExtensionAPI, mainWorktree: string): void {
	pi.registerTool(defineTool({
		name: PLANNING_REVIEW_TOOL,
		label: "Submit planning review",
		description: "Record PASS for exact current draft after independent semantic review. Call only when no material blockers remain.",
		parameters: Type.Object({}),
		async execute() {
			return withFileMutationQueue(planningReviewPath(mainWorktree), async () => {
				const pass = await writePlanningReviewPass(mainWorktree);
				return { content: [{ type: "text", text: `Recorded reviewer PASS for ${pass.graph_id} at ${pass.graph_hash}.` }], details: pass, terminate: true };
			});
		},
	}));
}

function registerWorkerTool(
	pi: ExtensionAPI,
	worker: WorkerEnvironment,
	type: WorkerEvent,
	runner: CommandRunner,
	cwd: string,
): void {
	const definition = eventDefinition(type);
	pi.registerTool(defineTool({
		name: WORKER_TOOLS[type],
		label: definition.label,
		description: definition.description,
		parameters: definition.parameters,
		prepareArguments(args) {
			if (type !== "request_review" || !args || typeof args !== "object" || Array.isArray(args)) return args as Record<PropertyKey, unknown>;
			const { commit: _commit, ...prepared } = args as Record<string, unknown>;
			return prepared;
		},
		async execute(_toolCallId, params) {
			const payload = definition.payload(params as Record<string, unknown>);
			if (type === "request_review") payload.commit = await commandOutput(runner, "git", ["rev-parse", "HEAD"], cwd);
			const envelope = await sendWorkerEnvelope(worker, type, payload, runner, cwd);
			return { content: [{ type: "text", text: `Sent ${type} for ${worker.issue_id}.` }], details: envelope, terminate: true };
		},
	}));
}

function eventDefinition(type: WorkerEvent): {
	label: string;
	description: string;
	parameters: ReturnType<typeof Type.Object>;
	payload: (params: Record<string, unknown>) => Record<string, unknown>;
} {
	switch (type) {
		case "request_review":
			return { label: "Request review", description: "Request reviewer dispatch for current worktree HEAD at the prompted attempt and review round.", parameters: Type.Object({ attempt: Type.Integer({ minimum: 1 }), review_round: Type.Integer({ minimum: 1 }), summary: Type.Optional(Type.String()) }), payload: (params) => params };
		case "submit_review":
			return { label: "Submit review", description: "Submit the exact frozen command, exit code, and independent reviewer verdict; non-approvals need findings.", parameters: Type.Object({ commit: Type.String(), attempt: Type.Integer({ minimum: 1 }), review_round: Type.Integer({ minimum: 1 }), command: Type.String(), exit_code: Type.Integer({ minimum: 0 }), verdict: Type.Union([Type.Literal("approved"), Type.Literal("changes_requested"), Type.Literal("blocked")]), findings: Type.Array(Type.String()), fixed_thread_ids: Type.Optional(Type.Array(Type.String())) }), payload: (params) => params };
		case "submit_health":
			return { label: "Submit health", description: "Submit explicit PR-health evidence for the prompted attempt and review round.", parameters: Type.Object({ summary: Type.String(), actionable: Type.Boolean(), attempt: Type.Integer({ minimum: 1 }), review_round: Type.Integer({ minimum: 1 }), thread_ids: Type.Optional(Type.Array(Type.String())), checks: Type.Optional(Type.Array(Type.Object({ name: Type.String(), link: Type.Optional(Type.String()), output: Type.Optional(Type.String()) }))) }), payload: (params) => params };
		case "block_task":
			return { label: "Block task", description: "Report a blocker for the prompted task attempt and review round.", parameters: Type.Object({ reason: Type.String(), attempt: Type.Integer({ minimum: 1 }), review_round: Type.Integer({ minimum: 1 }) }), payload: (params) => params };
	}
}

export function workerDeliveryContext(graph: DeliveryGraph): Record<string, unknown> {
	return { goal: graph.goal, constraints: graph.constraints, non_goals: graph.non_goals };
}

export function workerIssueContext(issue: LocalIssue, includeTesting: boolean): Record<string, unknown> {
	return {
		id: issue.id,
		title: issue.title,
		purpose: issue.purpose,
		acceptance: issue.acceptance,
		...(includeTesting ? { testing: issue.testing } : {}),
	};
}

function parseWorkerEvents(value: unknown, role: WorkerRole): WorkerEvent[] {
	if (!Array.isArray(value) || !value.length) throw new Error("worker events must be a non-empty array");
	const events = [...new Set(value.map((event) => oneOf(event, Object.keys(WORKER_TOOLS) as WorkerEvent[], "worker event")))];
	for (const event of events) {
		if (!WORKER_ROLE_EVENTS[role].includes(event)) throw new Error(`${role} worker cannot send ${event}`);
	}
	return events;
}

function parseWorkerRole(value: unknown): WorkerRole {
	return oneOf(value, ["implementer", "reviewer"] as const, "worker role");
}

interface WorkerHostState {
	main_worktree: string;
	workspace_id: string;
}

interface WorkerHostOptions {
	runner: CommandRunner;
	delay?: (milliseconds: number) => Promise<void>;
}

type CommandResult = Awaited<ReturnType<CommandRunner>>;

export function workerEnvironmentArgs(launch: WorkerLaunch): string[] {
	return Object.entries(launch.env).flatMap(([key, value]) => ["--env", `${key}=${value}`]);
}

export function workerAgentName(workspaceId: string, runId: string, roleKey: string, role: WorkerRole): string {
	const id = nonEmptyString(workspaceId, "Herdr workspace id");
	const hash = createHash("sha256").update(`${id}:${runId}:${roleKey}:${role}`).digest("hex").slice(0, 24);
	return `dag-${hash}-${role === "implementer" ? "i" : "r"}`;
}

export async function workerWorkspaceId(mainWorktree: string, mainPane: string, options: WorkerHostOptions): Promise<string> {
	const paneId = nonEmptyString(mainPane, "recorded main Herdr pane");
	const pane = (await listWorkerPanes(mainWorktree, options))
		.map((entry, index) => object(entry, `Herdr pane ${index}`))
		.find((entry) => entry.pane_id === paneId);
	if (!pane) throw new Error(`Recorded main Herdr pane is missing: ${paneId}`);
	return nonEmptyString(pane.workspace_id, "recorded main Herdr workspace");
}

/** Every agent-list consumer gets only agents owned by this Herdr workspace. */
export async function listWorkerAgents(state: WorkerHostState, options: WorkerHostOptions): Promise<Map<string, string>> {
	const workspaceId = nonEmptyString(state.workspace_id, "recorded Herdr workspace");
	const response = object(JSON.parse(await commandOutput(options.runner, "herdr", ["agent", "list"], state.main_worktree)), "Herdr agent list response");
	const result = object(response.result, "Herdr agent list result");
	return new Map(array(result.agents, "Herdr agents").flatMap((entry, index) => {
		const agent = object(entry, `Herdr agent ${index}`);
		if (nonEmptyString(agent.workspace_id, `Herdr agent ${index} workspace`) !== workspaceId) return [];
		return [[
			nonEmptyString(agent.pane_id, `Herdr agent ${index} pane`),
			nonEmptyString(agent.agent_status, `Herdr agent ${index} status`),
		] as const];
	}));
}

export async function createWorkerTab(
	state: WorkerHostState,
	cwd: string,
	launch: WorkerLaunch,
	label: string,
	options: WorkerHostOptions,
): Promise<{ tab_id: string; pane_id: string }> {
	const text = await commandOutput(options.runner, "herdr", [
		"tab", "create", "--workspace", nonEmptyString(state.workspace_id, "recorded Herdr workspace"), "--cwd", cwd, ...workerEnvironmentArgs(launch), "--label", label, "--no-focus",
	], state.main_worktree);
	const result = object(object(JSON.parse(text), "Herdr tab response").result, "Herdr tab result");
	return {
		tab_id: nonEmptyString(object(result.tab, "Herdr tab").tab_id, "Herdr tab id"),
		pane_id: nonEmptyString(object(result.root_pane, "Herdr root pane").pane_id, "Herdr root pane id"),
	};
}

/** Reuse a recorded root tab, recover it by provisioning identity, or create it once. */
export async function reconcileWorkerTab(
	state: WorkerHostState,
	input: {
		tab_id?: string;
		pane_id?: string;
		cwd: string;
		launch: WorkerLaunch;
		label: string;
	},
	options: WorkerHostOptions,
): Promise<{ tab_id: string; pane_id: string }> {
	if (input.tab_id && input.pane_id && await workerTabExists(state, input.tab_id, options)) {
		return { tab_id: input.tab_id, pane_id: input.pane_id };
	}
	return await findWorkerTab(state, input.label, options)
		?? await createWorkerTab(state, input.cwd, input.launch, input.label, options);
}

export async function findWorkerTab(
	state: WorkerHostState,
	label: string,
	options: WorkerHostOptions,
): Promise<{ tab_id: string; pane_id: string } | undefined> {
	const workspaceId = nonEmptyString(state.workspace_id, "recorded Herdr workspace");
	const matches = (await listWorkerTabs(state.main_worktree, options))
		.map((entry, index) => object(entry, `Herdr tab ${index}`))
		.filter((tab, index) => nonEmptyString(tab.workspace_id, `Herdr tab ${index} workspace`) === workspaceId)
		.filter((tab) => tab.label === label);
	if (matches.length > 1) throw new Error(`Multiple Herdr tabs match provisioning identity: ${label}`);
	if (!matches.length) return undefined;
	const tabId = nonEmptyString(object(matches[0], "Herdr tab").tab_id, "Herdr tab id");
	const panes = (await listWorkerPanes(state.main_worktree, options))
		.filter((entry, index) => object(entry, `Herdr pane ${index}`).tab_id === tabId);
	if (panes.length !== 1) throw new Error(`Provisioned Herdr tab ${tabId} must contain exactly one root pane`);
	return { tab_id: tabId, pane_id: nonEmptyString(object(panes[0], "Herdr pane").pane_id, "Herdr pane id") };
}

export async function workerTabExists(state: WorkerHostState, tabId: string, options: WorkerHostOptions): Promise<boolean> {
	const expected = nonEmptyString(state.workspace_id, "recorded Herdr workspace");
	const id = nonEmptyString(tabId, "Herdr tab id");
	const tab = (await listWorkerTabs(state.main_worktree, options))
		.map((entry, index) => object(entry, `Herdr tab ${index}`))
		.find((entry) => entry.tab_id === id);
	if (!tab) return false;
	const actual = nonEmptyString(tab.workspace_id, `Herdr tab ${id} workspace`);
	if (actual !== expected) throw new Error(`Herdr tab ${id} belongs to workspace ${actual}, expected initiating workspace ${expected}`);
	return true;
}

export async function ensureWorkerPane(
	state: WorkerHostState,
	tabId: string,
	rootPane: string,
	cwd: string,
	launch: WorkerLaunch,
	label: string,
	options: WorkerHostOptions,
): Promise<string> {
	const tab = nonEmptyString(tabId, "Herdr tab id");
	const workspace = nonEmptyString(state.workspace_id, "recorded Herdr workspace");
	const ownerTab = (await listWorkerTabs(state.main_worktree, options))
		.map((entry, index) => object(entry, `Herdr tab ${index}`))
		.find((entry) => entry.tab_id === tab);
	if (!ownerTab) throw new Error(`Herdr tab is missing: ${tab}`);
	const ownerWorkspace = nonEmptyString(ownerTab.workspace_id, `Herdr tab ${tab} workspace`);
	if (ownerWorkspace !== workspace) throw new Error(`Herdr tab ${tab} belongs to workspace ${ownerWorkspace}, expected initiating workspace ${workspace}`);
	const root = nonEmptyString(rootPane, "Herdr root pane");
	const panes = (await listWorkerPanes(state.main_worktree, options)).map((entry, index) => object(entry, `Herdr pane ${index}`));
	const owner = panes.find((pane) => pane.pane_id === root);
	if (!owner) throw new Error(`Herdr root pane is missing: ${root}`);
	if (owner.tab_id !== tab) throw new Error(`Herdr root pane ${root} does not belong to tab ${tab}`);
	const reviewers = panes.filter((pane) => pane.tab_id === tab && pane.pane_id !== root);
	const named = reviewers.filter((pane) => pane.label === label);
	if (named.length > 1) throw new Error(`Multiple Herdr panes match provisioning identity: ${label}`);
	if (named.length) return nonEmptyString(named[0].pane_id, "Herdr reviewer pane id");
	if (reviewers.length > 1) throw new Error(`Provisioned Herdr tab ${tab} has multiple reviewer panes`);
	if (reviewers.length) return nonEmptyString(reviewers[0].pane_id, "Herdr reviewer pane id");
	const text = await commandOutput(options.runner, "herdr", [
		"pane", "split", "--pane", root,
		"--direction", "right", "--cwd", cwd, ...workerEnvironmentArgs(launch), "--no-focus",
	], state.main_worktree);
	const result = object(object(JSON.parse(text), "Herdr pane response").result, "Herdr pane result");
	const pane = nonEmptyString(object(result.pane, "Herdr reviewer pane").pane_id, "Herdr reviewer pane id");
	await commandOutput(options.runner, "herdr", ["pane", "rename", pane, label], state.main_worktree);
	return pane;
}

export async function startWorkerAgent(
	state: WorkerHostState,
	agent: string,
	pane: string,
	launch: WorkerLaunch,
	options: WorkerHostOptions,
	hooks: { beforeStart?: () => Promise<void>; onStarted?: () => Promise<void> } = {},
): Promise<"existing" | "started"> {
	assertWorkerAgentName(agent);
	const name = nonEmptyString(agent, "Herdr agent name");
	const paneId = nonEmptyString(pane, "Herdr agent pane");
	const existing = await getWorkerAgent(state, name, options);
	if (existing) {
		assertWorkerAgentPane(name, paneId, existing);
		return "existing";
	}
	await hooks.beforeStart?.();
	const arguments_ = ["agent", "start", name, "--kind", "pi", "--pane", paneId, "--", ...launch.args];
	for (let attempt = 1; attempt <= 5; attempt += 1) {
		const result = await options.runner("herdr", arguments_, { cwd: state.main_worktree });
		if (result.code === 0) {
			await hooks.onStarted?.();
			return "started";
		}
		if (hasHerdrErrorCode(result, "agent_name_taken")) {
			const raced = await getWorkerAgent(state, name, options);
			if (!raced) throw new Error(`Herdr agent ${name} reported agent_name_taken but could not be found; refusing to start a duplicate`);
			assertWorkerAgentPane(name, paneId, raced);
			return "existing";
		}
		if (!hasHerdrErrorCode(result, "agent_pane_busy") || attempt === 5) {
			throw new Error(commandFailure("herdr", arguments_, result));
		}
		await (options.delay ?? delay)(250);
	}
	throw new Error(`Herdr agent ${name} could not be started`);
}

export async function promptWorkerAgent(
	state: WorkerHostState,
	agent: string,
	payload: Record<string, unknown>,
	options: WorkerHostOptions,
): Promise<void> {
	assertWorkerAgentName(agent);
	await commandOutput(options.runner, "herdr", ["agent", "prompt", agent, JSON.stringify(payload)], state.main_worktree);
}

export async function retireWorkerTab(state: WorkerHostState, tabId: string, options: WorkerHostOptions): Promise<void> {
	const id = nonEmptyString(tabId, "Herdr tab id");
	try {
		if (!(await workerTabExists(state, id, options))) return;
		await commandOutput(options.runner, "herdr", ["tab", "close", id], state.main_worktree);
	} catch (error) {
		if (!(await confirmsWorkerTabAbsent(state, id, options))) throw error;
	}
}

function assertWorkerAgentName(agent: string): void {
	if (!/^[a-z][a-z0-9_-]{0,31}$/.test(agent)) throw new Error(`Invalid Herdr agent name: ${agent}`);
}

async function listWorkerTabs(mainWorktree: string, options: WorkerHostOptions): Promise<unknown[]> {
	const result = object(object(JSON.parse(await commandOutput(options.runner, "herdr", ["tab", "list"], mainWorktree)), "Herdr tab list response").result, "Herdr tab list result");
	return array(result.tabs, "Herdr tabs");
}

async function listWorkerPanes(mainWorktree: string, options: WorkerHostOptions): Promise<unknown[]> {
	const result = object(object(JSON.parse(await commandOutput(options.runner, "herdr", ["pane", "list"], mainWorktree)), "Herdr pane list response").result, "Herdr pane list result");
	return array(result.panes, "Herdr panes");
}

async function getWorkerAgent(state: WorkerHostState, name: string, options: WorkerHostOptions): Promise<Record<string, unknown> | undefined> {
	const arguments_ = ["agent", "get", name];
	const result = await options.runner("herdr", arguments_, { cwd: state.main_worktree });
	if (result.code !== 0) {
		if (hasHerdrErrorCode(result, "agent_not_found")) return undefined;
		throw new Error(commandFailure("herdr", arguments_, result));
	}
	const response = object(JSON.parse(result.stdout), "Herdr agent get response");
	return object(object(response.result, "Herdr agent get result").agent, `Herdr agent ${name}`);
}

function assertWorkerAgentPane(name: string, expected: string, agent: Record<string, unknown>): void {
	const actual = typeof agent.pane_id === "string" ? agent.pane_id : "missing";
	if (actual !== expected) {
		throw new Error(`Herdr agent name collision for ${name}: expected pane ${expected}, found ${actual}; refusing to reuse or replace it`);
	}
}

async function confirmsWorkerTabAbsent(state: WorkerHostState, tabId: string, options: WorkerHostOptions): Promise<boolean> {
	try {
		const result = await options.runner("herdr", ["tab", "get", tabId], { cwd: state.main_worktree });
		return result.code !== 0 && hasHerdrErrorCode(result, "tab_not_found");
	} catch {
		return false;
	}
}

function hasHerdrErrorCode(result: CommandResult, expected: string): boolean {
	return [result.stdout, result.stderr].some((text) => {
		try {
			return containsHerdrErrorCode(JSON.parse(text), expected);
		} catch {
			return false;
		}
	});
}

function containsHerdrErrorCode(value: unknown, expected: string): boolean {
	if (typeof value !== "object" || value === null) return false;
	if (Array.isArray(value)) return value.some((entry) => containsHerdrErrorCode(entry, expected));
	const input = value as Record<string, unknown>;
	const error = input.error;
	return (typeof error === "object" && error !== null && !Array.isArray(error) && (error as Record<string, unknown>).code === expected)
		|| Object.values(input).some((entry) => containsHerdrErrorCode(entry, expected));
}

async function delay(milliseconds: number): Promise<void> {
	await new Promise<void>((done) => { setTimeout(done, milliseconds); });
}
