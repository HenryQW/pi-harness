import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { extensionConfigDir } from "@henryqw/pi-config-store";
import {
	createHerdrClient,
	hasHerdrErrorCode,
	herdrCommandFailure,
	startPiAgent,
	type HerdrClient,
	type HerdrExecResult,
} from "@henryqw/pi-herdr";
import { isCleanCommitted, type AllocationIntent, type TaskAttempt, type TaskRequest, type WorkspaceIdentity } from "./schema.ts";
import type {
	AllocationReconciliation,
	AllocationResult,
	HostAllocationKind,
	HostCleanupKind,
	HostRuntime,
	OperationContext,
	TaskCandidateInspector,
	VerifiedImplementerLaunch,
	WorkerResult,
} from "./runner.ts";

const MIN_HERDR_VERSION = [0, 9, 0] as const;
const MIN_HERDR_PROTOCOL = 22;
const HERDR_OPERATION_CAP_MS = 30_000;
const LSOF_OPERATION_CAP_MS = 3_000;
const GIT_INSPECTION_CAP_MS = 30_000;
const OUTPUT_LIMIT = 1024 * 1024;
const DIAGNOSTIC_LIMIT = 8 * 1024;
const ASSIGNMENT_LIMIT = 96 * 1024;
const LEASE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const PROCESS_LEASE_ENV = "PI_ORCHESTRATOR_PROCESS_LEASE";
const SETTLED_AGENT_STATES = new Set(["idle", "done"]);

export interface HostProcessOptions {
	cwd: string;
	signal: AbortSignal;
	timeoutMs: number;
}

export type HostProcessRunner = (
	command: string,
	args: string[],
	options: HostProcessOptions,
) => Promise<{ code: number; stdout: string; stderr: string; killed?: boolean }>;

export interface HerdrHostRuntimeOptions {
	inspectTaskCandidate: TaskCandidateInspector["inspectTaskCandidate"];
	runProcess?: HostProcessRunner;
	killProcess?: (pid: number, signal: NodeJS.Signals) => void;
	delay?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
	now?: () => number;
	randomId?: () => string;
	env?: NodeJS.ProcessEnv;
	leaseDirectory?: string;
	lsofCommand?: string;
}

type WorkspaceDetails = {
	kind: "workspace";
	label: string;
	worktreeCwd: string;
	repoRoot: string;
	expectedWorktreeId: string;
};

type WorkerTabDetails = {
	kind: "worker_tab";
	label: string;
	workspaceId: string;
	workspaceRootTabId: string;
	workspaceRootPaneId: string;
	worktreeCwd: string;
	leasePath: string;
};

type AgentDetails = {
	kind: "agent";
	agentName: string;
	workspaceId: string;
	tabId: string;
	paneId: string;
	worktreeCwd: string;
	leasePath: string;
};

type HostDetails = WorkspaceDetails | WorkerTabDetails | AgentDetails;
type JsonRecord = Record<string, unknown>;

const defaultRunProcess: HostProcessRunner = (command, args, options) => new Promise((resolveResult) => {
	execFile(command, args, {
		cwd: options.cwd,
		signal: options.signal,
		timeout: options.timeoutMs,
		maxBuffer: OUTPUT_LIMIT,
		shell: false,
	}, (error, stdout, stderr) => {
		resolveResult({
			code: error ? (typeof error.code === "number" ? error.code : -1) : 0,
			killed: Boolean(error && "killed" in error && error.killed),
			stdout: String(stdout),
			stderr: String(stderr),
		});
	});
});

