import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { executionIssues, hashDeliveryGraph, parseDeliveryGraph } from "./graph.ts";
import {
	RUN_STATE_VERSION,
	RUN_TASK_STATUSES,
	type CleanupBlock,
	type DeliveryGraph,
	type HealthCheckEvidence,
	type GateCommandAmendment,
	type GateOutputEvidence,
	type HealthFastForwardIntent,
	type LocalIssue,
	type PrHealthState,
	type PullRequestIdentity,
	type RequiredGateEvidence,
	type RequiredGateInvalidation,
	type RunState,
	type RunTaskState,
	type RunWave,
	type SkillRegistryEntry,
	type WorkerEnvelope,
} from "./model.ts";
import { array, exactKeys, nonEmptyString, object, oneOf, positiveInteger, stringArray } from "./validate.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RUN_PHASES = ["execution", "blocked", "aborted", "completed"] as const;
const PR_HEALTH_STATUSES = ["triaging", "repairing", "reviewing", "applying", "pushing", "post_push_cleanup", "blocked", "completed"] as const;

const RUN_STATE_KEYS = [
	"version", "run_id", "graph_hash", "graph", "skill_registry", "source_commit", "integration_head", "main_worktree", "integration_branch", "default_branch", "created_at", "phase", "tasks", "resolutions", "gate_command_amendments", "main_pane", "workspace_id",
	"abort_reason", "block_reason", "wave", "cleanup_blocks", "pr", "health", "health_history", "health_fast_forward_intent", "accepted_events",
] as const;

const TASK_STRING_FIELDS = [
	"block_reason", "wave_base", "worktree", "branch", "tab_id",
	"implementer_provisioning_id", "implementer_pane", "implementer_agent",
	"reviewer_provisioning_id", "reviewer_pane", "reviewer_agent", "activity_started_at",
	"commit", "integration_intent", "review_command", "review_commit", "conflict_base",
	"final_gate_head", "repair_issue_id", "repair_base", "repair_commit",
] as const;
const TASK_BOOLEAN_FIELDS = [
	"implementer_instruction_pending", "reviewer_instruction_pending", "resolution_pending",
	"tab_cleanup_done", "worktree_cleanup_done", "branch_cleanup_done",
] as const;
const RUN_TASK_KEYS = [
	"status", "attempts", ...TASK_STRING_FIELDS, ...TASK_BOOLEAN_FIELDS,
	"review_rounds", "pending_action", "blocked_role", "review_exit_code", "review_stdout", "review_stderr", "required_gate_invalidations", "review_findings", "final_gate_findings", "repair_attempt",
] as const;

const HEALTH_STRING_FIELDS = [
	"summary", "worktree", "branch", "base", "commit", "integration_intent",
	"reviewer_tab_id", "reviewer_pane", "reviewer_agent", "coder_tab_id", "coder_pane", "coder_agent", "activity_started_at",
	"review_command", "review_commit",
] as const;
const PR_HEALTH_KEYS = [
	"status", "head", ...HEALTH_STRING_FIELDS, "actionable", "thread_ids", "checks", "resolved_thread_ids", "attempt", "review_round", "review_exit_code", "review_stdout", "review_stderr", "review_findings", "fixed_thread_ids", "blocked_role", "instruction_pending",
] as const;

export type Uuid = () => string;

export function stateRoot(mainWorktree: string): string {
	return join(resolve(mainWorktree), ".context", "pi-auto-dag");
}

export function runDirectory(mainWorktree: string, runId: string): string {
	assertRunId(runId);
	return join(stateRoot(mainWorktree), "runs", runId);
}

