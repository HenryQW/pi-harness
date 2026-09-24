import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rmdir, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
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
import {
	isCleanCommitted,
	type AgentAllocationIntent,
	type AllocationIntent,
	type AllocationKind,
	type ExecuteRequest,
	type HostAllocationIntent,
	type HostAllocationPlan,
	type TaskAttempt,
	type TaskRequest,
	type WorkerTabAllocationIntent,
	type WorkspaceAllocationIntent,
	type WorkspaceIdentity,
	type WorktreeAllocationIntent,
	type WorktreeAllocationPlan,
} from "./schema.ts";
import {
	buildChangesetTaskPrompt,
	type AgentAllocationResult,
	type AllocationReconciliation,
	type HostAllocationKind,
	type HostAllocationResult,
	type HostCleanupKind,
	type HostRuntime,
	type InFlightTaskCandidateInspection,
	type InFlightTaskCandidateInspector,
	type OperationContext,
	type TextTaskContext,
	type TransientLaunchHandle,
	type VerifiedLaunch,
	withTransientLaunch,
	type WorkerResult,
	type WorkerTabAllocationResult,
	type WorkspaceAllocationResult,
} from "./runner.ts";
import { runProcess as defaultRunProcess } from "./process.ts";

const MIN_HERDR_VERSION = [0, 9, 0] as const;
const MIN_HERDR_PROTOCOL = 22;
const HERDR_OPERATION_CAP_MS = 30_000;
const LSOF_OPERATION_CAP_MS = 3_000;
const PROCESS_INSPECTION_CAP_MS = 3_000;
const GIT_INSPECTION_CAP_MS = 30_000;
const STALLED_PROMPT_POLL_MS = 250;
const HOST_LAYOUT_POLL_MS = 50;
const HOST_LAYOUT_MAX_POLLS = 40;
const DIAGNOSTIC_LIMIT = 8 * 1024;
const LEASE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const PROCESS_LEASE_ENV = "PI_SUBAGENT_PROCESS_LEASE";
const CORRELATION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const HERDR_AGENT_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
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
	inspectInFlightTaskCandidate: InFlightTaskCandidateInspector["inspectInFlightTaskCandidate"];
	runProcess?: HostProcessRunner;
	killProcess?: (pid: number, signal: NodeJS.Signals) => void;
	delay?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
	now?: () => number;
	randomId?: () => string;
	env?: NodeJS.ProcessEnv;
	leaseDirectory?: string;
	lsofCommand?: string;
}

type RepositoryIdentity = Pick<WorkspaceAllocationIntent, "repoKey" | "herdrRepoRoot">;
type JsonRecord = Record<string, unknown>;

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