function record(value: unknown, label: string): JsonRecord {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is malformed.`);
	return value as JsonRecord;
}

function resultRecord(value: unknown, label: string): JsonRecord {
	return record(record(value, label).result, `${label} result`);
}

function parseJsonObject(value: string, label: string): JsonRecord {
	try {
		return record(JSON.parse(value) as unknown, label);
	} catch (error) {
		throw new Error(`${label} returned malformed JSON.`, { cause: error });
	}
}

function exactString(value: unknown, label: string): string {
	if (typeof value !== "string" || !value.trim() || value.trim() !== value || value.includes("\0")) {
		throw new Error(`${label} must be a non-empty exact string.`);
	}
	return value;
}

function exactKeys(value: JsonRecord, expected: readonly string[], label: string): void {
	const actual = Object.keys(value).sort();
	const wanted = [...expected].sort();
	if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
		throw new Error(`${label} has unsupported or missing fields.`);
	}
}

function safeText(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).slice(0, 1_000);
}

function compareVersion(actual: string, minimum: readonly number[]): boolean {
	const match = /^(\d+)\.(\d+)\.(\d+)(?:(-[0-9A-Za-z.-]+)|\+[0-9A-Za-z.-]+)?$/.exec(actual);
	if (!match) return false;
	const values = match.slice(1, 4).map(Number);
	for (let index = 0; index < minimum.length; index += 1) {
		if (values[index]! !== minimum[index]!) return values[index]! > minimum[index]!;
	}
	return match[4] === undefined;
}

function statusFields(stdout: string): Map<string, string> {
	const result = new Map<string, string>();
	for (const line of stdout.trim().split(/\r?\n/)) {
		const separator = line.indexOf(":");
		if (separator < 1) throw new Error("herdr status server returned malformed output.");
		const key = line.slice(0, separator).trim();
		const value = line.slice(separator + 1).trim();
		if (!key || !value || result.has(key)) throw new Error("herdr status server returned ambiguous output.");
		result.set(key, value);
	}
	return result;
}

function localSchemaReference(schema: JsonRecord, reference: unknown): JsonRecord {
	if (typeof reference !== "string" || !reference.startsWith("#/schemas/request/$defs/")) {
		throw new Error("Herdr API schema contains an unsupported request reference.");
	}
	const name = reference.slice("#/schemas/request/$defs/".length);
	const schemas = record(schema.schemas, "Herdr API schemas");
	const request = record(schemas.request, "Herdr request schema");
	const definitions = record(request.$defs, "Herdr request definitions");
	return record(definitions[name], `Herdr request definition ${name}`);
}

function supportsString(value: unknown): boolean {
	if (value === "string") return true;
	return Array.isArray(value) && value.includes("string");
}

function requireSchemaCapabilities(schema: JsonRecord): void {
	if (typeof schema.protocol !== "number" || !Number.isInteger(schema.protocol) || schema.protocol < MIN_HERDR_PROTOCOL) {
		throw new Error(`Herdr API schema protocol must be at least ${MIN_HERDR_PROTOCOL}.`);
	}
	const schemas = record(schema.schemas, "Herdr API schemas");
	const request = record(schemas.request, "Herdr request schema");
	const definitions = request.oneOf;
	if (!Array.isArray(definitions)) throw new Error("Herdr API request schema has no command definitions.");
	const method = (name: string): JsonRecord => {
		const matches = definitions.filter((entry) => {
			try {
				const properties = record(record(entry, "Herdr method").properties, "Herdr method properties");
				return record(properties.method, "Herdr method name").const === name;
			} catch {
				return false;
			}
		});
		if (matches.length !== 1) throw new Error(`Herdr API schema must advertise exactly one ${name} request.`);
		return record(matches[0], `Herdr ${name} request`);
	};
	const params = (name: string): JsonRecord => {
		const properties = record(method(name).properties, `Herdr ${name} properties`);
		return localSchemaReference(schema, record(properties.params, `Herdr ${name} params`).$ref);
	};

	for (const name of ["pane.close", "pane.process_info"] as const) {
		const properties = record(params(name).properties, `Herdr ${name} parameter properties`);
		if (!supportsString(record(properties.pane_id, `Herdr ${name} pane_id`).type)) {
			throw new Error(`Herdr API schema does not support ID-addressable ${name}.`);
		}
	}
	const tabProperties = record(params("tab.create").properties, "Herdr tab.create parameter properties");
	const env = record(tabProperties.env, "Herdr tab.create env");
	const additional = record(env.additionalProperties, "Herdr tab.create env values");
	if (env.type !== "object" || !supportsString(additional.type)) {
		throw new Error("Herdr API schema does not advertise tab.create env support.");
	}
}

function ownedIntent(attempt: TaskAttempt, kind: AllocationIntent["kind"]): AllocationIntent {
	const matches = attempt.allocations.filter((intent) => intent.kind === kind && intent.status === "owned");
	if (matches.length !== 1 || !matches[0]!.resourceId) throw new Error(`Task lacks one exact owned ${kind} allocation.`);
	return matches[0]!;
}

function worktreeIntent(attempt: TaskAttempt): AllocationIntent & { worktree: NonNullable<AllocationIntent["worktree"]> } {
	const intent = ownedIntent(attempt, "worktree");
	if (!intent.worktree || intent.resourceId !== intent.worktree.path || intent.worktree.cwd !== intent.worktree.path) {
		throw new Error("Task lacks exact owned worktree metadata.");
	}
	return intent as AllocationIntent & { worktree: NonNullable<AllocationIntent["worktree"]> };
}

function parseDetails(intent: AllocationIntent): HostDetails {
	let parsed;
	try {
		parsed = record(JSON.parse(intent.details) as unknown, `${intent.kind} allocation details`);
	} catch (error) {
		throw new Error(`${intent.kind} allocation details are malformed.`, { cause: error });
	}
	if (parsed.kind !== intent.kind) throw new Error(`${intent.kind} allocation details have the wrong kind.`);
	if (intent.kind === "workspace") {
		exactKeys(parsed, ["kind", "label", "worktreeCwd", "repoRoot", "expectedWorktreeId"], "workspace allocation details");
		return {
			kind: "workspace",
			label: exactString(parsed.label, "workspace label"),
			worktreeCwd: exactString(parsed.worktreeCwd, "workspace worktree cwd"),
			repoRoot: exactString(parsed.repoRoot, "workspace repository root"),
			expectedWorktreeId: exactString(parsed.expectedWorktreeId, "workspace expected worktree ID"),
		};
	}
	if (intent.kind === "worker_tab") {
		exactKeys(parsed, ["kind", "label", "workspaceId", "workspaceRootTabId", "workspaceRootPaneId", "worktreeCwd", "leasePath"], "worker-tab allocation details");
		return {
			kind: "worker_tab",
			label: exactString(parsed.label, "worker-tab label"),
			workspaceId: exactString(parsed.workspaceId, "worker-tab workspace ID"),
			workspaceRootTabId: exactString(parsed.workspaceRootTabId, "workspace root tab ID"),
			workspaceRootPaneId: exactString(parsed.workspaceRootPaneId, "workspace root pane ID"),
			worktreeCwd: exactString(parsed.worktreeCwd, "worker-tab cwd"),
			leasePath: exactString(parsed.leasePath, "worker-tab lease path"),
		};
	}
	exactKeys(parsed, ["kind", "agentName", "workspaceId", "tabId", "paneId", "worktreeCwd", "leasePath"], "agent allocation details");
	return {
		kind: "agent",
		agentName: exactString(parsed.agentName, "agent name"),
		workspaceId: exactString(parsed.workspaceId, "agent workspace ID"),
		tabId: exactString(parsed.tabId, "agent tab ID"),
		paneId: exactString(parsed.paneId, "agent pane ID"),
		worktreeCwd: exactString(parsed.worktreeCwd, "agent worktree cwd"),
		leasePath: exactString(parsed.leasePath, "agent lease path"),
	};
}

function expectedLabel(token: string, kind: "workspace" | "worker"): string {
	return `pi-orchestrator-${token}-${kind}`;
}

function expectedAgentName(token: string): string {
	return `pi-orchestrator-${token}-agent`;
}

function requireIntentIdentity(intent: AllocationIntent, attempt: TaskAttempt): void {
	if (intent.token !== attempt.correlationToken || intent.generation !== attempt.allocationGeneration) {
		throw new Error(`${intent.kind} allocation intent does not match the task attempt.`);
	}
}

function assertWorkspaceDetails(details: WorkspaceDetails, intent: AllocationIntent, attempt: TaskAttempt): void {
	const worktree = worktreeIntent(attempt);
	if (details.label !== expectedLabel(intent.token, "workspace")
		|| details.worktreeCwd !== worktree.worktree.cwd
		|| details.repoRoot !== worktree.worktree.repoRoot
		|| details.expectedWorktreeId !== worktree.resourceId) {
		throw new Error("Workspace allocation details drifted from the exact owned worktree.");
	}
}

function assertWorkerTabDetails(details: WorkerTabDetails, intent: AllocationIntent, attempt: TaskAttempt): void {
	const worktree = worktreeIntent(attempt);
	const workspace = ownedIntent(attempt, "workspace");
	if (details.label !== expectedLabel(intent.token, "worker")
		|| details.workspaceId !== workspace.resourceId
		|| details.workspaceRootTabId !== workspace.resources?.tabId
		|| details.workspaceRootPaneId !== workspace.resources?.rootPaneId
		|| details.worktreeCwd !== worktree.worktree.cwd) {
		throw new Error("Worker-tab allocation details drifted from their exact parent resources.");
	}
}

function assertAgentDetails(details: AgentDetails, intent: AllocationIntent, attempt: TaskAttempt): void {
	const worktree = worktreeIntent(attempt);
	const workspace = ownedIntent(attempt, "workspace");
	const tab = ownedIntent(attempt, "worker_tab");
	if (details.agentName !== expectedAgentName(intent.token)
		|| details.workspaceId !== workspace.resourceId
		|| details.tabId !== tab.resourceId
		|| details.paneId !== tab.resources?.rootPaneId
		|| details.worktreeCwd !== worktree.worktree.cwd
		|| details.leasePath !== tab.resources?.leasePath) {
		throw new Error("Agent allocation details drifted from their exact parent resources.");
	}
}

function parseWorkspaceInfo(response: JsonRecord, expectedId?: string): JsonRecord {
	const result = resultRecord(response, "Herdr workspace response");
	if (result.type !== "workspace_info") throw new Error("Herdr workspace response has the wrong type.");
	const workspace = record(result.workspace, "Herdr workspace");
	const workspaceId = exactString(workspace.workspace_id, "Herdr workspace_id");
	if (expectedId && workspaceId !== expectedId) throw new Error("Herdr workspace response returned a different workspace ID.");
	return workspace;
}

function parseAgent(response: JsonRecord, expected: AgentDetails, acceptedTypes: readonly string[]): { status: string; interactiveReady: boolean } {
	const result = resultRecord(response, "Herdr agent response");
	if (!acceptedTypes.includes(String(result.type))) throw new Error("Herdr agent response has the wrong type.");
	const agent = record(result.agent, "Herdr agent");
	if (exactString(agent.name, "Herdr agent name") !== expected.agentName
		|| exactString(agent.pane_id, "Herdr agent pane_id") !== expected.paneId
		|| exactString(agent.tab_id, "Herdr agent tab_id") !== expected.tabId
		|| exactString(agent.workspace_id, "Herdr agent workspace_id") !== expected.workspaceId
		|| exactString(agent.cwd, "Herdr agent cwd") !== expected.worktreeCwd) {
		throw new Error("Herdr agent response does not match the exact saved worker identity.");
	}
	const status = exactString(agent.agent_status, "Herdr agent status");
	if (!["idle", "working", "blocked", "done", "unknown"].includes(status)) throw new Error("Herdr agent status is unsupported.");
	return { status, interactiveReady: agent.interactive_ready === true };
}

function requireOkResponse(stdout: string, label: string): void {
	if (resultRecord(parseJsonObject(stdout, label), label).type !== "ok") {
		throw new Error(`${label} has the wrong type.`);
	}
}

function assignment(input: {
	task: TaskRequest;
	kind: "initial" | "correction";
	worktreeCwd: string;
	failure?: string;
}): string {
	const checks = input.task.checks.map((check) => JSON.stringify({ command: check.command, args: check.args })).join("\n");
	const text = [
		`Task: ${input.task.id}`,
		`Worktree: ${input.worktreeCwd}`,
		`Integrated dependencies: ${input.task.dependsOn.length ? input.task.dependsOn.join(", ") : "none"}`,
		"",
		"Requirements:",
		input.task.requirements,
		"",
		"Deliverable:",
		input.task.deliverable,
		"",
		"Required checks (direct command/argv):",
		checks,
		...(input.kind === "correction" ? ["", "Correction failure:", exactString(input.failure, "correction failure")] : []),
		"",
		"Work only in the exact worktree above. Commit the complete result and leave that worktree clean.",
	].join("\n");
	if (Buffer.byteLength(text, "utf8") > ASSIGNMENT_LIMIT) throw new Error(`Worker assignment exceeds ${ASSIGNMENT_LIMIT} bytes.`);
	return text;
}

export class HerdrHostRuntime implements HostRuntime {
	private readonly inspectCandidate: TaskCandidateInspector["inspectTaskCandidate"];
	private readonly execute: HostProcessRunner;
	private readonly herdr: HerdrClient<HostProcessOptions>;
	private readonly kill: (pid: number, signal: NodeJS.Signals) => void;
	private readonly delay: (milliseconds: number, signal: AbortSignal) => Promise<void>;
	private readonly now: () => number;
	private readonly randomId: () => string;
	private readonly env: NodeJS.ProcessEnv;
	private readonly leaseDirectory: string;
	private readonly lsofCommand: string;

	constructor(options: HerdrHostRuntimeOptions) {
		this.inspectCandidate = options.inspectTaskCandidate;
		this.execute = options.runProcess ?? defaultRunProcess;
		this.herdr = createHerdrClient(this.execute);
		this.kill = options.killProcess ?? ((pid, signal) => process.kill(pid, signal));
		this.delay = options.delay ?? (async (milliseconds, signal) => await sleep(milliseconds, undefined, { signal, ref: false }));
		this.now = options.now ?? Date.now;
		this.randomId = options.randomId ?? (() => randomBytes(16).toString("hex"));
		this.env = options.env ?? process.env;
		this.leaseDirectory = resolve(options.leaseDirectory ?? join(extensionConfigDir("pi-orchestrator"), "leases"));
		this.lsofCommand = options.lsofCommand ?? "lsof";
	}

	/** Fail-closed Herdr caller/capability gate. This method creates no state or host resource. */
	async preflightHost(input: { root: string }, context: OperationContext): Promise<void> {
		context.signal.throwIfAborted();
		if (this.env.HERDR_ENV !== "1") throw new Error("Pi Orchestrator requires HERDR_ENV=1.");
		const paneId = exactString(this.env.HERDR_PANE_ID, "HERDR_PANE_ID");
		const root = await realpath(input.root);

		const versionOutput = await this.herdr.run(["--version"], this.processOptions(root, context, HERDR_OPERATION_CAP_MS));
		const versionMatch = /^herdr (\S+)\s*$/.exec(versionOutput);
		if (!versionMatch || !compareVersion(versionMatch[1]!, MIN_HERDR_VERSION)) {
			throw new Error("Herdr client version must be at least 0.9.0.");
		}
		const status = statusFields(await this.herdr.run(["status", "server"], this.processOptions(root, context, HERDR_OPERATION_CAP_MS)));
		if (status.get("status") !== "running"
			|| !compareVersion(status.get("version") ?? "", MIN_HERDR_VERSION)
			|| status.get("endpoint_compatible") !== "yes"
			|| status.get("private_protocol_compatible") !== "yes"
			|| !/^\d+$/.test(status.get("private_protocol") ?? "")
			|| Number(status.get("private_protocol")) < MIN_HERDR_PROTOCOL) {
			throw new Error("Herdr server must be compatible version >=0.9.0 with private protocol >=22.");
		}
		const schema = await this.herdr.json(["api", "schema", "--json"], this.processOptions(root, context, HERDR_OPERATION_CAP_MS));
		requireSchemaCapabilities(schema);

		const lsof = await this.execute(this.lsofCommand, ["-v"], this.processOptions(root, context, LSOF_OPERATION_CAP_MS));
		if (lsof.code !== 0 || lsof.killed) throw new Error("Native lsof is required for exact worker process leases.");

		const paneResponse = await this.herdr.json(["pane", "get", paneId], this.processOptions(root, context, HERDR_OPERATION_CAP_MS));
		const paneResult = resultRecord(paneResponse, "Herdr current pane response");
		if (paneResult.type !== "pane_info") throw new Error("Herdr current pane response has the wrong type.");
		const pane = record(paneResult.pane, "Herdr current pane");
		if (exactString(pane.pane_id, "Herdr current pane_id") !== paneId) throw new Error("Herdr current pane ID does not match HERDR_PANE_ID.");
		const workspaceId = exactString(pane.workspace_id, "Herdr current workspace_id");
		const workspaceResponse = await this.herdr.json(["workspace", "get", workspaceId], this.processOptions(root, context, HERDR_OPERATION_CAP_MS));
		const workspace = parseWorkspaceInfo(workspaceResponse, workspaceId);
		const worktree = record(workspace.worktree, "Herdr current workspace worktree");
		const checkout = await realpath(exactString(worktree.checkout_path, "Herdr current checkout_path"));
		const repoRoot = await realpath(exactString(worktree.repo_root, "Herdr current repo_root"));
		if (checkout !== root || repoRoot !== root) {
			throw new Error("The current Herdr workspace checkout and repository must both match canonical Main.");
		}
	}

	async planHostAllocation(
		input: { kind: HostAllocationKind; task: TaskRequest; attempt: TaskAttempt; owned: Partial<Record<AllocationIntent["kind"], string>> },
		context: OperationContext,
	): Promise<string> {
		context.signal.throwIfAborted();
		const worktree = worktreeIntent(input.attempt);
		const worktreeId = exactString(worktree.resourceId, "owned worktree ID");
		if (input.owned.worktree !== worktreeId) throw new Error("Host allocation does not reference the exact owned worktree.");
		if (input.kind === "workspace") {
			return JSON.stringify({
				kind: "workspace",
				label: expectedLabel(input.attempt.correlationToken, "workspace"),
				worktreeCwd: worktree.worktree.cwd,
				repoRoot: worktree.worktree.repoRoot,
				expectedWorktreeId: worktreeId,
			} satisfies WorkspaceDetails);
		}
		const workspace = ownedIntent(input.attempt, "workspace");
		const workspaceId = exactString(workspace.resourceId, "owned workspace ID");
		if (input.owned.workspace !== workspaceId) throw new Error("Host allocation does not reference the exact owned workspace.");
		if (input.kind === "worker_tab") {
			const leasePath = join(this.leaseDirectory, input.attempt.correlationToken, `${this.randomId()}.lease`);
			this.assertLeasePath(leasePath, input.attempt.correlationToken);
			return JSON.stringify({
				kind: "worker_tab",
				label: expectedLabel(input.attempt.correlationToken, "worker"),
				workspaceId,
				workspaceRootTabId: exactString(workspace.resources?.tabId, "owned workspace root tab ID"),
				workspaceRootPaneId: exactString(workspace.resources?.rootPaneId, "owned workspace root pane ID"),
				worktreeCwd: worktree.worktree.cwd,
				leasePath,
			} satisfies WorkerTabDetails);
		}
		const tab = ownedIntent(input.attempt, "worker_tab");
		const tabId = exactString(tab.resourceId, "owned worker tab ID");
		if (input.owned.worker_tab !== tabId) throw new Error("Agent allocation does not reference the exact owned worker tab.");
		const leasePath = exactString(tab.resources?.leasePath, "owned worker lease path");
		this.assertLeasePath(leasePath, input.attempt.correlationToken);
		return JSON.stringify({
			kind: "agent",
			agentName: expectedAgentName(input.attempt.correlationToken),
			workspaceId,
			tabId,
			paneId: exactString(tab.resources?.rootPaneId, "owned worker root pane ID"),
			worktreeCwd: worktree.worktree.cwd,
			leasePath,
		} satisfies AgentDetails);
	}

	async allocateHost(
		input: { intent: AllocationIntent; task: TaskRequest; attempt: TaskAttempt; verifyLaunch?: () => Promise<VerifiedImplementerLaunch> },
		context: OperationContext,
	): Promise<AllocationResult> {
		requireIntentIdentity(input.intent, input.attempt);
		const details = parseDetails(input.intent);
		if (details.kind === "workspace") {
			if (input.verifyLaunch) throw new Error("Implementer launch verification is valid only at the agent allocation boundary.");
			return await this.allocateWorkspace(details, input.intent, input.attempt, context);
		}
		if (details.kind === "worker_tab") {
			if (input.verifyLaunch) throw new Error("Implementer launch verification is valid only at the agent allocation boundary.");
			return await this.allocateWorkerTab(details, input.intent, input.attempt, context);
		}
		return await this.allocateAgent(details, input.intent, input.attempt, input.verifyLaunch, context);
	}

	async reconcileHostAllocation(
		input: { intent: AllocationIntent; task: TaskRequest; attempt: TaskAttempt },
		context: OperationContext,
	): Promise<AllocationReconciliation> {
		requireIntentIdentity(input.intent, input.attempt);
		const details = parseDetails(input.intent);
		if (details.kind === "workspace") {
			assertWorkspaceDetails(details, input.intent, input.attempt);
			const response = await this.herdr.json(
				["worktree", "list", "--cwd", details.worktreeCwd],
				this.processOptions(details.repoRoot, context, HERDR_OPERATION_CAP_MS),
			);
			const result = resultRecord(response, "Herdr worktree list response");
			if (result.type !== "worktree_list" || !Array.isArray(result.worktrees)) throw new Error("Herdr worktree list response is malformed.");
			const worktrees = result.worktrees.map((entry) => {
				const item = record(entry, "Herdr listed worktree");
				const path = exactString(item.path, "Herdr listed worktree path");
				const label = exactString(item.label, "Herdr listed worktree label");
				const openWorkspaceId = item.open_workspace_id;
				if (openWorkspaceId !== undefined && openWorkspaceId !== null) exactString(openWorkspaceId, "Herdr listed open workspace ID");
				return { path, label, openWorkspaceId: typeof openWorkspaceId === "string" ? openWorkspaceId : undefined };
			});
			const target = worktrees.filter((item) => item.path === details.worktreeCwd);
			const tokenMatches = worktrees.filter((item) => item.label === details.label);
			const possible = [
				...(target.length === 1 ? [] : [`expected worktree match count ${target.length}`]),
				...target.filter((item) => item.openWorkspaceId).map((item) => `possible workspace ${item.openWorkspaceId}`),
				...tokenMatches.map((item) => `token-labelled worktree ${item.path}${item.openWorkspaceId ? ` in workspace ${item.openWorkspaceId}` : ""}`),
			];
			return possible.length
				? { outcome: "possible", failure: "A possible prior Herdr workspace allocation or parent mismatch remains; it was not adopted or closed.", possibleResources: possible }
				: { outcome: "absent" };
		}
		if (details.kind === "worker_tab") {
			assertWorkerTabDetails(details, input.intent, input.attempt);
			this.assertLeasePath(details.leasePath, input.intent.token);
			const tabs = (await this.listTabs(details.workspaceId, details.worktreeCwd, context)).map((tab) => ({
				id: exactString(tab.tab_id, "Herdr listed tab ID"),
				workspaceId: exactString(tab.workspace_id, "Herdr listed tab workspace ID"),
				label: exactString(tab.label, "Herdr listed tab label"),
			}));
			if (tabs.some((tab) => tab.workspaceId !== details.workspaceId)) {
				throw new Error("Herdr tab list escaped the exact saved workspace scope.");
			}
			const rootTabs = tabs.filter((tab) => tab.id === details.workspaceRootTabId);
			const unexpected = tabs.filter((tab) => tab.id !== details.workspaceRootTabId || tab.label === details.label);
			const holders = await this.scanLease(details.leasePath, details.worktreeCwd, context, undefined, true);
			const possible = [
				...(rootTabs.length === 1 ? [] : [`workspace root tab match count ${rootTabs.length}`]),
				...unexpected.map((tab) => `possible tab ${tab.id}`),
				...holders.map((pid) => `lease holder pid ${pid}`),
			];
			return possible.length
				? { outcome: "possible", failure: "A possible prior worker-tab allocation, parent mismatch, or lease holder remains; it was not adopted or touched.", possibleResources: possible }
				: { outcome: "absent" };
		}
		assertAgentDetails(details, input.intent, input.attempt);
		this.assertLeasePath(details.leasePath, input.intent.token);
		try {
			await this.assertPrivateLease(details.leasePath, false);
			const agents = (await this.listAgents(details.worktreeCwd, context)).map((agent) => {
				const name = agent.name;
				if (name !== undefined && name !== null && typeof name !== "string") throw new Error("Herdr listed agent name is malformed.");
				return {
					name: typeof name === "string" ? name : undefined,
					paneId: exactString(agent.pane_id, "Herdr listed agent pane ID"),
					tabId: exactString(agent.tab_id, "Herdr listed agent tab ID"),
				};
			});
			const matches = agents.filter((agent) => agent.name === details.agentName || agent.paneId === details.paneId || agent.tabId === details.tabId);
			const holders = await this.scanLease(details.leasePath, details.worktreeCwd, context);
			const possible = [
				...matches.map((agent) => `possible agent ${agent.name ?? "without expected name"} in pane ${agent.paneId}`),
				...holders.map((pid) => `lease holder pid ${pid}`),
			];
			if (possible.length) {
				return { outcome: "possible", failure: "A possible prior agent allocation or lease holder remains; it was not adopted or touched.", possibleResources: possible };
			}
			await this.assertStartableAgentPane(details, context);
			return { outcome: "absent" };
		} catch (error) {
			return {
				outcome: "possible",
				failure: `A prior agent allocation cannot be proved absent: ${safeText(error)}`,
				possibleResources: [details.agentName, details.paneId, details.leasePath],
			};
		}
	}

	async runWorker(
		input: {
			task: TaskRequest;
			attempt: TaskAttempt;
			workerId: string;
			kind: "initial" | "correction";
			preCandidate: WorkspaceIdentity;
			failure?: string;
		},
		context: OperationContext,
	): Promise<WorkerResult> {
		const intent = ownedIntent(input.attempt, "agent");
		const details = parseDetails(intent);
		if (details.kind !== "agent") throw new Error("Owned agent allocation has the wrong details.");
		assertAgentDetails(details, intent, input.attempt);
		if (input.workerId !== intent.resourceId || input.workerId !== details.agentName) {
			throw new Error("Worker prompt does not target the exact saved agent.");
		}
		let ready;
		try {
			ready = await this.waitForSettledAgent(details, context);
		} catch (error) {
			return { outcome: context.signal.aborted ? "interrupted" : "unknown", diagnostic: `Exact worker readiness is unknown: ${safeText(error)}` };
		}
		if (ready.status === "blocked") return { outcome: "blocked", diagnostic: await this.diagnostic(details, context, "Worker was blocked before prompt submission.") };
		if (!SETTLED_AGENT_STATES.has(ready.status) || !ready.interactiveReady) {
			return { outcome: "unknown", diagnostic: `Exact worker was not interactively ready: ${ready.status}.` };
		}

		const text = assignment({ task: input.task, kind: input.kind, worktreeCwd: details.worktreeCwd, ...(input.failure ? { failure: input.failure } : {}) });
		const promptArgs = [
			"agent", "prompt", details.agentName, text, "--wait",
			"--until", "idle", "--until", "done", "--until", "blocked",
			"--timeout", String(this.callTimeout(context, HERDR_OPERATION_CAP_MS)),
		];
		const prompted = await this.herdr.exec(promptArgs, this.processOptions(details.worktreeCwd, context, HERDR_OPERATION_CAP_MS));
		if (prompted.code !== 0 || prompted.killed) {
			if (!prompted.killed && !context.signal.aborted && hasHerdrErrorCode(prompted, "agent_prompt_stalled")) {
				let settled;
				try {
					settled = await this.waitForSettledAgent(details, context);
				} catch (error) {
					return { outcome: "unknown", diagnostic: `Delivered stalled prompt could not be reconciled: ${safeText(error)}` };
				}
				if (settled.status === "blocked") return { outcome: "blocked", diagnostic: await this.diagnostic(details, context, "Delivered stalled prompt settled as blocked.") };
				if (!SETTLED_AGENT_STATES.has(settled.status)) return { outcome: "unknown", diagnostic: `Delivered stalled prompt did not settle: ${settled.status}.` };
				return await this.candidateResult(input, details, context, true);
			}
			return {
				outcome: prompted.killed || context.signal.aborted ? "interrupted" : "unknown",
				diagnostic: `Worker prompt result is unknown and will not be replayed: ${safeText(herdrCommandFailure(["agent", "prompt"], prompted))}`,
			};
		}
		let settled;
		try {
			settled = parseAgent(parseJsonObject(prompted.stdout, "Herdr agent prompt"), details, ["agent_prompted"]);
		} catch (error) {
			return { outcome: "unknown", diagnostic: `Worker prompt response is malformed: ${safeText(error)}` };
		}
		if (settled.status === "blocked") return { outcome: "blocked", diagnostic: await this.diagnostic(details, context, "Worker settled as blocked.") };
		if (!SETTLED_AGENT_STATES.has(settled.status)) return { outcome: "unknown", diagnostic: `Worker prompt did not return a settled state: ${settled.status}.` };
		return await this.candidateResult(input, details, context, false);
	}

	async terminateWorker(
		input: { task: TaskRequest; attempt: TaskAttempt; workerId: string; candidate: WorkspaceIdentity },
		context: OperationContext,
	): Promise<{ outcome: "terminated" } | { outcome: "unknown"; failure: string }> {
		try {
			const intent = ownedIntent(input.attempt, "agent");
			const details = parseDetails(intent);
			if (details.kind !== "agent") throw new Error("Owned agent allocation has the wrong details.");
			assertAgentDetails(details, intent, input.attempt);
			if (input.workerId !== intent.resourceId || input.workerId !== details.agentName) throw new Error("Worker termination identity does not match the exact saved agent.");
			this.assertLeasePath(details.leasePath, intent.token);
			await this.assertPrivateLease(details.leasePath, false);

			const processInfo = await this.herdr.json(
				["pane", "process-info", "--pane", details.paneId],
				this.processOptions(details.worktreeCwd, context, HERDR_OPERATION_CAP_MS),
			);
			const processResult = resultRecord(processInfo, "Herdr pane process-info response");
			if (processResult.type !== "pane_process_info") throw new Error("Herdr pane process-info response has the wrong type.");
			const captured = record(processResult.process_info, "Herdr pane process-info");
			if (captured.pane_id !== details.paneId) {
				throw new Error("Herdr pane process-info did not match the exact saved pane.");
			}

			const closed = await this.herdr.exec(["pane", "close", details.paneId], this.processOptions(details.worktreeCwd, context, HERDR_OPERATION_CAP_MS));
			if (closed.code !== 0 || closed.killed) throw new Error(herdrCommandFailure(["pane", "close"], closed));
			requireOkResponse(closed.stdout, "Herdr pane close response");
			if (!await this.paneAbsent(details.paneId, details.worktreeCwd, context)) throw new Error("The exact saved pane still exists after pane close.");

			let holders = await this.scanLease(details.leasePath, details.worktreeCwd, context);
			if (holders.length) {
				await this.signalExactHolders(holders, details, "SIGTERM", context);
				await this.delay(250, context.signal);
				holders = await this.scanLease(details.leasePath, details.worktreeCwd, context);
			}
			if (holders.length) {
				await this.signalExactHolders(holders, details, "SIGKILL", context);
				await this.delay(100, context.signal);
				holders = await this.scanLease(details.leasePath, details.worktreeCwd, context);
			}
			if (holders.length) throw new Error(`Exact process lease still has ${holders.length} surviving holder(s).`);
			await this.delay(50, context.signal);
			if ((await this.scanLease(details.leasePath, details.worktreeCwd, context)).length) {
				throw new Error("Exact process lease did not remain empty for two consecutive scans.");
			}
			return { outcome: "terminated" };
		} catch (error) {
			return { outcome: "unknown", failure: safeText(error) };
		}
	}

	async cleanupHost(
		input: { kind: HostCleanupKind; task: TaskRequest; attempt: TaskAttempt },
		context: OperationContext,
	): Promise<{ outcome: "completed" | "absent" } | { outcome: "blocked"; failure: string }> {
		if (input.attempt.termination?.status !== "terminated") {
			return { outcome: "blocked", failure: "Host cleanup requires exact recorded worker termination." };
		}
		try {
			if (input.kind === "worker_tab") {
				const tabIntent = ownedIntent(input.attempt, "worker_tab");
				const workspaceIntent = ownedIntent(input.attempt, "workspace");
				const details = parseDetails(tabIntent);
				if (details.kind !== "worker_tab") throw new Error("Saved worker-tab identity is malformed.");
				assertWorkerTabDetails(details, tabIntent, input.attempt);
				const tabId = exactString(tabIntent.resourceId, "saved worker tab ID");
				const workspaceId = exactString(workspaceIntent.resourceId, "saved workspace ID");
				if (tabId === details.workspaceRootTabId) throw new Error("Saved worker tab aliases the workspace root tab.");
				if (!await this.paneAbsent(exactString(tabIntent.resources?.rootPaneId, "saved worker pane ID"), details.worktreeCwd, context)) {
					return { outcome: "blocked", failure: "The exact saved worker pane still exists after termination." };
				}
				if (await this.workspaceAbsent(workspaceId, details.worktreeCwd, context)) return { outcome: "absent" };
				const tab = await this.getTab(tabId, details.worktreeCwd, context);
				if (!tab) return { outcome: "absent" };
				if (tab.workspace_id !== workspaceId || tab.label !== details.label || tab.pane_count !== 0) {
					return { outcome: "blocked", failure: "The exact saved worker tab no longer matches its owned empty tab identity." };
				}
				const closed = await this.herdr.exec(["tab", "close", tabId], this.processOptions(details.worktreeCwd, context, HERDR_OPERATION_CAP_MS));
				if (closed.code !== 0 || closed.killed) return { outcome: "blocked", failure: safeText(herdrCommandFailure(["tab", "close"], closed)) };
				requireOkResponse(closed.stdout, "Herdr tab close response");
				return await this.getTab(tabId, details.worktreeCwd, context) === undefined
					? { outcome: "completed" }
					: { outcome: "blocked", failure: "The exact saved worker tab still exists after close." };
			}

			const workerCleanup = input.attempt.cleanup.find((step) => step.kind === "worker_tab");
			if (workerCleanup?.status !== "completed") return { outcome: "blocked", failure: "Workspace cleanup must follow worker-tab reconciliation." };
			const workspaceIntent = ownedIntent(input.attempt, "workspace");
			const details = parseDetails(workspaceIntent);
			if (details.kind !== "workspace") throw new Error("Saved workspace identity is malformed.");
			assertWorkspaceDetails(details, workspaceIntent, input.attempt);
			const workspaceId = exactString(workspaceIntent.resourceId, "saved workspace ID");
			if (await this.workspaceAbsent(workspaceId, details.worktreeCwd, context)) return { outcome: "absent" };
			const response = await this.herdr.json(["workspace", "get", workspaceId], this.processOptions(details.worktreeCwd, context, HERDR_OPERATION_CAP_MS));
			const workspace = parseWorkspaceInfo(response, workspaceId);
			const worktree = record(workspace.worktree, "Owned Herdr workspace worktree");
			if (workspace.label !== details.label || worktree.checkout_path !== details.worktreeCwd || worktree.repo_root !== details.repoRoot) {
				return { outcome: "blocked", failure: "The exact saved workspace no longer matches its owned label and checkout." };
			}
			const rootTabId = exactString(workspaceIntent.resources?.tabId, "saved workspace root tab ID");
			const rootPaneId = exactString(workspaceIntent.resources?.rootPaneId, "saved workspace root pane ID");
			const tabs = await this.listTabs(workspaceId, details.worktreeCwd, context);
			const panes = await this.listPanes(workspaceId, details.worktreeCwd, context);
			if (tabs.length !== 1 || tabs[0]!.tab_id !== rootTabId || tabs[0]!.workspace_id !== workspaceId || tabs[0]!.pane_count !== 1
				|| panes.length !== 1 || panes[0]!.pane_id !== rootPaneId || panes[0]!.tab_id !== rootTabId
				|| panes[0]!.workspace_id !== workspaceId || (panes[0]!.agent !== undefined && panes[0]!.agent !== null)) {
				return { outcome: "blocked", failure: "The exact saved workspace contains missing, mismatched, or additional resources; it was not closed." };
			}
			const closed = await this.herdr.exec(["workspace", "close", workspaceId], this.processOptions(details.worktreeCwd, context, HERDR_OPERATION_CAP_MS));
			if (closed.code !== 0 || closed.killed) return { outcome: "blocked", failure: safeText(herdrCommandFailure(["workspace", "close"], closed)) };
			requireOkResponse(closed.stdout, "Herdr workspace close response");
			return await this.workspaceAbsent(workspaceId, details.worktreeCwd, context)
				? { outcome: "completed" }
				: { outcome: "blocked", failure: "The exact saved workspace still exists after close." };
		} catch (error) {
			return { outcome: "blocked", failure: safeText(error) };
		}
	}

	private async allocateWorkspace(
		details: WorkspaceDetails,
		intent: AllocationIntent,
		attempt: TaskAttempt,
		context: OperationContext,
	): Promise<AllocationResult> {
		assertWorkspaceDetails(details, intent, attempt);
		const args = ["worktree", "open", "--path", details.worktreeCwd, "--label", details.label, "--no-focus"];
		const response = await this.herdr.exec(args, this.processOptions(details.repoRoot, context, HERDR_OPERATION_CAP_MS));
		if (response.code !== 0 || response.killed) {
			return { outcome: "unknown", failure: safeText(herdrCommandFailure(args, response)), possibleResources: [details.label] };
		}
		try {
			const result = resultRecord(parseJsonObject(response.stdout, "Herdr worktree open response"), "Herdr worktree open response");
			if (result.type !== "worktree_opened" || result.already_open !== false) throw new Error("Herdr did not create one fresh worktree workspace.");
			const workspace = record(result.workspace, "Herdr opened workspace");
			const tab = record(result.tab, "Herdr opened root tab");
			const pane = record(result.root_pane, "Herdr opened root pane");
			const worktree = record(result.worktree, "Herdr opened worktree");
			const workspaceId = exactString(workspace.workspace_id, "opened workspace_id");
			const tabId = exactString(tab.tab_id, "opened tab_id");
			const rootPaneId = exactString(pane.pane_id, "opened root pane_id");
			const workspaceWorktree = record(workspace.worktree, "opened workspace worktree");
			if (workspace.label !== details.label || workspace.focused !== false || tab.workspace_id !== workspaceId
				|| tab.focused !== false || pane.workspace_id !== workspaceId || pane.tab_id !== tabId || pane.focused !== false
				|| worktree.path !== details.worktreeCwd || workspaceWorktree.checkout_path !== details.worktreeCwd
				|| workspaceWorktree.repo_root !== details.repoRoot) {
				throw new Error("Herdr worktree open response does not prove the exact non-focused checkout.");
			}
			return { outcome: "owned", resourceId: workspaceId, resources: { tabId, rootPaneId } };
		} catch (error) {
			return { outcome: "unknown", failure: safeText(error), possibleResources: [details.label] };
		}
	}

	private async allocateWorkerTab(
		details: WorkerTabDetails,
		intent: AllocationIntent,
		attempt: TaskAttempt,
		context: OperationContext,
	): Promise<AllocationResult> {
		assertWorkerTabDetails(details, intent, attempt);
		await this.createPrivateLease(details.leasePath, intent.token);
		const args = [
			"tab", "create", "--workspace", details.workspaceId, "--cwd", details.worktreeCwd,
			"--label", details.label, "--env", `${PROCESS_LEASE_ENV}=${details.leasePath}`, "--no-focus",
		];
		const response = await this.herdr.exec(args, this.processOptions(details.worktreeCwd, context, HERDR_OPERATION_CAP_MS));
		if (response.code !== 0 || response.killed) {
			return { outcome: "unknown", failure: safeText(herdrCommandFailure(args, response)), possibleResources: [details.label, details.leasePath] };
		}
		try {
			const result = resultRecord(parseJsonObject(response.stdout, "Herdr tab create response"), "Herdr tab create response");
			if (result.type !== "tab_created") throw new Error("Herdr tab create response has the wrong type.");
			const tab = record(result.tab, "Herdr created tab");
			const pane = record(result.root_pane, "Herdr created tab root pane");
			const tabId = exactString(tab.tab_id, "created tab_id");
			const paneId = exactString(pane.pane_id, "created root pane_id");
			if (tabId === details.workspaceRootTabId || paneId === details.workspaceRootPaneId
				|| tab.workspace_id !== details.workspaceId || tab.label !== details.label || tab.focused !== false || tab.pane_count !== 1
				|| pane.workspace_id !== details.workspaceId || pane.tab_id !== tabId || pane.cwd !== details.worktreeCwd || pane.focused !== false) {
				throw new Error("Herdr tab create response does not prove one exact non-focused worker pane distinct from the workspace root.");
			}
			return { outcome: "owned", resourceId: tabId, resources: { rootPaneId: paneId, leasePath: details.leasePath } };
		} catch (error) {
			return { outcome: "unknown", failure: safeText(error), possibleResources: [details.label, details.leasePath] };
		}
	}

	private async allocateAgent(
		details: AgentDetails,
		intent: AllocationIntent,
		attempt: TaskAttempt,
		verifyLaunch: (() => Promise<VerifiedImplementerLaunch>) | undefined,
		context: OperationContext,
	): Promise<AllocationResult> {
		assertAgentDetails(details, intent, attempt);
		if (!verifyLaunch) throw new Error("Agent start requires immediate Implementer launch verification.");
		this.assertLeasePath(details.leasePath, intent.token);
		await this.assertPrivateLease(details.leasePath, false);
		if ((await this.scanLease(details.leasePath, details.worktreeCwd, context)).length) {
			throw new Error("Agent start requires an empty exact process lease.");
		}
		await this.assertStartableAgentPane(details, context);
		const options = this.processOptions(details.worktreeCwd, context, HERDR_OPERATION_CAP_MS);
		const launch = await verifyLaunch();
		if (launch.role !== "implementer") throw new Error("Agent start verification returned the wrong Role.");
		if (Object.keys(launch.env).length) throw new Error("Herdr Implementer launch must not receive caller Role environment variables.");
		const response = await startPiAgent(this.herdr, {
			name: details.agentName,
			pane: details.paneId,
			args: launch.args,
			options,
			shouldRetry: () => false,
		});
		if (response.code !== 0 || response.killed) {
			const failure = safeText(herdrCommandFailure(["agent", "start"], response));
			return hasHerdrErrorCode(response, "agent_pane_busy") && !response.killed
				? { outcome: "absent", failure }
				: { outcome: "unknown", failure, possibleResources: [details.agentName, details.paneId] };
		}
		try {
			const agent = parseAgent(parseJsonObject(response.stdout, "Herdr agent start response"), details, ["agent_started"]);
			if (!agent.interactiveReady || agent.status !== "idle") throw new Error("Started Herdr agent is not exactly ready and idle.");
			return { outcome: "owned", resourceId: details.agentName, resources: { paneId: details.paneId } };
		} catch (error) {
			return { outcome: "unknown", failure: safeText(error), possibleResources: [details.agentName, details.paneId] };
		}
	}

	private async candidateResult(
		input: { task: TaskRequest; attempt: TaskAttempt; preCandidate: WorkspaceIdentity },
		details: AgentDetails,
		context: OperationContext,
		stalled: boolean,
	): Promise<WorkerResult> {
		let candidate: WorkspaceIdentity;
		try {
			candidate = await this.inspectCandidate(
				{ root: details.worktreeCwd, task: input.task, attempt: input.attempt },
				this.childContext(context, GIT_INSPECTION_CAP_MS),
			);
		} catch (error) {
			return { outcome: "unknown", diagnostic: `Settled worker candidate inspection failed: ${safeText(error)}` };
		}
		const expectedBranch = `refs/heads/${worktreeIntent(input.attempt).worktree.branch}`;
		if (!isCleanCommitted(candidate) || candidate.branch !== expectedBranch || candidate.head === input.preCandidate.head) {
			const diagnostic = await this.diagnostic(details, context, "Settled worker did not produce an exact changed clean committed candidate.");
			return stalled ? { outcome: "unknown", diagnostic } : { outcome: "blocked", diagnostic };
		}
		return { outcome: "candidate", candidate, diagnostic: await this.diagnostic(details, context, stalled ? "Delivered stalled prompt settled with a candidate." : "Worker settled with a candidate.") };
	}

	private async waitForSettledAgent(details: AgentDetails, context: OperationContext): Promise<{ status: string; interactiveReady: boolean }> {
		const response = await this.herdr.json([
			"agent", "wait", details.agentName,
			"--until", "idle", "--until", "done", "--until", "blocked", "--until", "unknown",
			"--timeout", String(this.callTimeout(context, HERDR_OPERATION_CAP_MS)),
		], this.processOptions(details.worktreeCwd, context, HERDR_OPERATION_CAP_MS));
		return parseAgent(response, details, ["agent_info"]);
	}

	private async diagnostic(details: AgentDetails, context: OperationContext, prefix: string): Promise<string> {
		try {
			const response = await this.herdr.exec(
				["agent", "read", details.agentName, "--source", "recent", "--lines", "80", "--format", "text"],
				this.processOptions(details.worktreeCwd, context, HERDR_OPERATION_CAP_MS),
			);
			if (response.code === 0 && !response.killed && response.stdout.trim()) return `${prefix}\n${response.stdout.slice(0, DIAGNOSTIC_LIMIT)}`;
		} catch {
			// Terminal text is diagnostic only; lifecycle evidence remains authoritative.
		}
		return prefix;
	}

	private async assertStartableAgentPane(details: AgentDetails, context: OperationContext): Promise<void> {
		const paneResponse = await this.herdr.json(
			["pane", "get", details.paneId],
			this.processOptions(details.worktreeCwd, context, HERDR_OPERATION_CAP_MS),
		);
		const paneResult = resultRecord(paneResponse, "Herdr agent pane response");
		if (paneResult.type !== "pane_info") throw new Error("Herdr agent pane response has the wrong type.");
		const pane = record(paneResult.pane, "Herdr agent pane");
		if (exactString(pane.pane_id, "Herdr agent pane ID") !== details.paneId
			|| exactString(pane.tab_id, "Herdr agent pane tab ID") !== details.tabId
			|| exactString(pane.workspace_id, "Herdr agent pane workspace ID") !== details.workspaceId
			|| pane.cwd !== details.worktreeCwd || pane.foreground_cwd !== details.worktreeCwd
			|| pane.agent !== null || pane.agent_status !== "unknown") {
			throw new Error("The exact saved agent pane is not empty and startable in its owned worktree.");
		}

		const processResponse = await this.herdr.json(
			["pane", "process-info", "--pane", details.paneId],
			this.processOptions(details.worktreeCwd, context, HERDR_OPERATION_CAP_MS),
		);
		const processResult = resultRecord(processResponse, "Herdr agent pane process-info response");
		if (processResult.type !== "pane_process_info") throw new Error("Herdr agent pane process-info response has the wrong type.");
		const processInfo = record(processResult.process_info, "Herdr agent pane process-info");
		const shellPid = processInfo.shell_pid;
		const foreground = processInfo.foreground_processes;
		if (exactString(processInfo.pane_id, "Herdr agent process pane ID") !== details.paneId
			|| !Number.isSafeInteger(shellPid) || Number(shellPid) <= 0
			|| processInfo.foreground_process_group_id !== shellPid
			|| !Array.isArray(foreground) || foreground.length !== 1) {
			throw new Error("The exact saved agent pane process state is not an idle foreground shell.");
		}
		const shell = record(foreground[0], "Herdr agent pane foreground process");
		if (shell.pid !== shellPid || shell.cwd !== details.worktreeCwd) {
			throw new Error("The exact saved agent pane foreground process is not its owned idle shell.");
		}
		exactString(shell.name, "Herdr agent pane shell name");
	}

	private async createPrivateLease(path: string, token: string): Promise<void> {
		this.assertLeasePath(path, token);
		const directory = resolve(this.leaseDirectory, token);
		await mkdir(directory, { recursive: true, mode: DIRECTORY_MODE });
		for (const checked of [this.leaseDirectory, directory]) {
			const info = await lstat(checked);
			if (info.isSymbolicLink() || !info.isDirectory() || (info.mode & 0o077) !== 0) {
				throw new Error(`Process lease directory must be a private non-symlink directory: ${checked}`);
			}
		}
		let file;
		try {
			file = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, LEASE_MODE);
			await file.chmod(LEASE_MODE);
		} finally {
			await file?.close();
		}
		await this.assertPrivateLease(path, false);
	}

	private assertLeasePath(path: string, token: string): void {
		const parent = resolve(this.leaseDirectory, token);
		const candidate = resolve(path);
		if (candidate !== path || !candidate.startsWith(`${parent}${sep}`) || !/^[0-9a-f]{32}\.lease$/.test(candidate.slice(parent.length + 1))) {
			throw new Error("Process lease path is not the exact random path owned by this task token.");
		}
	}

	private async assertPrivateLease(path: string, allowMissing: boolean): Promise<boolean> {
		let info;
		try {
			info = await lstat(path);
		} catch (error) {
			if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") return false;
			throw new Error(`Exact process lease cannot be inspected: ${path}`, { cause: error });
		}
		const uid = process.getuid?.();
		if (info.isSymbolicLink() || !info.isFile() || (info.mode & 0o777) !== LEASE_MODE || (uid !== undefined && info.uid !== uid)) {
			throw new Error("Exact process lease must be a current-user regular non-symlink mode-0600 file.");
		}
		return true;
	}

	private async scanLease(
		path: string,
		cwd: string,
		context: OperationContext,
		pid?: number,
		allowMissing = false,
	): Promise<number[]> {
		if (!await this.assertPrivateLease(path, allowMissing)) return [];
		const args = ["-nP", "-a", ...(pid === undefined ? [] : ["-p", String(pid)]), "-F", "p", "--", path];
		const result = await this.execute(this.lsofCommand, args, this.processOptions(cwd, context, LSOF_OPERATION_CAP_MS));
		if (result.killed || ![0, 1].includes(result.code) || (result.code === 1 && (result.stdout.trim() || result.stderr.trim()))) {
			throw new Error("Exact process lease lsof scan failed or was ambiguous.");
		}
		if (result.code === 1) return [];
		if (result.stderr.trim()) throw new Error("Exact process lease lsof scan returned unexpected diagnostics.");
		const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
		if (!lines.length || lines.some((line) => !/^p[1-9]\d*$/.test(line))) {
			throw new Error("Exact process lease lsof scan returned malformed PID fields.");
		}
		const holders = [...new Set(lines.map((line) => Number(line.slice(1))))];
		if (holders.some((holder) => !Number.isSafeInteger(holder) || holder <= 0) || (pid !== undefined && holders.some((holder) => holder !== pid))) {
			throw new Error("Exact process lease lsof scan returned an unexpected PID.");
		}
		return holders;
	}

	private async signalExactHolders(
		holders: readonly number[],
		details: AgentDetails,
		signal: "SIGTERM" | "SIGKILL",
		context: OperationContext,
	): Promise<void> {
		for (const pid of holders) {
			context.signal.throwIfAborted();
			if (!(await this.scanLease(details.leasePath, details.worktreeCwd, context, pid)).includes(pid)) continue;
			try {
				this.kill(pid, signal);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
			}
		}
	}

	private async listTabs(workspaceId: string, cwd: string, context: OperationContext): Promise<JsonRecord[]> {
		const response = await this.herdr.json(["tab", "list", "--workspace", workspaceId], this.processOptions(cwd, context, HERDR_OPERATION_CAP_MS));
		const result = resultRecord(response, "Herdr tab list response");
		if (result.type !== "tab_list" || !Array.isArray(result.tabs)) throw new Error("Herdr tab list response is malformed.");
		return result.tabs.map((item) => record(item, "Herdr listed tab"));
	}

	private async listAgents(cwd: string, context: OperationContext): Promise<JsonRecord[]> {
		const response = await this.herdr.json(["agent", "list"], this.processOptions(cwd, context, HERDR_OPERATION_CAP_MS));
		const result = resultRecord(response, "Herdr agent list response");
		if (result.type !== "agent_list" || !Array.isArray(result.agents)) throw new Error("Herdr agent list response is malformed.");
		return result.agents.map((item) => record(item, "Herdr listed agent"));
	}

	private async listPanes(workspaceId: string, cwd: string, context: OperationContext): Promise<JsonRecord[]> {
		const response = await this.herdr.json(["pane", "list", "--workspace", workspaceId], this.processOptions(cwd, context, HERDR_OPERATION_CAP_MS));
		const result = resultRecord(response, "Herdr pane list response");
		if (result.type !== "pane_list" || !Array.isArray(result.panes)) throw new Error("Herdr pane list response is malformed.");
		return result.panes.map((item) => record(item, "Herdr listed pane"));
	}

	private async getTab(tabId: string, cwd: string, context: OperationContext): Promise<JsonRecord | undefined> {
		const response = await this.herdr.exec(["tab", "get", tabId], this.processOptions(cwd, context, HERDR_OPERATION_CAP_MS));
		if (response.code === 0 && !response.killed) {
			const result = resultRecord(parseJsonObject(response.stdout, "Herdr tab get response"), "Herdr tab get response");
			if (result.type !== "tab_info") throw new Error("Herdr tab get response has the wrong type.");
			const tab = record(result.tab, "Herdr tab");
			if (exactString(tab.tab_id, "Herdr tab ID") !== tabId) throw new Error("Herdr tab get returned mismatched data.");
			return tab;
		}
		if (!response.killed && hasHerdrErrorCode(response, "tab_not_found")) return undefined;
		throw new Error("Exact saved tab presence is ambiguous.");
	}

	private async paneAbsent(paneId: string, cwd: string, context: OperationContext): Promise<boolean> {
		const response = await this.herdr.exec(["pane", "get", paneId], this.processOptions(cwd, context, HERDR_OPERATION_CAP_MS));
		if (response.code === 0 && !response.killed) {
			const result = resultRecord(parseJsonObject(response.stdout, "Herdr pane get response"), "Herdr pane get response");
			if (result.type !== "pane_info" || record(result.pane, "Herdr pane").pane_id !== paneId) throw new Error("Herdr pane get returned mismatched data.");
			return false;
		}
		if (!response.killed && hasHerdrErrorCode(response, "pane_not_found")) return true;
		throw new Error("Exact saved pane presence is ambiguous.");
	}

	private async workspaceAbsent(workspaceId: string, cwd: string, context: OperationContext): Promise<boolean> {
		const response = await this.herdr.exec(["workspace", "get", workspaceId], this.processOptions(cwd, context, HERDR_OPERATION_CAP_MS));
		if (response.code === 0 && !response.killed) {
			parseWorkspaceInfo(parseJsonObject(response.stdout, "Herdr workspace get response"), workspaceId);
			return false;
		}
		if (!response.killed && hasHerdrErrorCode(response, "workspace_not_found")) return true;
		throw new Error("Exact saved workspace presence is ambiguous.");
	}

	private processOptions(cwd: string, context: OperationContext, cap: number): HostProcessOptions {
		context.signal.throwIfAborted();
		return { cwd, signal: context.signal, timeoutMs: this.callTimeout(context, cap) };
	}

	private childContext(context: OperationContext, cap: number): OperationContext {
		return { signal: context.signal, deadline: context.deadline, timeoutMs: this.callTimeout(context, cap) };
	}

	private callTimeout(context: OperationContext, cap: number): number {
		const remaining = Math.min(context.timeoutMs, context.deadline - this.now(), cap);
		if (!Number.isFinite(remaining) || remaining <= 0) throw new Error("Operation deadline is exhausted.");
		return Math.max(1, Math.floor(remaining));
	}
}

export function createHerdrHostRuntime(options: HerdrHostRuntimeOptions): HerdrHostRuntime {
	return new HerdrHostRuntime(options);
}