export function createInitialRunState(input: {
	run_id: string;
	graph: DeliveryGraph;
	skill_registry: SkillRegistryEntry[];
	source_commit: string;
	main_worktree: string;
	integration_branch: string;
	default_branch: string;
	created_at: string;
	main_pane: string;
	workspace_id: string;
}): RunState {
	assertRunId(input.run_id);
	const graph = parseDeliveryGraph(input.graph);
	const sourceCommit = nonEmptyString(input.source_commit, "source_commit");
	return {
		version: RUN_STATE_VERSION,
		run_id: input.run_id,
		graph_hash: hashDeliveryGraph(graph),
		graph,
		skill_registry: parseSkillRegistry(input.skill_registry, "skill_registry"),
		source_commit: sourceCommit,
		integration_head: sourceCommit,
		main_worktree: resolve(input.main_worktree),
		integration_branch: nonEmptyString(input.integration_branch, "integration_branch"),
		default_branch: nonEmptyString(input.default_branch, "default_branch"),
		created_at: nonEmptyString(input.created_at, "created_at"),
		phase: "execution",
		tasks: Object.fromEntries(executionIssues(graph).map((issue) => [issue.id, { status: "pending", attempts: 0 }])),
		resolutions: {},
		main_pane: nonEmptyString(input.main_pane, "main Herdr pane"),
		workspace_id: nonEmptyString(input.workspace_id, "Herdr workspace id"),
	};
}

/** The active lock is exclusive; it is deliberately not removed by a failed cleanup. */
export async function createRun(mainWorktree: string, state: RunState, uuid: Uuid = randomUUID): Promise<void> {
	const root = stateRoot(mainWorktree);
	await mkdir(join(root, "runs"), { recursive: true });
	if (!(await claimActiveRun(mainWorktree, state.run_id))) {
		throw new Error(`An active pi-auto-dag run already exists: ${state.run_id}`);
	}

	try {
		await mkdir(runDirectory(mainWorktree, state.run_id));
		await writeRunState(mainWorktree, state, uuid);
	} catch (error) {
		await unlink(join(root, "active.json")).catch(() => {});
		throw error;
	}
}

/** Claim the exclusive active lock; a retained run may re-enter when it already owns it. */
export async function claimActiveRun(mainWorktree: string, runId: string): Promise<boolean> {
	assertRunId(runId);
	const active = join(stateRoot(mainWorktree), "active.json");
	for (;;) {
		try {
			await writeFile(active, JSON.stringify({ run_id: runId }), { encoding: "utf8", flag: "wx", mode: 0o600 });
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const owner = await readActiveRunId(mainWorktree);
			if (owner === runId) return false;
			if (owner) throw new Error(`An active pi-auto-dag run already exists: ${owner}`);
		}
	}
}