function exactAbsolutePath(value: unknown, label: string): string {
	const path = exactString(value, label);
	if (!isAbsolute(path)) throw new Error(`${label} must be an absolute path.`);
	return path;
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

type AllocationOfKind<Kind extends AllocationKind> = Extract<AllocationIntent, { kind: Kind }>;

function ownedIntent<Kind extends AllocationKind>(attempt: TaskAttempt, kind: Kind): AllocationOfKind<Kind> {
	const matches = attempt.allocations.filter(
		(intent): intent is AllocationOfKind<Kind> => intent.kind === kind && intent.status === "owned",
	);
	if (matches.length !== 1) throw new Error(`Task lacks one exact owned ${kind} allocation.`);
	return matches[0]!;
}

function worktreeIntent(attempt: TaskAttempt): WorktreeAllocationPlan {
	const intent = ownedIntent(attempt, "worktree");
	if (!intent.worktree || intent.worktree.cwd !== intent.worktree.path) {
		throw new Error("Task lacks exact owned worktree metadata.");
	}
	return intent.worktree;
}

export function workspaceLabel(attempt: Pick<TaskAttempt, "correlationToken">): string {
	return attempt.correlationToken.slice(-6);
}

function legacyWorkspaceLabel(requestId: ExecuteRequest["id"], task: TaskRequest, attempt: TaskAttempt): string {
	return `${requestId}/${task.id}#${attempt.number}`;
}

function expectedWorkerLabel(task: TaskRequest): string {
	return `${task.role}/${task.modelClass}`;
}

function expectedAgentName(token: string): string {
	if (!CORRELATION_TOKEN_PATTERN.test(token)) throw new Error("Agent correlation token is invalid.");
	const segment = token.length <= 24 && !/[^0-9a-f]/.test(token)
		? token
		: createHash("sha256").update(token).digest("hex").slice(0, 24);
	const name = `o-${segment}-agent`;
	if (!HERDR_AGENT_NAME_PATTERN.test(name)) throw new Error("Agent correlation token cannot produce a valid Herdr name.");
	return name;
}

function requireIntentIdentity(intent: AllocationIntent, attempt: TaskAttempt): void {
	if (intent.token !== attempt.correlationToken || intent.generation !== attempt.allocationGeneration) {
		throw new Error(`${intent.kind} allocation intent does not match the task attempt.`);
	}
}

function assertWorkspaceIntent(
	intent: WorkspaceAllocationIntent,
	requestId: ExecuteRequest["id"],
	task: TaskRequest,
	attempt: TaskAttempt,
): void {
	const worktree = worktreeIntent(attempt);
	const label = exactString(intent.label, "workspace label");
	if ((label !== workspaceLabel(attempt) && label !== legacyWorkspaceLabel(requestId, task, attempt))
		|| exactAbsolutePath(intent.worktreeCwd, "workspace worktree cwd") !== worktree.cwd
		|| exactAbsolutePath(intent.mainRoot, "workspace Main root") !== worktree.repoRoot) {
		throw new Error("Workspace allocation plan drifted from the exact owned worktree.");
	}
	exactAbsolutePath(intent.repoKey, "workspace repository key");
	exactAbsolutePath(intent.herdrRepoRoot, "workspace Herdr repository root");
}

function assertWorkerTabIntent(intent: WorkerTabAllocationIntent, task: TaskRequest, attempt: TaskAttempt): void {
	const worktree = worktreeIntent(attempt);
	const workspace = ownedIntent(attempt, "workspace");
	if (exactString(intent.label, "worker-tab label") !== expectedWorkerLabel(task)
		|| exactString(intent.workspaceId, "worker-tab workspace ID") !== workspace.workspaceId
		|| exactString(intent.workspaceRootTabId, "workspace root tab ID") !== workspace.rootTabId
		|| exactString(intent.workspaceRootPaneId, "workspace root pane ID") !== workspace.rootPaneId
		|| exactAbsolutePath(intent.worktreeCwd, "worker-tab cwd") !== worktree.cwd) {
		throw new Error("Worker-tab allocation plan drifted from its exact parent resources.");
	}
	exactAbsolutePath(intent.leasePath, "worker-tab lease path");
}

function assertAgentIntent(intent: AgentAllocationIntent, attempt: TaskAttempt): void {
	const worktree = worktreeIntent(attempt);
	const workspace = ownedIntent(attempt, "workspace");
	const tab = ownedIntent(attempt, "worker_tab");
	if (exactString(intent.agentName, "agent name") !== expectedAgentName(intent.token)
		|| exactString(intent.workspaceId, "agent workspace ID") !== workspace.workspaceId
		|| exactString(intent.tabId, "agent tab ID") !== tab.tabId
		|| exactString(intent.paneId, "agent pane ID") !== tab.paneId
		|| exactAbsolutePath(intent.worktreeCwd, "agent worktree cwd") !== worktree.cwd
		|| exactAbsolutePath(intent.leasePath, "agent lease path") !== tab.leasePath) {
		throw new Error("Agent allocation plan drifted from its exact parent resources.");
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

function parseAgent(response: JsonRecord, expected: AgentAllocationIntent, acceptedTypes: readonly string[]): { status: string; interactiveReady: boolean } {
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

export class HerdrHostRuntime implements HostRuntime {
	private readonly inspectInFlightCandidate: InFlightTaskCandidateInspector["inspectInFlightTaskCandidate"];
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
		this.inspectInFlightCandidate = options.inspectInFlightTaskCandidate;
		this.execute = options.runProcess ?? defaultRunProcess;
		this.herdr = createHerdrClient(this.execute);
		this.kill = options.killProcess ?? ((pid, signal) => process.kill(pid, signal));
		this.delay = options.delay ?? (async (milliseconds, signal) => await sleep(milliseconds, undefined, { signal, ref: false }));
		this.now = options.now ?? Date.now;
		this.randomId = options.randomId ?? (() => randomBytes(16).toString("hex"));
		this.env = options.env ?? process.env;
		this.leaseDirectory = resolve(options.leaseDirectory ?? join(extensionConfigDir("pi-subagent"), "leases"));
		this.lsofCommand = options.lsofCommand ?? "lsof";
	}

	/** Fail-closed Herdr caller/capability gate. This method creates no state or host resource. */
	async preflightHost(input: { root: string }, context: OperationContext): Promise<void> {
		context.signal.throwIfAborted();
		if (this.env.HERDR_ENV !== "1") throw new Error("Pi Subagent requires HERDR_ENV=1.");
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
		if (checkout !== root) throw new Error("The current Herdr workspace checkout does not match canonical Main.");

		const identity = await this.repositoryIdentity(root, context);
		const repoKey = await realpath(exactString(worktree.repo_key, "Herdr current repo_key"));
		if (repoKey !== identity.repoKey) throw new Error("The current Herdr workspace repo_key does not match Git's common directory.");
		const repoRoot = await realpath(exactString(worktree.repo_root, "Herdr current repo_root"));
		if (repoRoot !== identity.herdrRepoRoot) {
			throw new Error("The current Herdr workspace repo_root does not match Git's primary checkout.");
		}
	}

	async planHostAllocation(
		input: {
			readonly requestId: ExecuteRequest["id"];
			readonly goal: ExecuteRequest["goal"];
			kind: HostAllocationKind;
			task: TaskRequest;
			attempt: TaskAttempt;
		},
		context: OperationContext,
	): Promise<HostAllocationPlan> {
		context.signal.throwIfAborted();
		const worktree = worktreeIntent(input.attempt);
		const worktreeCwd = exactAbsolutePath(worktree.cwd, "owned worktree cwd");
		if (input.kind === "workspace") {
			if (input.task.kind !== "changeset") throw new Error("Herdr assignment requires a changeset task.");
			buildChangesetTaskPrompt({ goal: input.goal, contexts: [], task: input.task, kind: "initial", worktreeCwd });
			const mainRoot = exactAbsolutePath(worktree.repoRoot, "owned worktree Main root");
			const identity = await this.repositoryIdentity(mainRoot, context);
			return {
				kind: "workspace",
				label: workspaceLabel(input.attempt),
				worktreeCwd,
				mainRoot,
				...identity,
			};
		}
		const workspace = ownedIntent(input.attempt, "workspace");
		const workspaceId = exactString(workspace.workspaceId, "owned workspace ID");
		if (input.kind === "worker_tab") {
			const leasePath = join(this.leaseDirectory, input.attempt.correlationToken, `${this.randomId()}.lease`);
			this.assertLeasePath(leasePath, input.attempt.correlationToken);
			return {
				kind: "worker_tab",
				label: expectedWorkerLabel(input.task),
				workspaceId,
				workspaceRootTabId: exactString(workspace.rootTabId, "owned workspace root tab ID"),
				workspaceRootPaneId: exactString(workspace.rootPaneId, "owned workspace root pane ID"),
				worktreeCwd,
				leasePath,
			};
		}
		const tab = ownedIntent(input.attempt, "worker_tab");
		const tabId = exactString(tab.tabId, "owned worker tab ID");
		const leasePath = exactString(tab.leasePath, "owned worker lease path");
		this.assertLeasePath(leasePath, input.attempt.correlationToken);
		return {
			kind: "agent",
			agentName: expectedAgentName(input.attempt.correlationToken),
			workspaceId,
			tabId,
			paneId: exactString(tab.paneId, "owned worker pane ID"),
			worktreeCwd,
			leasePath,
		};
	}

	async allocateHost(
		input: {
			requestId: ExecuteRequest["id"];
			intent: HostAllocationIntent;
			task: TaskRequest;
			attempt: TaskAttempt;
			acquireLaunch?: () => Promise<TransientLaunchHandle<VerifiedLaunch>>;
		},
		context: OperationContext,
	): Promise<HostAllocationResult> {
		requireIntentIdentity(input.intent, input.attempt);
		if (input.intent.kind === "workspace") {
			if (input.acquireLaunch) throw new Error("Role launch acquisition is valid only at the exact agent allocation boundary.");
			return await this.allocateWorkspace(input.intent, input.requestId, input.task, input.attempt, context);
		}
		if (input.intent.kind === "worker_tab") {
			if (input.acquireLaunch) throw new Error("Role launch acquisition is valid only at the exact agent allocation boundary.");
			return await this.allocateWorkerTab(input.intent, input.task, input.attempt, context);
		}
		return await this.allocateAgent(input.intent, input.task.role, input.attempt, input.acquireLaunch, context);
	}

	async reconcileHostAllocation(
		input: { requestId: ExecuteRequest["id"]; intent: HostAllocationIntent; task: TaskRequest; attempt: TaskAttempt },
		context: OperationContext,
	): Promise<AllocationReconciliation<HostAllocationKind>> {
		requireIntentIdentity(input.intent, input.attempt);
		const allocation = input.intent;
		if (allocation.kind === "workspace") {
			assertWorkspaceIntent(allocation, input.requestId, input.task, input.attempt);
			await this.assertRepositoryIdentity(allocation, context);
			const response = await this.herdr.json(
				["worktree", "list", "--cwd", allocation.worktreeCwd],
				this.processOptions(allocation.herdrRepoRoot, context, HERDR_OPERATION_CAP_MS),
			);
			const result = resultRecord(response, "Herdr worktree list response");
			if (result.type !== "worktree_list" || !Array.isArray(result.worktrees)) throw new Error("Herdr worktree list response is malformed.");
			const source = record(result.source, "Herdr worktree list source");
			if (exactString(source.source_checkout_path, "Herdr worktree list source checkout_path") !== allocation.worktreeCwd
				|| exactString(source.repo_key, "Herdr worktree list source repo_key") !== allocation.repoKey
				|| exactString(source.repo_root, "Herdr worktree list source repo_root") !== allocation.herdrRepoRoot) {
				throw new Error("Herdr worktree list source does not match the exact saved repository identity.");
			}
			const worktrees = result.worktrees.map((entry) => {
				const item = record(entry, "Herdr listed worktree");
				const path = exactString(item.path, "Herdr listed worktree path");
				const label = exactString(item.label, "Herdr listed worktree label");
				const openWorkspaceId = item.open_workspace_id;
				if (openWorkspaceId !== undefined && openWorkspaceId !== null) exactString(openWorkspaceId, "Herdr listed open workspace ID");
				return { path, label, openWorkspaceId: typeof openWorkspaceId === "string" ? openWorkspaceId : undefined };
			});
			const target = worktrees.filter((item) => item.path === allocation.worktreeCwd);
			const tokenMatches = worktrees.filter((item) => item.label === allocation.label);
			const possible = [
				...(target.length === 1 ? [] : [`expected worktree match count ${target.length}`]),
				...target.filter((item) => item.openWorkspaceId).map((item) => `possible workspace ${item.openWorkspaceId}`),
				...tokenMatches.map((item) => `token-labelled worktree ${item.path}${item.openWorkspaceId ? ` in workspace ${item.openWorkspaceId}` : ""}`),
			];
			return possible.length
				? { kind: "workspace", outcome: "possible", failure: "A possible prior Herdr workspace allocation or parent mismatch remains; it was not adopted or closed.", possibleResources: possible }
				: { kind: "workspace", outcome: "absent" };
		}
		if (allocation.kind === "worker_tab") {
			assertWorkerTabIntent(allocation, input.task, input.attempt);
			this.assertLeasePath(allocation.leasePath, input.intent.token);
			const tabs = (await this.listTabs(allocation.workspaceId, allocation.worktreeCwd, context)).map((tab) => ({
				id: exactString(tab.tab_id, "Herdr listed tab ID"),
				workspaceId: exactString(tab.workspace_id, "Herdr listed tab workspace ID"),
				label: exactString(tab.label, "Herdr listed tab label"),
			}));
			if (tabs.some((tab) => tab.workspaceId !== allocation.workspaceId)) {
				throw new Error("Herdr tab list escaped the exact saved workspace scope.");
			}
			const rootTabs = tabs.filter((tab) => tab.id === allocation.workspaceRootTabId);
			const unexpected = tabs.filter((tab) => tab.label === allocation.label);
			const holders = await this.scanLease(allocation.leasePath, allocation.worktreeCwd, context, undefined, true);
			const possible = [
				...(rootTabs.length === 1 ? [] : [`workspace root tab match count ${rootTabs.length}`]),
				...unexpected.map((tab) => `possible tab ${tab.id}`),
				...holders.map((pid) => `lease holder pid ${pid}`),
			];
			return possible.length
				? { kind: "worker_tab", outcome: "possible", failure: "A possible prior worker-tab allocation, parent mismatch, or lease holder remains; it was not adopted or touched.", possibleResources: possible }
				: { kind: "worker_tab", outcome: "absent" };
		}
		assertAgentIntent(allocation, input.attempt);
		this.assertLeasePath(allocation.leasePath, input.intent.token);
		try {
			await this.assertPrivateLease(allocation.leasePath, false);
			const agents = (await this.listAgents(allocation.worktreeCwd, context)).map((agent) => {
				const name = agent.name;
				if (name !== undefined && name !== null && typeof name !== "string") throw new Error("Herdr listed agent name is malformed.");
				return {
					name: typeof name === "string" ? name : undefined,
					paneId: exactString(agent.pane_id, "Herdr listed agent pane ID"),
					tabId: exactString(agent.tab_id, "Herdr listed agent tab ID"),
				};
			});
			const matches = agents.filter((agent) => agent.name === allocation.agentName || agent.paneId === allocation.paneId || agent.tabId === allocation.tabId);
			const holders = await this.scanLease(allocation.leasePath, allocation.worktreeCwd, context);
			const possible = [
				...matches.map((agent) => `possible agent ${agent.name ?? "without expected name"} in pane ${agent.paneId}`),
				...holders.map((pid) => `lease holder pid ${pid}`),
			];
			if (possible.length) {
				return { kind: "agent", outcome: "possible", failure: "A possible prior agent allocation or lease holder remains; it was not adopted or touched.", possibleResources: possible };
			}
			await this.assertStartableAgentPane(allocation, context, { requireExclusiveTty: true });
			return { kind: "agent", outcome: "absent" };
		} catch (error) {
			return {
				kind: "agent",
				outcome: "possible",
				failure: `A prior agent allocation cannot be proved absent: ${safeText(error)}`,
				possibleResources: [allocation.agentName, allocation.paneId, allocation.leasePath],
			};
		}
	}

	async runWorker(
		input: {
			readonly goal: ExecuteRequest["goal"];
			readonly contexts: readonly TextTaskContext[];
			task: TaskRequest;
			attempt: TaskAttempt;
			workerId: string;
			kind: "initial" | "correction" | "followup";
			preCandidate: WorkspaceIdentity;
			failure?: string;
			instruction?: string;
		},
		context: OperationContext,
	): Promise<WorkerResult> {
		const allocation = ownedIntent(input.attempt, "agent");
		requireIntentIdentity(allocation, input.attempt);
		assertAgentIntent(allocation, input.attempt);
		if (input.workerId !== allocation.agentName) {
			throw new Error("Worker prompt does not target the exact saved agent.");
		}
		let text: string;
		try {
			if (input.task.kind !== "changeset") throw new Error("Herdr assignment requires a changeset task.");
			text = buildChangesetTaskPrompt({
				goal: input.goal,
				contexts: input.contexts,
				task: input.task,
				kind: input.kind,
				worktreeCwd: allocation.worktreeCwd,
				...(input.failure ? { failure: input.failure } : {}),
				...(input.instruction ? { instruction: input.instruction } : {}),
			});
		} catch (error) {
			return { outcome: "not_prompted", diagnostic: `Worker assignment was not submitted: ${safeText(error)}` };
		}
		let ready;
		try {
			ready = await this.waitForSettledAgent(allocation, context);
		} catch (error) {
			return { outcome: context.signal.aborted ? "interrupted" : "unknown", diagnostic: `Exact worker readiness is unknown: ${safeText(error)}` };
		}
		if (ready.status === "blocked") return { outcome: "not_prompted", diagnostic: await this.diagnostic(allocation, context, "Worker was blocked before prompt submission.") };
		if (!SETTLED_AGENT_STATES.has(ready.status) || !ready.interactiveReady) {
			return { outcome: "unknown", diagnostic: `Exact worker was not interactively ready: ${ready.status}.` };
		}

		const promptOptions = this.processOptions(allocation.worktreeCwd, context, HERDR_OPERATION_CAP_MS);
		const promptArgs = [
			"agent", "prompt", allocation.agentName, text, "--wait",
			"--until", "working", "--until", "done", "--until", "blocked",
			"--timeout", String(promptOptions.timeoutMs),
		];
		const prompted = await this.herdr.exec(promptArgs, promptOptions);
		if (prompted.code !== 0 || prompted.killed) {
			if (!prompted.killed && !context.signal.aborted && hasHerdrErrorCode(prompted, "agent_prompt_stalled")) {
				return await this.reconcileDeliveredPrompt(input, allocation, context);
			}
			return {
				outcome: prompted.killed || context.signal.aborted ? "interrupted" : "unknown",
				diagnostic: `Worker prompt result is unknown and will not be replayed: ${safeText(herdrCommandFailure(["agent", "prompt"], prompted))}`,
			};
		}
		let settled;
		try {
			settled = parseAgent(parseJsonObject(prompted.stdout, "Herdr agent prompt"), allocation, ["agent_prompted"]);
		} catch (error) {
			return { outcome: "unknown", diagnostic: `Worker prompt response is malformed: ${safeText(error)}` };
		}
		if (settled.status === "working") return await this.reconcileDeliveredPrompt(input, allocation, context);
		if (settled.status === "blocked") return { outcome: "blocked", diagnostic: await this.diagnostic(allocation, context, "Worker settled as blocked.") };
		if (!SETTLED_AGENT_STATES.has(settled.status)) return { outcome: "unknown", diagnostic: `Worker prompt did not return a settled state: ${settled.status}.` };
		return await this.candidateResult(input, allocation, context);
	}

	async terminateWorker(
		input: { task: TaskRequest; attempt: TaskAttempt; workerId: string; candidate: WorkspaceIdentity },
		context: OperationContext,
	): Promise<{ outcome: "terminated" } | { outcome: "unknown"; failure: string }> {
		try {
			const allocation = ownedIntent(input.attempt, "agent");
			requireIntentIdentity(allocation, input.attempt);
			assertAgentIntent(allocation, input.attempt);
			if (input.workerId !== allocation.agentName) throw new Error("Worker termination identity does not match the exact saved agent.");
			this.assertLeasePath(allocation.leasePath, allocation.token);
			await this.assertPrivateLease(allocation.leasePath, false);
			const agents = (await this.listAgents(allocation.worktreeCwd, context)).map((agent) => ({
				name: typeof agent.name === "string" ? agent.name : undefined,
				paneId: exactString(agent.pane_id, "Herdr listed agent pane ID"),
				tabId: exactString(agent.tab_id, "Herdr listed agent tab ID"),
			}));
			const related = agents.filter((agent) => agent.name === allocation.agentName
				|| agent.paneId === allocation.paneId || agent.tabId === allocation.tabId);
			if (related.length !== 1 || related[0]!.name !== allocation.agentName
				|| related[0]!.paneId !== allocation.paneId || related[0]!.tabId !== allocation.tabId) {
				throw new Error("Worker termination requires one exact current agent, tab, and pane match.");
			}

			const processInfo = await this.herdr.json(
				["pane", "process-info", "--pane", allocation.paneId],
				this.processOptions(allocation.worktreeCwd, context, HERDR_OPERATION_CAP_MS),
			);
			const processResult = resultRecord(processInfo, "Herdr pane process-info response");
			if (processResult.type !== "pane_process_info") throw new Error("Herdr pane process-info response has the wrong type.");
			const captured = record(processResult.process_info, "Herdr pane process-info");
			if (captured.pane_id !== allocation.paneId) {
				throw new Error("Herdr pane process-info did not match the exact saved pane.");
			}

			const closed = await this.herdr.exec(["pane", "close", allocation.paneId], this.processOptions(allocation.worktreeCwd, context, HERDR_OPERATION_CAP_MS));
			if (closed.code !== 0 || closed.killed) throw new Error(herdrCommandFailure(["pane", "close"], closed));
			requireOkResponse(closed.stdout, "Herdr pane close response");
			if (!await this.paneAbsent(allocation.paneId, allocation.worktreeCwd, context)) throw new Error("The exact saved pane still exists after pane close.");

			let holders = await this.scanLease(allocation.leasePath, allocation.worktreeCwd, context);
			if (holders.length) {
				await this.signalExactHolders(holders, allocation, "SIGTERM", context);
				await this.delay(250, context.signal);
				holders = await this.scanLease(allocation.leasePath, allocation.worktreeCwd, context);
			}
			if (holders.length) {
				await this.signalExactHolders(holders, allocation, "SIGKILL", context);
				await this.delay(100, context.signal);
				holders = await this.scanLease(allocation.leasePath, allocation.worktreeCwd, context);
			}
			if (holders.length) throw new Error(`Exact process lease still has ${holders.length} surviving holder(s).`);
			await this.delay(50, context.signal);
			if ((await this.scanLease(allocation.leasePath, allocation.worktreeCwd, context)).length) {
				throw new Error("Exact process lease did not remain empty for two consecutive scans.");
			}
			return { outcome: "terminated" };
		} catch (error) {
			return { outcome: "unknown", failure: safeText(error) };
		}
	}

	async reconcileWorkerTermination(
		input: { task: TaskRequest; attempt: TaskAttempt; workerId: string; candidate: WorkspaceIdentity },
		context: OperationContext,
	): Promise<{ outcome: "terminated" | "active" } | { outcome: "unknown"; failure: string }> {
		try {
			const allocation = ownedIntent(input.attempt, "agent");
			requireIntentIdentity(allocation, input.attempt);
			assertAgentIntent(allocation, input.attempt);
			if (input.workerId !== allocation.agentName) throw new Error("Saved termination worker does not match the exact owned agent.");
			this.assertLeasePath(allocation.leasePath, allocation.token);
			await this.assertPrivateLease(allocation.leasePath, false);
			const agents = (await this.listAgents(allocation.worktreeCwd, context)).map((agent) => ({
				name: typeof agent.name === "string" ? agent.name : undefined,
				paneId: exactString(agent.pane_id, "Herdr listed agent pane ID"),
				tabId: exactString(agent.tab_id, "Herdr listed agent tab ID"),
			}));
			const related = agents.filter((agent) => agent.name === allocation.agentName
				|| agent.paneId === allocation.paneId || agent.tabId === allocation.tabId);
			if (related.length) {
				if (related.length !== 1 || related[0]!.name !== allocation.agentName
					|| related[0]!.paneId !== allocation.paneId || related[0]!.tabId !== allocation.tabId) {
					throw new Error("Observed worker identity does not exactly match the saved owned agent and pane.");
				}
				if (await this.paneAbsent(allocation.paneId, allocation.worktreeCwd, context)) {
					throw new Error("Exact saved agent exists but its saved pane is absent.");
				}
				const processInfo = await this.herdr.json(
					["pane", "process-info", "--pane", allocation.paneId],
					this.processOptions(allocation.worktreeCwd, context, HERDR_OPERATION_CAP_MS),
				);
				const result = resultRecord(processInfo, "Herdr pane process-info response");
				if (result.type !== "pane_process_info"
					|| record(result.process_info, "Herdr pane process-info").pane_id !== allocation.paneId) {
					throw new Error("Exact saved pane process ownership could not be proved.");
				}
				return { outcome: "active" };
			}
			if (!await this.paneAbsent(allocation.paneId, allocation.worktreeCwd, context)) {
				throw new Error("Saved agent is absent but the exact saved pane still exists.");
			}
			if ((await this.scanLease(allocation.leasePath, allocation.worktreeCwd, context)).length) {
				throw new Error("Saved worker is absent but its private process lease still has holders.");
			}
			await this.delay(50, context.signal);
			if ((await this.scanLease(allocation.leasePath, allocation.worktreeCwd, context)).length) {
				throw new Error("Private process lease did not remain empty for two consecutive scans.");
			}
			return { outcome: "terminated" };
		} catch (error) {
			return { outcome: "unknown", failure: safeText(error) };
		}
	}

	async cleanupHost(
		input: { requestId: ExecuteRequest["id"]; kind: HostCleanupKind; task: TaskRequest; attempt: TaskAttempt },
		context: OperationContext,
	): Promise<{ outcome: "completed" | "absent" } | { outcome: "blocked"; failure: string }> {
		if (input.attempt.termination?.status !== "terminated") {
			return { outcome: "blocked", failure: "Host cleanup requires exact recorded worker termination." };
		}
		try {
			if (input.kind === "worker_tab") {
				const allocation = ownedIntent(input.attempt, "worker_tab");
				const workspace = ownedIntent(input.attempt, "workspace");
				requireIntentIdentity(allocation, input.attempt);
				requireIntentIdentity(workspace, input.attempt);
				assertWorkerTabIntent(allocation, input.task, input.attempt);
				const leasePath = exactString(allocation.leasePath, "saved worker lease path");
				this.assertLeasePath(leasePath, input.attempt.correlationToken);
				assertWorkspaceIntent(workspace, input.requestId, input.task, input.attempt);
				await this.assertRepositoryIdentity(workspace, context);
				const tabId = exactString(allocation.tabId, "saved worker tab ID");
				const workspaceId = exactString(workspace.workspaceId, "saved workspace ID");
				if (tabId === allocation.workspaceRootTabId) throw new Error("Saved worker tab aliases the workspace root tab.");
				const paneId = exactString(allocation.paneId, "saved worker pane ID");
				if (!await this.paneAbsent(paneId, allocation.worktreeCwd, context)) {
					return { outcome: "blocked", failure: "The exact saved worker pane still exists after termination." };
				}
				const workspaceIsAbsent = await this.workspaceAbsent(workspaceId, workspace, context);
				const tab = await this.getTab(tabId, allocation.worktreeCwd, context);
				if (tab) {
					if (workspaceIsAbsent || tab.workspace_id !== workspaceId || tab.label !== allocation.label || tab.pane_count !== 0) {
						return { outcome: "blocked", failure: "The exact saved worker tab no longer matches its owned empty tab identity." };
					}
					const closed = await this.herdr.exec(["tab", "close", tabId], this.processOptions(allocation.worktreeCwd, context, HERDR_OPERATION_CAP_MS));
					if (closed.code !== 0 || closed.killed) return { outcome: "blocked", failure: safeText(herdrCommandFailure(["tab", "close"], closed)) };
					requireOkResponse(closed.stdout, "Herdr tab close response");
					if (await this.getTab(tabId, allocation.worktreeCwd, context)) {
						return { outcome: "blocked", failure: "The exact saved worker tab still exists after close." };
					}
				}
				await this.removeLeaseArtifacts(allocation, input.attempt.correlationToken, paneId, tabId, context);
				return tab ? { outcome: "completed" } : { outcome: "absent" };
			}

			const workerCleanup = input.attempt.cleanup.find((step) => step.kind === "worker_tab");
			if (workerCleanup?.status !== "completed") return { outcome: "blocked", failure: "Workspace cleanup must follow worker-tab reconciliation." };
			const allocation = ownedIntent(input.attempt, "workspace");
			requireIntentIdentity(allocation, input.attempt);
			assertWorkspaceIntent(allocation, input.requestId, input.task, input.attempt);
			await this.assertRepositoryIdentity(allocation, context);
			const workspaceId = exactString(allocation.workspaceId, "saved workspace ID");
			if (await this.workspaceAbsent(workspaceId, allocation, context)) return { outcome: "absent" };
			const response = await this.herdr.json(["workspace", "get", workspaceId], this.processOptions(allocation.herdrRepoRoot, context, HERDR_OPERATION_CAP_MS));
			const workspace = parseWorkspaceInfo(response, workspaceId);
			this.assertWorkspaceEvidence(workspace, allocation);
			const closed = await this.herdr.exec(["workspace", "close", workspaceId], this.processOptions(allocation.herdrRepoRoot, context, HERDR_OPERATION_CAP_MS));
			if (closed.code !== 0 || closed.killed) return { outcome: "blocked", failure: safeText(herdrCommandFailure(["workspace", "close"], closed)) };
			requireOkResponse(closed.stdout, "Herdr workspace close response");
			return await this.workspaceAbsent(workspaceId, allocation, context)
				? { outcome: "completed" }
				: { outcome: "blocked", failure: "The exact saved workspace still exists after close." };
		} catch (error) {
			return { outcome: "blocked", failure: safeText(error) };
		}
	}

	private async allocateWorkspace(
		allocation: WorkspaceAllocationIntent,
		requestId: ExecuteRequest["id"],
		task: TaskRequest,
		attempt: TaskAttempt,
		context: OperationContext,
	): Promise<WorkspaceAllocationResult> {
		assertWorkspaceIntent(allocation, requestId, task, attempt);
		await this.assertRepositoryIdentity(allocation, context);
		const args = ["worktree", "open", "--cwd", allocation.herdrRepoRoot, "--path", allocation.worktreeCwd, "--label", allocation.label, "--no-focus"];
		const response = await this.herdr.exec(args, this.processOptions(allocation.herdrRepoRoot, context, HERDR_OPERATION_CAP_MS));
		if (response.code !== 0 || response.killed) {
			return { kind: "workspace", outcome: "unknown", failure: safeText(herdrCommandFailure(args, response)), possibleResources: [allocation.label] };
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
			if (workspace.label !== allocation.label || workspace.focused !== false || tab.workspace_id !== workspaceId
				|| tab.focused !== false || pane.workspace_id !== workspaceId || pane.tab_id !== tabId || pane.focused !== false
				|| worktree.path !== allocation.worktreeCwd || workspaceWorktree.checkout_path !== allocation.worktreeCwd
				|| workspaceWorktree.repo_key !== allocation.repoKey || workspaceWorktree.repo_root !== allocation.herdrRepoRoot) {
				throw new Error("Herdr worktree open response does not prove the exact non-focused checkout and repository.");
			}
			return { kind: "workspace", outcome: "owned", workspaceId, rootTabId: tabId, rootPaneId };
		} catch (error) {
			return { kind: "workspace", outcome: "unknown", failure: safeText(error), possibleResources: [allocation.label] };
		}
	}

	private async allocateWorkerTab(
		allocation: WorkerTabAllocationIntent,
		task: TaskRequest,
		attempt: TaskAttempt,
		context: OperationContext,
	): Promise<WorkerTabAllocationResult> {
		assertWorkerTabIntent(allocation, task, attempt);
		await this.createPrivateLease(allocation.leasePath, allocation.token);
		await this.waitForStableWorkspacePanes(allocation.workspaceId, allocation.worktreeCwd, context);
		const args = [
			"tab", "create", "--workspace", allocation.workspaceId, "--cwd", allocation.worktreeCwd,
			"--label", allocation.label, "--env", `${PROCESS_LEASE_ENV}=${allocation.leasePath}`, "--no-focus",
		];
		const response = await this.herdr.exec(args, this.processOptions(allocation.worktreeCwd, context, HERDR_OPERATION_CAP_MS));
		if (response.code !== 0 || response.killed) {
			return { kind: "worker_tab", outcome: "unknown", failure: safeText(herdrCommandFailure(args, response)), possibleResources: [allocation.label, allocation.leasePath] };
		}
		try {
			const result = resultRecord(parseJsonObject(response.stdout, "Herdr tab create response"), "Herdr tab create response");
			if (result.type !== "tab_created") throw new Error("Herdr tab create response has the wrong type.");
			const tab = record(result.tab, "Herdr created tab");
			const pane = record(result.root_pane, "Herdr created tab root pane");
			const tabId = exactString(tab.tab_id, "created tab_id");
			const paneId = exactString(pane.pane_id, "created root pane_id");
			if (tabId === allocation.workspaceRootTabId || paneId === allocation.workspaceRootPaneId
				|| tab.workspace_id !== allocation.workspaceId || tab.label !== allocation.label || tab.focused !== false || tab.pane_count !== 1
				|| pane.workspace_id !== allocation.workspaceId || pane.tab_id !== tabId || pane.cwd !== allocation.worktreeCwd || pane.focused !== false) {
				throw new Error("Herdr tab create response does not prove one exact non-focused worker pane distinct from the workspace root.");
			}
			return { kind: "worker_tab", outcome: "owned", tabId, paneId };
		} catch (error) {
			return { kind: "worker_tab", outcome: "unknown", failure: safeText(error), possibleResources: [allocation.label, allocation.leasePath] };
		}
	}

	private async allocateAgent(
		allocation: AgentAllocationIntent,
		expectedRole: TaskRequest["role"],
		attempt: TaskAttempt,
		acquireLaunch: (() => Promise<TransientLaunchHandle<VerifiedLaunch>>) | undefined,
		context: OperationContext,
	): Promise<AgentAllocationResult> {
		assertAgentIntent(allocation, attempt);
		if (!acquireLaunch) throw new Error("Agent start requires immediate Role launch acquisition.");
		this.assertLeasePath(allocation.leasePath, allocation.token);
		await this.assertPrivateLease(allocation.leasePath, false);
		if ((await this.scanLease(allocation.leasePath, allocation.worktreeCwd, context)).length) {
			throw new Error("Agent start requires an empty exact process lease.");
		}
		await this.assertStartableAgentPane(allocation, context, { requireExclusiveTty: false });
		const options = this.processOptions(allocation.worktreeCwd, context, HERDR_OPERATION_CAP_MS);
		const handle = await acquireLaunch();
		return await withTransientLaunch(handle, async (launch) => {
			if (launch.role !== expectedRole) throw new Error("Agent start acquisition returned the wrong Role.");
			if (Object.keys(launch.env).length) throw new Error("Herdr agent launch must not receive caller Role environment variables.");
			const response = await startPiAgent(this.herdr, {
				name: allocation.agentName,
				pane: allocation.paneId,
				args: launch.args,
				options,
				shouldRetry: () => false,
			});
			if (response.code !== 0 || response.killed) {
				const failure = safeText(herdrCommandFailure(["agent", "start"], response));
				return hasHerdrErrorCode(response, "agent_pane_busy") && !response.killed
					? { kind: "agent", outcome: "absent", failure }
					: { kind: "agent", outcome: "unknown", failure, possibleResources: [allocation.agentName, allocation.paneId] };
			}
			try {
				const agent = parseAgent(parseJsonObject(response.stdout, "Herdr agent start response"), allocation, ["agent_started"]);
				if (!agent.interactiveReady || agent.status !== "idle") throw new Error("Started Herdr agent is not exactly ready and idle.");
				return { kind: "agent", outcome: "owned" };
			} catch (error) {
				return { kind: "agent", outcome: "unknown", failure: safeText(error), possibleResources: [allocation.agentName, allocation.paneId] };
			}
		});
	}

	private async reconcileDeliveredPrompt(
		input: { task: TaskRequest; attempt: TaskAttempt; preCandidate: WorkspaceIdentity },
		allocation: AgentAllocationIntent,
		context: OperationContext,
		promptMayBeInFlight = true,
	): Promise<WorkerResult> {
		for (;;) {
			let lifecycle;
			try {
				lifecycle = await this.waitForAgentLifecycle(allocation, context, true);
			} catch (error) {
				return {
					outcome: this.contextInterrupted(context) ? "interrupted" : "unknown",
					diagnostic: `Delivered prompt lifecycle is unknown: ${safeText(error)}`,
				};
			}

			if (lifecycle.status === "blocked") {
				return { outcome: "blocked", diagnostic: await this.diagnostic(allocation, context, "Delivered prompt settled as blocked.") };
			}
			if (lifecycle.status === "unknown") {
				return { outcome: "unknown", diagnostic: "Delivered prompt lifecycle is unknown." };
			}

			let inspection: InFlightTaskCandidateInspection;
			try {
				inspection = await this.inspectInFlightCandidate(
					{ root: allocation.worktreeCwd, task: input.task, attempt: input.attempt },
					this.childContext(context, GIT_INSPECTION_CAP_MS),
				);
			} catch (error) {
				return {
					outcome: this.contextInterrupted(context) ? "interrupted" : "unknown",
					diagnostic: `Delivered prompt candidate inspection failed: ${safeText(error)}`,
				};
			}
			if (this.contextInterrupted(context)) {
				return { outcome: "interrupted", diagnostic: "Delivered prompt reconciliation was interrupted." };
			}
			if (SETTLED_AGENT_STATES.has(lifecycle.status)
				&& inspection.valid
				&& inspection.clean
				&& this.isExpectedCandidate(input, inspection.candidate)) {
				return {
					outcome: "candidate",
					candidate: inspection.candidate,
					diagnostic: await this.diagnostic(allocation, context, "Delivered prompt settled with a candidate."),
				};
			}
			if (!promptMayBeInFlight && SETTLED_AGENT_STATES.has(lifecycle.status)) {
				return {
					outcome: "blocked",
					diagnostic: await this.diagnostic(allocation, context, "Settled worker did not produce an exact changed clean committed candidate."),
				};
			}

			try {
				await this.delay(STALLED_PROMPT_POLL_MS, context.signal);
			} catch (error) {
				return {
					outcome: this.contextInterrupted(context) ? "interrupted" : "unknown",
					diagnostic: `Delivered prompt polling failed: ${safeText(error)}`,
				};
			}
		}
	}

	private async candidateResult(
		input: { task: TaskRequest; attempt: TaskAttempt; preCandidate: WorkspaceIdentity },
		allocation: AgentAllocationIntent,
		context: OperationContext,
	): Promise<WorkerResult> {
		let inspection: InFlightTaskCandidateInspection;
		try {
			inspection = await this.inspectInFlightCandidate(
				{ root: allocation.worktreeCwd, task: input.task, attempt: input.attempt },
				this.childContext(context, GIT_INSPECTION_CAP_MS),
			);
		} catch (error) {
			return { outcome: "unknown", diagnostic: `Settled worker candidate inspection failed: ${safeText(error)}` };
		}
		if (!inspection.valid || !inspection.clean || !this.isExpectedCandidate(input, inspection.candidate)) {
			return await this.reconcileDeliveredPrompt(input, allocation, context, false);
		}
		return {
			outcome: "candidate",
			candidate: inspection.candidate,
			diagnostic: await this.diagnostic(allocation, context, "Worker settled with a candidate."),
		};
	}

	private isExpectedCandidate(
		input: { attempt: TaskAttempt; preCandidate: WorkspaceIdentity },
		candidate: WorkspaceIdentity,
	): boolean {
		const expectedBranch = `refs/heads/${worktreeIntent(input.attempt).branch}`;
		return isCleanCommitted(candidate) && candidate.branch === expectedBranch && candidate.head !== input.preCandidate.head;
	}

	private async waitForSettledAgent(allocation: AgentAllocationIntent, context: OperationContext): Promise<{ status: string; interactiveReady: boolean }> {
		return await this.waitForAgentLifecycle(allocation, context, false);
	}

	private async waitForAgentLifecycle(
		allocation: AgentAllocationIntent,
		context: OperationContext,
		includeWorking: boolean,
	): Promise<{ status: string; interactiveReady: boolean }> {
		const options = this.processOptions(allocation.worktreeCwd, context, HERDR_OPERATION_CAP_MS);
		const response = await this.herdr.json([
			"agent", "wait", allocation.agentName,
			"--until", "idle", "--until", "done", "--until", "blocked",
			...(includeWorking ? ["--until", "working"] : []),
			"--until", "unknown", "--timeout", String(options.timeoutMs),
		], options);
		return parseAgent(response, allocation, ["agent_info"]);
	}

	private async diagnostic(allocation: AgentAllocationIntent, context: OperationContext, prefix: string): Promise<string> {
		try {
			const response = await this.herdr.exec(
				["agent", "read", allocation.agentName, "--source", "recent", "--lines", "80", "--format", "text"],
				this.processOptions(allocation.worktreeCwd, context, HERDR_OPERATION_CAP_MS),
			);
			if (response.code === 0 && !response.killed && response.stdout.trim()) return `${prefix}\n${response.stdout.slice(0, DIAGNOSTIC_LIMIT)}`;
		} catch {
			// Terminal text is diagnostic only; lifecycle evidence remains authoritative.
		}
		return prefix;
	}

	private async assertStartableAgentPane(
		allocation: AgentAllocationIntent,
		context: OperationContext,
		options: { requireExclusiveTty: boolean },
	): Promise<void> {
		const paneResponse = await this.herdr.json(
			["pane", "get", allocation.paneId],
			this.processOptions(allocation.worktreeCwd, context, HERDR_OPERATION_CAP_MS),
		);
		const paneResult = resultRecord(paneResponse, "Herdr agent pane response");
		if (paneResult.type !== "pane_info") throw new Error("Herdr agent pane response has the wrong type.");
		const pane = record(paneResult.pane, "Herdr agent pane");
		if (exactString(pane.pane_id, "Herdr agent pane ID") !== allocation.paneId
			|| exactString(pane.tab_id, "Herdr agent pane tab ID") !== allocation.tabId
			|| exactString(pane.workspace_id, "Herdr agent pane workspace ID") !== allocation.workspaceId
			|| pane.cwd !== allocation.worktreeCwd || pane.foreground_cwd !== allocation.worktreeCwd
			|| (pane.agent !== undefined && pane.agent !== null) || pane.agent_status !== "unknown") {
			throw new Error("The exact saved agent pane is not empty and startable in its owned worktree.");
		}

		const processResponse = await this.herdr.json(
			["pane", "process-info", "--pane", allocation.paneId],
			this.processOptions(allocation.worktreeCwd, context, HERDR_OPERATION_CAP_MS),
		);
		const processResult = resultRecord(processResponse, "Herdr agent pane process-info response");
		if (processResult.type !== "pane_process_info") throw new Error("Herdr agent pane process-info response has the wrong type.");
		const processInfo = record(processResult.process_info, "Herdr agent pane process-info");
		const shellPid = processInfo.shell_pid;
		const foreground = processInfo.foreground_processes;
		if (exactString(processInfo.pane_id, "Herdr agent process pane ID") !== allocation.paneId
			|| !Number.isSafeInteger(shellPid) || Number(shellPid) <= 0
			|| processInfo.foreground_process_group_id !== shellPid
			|| !Array.isArray(foreground) || foreground.length !== 1) {
			throw new Error("The exact saved agent pane process state is not an idle foreground shell.");
		}
		const shell = record(foreground[0], "Herdr agent pane foreground process");
		if (shell.pid !== shellPid || shell.cwd !== allocation.worktreeCwd) {
			throw new Error("The exact saved agent pane foreground process is not its owned idle shell.");
		}
		exactString(shell.name, "Herdr agent pane shell name");
		if (!options.requireExclusiveTty) return;

		// Herdr's foreground list excludes background jobs, so recovery inventories every process on the shell's controlling TTY.
		const inventory = await this.execute(
			"ps",
			["-axo", "pid=,tty="],
			this.processOptions(allocation.worktreeCwd, context, PROCESS_INSPECTION_CAP_MS),
		);
		if (inventory.code !== 0 || inventory.killed || inventory.stderr.trim() || !inventory.stdout.trim()) {
			throw new Error("The exact saved agent pane process inventory failed or was ambiguous.");
		}
		const processes = inventory.stdout.trim().split(/\r?\n/).map((line) => {
			const match = /^\s*([1-9]\d*)\s+(\S+)\s*$/.exec(line);
			if (!match) throw new Error("The exact saved agent pane process inventory is malformed.");
			return { pid: Number(match[1]), tty: match[2]! };
		});
		if (processes.some(({ pid }) => !Number.isSafeInteger(pid)) || new Set(processes.map(({ pid }) => pid)).size !== processes.length) {
			throw new Error("The exact saved agent pane process inventory is malformed.");
		}
		const savedShell = processes.filter(({ pid }) => pid === shellPid);
		if (savedShell.length !== 1 || ["?", "??", "-"].includes(savedShell[0]!.tty)
			|| processes.filter(({ tty }) => tty === savedShell[0]!.tty).length !== 1) {
			throw new Error("The exact saved agent pane contains a process other than its owned idle shell.");
		}
	}

	private async createPrivateLease(path: string, token: string): Promise<void> {
		this.assertLeasePath(path, token);
		const directory = resolve(this.leaseDirectory, token);
		await mkdir(directory, { recursive: true, mode: DIRECTORY_MODE });
		await this.assertPrivateLeaseDirectories(path, false);
		let file;
		try {
			file = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, LEASE_MODE);
			await file.chmod(LEASE_MODE);
		} finally {
			await file?.close();
		}
		await this.assertPrivateLease(path, false);
	}

	private async removeLeaseArtifacts(
		allocation: WorkerTabAllocationIntent,
		token: string,
		paneId: string,
		tabId: string,
		context: OperationContext,
	): Promise<void> {
		this.assertLeasePath(allocation.leasePath, token);
		await this.assertPrivateLeaseDirectories(allocation.leasePath, true);
		const leaseWasPresent = await this.assertPrivateLease(allocation.leasePath, true);
		if ((await this.scanLease(allocation.leasePath, allocation.worktreeCwd, context, undefined, true)).length) {
			throw new Error("Exact process lease still has a holder during cleanup.");
		}
		await this.delay(50, context.signal);
		if ((await this.scanLease(allocation.leasePath, allocation.worktreeCwd, context, undefined, true)).length) {
			throw new Error("Exact process lease did not remain empty for two consecutive cleanup scans.");
		}
		if (!await this.paneAbsent(paneId, allocation.worktreeCwd, context)) {
			throw new Error("The exact saved worker pane reappeared before lease cleanup.");
		}
		if (await this.getTab(tabId, allocation.worktreeCwd, context)) {
			throw new Error("The exact saved worker tab reappeared before lease cleanup.");
		}
		const directoryPresent = await this.assertPrivateLeaseDirectories(allocation.leasePath, true);
		if (leaseWasPresent) {
			if (!directoryPresent) throw new Error("Exact process lease directory disappeared during cleanup.");
			await this.assertPrivateLease(allocation.leasePath, false);
			await unlink(allocation.leasePath);
		} else if (await this.assertPrivateLease(allocation.leasePath, true)) {
			throw new Error("Exact process lease appeared during cleanup.");
		}
		if (!directoryPresent) return;
		try {
			await rmdir(dirname(allocation.leasePath));
		} catch (error) {
			if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
		}
	}

	private async assertPrivateLeaseDirectories(path: string, allowMissing: boolean): Promise<boolean> {
		for (const checked of [this.leaseDirectory, dirname(path)]) {
			let info;
			try {
				info = await lstat(checked);
			} catch (error) {
				if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") return false;
				throw new Error(`Process lease directory cannot be inspected: ${checked}`, { cause: error });
			}
			const uid = process.getuid?.();
			if (info.isSymbolicLink() || !info.isDirectory() || (info.mode & 0o077) !== 0 || (uid !== undefined && info.uid !== uid)) {
				throw new Error(`Process lease directory must be a private current-user non-symlink directory: ${checked}`);
			}
		}
		return true;
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
		allocation: AgentAllocationIntent,
		signal: "SIGTERM" | "SIGKILL",
		context: OperationContext,
	): Promise<void> {
		for (const pid of holders) {
			context.signal.throwIfAborted();
			if (!(await this.scanLease(allocation.leasePath, allocation.worktreeCwd, context, pid)).includes(pid)) continue;
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

	private async waitForStableWorkspacePanes(workspaceId: string, cwd: string, context: OperationContext): Promise<void> {
		let previous: string | undefined;
		for (let poll = 0; poll < HOST_LAYOUT_MAX_POLLS; poll += 1) {
			const snapshot = (await this.listPanes(workspaceId, cwd, context)).map((pane) => {
				const paneId = exactString(pane.pane_id, "Herdr listed pane ID");
				const tabId = exactString(pane.tab_id, "Herdr listed pane tab ID");
				if (exactString(pane.workspace_id, "Herdr listed pane workspace ID") !== workspaceId) {
					throw new Error("Herdr pane list escaped the exact saved workspace scope.");
				}
				return `${tabId}\0${paneId}`;
			}).sort().join("\n");
			if (previous === snapshot) return;
			previous = snapshot;
			if (poll === HOST_LAYOUT_MAX_POLLS - 1) return;
			await this.delay(HOST_LAYOUT_POLL_MS, context.signal);
		}
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

	private async workspaceAbsent(workspaceId: string, allocation: WorkspaceAllocationIntent, context: OperationContext): Promise<boolean> {
		const response = await this.herdr.exec(
			["workspace", "get", workspaceId],
			this.processOptions(allocation.herdrRepoRoot, context, HERDR_OPERATION_CAP_MS),
		);
		if (response.code === 0 && !response.killed) {
			const workspace = parseWorkspaceInfo(parseJsonObject(response.stdout, "Herdr workspace get response"), workspaceId);
			this.assertWorkspaceEvidence(workspace, allocation);
			return false;
		}
		if (!response.killed && hasHerdrErrorCode(response, "workspace_not_found")) return true;
		throw new Error("Exact saved workspace presence is ambiguous.");
	}

	private assertWorkspaceEvidence(workspace: JsonRecord, allocation: WorkspaceAllocationIntent): void {
		const worktree = record(workspace.worktree, "Owned Herdr workspace worktree");
		if (exactString(workspace.label, "Owned Herdr workspace label") !== allocation.label
			|| exactString(worktree.checkout_path, "Owned Herdr workspace checkout_path") !== allocation.worktreeCwd
			|| exactString(worktree.repo_key, "Owned Herdr workspace repo_key") !== allocation.repoKey
			|| exactString(worktree.repo_root, "Owned Herdr workspace repo_root") !== allocation.herdrRepoRoot) {
			throw new Error("The exact saved workspace no longer matches its owned label, checkout, and repository.");
		}
	}

	private async repositoryIdentity(mainRoot: string, context: OperationContext): Promise<RepositoryIdentity> {
		const root = exactAbsolutePath(mainRoot, "Git common-directory probe root");
		const result = await this.execute(
			"git",
			["rev-parse", "--path-format=absolute", "--git-common-dir"],
			this.processOptions(root, context, GIT_INSPECTION_CAP_MS),
		);
		if (result.code !== 0 || result.killed) throw new Error("Git common-directory identity probe failed.");
		const output = result.stdout.replace(/\r?\n$/, "");
		if (!output || /[\r\n\0]/.test(output) || !isAbsolute(output)) {
			throw new Error("Git common-directory identity probe returned malformed output.");
		}
		const repoKey = await realpath(output);
		const repoKeyInfo = await lstat(repoKey);
		if (!repoKeyInfo.isDirectory() || basename(repoKey) !== ".git") {
			throw new Error("Git common-directory identity does not name a real .git directory.");
		}
		const herdrRepoRoot = dirname(repoKey);
		const resolvedRepoRoot = await realpath(herdrRepoRoot);
		const repoRootInfo = await lstat(resolvedRepoRoot);
		if (!isAbsolute(herdrRepoRoot) || resolvedRepoRoot !== herdrRepoRoot || !repoRootInfo.isDirectory()) {
			throw new Error("Git common-directory identity does not derive an absolute existing real primary repository root.");
		}
		return { repoKey, herdrRepoRoot };
	}

	private async assertRepositoryIdentity(allocation: WorkspaceAllocationIntent, context: OperationContext): Promise<void> {
		const identity = await this.repositoryIdentity(allocation.mainRoot, context);
		if (identity.repoKey !== allocation.repoKey || identity.herdrRepoRoot !== allocation.herdrRepoRoot) {
			throw new Error("Persisted workspace repository identity no longer matches Git.");
		}
	}

	private processOptions(cwd: string, context: OperationContext, cap = HERDR_OPERATION_CAP_MS): HostProcessOptions {
		context.signal.throwIfAborted();
		return { cwd, signal: context.signal, timeoutMs: this.callTimeout(context, cap) };
	}

	private childContext(context: OperationContext, cap: number): OperationContext {
		return { signal: context.signal, deadline: context.deadline, timeoutMs: this.callTimeout(context, cap) };
	}

	private callTimeout(context: OperationContext, cap: number): number {
		const remaining = Math.min(context.timeoutMs ?? cap, context.deadline === undefined ? cap : context.deadline - this.now(), cap);
		if (!Number.isFinite(remaining) || remaining <= 0) throw new Error("Operation deadline is exhausted.");
		return Math.max(1, Math.floor(remaining));
	}

	private contextInterrupted(context: OperationContext): boolean {
		return context.signal.aborted || (context.deadline !== undefined && context.deadline <= this.now());
	}
}
