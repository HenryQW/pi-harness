import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { executionIssues, hashDeliveryGraph, parseDeliveryGraph } from "./graph.ts";
import {
	RUN_STATE_VERSION,
	RUN_TASK_STATUSES,
	type CleanupBlock,
	type DeliveryGraph,
	type GateCommandAmendment,
	type GateOutputEvidence,
	type BlockedNotificationPayload,
	type CompletedNotificationPayload,
	type LocalIssue,
	type PullRequestIdentity,
	type RequiredGateEvidence,
	type RequiredGateInvalidation,
	type RunNotification,
	type RunState,
	type RunTaskState,
	type RunWave,
	type WorkerEnvelope,
} from "./model.ts";
import { array, exactKeys, nonEmptyString, object, oneOf, positiveInteger, stringArray } from "./validate.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RUN_PHASES = ["execution", "blocked", "aborted", "completed"] as const;

const RUN_STATE_KEYS = [
	"version", "run_id", "graph_hash", "graph", "source_commit", "integration_head", "main_worktree", "integration_branch", "default_branch", "created_at", "phase", "tasks", "resolutions", "gate_command_amendments", "main_pane", "workspace_id",
	"abort_reason", "abort_cleanup_complete", "block_reason", "wave", "cleanup_blocks", "pr", "notifications", "current_notification_id", "accepted_events",
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
		notifications: [],
		main_pane: nonEmptyString(input.main_pane, "main Herdr pane"),
		workspace_id: nonEmptyString(input.workspace_id, "Herdr workspace id"),
	};
}