/** `rename` replaces state.json atomically within its one run directory. */
export async function writeRunState(mainWorktree: string, state: RunState, uuid: Uuid = randomUUID): Promise<void> {
	const persisted = parseRunState(state);
	const directory = runDirectory(mainWorktree, persisted.run_id);
	const temporary = join(directory, `.state-${uuid()}.tmp`);
	const destination = join(directory, "state.json");
	await writeFile(temporary, `${JSON.stringify(persisted, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	await rename(temporary, destination);
}

export async function readRunState(mainWorktree: string, runId: string): Promise<RunState | undefined> {
	try {
		return parseRunState(JSON.parse(await readFile(join(runDirectory(mainWorktree, runId), "state.json"), "utf8")));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

export async function readActiveRunId(mainWorktree: string): Promise<string | undefined> {
	try {
		const value = object(JSON.parse(await readFile(join(stateRoot(mainWorktree), "active.json"), "utf8")), "active run lock");
		exactKeys(value, ["run_id"], "active run lock");
		const runId = nonEmptyString(value.run_id, "active run lock.run_id");
		assertRunId(runId);
		return runId;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

export async function readActiveRun(mainWorktree: string): Promise<RunState> {
	const runId = await readActiveRunId(mainWorktree);
	if (!runId) throw new Error("No active pi-auto-dag run");
	const state = await readRunState(mainWorktree, runId);
	if (!state) throw new Error(`Active pi-auto-dag run is missing state.json: ${runId}`);
	return state;
}

export function hasAcceptedWorkerEvent(state: RunState, envelope: WorkerEnvelope): boolean {
	const id = nonEmptyString(envelope.event_id, "worker event_id");
	if (!state.accepted_events || !Object.hasOwn(state.accepted_events, id)) return false;
	const accepted = state.accepted_events[id];
	if (accepted !== workerEnvelopeHash(envelope)) throw new Error(`Auto DAG event ${id} body changed after acceptance`);
	return true;
}

export function recordAcceptedWorkerEvent(state: RunState, envelope: WorkerEnvelope): RunState {
	const id = nonEmptyString(envelope.event_id, "worker event_id");
	return hasAcceptedWorkerEvent(state, envelope)
		? state
		: { ...state, accepted_events: { ...(state.accepted_events ?? {}), [id]: workerEnvelopeHash(envelope) } };
}

function workerEnvelopeHash(envelope: WorkerEnvelope): string {
	return createHash("sha256").update(JSON.stringify(envelope)).digest("hex");
}

/** Call only after all owned worker/worktree cleanup has succeeded. */
export async function releaseActiveRun(mainWorktree: string, runId: string): Promise<void> {
	const active = await readActiveRunId(mainWorktree);
	if (active !== runId) throw new Error(`Run ${runId} does not own the active lock`);
	await unlink(join(stateRoot(mainWorktree), "active.json"));
}

export function parseRunState(value: unknown): RunState {
	const input = object(value, "run state");
	knownKeys(input, RUN_STATE_KEYS, "run state");
	if (input.version !== RUN_STATE_VERSION) throw new Error(`Unsupported run state version: ${String(input.version)}`);
	const runId = nonEmptyString(input.run_id, "run state.run_id");
	assertRunId(runId);
	const graph = parseDeliveryGraph(input.graph);
	const graphHash = nonEmptyString(input.graph_hash, "run state.graph_hash");
	const sourceCommit = nonEmptyString(input.source_commit, "run state.source_commit");
	if (graphHash !== hashDeliveryGraph(graph)) throw new Error("Run state graph_hash does not match its graph");
	const state: RunState = {
		version: RUN_STATE_VERSION,
		run_id: runId,
		graph_hash: graphHash,
		graph,
		skill_registry: parseSkillRegistry(input.skill_registry, "run state.skill_registry"),
		source_commit: sourceCommit,
		integration_head: nonEmptyString(input.integration_head, "run state.integration_head"),
		main_worktree: resolve(nonEmptyString(input.main_worktree, "run state.main_worktree")),
		integration_branch: nonEmptyString(input.integration_branch, "run state.integration_branch"),
		default_branch: nonEmptyString(input.default_branch, "run state.default_branch"),
		created_at: nonEmptyString(input.created_at, "run state.created_at"),
		phase: oneOf(input.phase, RUN_PHASES, "run state.phase"),
		tasks: parseTasks(input.tasks, graph),
		resolutions: parseResolutions(input.resolutions, graph),
		main_pane: nonEmptyString(input.main_pane, "run state.main_pane"),
		workspace_id: nonEmptyString(input.workspace_id, "run state.workspace_id"),
	};
	if (input.gate_command_amendments !== undefined) {
		state.gate_command_amendments = parseGateCommandAmendments(input.gate_command_amendments, graph);
	}
	if (input.abort_reason !== undefined) state.abort_reason = nonEmptyString(input.abort_reason, "run state.abort_reason");
	if (input.block_reason !== undefined) state.block_reason = nonEmptyString(input.block_reason, "run state.block_reason");
	if (input.wave !== undefined) state.wave = parseRunWave(input.wave, "run state.wave");
	if (input.cleanup_blocks !== undefined) state.cleanup_blocks = parseCleanupBlocks(input.cleanup_blocks, "run state.cleanup_blocks");
	if (input.pr !== undefined) state.pr = parsePullRequestIdentity(input.pr, "run state.pr");
	if (input.health !== undefined) state.health = parsePrHealthState(input.health, "run state.health");
	if (input.health_history !== undefined) state.health_history = array(input.health_history, "run state.health_history")
		.map((entry, index) => parsePrHealthState(entry, `run state.health_history[${index}]`));
	if (input.health_fast_forward_intent !== undefined) {
		state.health_fast_forward_intent = parseHealthFastForwardIntent(input.health_fast_forward_intent, "run state.health_fast_forward_intent");
	}
	if (input.accepted_events !== undefined) state.accepted_events = parseAcceptedEvents(input.accepted_events);
	return state;
}

function parseSkillRegistry(value: unknown, label: string): SkillRegistryEntry[] {
	return array(value, label).map((entry, index) => {
		const entryLabel = `${label}[${index}]`;
		const input = object(entry, entryLabel);
		exactKeys(input, ["name", "file_path"], entryLabel);
		const filePath = nonEmptyString(input.file_path, `${entryLabel}.file_path`);
		if (!isAbsolute(filePath)) throw new Error(`${entryLabel}.file_path must be absolute`);
		return {
			name: nonEmptyString(input.name, `${entryLabel}.name`),
			file_path: filePath,
		};
	});
}

function parseAcceptedEvents(value: unknown): Record<string, string> {
	const input = object(value, "run state.accepted_events");
	return Object.fromEntries(Object.entries(input).map(([eventId, hash]) => {
		if (!/^[A-Za-z0-9_-]+$/.test(eventId)) throw new Error("run state.accepted_events has unsafe event ID");
		const digest = nonEmptyString(hash, `run state.accepted_events.${eventId}`);
		if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error(`run state.accepted_events.${eventId} must be a SHA-256 hash`);
		return [eventId, digest];
	}));
}

function parseTasks(value: unknown, graph: DeliveryGraph): Record<string, RunTaskState> {
	const input = object(value, "run state.tasks");
	const issueIds = executionIssues(graph).map((issue) => issue.id);
	exactKeys(input, issueIds, "run state.tasks");
	return Object.fromEntries(issueIds.map((issueId) => [issueId, parseRunTaskState(input[issueId], `run state.tasks.${issueId}`)]));
}

function parseResolutions(value: unknown, graph: DeliveryGraph): Record<string, string> {
	const input = object(value, "run state.resolutions");
	const issueIds = executionIssues(graph).map((issue) => issue.id);
	knownKeys(input, issueIds, "run state.resolutions");
	return Object.fromEntries(Object.entries(input).map(([issueId, resolution]) => [
		issueId,
		nonEmptyString(resolution, `run state.resolutions.${issueId}`),
	]));
}

function parseGateCommandAmendments(value: unknown, graph: DeliveryGraph): GateCommandAmendment[] {
	const commands = new Map(executionIssues(graph).map((issue) => [issue.id, issue.testing]));
	return array(value, "run state.gate_command_amendments").map((entry, index) => {
		const label = `run state.gate_command_amendments[${index}]`;
		const input = object(entry, label);
		exactKeys(input, ["issue_id", "previous_command", "replacement_command", "failed_commit", "reason", "approved_at"], label);
		const issueId = nonEmptyString(input.issue_id, `${label}.issue_id`);
		const previous = nonEmptyString(input.previous_command, `${label}.previous_command`);
		const replacement = nonEmptyString(input.replacement_command, `${label}.replacement_command`);
		const current = commands.get(issueId);
		if (current === undefined) throw new Error(`${label}.issue_id must name a Delivery Graph Local Issue`);
		if (previous !== current) throw new Error(`${label}.previous_command does not match prior Required Gate command`);
		if (replacement === previous) throw new Error(`${label}.replacement_command must change Required Gate command`);
		commands.set(issueId, replacement);
		return {
			issue_id: issueId,
			previous_command: previous,
			replacement_command: replacement,
			failed_commit: nonEmptyString(input.failed_commit, `${label}.failed_commit`),
			reason: nonEmptyString(input.reason, `${label}.reason`),
			approved_at: timestamp(input.approved_at, `${label}.approved_at`),
		};
	});
}

function parseRunTaskState(value: unknown, label: string): RunTaskState {
	const input = object(value, label);
	knownKeys(input, RUN_TASK_KEYS, label);
	const task: RunTaskState = {
		status: oneOf(input.status, RUN_TASK_STATUSES, `${label}.status`),
		attempts: nonNegativeInteger(input.attempts, `${label}.attempts`),
	};
	if (input.block_reason !== undefined) task.block_reason = nonEmptyString(input.block_reason, `${label}.block_reason`);
	if (input.wave_base !== undefined) task.wave_base = nonEmptyString(input.wave_base, `${label}.wave_base`);
	if (input.worktree !== undefined) task.worktree = nonEmptyString(input.worktree, `${label}.worktree`);
	if (input.branch !== undefined) task.branch = nonEmptyString(input.branch, `${label}.branch`);
	if (input.tab_id !== undefined) task.tab_id = nonEmptyString(input.tab_id, `${label}.tab_id`);
	if (input.implementer_provisioning_id !== undefined) task.implementer_provisioning_id = nonEmptyString(input.implementer_provisioning_id, `${label}.implementer_provisioning_id`);
	if (input.implementer_pane !== undefined) task.implementer_pane = nonEmptyString(input.implementer_pane, `${label}.implementer_pane`);
	if (input.implementer_agent !== undefined) task.implementer_agent = nonEmptyString(input.implementer_agent, `${label}.implementer_agent`);
	if (input.reviewer_provisioning_id !== undefined) task.reviewer_provisioning_id = nonEmptyString(input.reviewer_provisioning_id, `${label}.reviewer_provisioning_id`);
	if (input.reviewer_pane !== undefined) task.reviewer_pane = nonEmptyString(input.reviewer_pane, `${label}.reviewer_pane`);
	if (input.reviewer_agent !== undefined) task.reviewer_agent = nonEmptyString(input.reviewer_agent, `${label}.reviewer_agent`);
	if (input.activity_started_at !== undefined) task.activity_started_at = timestamp(input.activity_started_at, `${label}.activity_started_at`);
	if (input.commit !== undefined) task.commit = nonEmptyString(input.commit, `${label}.commit`);
	if (input.integration_intent !== undefined) task.integration_intent = nonEmptyString(input.integration_intent, `${label}.integration_intent`);
	if (input.review_command !== undefined) task.review_command = nonEmptyString(input.review_command, `${label}.review_command`);
	if (input.review_commit !== undefined) task.review_commit = nonEmptyString(input.review_commit, `${label}.review_commit`);
	if (input.review_stdout !== undefined) task.review_stdout = parseGateOutputEvidence(input.review_stdout, `${label}.review_stdout`);
	if (input.review_stderr !== undefined) task.review_stderr = parseGateOutputEvidence(input.review_stderr, `${label}.review_stderr`);
	if (input.required_gate_invalidations !== undefined) {
		task.required_gate_invalidations = array(input.required_gate_invalidations, `${label}.required_gate_invalidations`)
			.map((entry, index) => parseRequiredGateInvalidation(entry, `${label}.required_gate_invalidations[${index}]`));
	}
	if (input.conflict_base !== undefined) task.conflict_base = nonEmptyString(input.conflict_base, `${label}.conflict_base`);
	if (input.final_gate_head !== undefined) task.final_gate_head = nonEmptyString(input.final_gate_head, `${label}.final_gate_head`);
	if (input.repair_issue_id !== undefined) task.repair_issue_id = nonEmptyString(input.repair_issue_id, `${label}.repair_issue_id`);
	if (input.repair_base !== undefined) task.repair_base = nonEmptyString(input.repair_base, `${label}.repair_base`);
	if (input.repair_commit !== undefined) task.repair_commit = nonEmptyString(input.repair_commit, `${label}.repair_commit`);
	if (input.implementer_instruction_pending !== undefined) task.implementer_instruction_pending = boolean(input.implementer_instruction_pending, `${label}.implementer_instruction_pending`);
	if (input.reviewer_instruction_pending !== undefined) task.reviewer_instruction_pending = boolean(input.reviewer_instruction_pending, `${label}.reviewer_instruction_pending`);
	if (input.resolution_pending !== undefined) task.resolution_pending = boolean(input.resolution_pending, `${label}.resolution_pending`);
	if (input.tab_cleanup_done !== undefined) task.tab_cleanup_done = boolean(input.tab_cleanup_done, `${label}.tab_cleanup_done`);
	if (input.worktree_cleanup_done !== undefined) task.worktree_cleanup_done = boolean(input.worktree_cleanup_done, `${label}.worktree_cleanup_done`);
	if (input.branch_cleanup_done !== undefined) task.branch_cleanup_done = boolean(input.branch_cleanup_done, `${label}.branch_cleanup_done`);
	if (input.review_rounds !== undefined) task.review_rounds = nonNegativeInteger(input.review_rounds, `${label}.review_rounds`);
	if (input.pending_action !== undefined) task.pending_action = oneOf(input.pending_action, ["initial", "revision", "replacement"] as const, `${label}.pending_action`);
	if (input.blocked_role !== undefined) task.blocked_role = oneOf(input.blocked_role, ["implementer", "reviewer"] as const, `${label}.blocked_role`);
	if (input.review_exit_code !== undefined) task.review_exit_code = nonNegativeInteger(input.review_exit_code, `${label}.review_exit_code`);
	if (input.review_findings !== undefined) task.review_findings = stringArray(input.review_findings, `${label}.review_findings`);
	if (input.final_gate_findings !== undefined) task.final_gate_findings = stringArray(input.final_gate_findings, `${label}.final_gate_findings`);
	if (input.repair_attempt !== undefined) task.repair_attempt = positiveInteger(input.repair_attempt, `${label}.repair_attempt`);
	return task;
}

function parseRunWave(value: unknown, label: string): RunWave {
	const input = object(value, label);
	exactKeys(input, ["base", "issue_ids"], label);
	return { base: nonEmptyString(input.base, `${label}.base`), issue_ids: stringArray(input.issue_ids, `${label}.issue_ids`) };
}

function parseCleanupBlocks(value: unknown, label: string): CleanupBlock[] {
	return array(value, label).map((entry, index) => {
		const blockLabel = `${label}[${index}]`;
		const input = object(entry, blockLabel);
		exactKeys(input, ["issue_id", "operation", "reason"], blockLabel);
		return {
			issue_id: nonEmptyString(input.issue_id, `${blockLabel}.issue_id`),
			operation: oneOf(input.operation, ["tab", "worktree", "branch"] as const, `${blockLabel}.operation`),
			reason: nonEmptyString(input.reason, `${blockLabel}.reason`),
		};
	});
}

function parsePullRequestIdentity(value: unknown, label: string): PullRequestIdentity {
	const input = object(value, label);
	exactKeys(input, ["number", "url", "head_ref", "base_ref", "head_oid"], label);
	return {
		number: positiveInteger(input.number, `${label}.number`),
		url: nonEmptyString(input.url, `${label}.url`),
		head_ref: nonEmptyString(input.head_ref, `${label}.head_ref`),
		base_ref: nonEmptyString(input.base_ref, `${label}.base_ref`),
		head_oid: nonEmptyString(input.head_oid, `${label}.head_oid`),
	};
}

function parsePrHealthState(value: unknown, label: string): PrHealthState {
	const input = object(value, label);
	knownKeys(input, PR_HEALTH_KEYS, label);
	const health: PrHealthState = {
		status: oneOf(input.status, PR_HEALTH_STATUSES, `${label}.status`),
		head: nonEmptyString(input.head, `${label}.head`),
	};
	if (input.summary !== undefined) health.summary = nonEmptyString(input.summary, `${label}.summary`);
	if (input.worktree !== undefined) health.worktree = nonEmptyString(input.worktree, `${label}.worktree`);
	if (input.branch !== undefined) health.branch = nonEmptyString(input.branch, `${label}.branch`);
	if (input.base !== undefined) health.base = nonEmptyString(input.base, `${label}.base`);
	if (input.commit !== undefined) health.commit = nonEmptyString(input.commit, `${label}.commit`);
	if (input.integration_intent !== undefined) health.integration_intent = nonEmptyString(input.integration_intent, `${label}.integration_intent`);
	if (input.reviewer_tab_id !== undefined) health.reviewer_tab_id = nonEmptyString(input.reviewer_tab_id, `${label}.reviewer_tab_id`);
	if (input.reviewer_pane !== undefined) health.reviewer_pane = nonEmptyString(input.reviewer_pane, `${label}.reviewer_pane`);
	if (input.reviewer_agent !== undefined) health.reviewer_agent = nonEmptyString(input.reviewer_agent, `${label}.reviewer_agent`);
	if (input.coder_tab_id !== undefined) health.coder_tab_id = nonEmptyString(input.coder_tab_id, `${label}.coder_tab_id`);
	if (input.coder_pane !== undefined) health.coder_pane = nonEmptyString(input.coder_pane, `${label}.coder_pane`);
	if (input.coder_agent !== undefined) health.coder_agent = nonEmptyString(input.coder_agent, `${label}.coder_agent`);
	if (input.activity_started_at !== undefined) health.activity_started_at = timestamp(input.activity_started_at, `${label}.activity_started_at`);
	if (input.actionable !== undefined) health.actionable = boolean(input.actionable, `${label}.actionable`);
	if (input.thread_ids !== undefined) health.thread_ids = stringArray(input.thread_ids, `${label}.thread_ids`);
	if (input.checks !== undefined) health.checks = array(input.checks, `${label}.checks`)
		.map((entry, index) => parseHealthCheckEvidence(entry, `${label}.checks[${index}]`));
	if (input.resolved_thread_ids !== undefined) health.resolved_thread_ids = stringArray(input.resolved_thread_ids, `${label}.resolved_thread_ids`);
	if (input.attempt !== undefined) health.attempt = positiveInteger(input.attempt, `${label}.attempt`);
	if (input.review_round !== undefined) health.review_round = nonNegativeInteger(input.review_round, `${label}.review_round`);
	if (input.review_command !== undefined) health.review_command = nonEmptyString(input.review_command, `${label}.review_command`);
	if (input.review_commit !== undefined) health.review_commit = nonEmptyString(input.review_commit, `${label}.review_commit`);
	if (input.review_exit_code !== undefined) health.review_exit_code = nonNegativeInteger(input.review_exit_code, `${label}.review_exit_code`);
	if (input.review_stdout !== undefined) health.review_stdout = parseGateOutputEvidence(input.review_stdout, `${label}.review_stdout`);
	if (input.review_stderr !== undefined) health.review_stderr = parseGateOutputEvidence(input.review_stderr, `${label}.review_stderr`);
	if (input.review_findings !== undefined) health.review_findings = stringArray(input.review_findings, `${label}.review_findings`);
	if (input.fixed_thread_ids !== undefined) health.fixed_thread_ids = stringArray(input.fixed_thread_ids, `${label}.fixed_thread_ids`);
	if (input.blocked_role !== undefined) health.blocked_role = oneOf(input.blocked_role, ["implementer", "reviewer"] as const, `${label}.blocked_role`);
	if (input.instruction_pending !== undefined) health.instruction_pending = boolean(input.instruction_pending, `${label}.instruction_pending`);
	return health;
}

function timestamp(value: unknown, label: string): string {
	const text = nonEmptyString(value, label);
	if (Number.isNaN(Date.parse(text))) throw new Error(`${label} must be a timestamp`);
	return text;
}

function parseRequiredGateInvalidation(value: unknown, label: string): RequiredGateInvalidation {
	const input = object(value, label);
	exactKeys(input, ["invalidated_at", "reason", "evidence"], label);
	const evidence = parseRequiredGateEvidence(input.evidence, `${label}.evidence`);
	if (evidence.exit_code === 0) throw new Error(`${label}.evidence.exit_code must be nonzero`);
	return {
		invalidated_at: timestamp(input.invalidated_at, `${label}.invalidated_at`),
		reason: nonEmptyString(input.reason, `${label}.reason`),
		evidence,
	};
}

function parseRequiredGateEvidence(value: unknown, label: string): RequiredGateEvidence {
	const input = object(value, label);
	exactKeys(input, ["command", "commit", "exit_code", "output"], label);
	const output = object(input.output, `${label}.output`);
	exactKeys(output, ["stdout", "stderr"], `${label}.output`);
	return {
		command: nonEmptyString(input.command, `${label}.command`),
		commit: nonEmptyString(input.commit, `${label}.commit`),
		exit_code: nonNegativeInteger(input.exit_code, `${label}.exit_code`),
		output: {
			stdout: parseGateOutputEvidence(output.stdout, `${label}.output.stdout`),
			stderr: parseGateOutputEvidence(output.stderr, `${label}.output.stderr`),
		},
	};
}

function parseGateOutputEvidence(value: unknown, label: string): GateOutputEvidence {
	const input = object(value, label);
	knownKeys(input, ["excerpt", "bytes", "truncated", "full_output"], label);
	const evidence: GateOutputEvidence = {
		excerpt: text(input.excerpt, `${label}.excerpt`),
		bytes: nonNegativeInteger(input.bytes, `${label}.bytes`),
		truncated: boolean(input.truncated, `${label}.truncated`),
	};
	if (input.full_output !== undefined) {
		const reference = object(input.full_output, `${label}.full_output`);
		exactKeys(reference, ["path", "sha256"], `${label}.full_output`);
		evidence.full_output = {
			path: nonEmptyString(reference.path, `${label}.full_output.path`),
			sha256: nonEmptyString(reference.sha256, `${label}.full_output.sha256`),
		};
	}
	if (evidence.truncated !== Boolean(evidence.full_output)) throw new Error(`${label}.truncated must match full_output`);
	return evidence;
}

function parseHealthCheckEvidence(value: unknown, label: string): HealthCheckEvidence {
	const input = object(value, label);
	knownKeys(input, ["name", "link", "output"], label);
	const check: HealthCheckEvidence = { name: nonEmptyString(input.name, `${label}.name`) };
	if (input.link !== undefined) check.link = nonEmptyString(input.link, `${label}.link`);
	if (input.output !== undefined) check.output = nonEmptyString(input.output, `${label}.output`);
	return check;
}

function parseHealthFastForwardIntent(value: unknown, label: string): HealthFastForwardIntent {
	const input = object(value, label);
	exactKeys(input, ["expected_head", "remote_head", "pr"], label);
	return {
		expected_head: nonEmptyString(input.expected_head, `${label}.expected_head`),
		remote_head: nonEmptyString(input.remote_head, `${label}.remote_head`),
		pr: parsePullRequestIdentity(input.pr, `${label}.pr`),
	};
}

function knownKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
	for (const key of Object.keys(value)) {
		if (!keys.includes(key)) throw new Error(`Unknown ${label} setting: ${key}`);
	}
}

function boolean(value: unknown, label: string): boolean {
	if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
	return value;
}

function text(value: unknown, label: string): string {
	if (typeof value !== "string") throw new Error(`${label} must be a string`);
	return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
		throw new Error(`${label} must be a non-negative integer`);
	}
	return value;
}

export function issueById(state: RunState, issueId: string): LocalIssue {
	const issue = executionIssues(state.graph).find((candidate) => candidate.id === issueId);
	if (!issue) throw new Error(`Run does not contain Local Issue: ${issueId}`);
	return issue;
}

export function task(state: RunState, issueId: string): RunTaskState {
	const value = state.tasks[issueId];
	if (!value) throw new Error(`Run Task is missing: ${issueId}`);
	return value;
}

export function replaceTask(state: RunState, issueId: string, next: RunTaskState): RunState {
	return { ...state, tasks: { ...state.tasks, [issueId]: next } };
}

function assertRunId(value: string): void {
	if (!UUID.test(value)) throw new Error(`Run ID must be a UUID: ${value}`);
}
