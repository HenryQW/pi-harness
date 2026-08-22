import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
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
	type WorkerEnvelope,
} from "./model.ts";
import { array, exactKeys, nonEmptyString, object, oneOf, positiveInteger, stringArray } from "./validate.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RUN_PHASES = ["execution", "blocked", "aborted", "completed"] as const;
const PR_HEALTH_STATUSES = ["triaging", "repairing", "reviewing", "applying", "pushing", "post_push_cleanup", "blocked", "completed"] as const;

const RUN_STATE_KEYS = [
	"version", "run_id", "graph_hash", "graph", "source_commit", "integration_head", "main_worktree", "integration_branch", "default_branch", "created_at", "phase", "tasks", "resolutions", "gate_command_amendments", "main_pane", "workspace_id",
	"abort_reason", "block_reason", "wave", "cleanup_blocks", "pr", "health", "health_history", "health_fast_forward_intent", "accepted_events",
] as const;

/** Single source of truth for durable task fields: key lists, parse branches, and labels derive from this table. */
const TASK_OPTIONAL_FIELDS: Record<string, (value: unknown, label: string) => unknown> = {
	block_reason: nonEmptyString,
	wave_base: nonEmptyString,
	worktree: nonEmptyString,
	branch: nonEmptyString,
	tab_id: nonEmptyString,
	implementer_provisioning_id: nonEmptyString,
	implementer_pane: nonEmptyString,
	implementer_agent: nonEmptyString,
	reviewer_provisioning_id: nonEmptyString,
	reviewer_pane: nonEmptyString,
	reviewer_agent: nonEmptyString,
	activity_started_at: timestamp,
	commit: nonEmptyString,
	integration_intent: nonEmptyString,
	review_command: nonEmptyString,
	review_commit: nonEmptyString,
	review_stdout: parseGateOutputEvidence,
	review_stderr: parseGateOutputEvidence,
	required_gate_invalidations: (value, label) => array(value, label)
		.map((entry, index) => parseRequiredGateInvalidation(entry, `${label}[${index}]`)),
	conflict_base: nonEmptyString,
	final_gate_head: nonEmptyString,
	repair_issue_id: nonEmptyString,
	repair_base: nonEmptyString,
	repair_commit: nonEmptyString,
	implementer_instruction_pending: boolean,
	reviewer_instruction_pending: boolean,
	resolution_pending: boolean,
	tab_cleanup_done: boolean,
	worktree_cleanup_done: boolean,
	branch_cleanup_done: boolean,
	review_rounds: nonNegativeInteger,
	pending_action: (value, label) => oneOf(value, ["initial", "revision", "replacement"] as const, label),
	blocked_role: (value, label) => oneOf(value, ["implementer", "reviewer"] as const, label),
	review_exit_code: nonNegativeInteger,
	review_findings: stringArray,
	final_gate_findings: stringArray,
	repair_attempt: positiveInteger,
};
const RUN_TASK_KEYS = ["status", "attempts", ...Object.keys(TASK_OPTIONAL_FIELDS)];

/** Single source of truth for durable PR-health fields. */
const HEALTH_OPTIONAL_FIELDS: Record<string, (value: unknown, label: string) => unknown> = {
	summary: nonEmptyString,
	worktree: nonEmptyString,
	branch: nonEmptyString,
	base: nonEmptyString,
	commit: nonEmptyString,
	integration_intent: nonEmptyString,
	reviewer_tab_id: nonEmptyString,
	reviewer_pane: nonEmptyString,
	reviewer_agent: nonEmptyString,
	coder_tab_id: nonEmptyString,
	coder_pane: nonEmptyString,
	coder_agent: nonEmptyString,
	activity_started_at: timestamp,
	review_command: nonEmptyString,
	review_commit: nonEmptyString,
	actionable: boolean,
	thread_ids: stringArray,
	checks: (value, label) => array(value, label).map((entry, index) => parseHealthCheckEvidence(entry, `${label}[${index}]`)),
	resolved_thread_ids: stringArray,
	attempt: positiveInteger,
	review_round: nonNegativeInteger,
	review_exit_code: nonNegativeInteger,
	review_stdout: parseGateOutputEvidence,
	review_stderr: parseGateOutputEvidence,
	review_findings: stringArray,
	fixed_thread_ids: stringArray,
	blocked_role: (value, label) => oneOf(value, ["implementer", "reviewer"] as const, label),
	instruction_pending: boolean,
};
const PR_HEALTH_KEYS = ["status", "head", ...Object.keys(HEALTH_OPTIONAL_FIELDS)];

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
	const result: RunTaskState = {
		status: oneOf(input.status, RUN_TASK_STATUSES, `${label}.status`),
		attempts: nonNegativeInteger(input.attempts, `${label}.attempts`),
	};
	applyOptionalFields(result as unknown as Record<string, unknown>, input, TASK_OPTIONAL_FIELDS, label);
	return result;
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
	const result: PrHealthState = {
		status: oneOf(input.status, PR_HEALTH_STATUSES, `${label}.status`),
		head: nonEmptyString(input.head, `${label}.head`),
	};
	applyOptionalFields(result as unknown as Record<string, unknown>, input, HEALTH_OPTIONAL_FIELDS, label);
	return result;
}

function applyOptionalFields(
	target: Record<string, unknown>,
	input: Record<string, unknown>,
	fields: Record<string, (value: unknown, label: string) => unknown>,
	label: string,
): void {
	for (const [key, parse] of Object.entries(fields)) {
		if (input[key] !== undefined) target[key] = parse(input[key], `${label}.${key}`);
	}
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