/** The active lock is exclusive; it is deliberately not removed by a failed cleanup. */
export async function createRun(mainWorktree: string, state: RunState, uuid: Uuid = randomUUID, afterClaim?: () => Promise<void>): Promise<void> {
	const root = stateRoot(mainWorktree);
	await mkdir(join(root, "runs"), { recursive: true });
	if (!(await claimActiveRun(mainWorktree, state.run_id))) {
		throw new Error(`An active pi-auto-dag run already exists: ${state.run_id}`);
	}

	try {
		await afterClaim?.();
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

/**
 * Record notification delivery beside state.json; `link` publishes the receipt exclusively, so concurrent
 * acknowledgements are idempotent and no process ever rewrites another's lifecycle snapshot to mark delivery.
 */
export async function acknowledgeRunNotification(mainWorktree: string, runId: string, eventId: string, deliveredAt: string, uuid: Uuid = randomUUID): Promise<void> {
	assertRunId(runId);
	if (!/^[A-Za-z0-9:._-]+$/.test(eventId)) throw new Error(`Unsafe run notification event ID: ${eventId}`);
	const directory = join(runDirectory(mainWorktree, runId), "delivered");
	await mkdir(directory, { recursive: true });
	const temporary = join(directory, `.receipt-${uuid()}.tmp`);
	await writeFile(temporary, `${JSON.stringify({ event_id: eventId, delivered_at: timestamp(deliveredAt, "run notification delivered_at") }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	try {
		await link(temporary, join(directory, `${eventId}.json`));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	} finally {
		await unlink(temporary).catch(() => {});
	}
}

async function readDeliveredAt(directory: string, eventId: string): Promise<string | undefined> {
	let raw: string;
	try {
		raw = await readFile(join(directory, `${eventId}.json`), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	const receipt = object(JSON.parse(raw), "run notification delivery receipt");
	exactKeys(receipt, ["event_id", "delivered_at"], "run notification delivery receipt");
	if (receipt.event_id !== eventId) throw new Error("run notification delivery receipt does not match its event ID");
	return timestamp(receipt.delivered_at, "run notification delivery receipt.delivered_at");
}

/** Delivery receipts are the cross-process authority for delivery; persisted `delivered_at` values stay untouched. */
async function mergeDeliveryReceipts(directory: string, state: RunState): Promise<RunState> {
	if (!state.notifications.some((notification) => !notification.delivered_at)) return state;
	const notifications = await Promise.all(state.notifications.map(async (notification) => {
		if (notification.delivered_at) return notification;
		const deliveredAt = await readDeliveredAt(directory, notification.event_id);
		return deliveredAt === undefined ? notification : { ...notification, delivered_at: deliveredAt };
	}));
	return { ...state, notifications };
}

/** `rename` replaces state.json atomically within its one run directory. */
export async function writeRunState(mainWorktree: string, state: RunState, uuid: Uuid = randomUUID): Promise<void> {
	const persisted = parseRunState(queueRunNotification(state));
	// Existing save helpers return their input object, so keep its durable outbox in sync.
	state.notifications = persisted.notifications;
	if (persisted.current_notification_id) state.current_notification_id = persisted.current_notification_id;
	else delete state.current_notification_id;
	const directory = runDirectory(mainWorktree, persisted.run_id);
	const temporary = join(directory, `.state-${uuid()}.tmp`);
	const destination = join(directory, "state.json");
	await writeFile(temporary, `${JSON.stringify(persisted, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	await rename(temporary, destination);
}

export async function readRunState(mainWorktree: string, runId: string): Promise<RunState | undefined> {
	let state: RunState;
	try {
		state = parseRunState(JSON.parse(await readFile(join(runDirectory(mainWorktree, runId), "state.json"), "utf8")));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	return await mergeDeliveryReceipts(join(runDirectory(mainWorktree, runId), "delivered"), state);
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
		notifications: parseRunNotifications(input.notifications, runId),
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
	if (input.abort_cleanup_complete !== undefined) {
		if (input.abort_cleanup_complete !== true || state.phase !== "aborted" || state.cleanup_blocks?.length) {
			throw new Error("run state.abort_cleanup_complete requires an aborted run without cleanup blocks");
		}
		state.abort_cleanup_complete = true;
	}
	if (input.pr !== undefined) state.pr = parsePullRequestIdentity(input.pr, "run state.pr");
	if (input.current_notification_id !== undefined) {
		const eventId = nonEmptyString(input.current_notification_id, "run state.current_notification_id");
		const notification = state.notifications.find((candidate) => candidate.event_id === eventId);
		if (!notification || notification.kind !== state.phase) throw new Error("run state.current_notification_id does not match its active notification phase");
		state.current_notification_id = eventId;
	}
	if (input.accepted_events !== undefined) state.accepted_events = parseAcceptedEvents(input.accepted_events);
	return state;
}

function parseRunNotifications(value: unknown, runId: string): RunNotification[] {
	const seen = new Set<string>();
	return array(value, "run state.notifications").map((entry, index) => {
		const label = `run state.notifications[${index}]`;
		const input = object(entry, label);
		knownKeys(input, ["event_id", "kind", "created_at", "payload", "delivered_at"], label);
		const kind = oneOf(input.kind, ["blocked", "completed"] as const, `${label}.kind`);
		const payload = kind === "blocked"
			? parseBlockedNotificationPayload(input.payload, `${label}.payload`)
			: parseCompletedNotificationPayload(input.payload, `${label}.payload`);
		const eventId = nonEmptyString(input.event_id, `${label}.event_id`);
		if (eventId !== runNotificationId(runId, kind, payload, index)) throw new Error(`${label}.event_id does not match its immutable payload`);
		if (seen.has(eventId)) throw new Error(`Duplicate run notification event ID: ${eventId}`);
		seen.add(eventId);
		const common = {
			event_id: eventId,
			created_at: timestamp(input.created_at, `${label}.created_at`),
			...(input.delivered_at === undefined ? {} : { delivered_at: timestamp(input.delivered_at, `${label}.delivered_at`) }),
		};
		return kind === "blocked"
			? { ...common, kind, payload: payload as BlockedNotificationPayload }
			: { ...common, kind, payload: payload as CompletedNotificationPayload };
	});
}

function parseBlockedNotificationPayload(value: unknown, label: string): BlockedNotificationPayload {
	const input = object(value, label);
	exactKeys(input, ["graph_id", "graph_hash", "integration_head", "block_reason", "blocked_tasks", "cleanup_blocks"], label);
	return {
		graph_id: nonEmptyString(input.graph_id, `${label}.graph_id`),
		graph_hash: sha256(input.graph_hash, `${label}.graph_hash`),
		integration_head: nonEmptyString(input.integration_head, `${label}.integration_head`),
		block_reason: nonEmptyString(input.block_reason, `${label}.block_reason`),
		blocked_tasks: array(input.blocked_tasks, `${label}.blocked_tasks`).map((entry, index) => {
			const taskLabel = `${label}.blocked_tasks[${index}]`;
			const task = object(entry, taskLabel);
			knownKeys(task, ["issue_id", "block_reason", "attempts", "review_rounds", "blocked_role"], taskLabel);
			return {
				issue_id: nonEmptyString(task.issue_id, `${taskLabel}.issue_id`),
				block_reason: nonEmptyString(task.block_reason, `${taskLabel}.block_reason`),
				attempts: nonNegativeInteger(task.attempts, `${taskLabel}.attempts`),
				...(task.review_rounds === undefined ? {} : { review_rounds: nonNegativeInteger(task.review_rounds, `${taskLabel}.review_rounds`) }),
				...(task.blocked_role === undefined ? {} : { blocked_role: oneOf(task.blocked_role, ["implementer", "reviewer"] as const, `${taskLabel}.blocked_role`) }),
			};
		}),
		cleanup_blocks: parseCleanupBlocks(input.cleanup_blocks, `${label}.cleanup_blocks`),
	};
}

function parseCompletedNotificationPayload(value: unknown, label: string): CompletedNotificationPayload {
	const input = object(value, label);
	exactKeys(input, ["graph_id", "graph_hash", "integration_head", "pr"], label);
	return {
		graph_id: nonEmptyString(input.graph_id, `${label}.graph_id`),
		graph_hash: sha256(input.graph_hash, `${label}.graph_hash`),
		integration_head: nonEmptyString(input.integration_head, `${label}.integration_head`),
		pr: parsePullRequestIdentity(input.pr, `${label}.pr`),
	};
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

function queueRunNotification(state: RunState): RunState {
	let kind: RunNotification["kind"];
	let payload: BlockedNotificationPayload | CompletedNotificationPayload;
	if (state.phase === "blocked") {
		kind = "blocked";
		payload = blockedNotificationPayload(state);
	} else if (state.phase === "completed" && runCleanupIsClear(state)) {
		kind = "completed";
		payload = completedNotificationPayload(state);
	} else {
		if (!state.current_notification_id) return state;
		const { current_notification_id: _currentNotificationId, ...inactive } = state;
		return inactive;
	}
	const current = state.notifications.find((notification) => notification.event_id === state.current_notification_id);
	if (current?.kind === kind && JSON.stringify(current.payload) === JSON.stringify(payload)) return state;
	const eventId = runNotificationId(state.run_id, kind, payload, state.notifications.length);
	const common = { event_id: eventId, created_at: new Date().toISOString() };
	const notification: RunNotification = kind === "blocked"
		? { ...common, kind, payload: payload as BlockedNotificationPayload }
		: { ...common, kind, payload: payload as CompletedNotificationPayload };
	return { ...state, current_notification_id: eventId, notifications: [...state.notifications, notification] };
}

function blockedNotificationPayload(state: RunState): BlockedNotificationPayload {
	return {
		graph_id: state.graph.id,
		graph_hash: state.graph_hash,
		integration_head: state.integration_head,
		block_reason: nonEmptyString(state.block_reason, "blocked run notification reason"),
		blocked_tasks: Object.entries(state.tasks)
			.filter(([, current]) => current.status === "blocked")
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([issueId, current]) => ({
				issue_id: issueId,
				block_reason: nonEmptyString(current.block_reason, `blocked Run Task ${issueId} reason`),
				attempts: current.attempts,
				...(current.review_rounds === undefined ? {} : { review_rounds: current.review_rounds }),
				...(current.blocked_role === undefined ? {} : { blocked_role: current.blocked_role }),
			})),
		cleanup_blocks: [...(state.cleanup_blocks ?? [])]
			.map((block) => ({ ...block }))
			.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
	};
}

function completedNotificationPayload(state: RunState): CompletedNotificationPayload {
	if (!state.pr) throw new Error("Completed run notification requires integration PR identity");
	return {
		graph_id: state.graph.id,
		graph_hash: state.graph_hash,
		integration_head: state.integration_head,
		pr: { ...state.pr },
	};
}

function runNotificationId(
	runId: string,
	kind: RunNotification["kind"],
	payload: BlockedNotificationPayload | CompletedNotificationPayload,
	sequence: number,
): string {
	const fingerprint = createHash("sha256").update(JSON.stringify({ sequence, payload })).digest("hex");
	return `auto-dag:${runId}:${kind}:${fingerprint}`;
}

export function notificationRunId(eventId: string): string {
	const value = nonEmptyString(eventId, "run notification event ID");
	const match = /^auto-dag:([^:]+):(blocked|completed):[a-f0-9]{64}$/.exec(value);
	if (!match) throw new Error(`Invalid run notification event ID: ${value}`);
	assertRunId(match[1]);
	return match[1];
}

export function runCleanupIsClear(state: RunState): boolean {
	if (state.cleanup_blocks?.length) return false;
	return Object.values(state.tasks).every((current) => {
		const tabOwned = current.tab_id || current.implementer_provisioning_id || current.reviewer_provisioning_id || current.implementer_pane || current.reviewer_pane;
		return current.status === "completed"
			&& (!tabOwned || current.tab_cleanup_done)
			&& (!current.worktree || current.worktree_cleanup_done)
			&& (!current.branch || current.branch_cleanup_done);
	});
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

function sha256(value: unknown, label: string): string {
	const digest = nonEmptyString(value, label);
	if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error(`${label} must be a SHA-256 hash`);
	return digest;
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
