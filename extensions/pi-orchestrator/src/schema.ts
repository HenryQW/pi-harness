import { isDeepStrictEqual } from "node:util";
import { Type } from "typebox";
import { Check, Errors } from "typebox/value";

export const RUN_STATE_VERSION = 1;
export const MAX_TASKS = 8;
export const MAX_EXECUTE_REQUEST_BYTES = 256 * 1024;

export const MODEL_CLASSES = ["fast", "balanced", "frontier", "fav"] as const;
export type ModelClass = (typeof MODEL_CLASSES)[number];
export type Role = "implementer" | "reviewer";

const ID_PATTERN = "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$";
const OID_PATTERN = "^(?:[0-9a-f]{40}|[0-9a-f]{64})$";
const SHA256_PATTERN = "^[0-9a-f]{64}$";
const TOKEN_PATTERN = "^[A-Za-z0-9_-]{16,128}$";
const IdSchema = Type.String({ minLength: 1, maxLength: 80, pattern: ID_PATTERN });
const TextSchema = Type.String({ minLength: 1, maxLength: 32_000 });
const OptionalTextSchema = Type.Optional(Type.String({ maxLength: 32_000 }));
const TimestampSchema = Type.Integer({ minimum: 0 });
const ModelClassSchema = Type.Union(MODEL_CLASSES.map((value) => Type.Literal(value)));
const RoleSchema = Type.Union([Type.Literal("implementer"), Type.Literal("reviewer")]);

export const CheckCommandSchema = Type.Object({
	command: TextSchema,
	args: Type.Array(Type.String({ maxLength: 16_000 }), { maxItems: 128 }),
}, { additionalProperties: false });

export const JudgmentSchema = Type.Object({
	criterion: TextSchema,
	modelClass: ModelClassSchema,
}, { additionalProperties: false });

export const TaskRequestSchema = Type.Object({
	id: IdSchema,
	modelClass: ModelClassSchema,
	requirements: TextSchema,
	deliverable: TextSchema,
	dependsOn: Type.Array(IdSchema, { maxItems: MAX_TASKS }),
	checks: Type.Array(CheckCommandSchema, { minItems: 1, maxItems: 32 }),
	judgment: Type.Optional(JudgmentSchema),
}, { additionalProperties: false });

export const ExecuteRequestSchema = Type.Object({
	id: IdSchema,
	goal: TextSchema,
	budgetMs: Type.Integer({ minimum: 1_000, maximum: 2_147_483_647 }),
	tasks: Type.Array(TaskRequestSchema, { minItems: 1, maxItems: MAX_TASKS }),
	finalChecks: Type.Array(CheckCommandSchema, { minItems: 1, maxItems: 32 }),
	finalJudgment: Type.Optional(JudgmentSchema),
}, { additionalProperties: false });

export const ResumeRequestSchema = Type.Union([
	Type.Object({ id: IdSchema, action: Type.Literal("retry"), taskId: IdSchema }, { additionalProperties: false }),
	Type.Object({ id: IdSchema, action: Type.Literal("verify"), taskId: IdSchema }, { additionalProperties: false }),
	Type.Object({ id: IdSchema, action: Type.Literal("finalize") }, { additionalProperties: false }),
]);

export type CheckCommand = { command: string; args: string[] };
export type Judgment = { criterion: string; modelClass: ModelClass };
export type TaskRequest = {
	id: string;
	modelClass: ModelClass;
	requirements: string;
	deliverable: string;
	dependsOn: string[];
	checks: CheckCommand[];
	judgment?: Judgment;
};
export type ExecuteRequest = {
	id: string;
	goal: string;
	budgetMs: number;
	tasks: TaskRequest[];
	finalChecks: CheckCommand[];
	finalJudgment?: Judgment;
};
export type ResumeRequest =
	| { id: string; action: "retry"; taskId: string }
	| { id: string; action: "verify"; taskId: string }
	| { id: string; action: "finalize" };

export interface WorkspaceIdentity {
	branch: string;
	head: string;
	index: string;
	tree: string;
}

export interface LaunchRecord {
	key: string;
	role: Role;
	modelClass: ModelClass;
	fingerprint: string;
}

export type AllocationKind = "worktree" | "workspace" | "worker_tab" | "agent";
export type AllocationStatus = "allocating" | "owned" | "absent" | "unknown";

export interface AllocationIntent {
	kind: AllocationKind;
	generation: number;
	token: string;
	details: string;
	status: AllocationStatus;
	resourceId?: string;
	possibleResources?: string[];
	failure?: string;
}

export interface PromptRecord {
	kind: "initial" | "correction";
	status: "submitting" | "settled" | "ambiguous";
	preCandidate: WorkspaceIdentity;
	candidate?: WorkspaceIdentity;
	failure?: string;
	at: number;
}

export interface CommandEvidence extends CheckCommand {
	code: number;
	killed: boolean;
	stdout: string;
	stderr: string;
}

export interface CheckBatchEvidence {
	phase: "preliminary" | "authoritative" | "final";
	candidate: WorkspaceIdentity;
	identityAfter: WorkspaceIdentity;
	results: CommandEvidence[];
	passed: boolean;
	at: number;
}

export interface ReviewEvidence {
	phase: "preliminary" | "authoritative" | "final";
	launchKey: string;
	criterion: string;
	base: WorkspaceIdentity;
	tip: WorkspaceIdentity;
	identityAfter: WorkspaceIdentity;
	verdict: string;
	passed: boolean;
	at: number;
}

export interface WorkerTermination {
	status: "terminating" | "terminated" | "unknown";
	workerId: string;
	candidate: WorkspaceIdentity;
	at?: number;
	failure?: string;
}

export interface IntegrationRecord {
	status: "integrating" | "integrated" | "failed" | "unknown";
	expectedMain: WorkspaceIdentity;
	candidate: WorkspaceIdentity;
	mainAfter?: WorkspaceIdentity;
	failure?: string;
}

export const CLEANUP_KINDS = ["worker_tab", "workspace", "worktree", "branch"] as const;
export type CleanupKind = (typeof CLEANUP_KINDS)[number];
export interface CleanupStep {
	kind: CleanupKind;
	status: "pending" | "running" | "completed";
	failure?: string;
}

export interface TaskAttempt {
	number: number;
	waveNumber: number;
	waveBase: WorkspaceIdentity;
	correlationToken: string;
	allocationGeneration: number;
	allocations: AllocationIntent[];
	prompts: PromptRecord[];
	candidate?: WorkspaceIdentity;
	preliminaryChecks?: CheckBatchEvidence;
	preliminaryReview?: ReviewEvidence;
	termination?: WorkerTermination;
	integrationBase?: WorkspaceIdentity;
	integrationCandidate?: WorkspaceIdentity;
	authoritativeChecks?: CheckBatchEvidence;
	authoritativeReview?: ReviewEvidence;
	integration?: IntegrationRecord;
	cleanup: CleanupStep[];
}

export type TaskStatus =
	| "pending"
	| "allocating"
	| "working"
	| "ready_to_integrate"
	| "integrating"
	| "cleanup"
	| "completed"
	| "needs_attention";

export interface TaskState {
	taskId: string;
	status: TaskStatus;
	implementerLaunchKey: string;
	judgmentLaunchKey?: string;
	attempts: TaskAttempt[];
	failure?: string;
}

export interface WaveState {
	number: number;
	base: WorkspaceIdentity;
	taskIds: string[];
	status: "dispatching" | "integrating" | "completed" | "needs_attention";
}

export interface FinalGateState {
	status: "pending" | "running" | "interrupted" | "passed" | "final_failed" | "superseded";
	identity?: WorkspaceIdentity;
	checks?: CheckBatchEvidence;
	review?: ReviewEvidence;
	failure?: string;
}

export type RequestStatus = "pending" | "running" | "needs_attention" | "completed" | "final_failed" | "superseded" | "aborted";

export interface CleanupRecovery {
	kind: "cleanup_only";
	taskId: string;
	deadline: number;
}

export interface RunState {
	version: typeof RUN_STATE_VERSION;
	request: ExecuteRequest;
	root: string;
	requestStartMain: WorkspaceIdentity;
	main: WorkspaceIdentity;
	deadlineStartedAt: number;
	deadline: number;
	launchRecords: Record<string, LaunchRecord>;
	status: RequestStatus;
	tasks: TaskState[];
	waves: WaveState[];
	final: FinalGateState;
	recovery?: CleanupRecovery;
	accepted: boolean;
	acceptedAt?: number;
	createdAt: number;
	updatedAt: number;
}

const WorkspaceSchema = Type.Object({
	branch: TextSchema,
	head: Type.String({ pattern: OID_PATTERN }),
	index: Type.String({ pattern: OID_PATTERN }),
	tree: Type.String({ pattern: OID_PATTERN }),
}, { additionalProperties: false });

const LaunchRecordSchema = Type.Object({
	key: TextSchema,
	role: RoleSchema,
	modelClass: ModelClassSchema,
	fingerprint: Type.String({ pattern: SHA256_PATTERN }),
}, { additionalProperties: false });

const AllocationIntentSchema = Type.Object({
	kind: Type.Union([Type.Literal("worktree"), Type.Literal("workspace"), Type.Literal("worker_tab"), Type.Literal("agent")]),
	generation: Type.Integer({ minimum: 1, maximum: 2 }),
	token: Type.String({ pattern: TOKEN_PATTERN }),
	details: TextSchema,
	status: Type.Union([Type.Literal("allocating"), Type.Literal("owned"), Type.Literal("absent"), Type.Literal("unknown")]),
	resourceId: Type.Optional(TextSchema),
	possibleResources: Type.Optional(Type.Array(TextSchema, { maxItems: 32 })),
	failure: OptionalTextSchema,
}, { additionalProperties: false });

const PromptRecordSchema = Type.Object({
	kind: Type.Union([Type.Literal("initial"), Type.Literal("correction")]),
	status: Type.Union([Type.Literal("submitting"), Type.Literal("settled"), Type.Literal("ambiguous")]),
	preCandidate: WorkspaceSchema,
	candidate: Type.Optional(WorkspaceSchema),
	failure: OptionalTextSchema,
	at: TimestampSchema,
}, { additionalProperties: false });

const CommandEvidenceSchema = Type.Object({
	command: TextSchema,
	args: Type.Array(Type.String({ maxLength: 16_000 }), { maxItems: 128 }),
	code: Type.Integer(),
	killed: Type.Boolean(),
	stdout: Type.String({ maxLength: 32_000 }),
	stderr: Type.String({ maxLength: 32_000 }),
}, { additionalProperties: false });

const CheckBatchEvidenceSchema = Type.Object({
	phase: Type.Union([Type.Literal("preliminary"), Type.Literal("authoritative"), Type.Literal("final")]),
	candidate: WorkspaceSchema,
	identityAfter: WorkspaceSchema,
	results: Type.Array(CommandEvidenceSchema, { maxItems: 32 }),
	passed: Type.Boolean(),
	at: TimestampSchema,
}, { additionalProperties: false });

const ReviewEvidenceSchema = Type.Object({
	phase: Type.Union([Type.Literal("preliminary"), Type.Literal("authoritative"), Type.Literal("final")]),
	launchKey: TextSchema,
	criterion: TextSchema,
	base: WorkspaceSchema,
	tip: WorkspaceSchema,
	identityAfter: WorkspaceSchema,
	verdict: Type.String({ maxLength: 32_000 }),
	passed: Type.Boolean(),
	at: TimestampSchema,
}, { additionalProperties: false });

const WorkerTerminationSchema = Type.Object({
	status: Type.Union([Type.Literal("terminating"), Type.Literal("terminated"), Type.Literal("unknown")]),
	workerId: TextSchema,
	candidate: WorkspaceSchema,
	at: Type.Optional(TimestampSchema),
	failure: OptionalTextSchema,
}, { additionalProperties: false });

const IntegrationRecordSchema = Type.Object({
	status: Type.Union([Type.Literal("integrating"), Type.Literal("integrated"), Type.Literal("failed"), Type.Literal("unknown")]),
	expectedMain: WorkspaceSchema,
	candidate: WorkspaceSchema,
	mainAfter: Type.Optional(WorkspaceSchema),
	failure: OptionalTextSchema,
}, { additionalProperties: false });

const CleanupStepSchema = Type.Object({
	kind: Type.Union(CLEANUP_KINDS.map((kind) => Type.Literal(kind))),
	status: Type.Union([Type.Literal("pending"), Type.Literal("running"), Type.Literal("completed")]),
	failure: OptionalTextSchema,
}, { additionalProperties: false });

const TaskAttemptSchema = Type.Object({
	number: Type.Integer({ minimum: 1, maximum: 2 }),
	waveNumber: Type.Integer({ minimum: 1 }),
	waveBase: WorkspaceSchema,
	correlationToken: Type.String({ pattern: TOKEN_PATTERN }),
	allocationGeneration: Type.Integer({ minimum: 1, maximum: 2 }),
	allocations: Type.Array(AllocationIntentSchema, { maxItems: 8 }),
	prompts: Type.Array(PromptRecordSchema, { maxItems: 2 }),
	candidate: Type.Optional(WorkspaceSchema),
	preliminaryChecks: Type.Optional(CheckBatchEvidenceSchema),
	preliminaryReview: Type.Optional(ReviewEvidenceSchema),
	termination: Type.Optional(WorkerTerminationSchema),
	integrationBase: Type.Optional(WorkspaceSchema),
	integrationCandidate: Type.Optional(WorkspaceSchema),
	authoritativeChecks: Type.Optional(CheckBatchEvidenceSchema),
	authoritativeReview: Type.Optional(ReviewEvidenceSchema),
	integration: Type.Optional(IntegrationRecordSchema),
	cleanup: Type.Array(CleanupStepSchema, { minItems: CLEANUP_KINDS.length, maxItems: CLEANUP_KINDS.length }),
}, { additionalProperties: false });

const TaskStateSchema = Type.Object({
	taskId: IdSchema,
	status: Type.Union([
		Type.Literal("pending"), Type.Literal("allocating"), Type.Literal("working"), Type.Literal("ready_to_integrate"),
		Type.Literal("integrating"), Type.Literal("cleanup"), Type.Literal("completed"), Type.Literal("needs_attention"),
	]),
	implementerLaunchKey: TextSchema,
	judgmentLaunchKey: Type.Optional(TextSchema),
	attempts: Type.Array(TaskAttemptSchema, { maxItems: 2 }),
	failure: OptionalTextSchema,
}, { additionalProperties: false });

const WaveStateSchema = Type.Object({
	number: Type.Integer({ minimum: 1 }),
	base: WorkspaceSchema,
	taskIds: Type.Array(IdSchema, { minItems: 1, maxItems: MAX_TASKS }),
	status: Type.Union([Type.Literal("dispatching"), Type.Literal("integrating"), Type.Literal("completed"), Type.Literal("needs_attention")]),
}, { additionalProperties: false });

const FinalGateSchema = Type.Object({
	status: Type.Union([
		Type.Literal("pending"), Type.Literal("running"), Type.Literal("interrupted"), Type.Literal("passed"),
		Type.Literal("final_failed"), Type.Literal("superseded"),
	]),
	identity: Type.Optional(WorkspaceSchema),
	checks: Type.Optional(CheckBatchEvidenceSchema),
	review: Type.Optional(ReviewEvidenceSchema),
	failure: OptionalTextSchema,
}, { additionalProperties: false });

const RunStateSchema = Type.Object({
	version: Type.Literal(RUN_STATE_VERSION),
	request: ExecuteRequestSchema,
	root: TextSchema,
	requestStartMain: WorkspaceSchema,
	main: WorkspaceSchema,
	deadlineStartedAt: TimestampSchema,
	deadline: TimestampSchema,
	launchRecords: Type.Record(Type.String(), LaunchRecordSchema),
	status: Type.Union([
		Type.Literal("pending"), Type.Literal("running"), Type.Literal("needs_attention"), Type.Literal("completed"),
		Type.Literal("final_failed"), Type.Literal("superseded"), Type.Literal("aborted"),
	]),
	tasks: Type.Array(TaskStateSchema, { minItems: 1, maxItems: MAX_TASKS }),
	waves: Type.Array(WaveStateSchema, { maxItems: MAX_TASKS }),
	final: FinalGateSchema,
	recovery: Type.Optional(Type.Object({
		kind: Type.Literal("cleanup_only"),
		taskId: IdSchema,
		deadline: TimestampSchema,
	}, { additionalProperties: false })),
	accepted: Type.Boolean(),
	acceptedAt: Type.Optional(TimestampSchema),
	createdAt: TimestampSchema,
	updatedAt: TimestampSchema,
}, { additionalProperties: false });

function normalizeCheck(check: CheckCommand, field: string): CheckCommand {
	return {
		command: normalizeText(check.command, `${field}.command`),
		args: check.args.map((arg, index) => {
			if (arg.includes("\0")) throw new Error(`${field}.args[${index}] must not contain NUL bytes.`);
			return arg;
		}),
	};
}

function normalizeText(value: string, field: string): string {
	const normalized = value.trim();
	if (!normalized || value.includes("\0")) throw new Error(`${field} must be non-empty text without NUL bytes.`);
	return normalized;
}

function normalizeJudgment(judgment: Judgment | undefined, field: string): Judgment | undefined {
	if (!judgment) return;
	return { ...judgment, criterion: normalizeText(judgment.criterion, `${field}.criterion`) };
}

function normalizeTask(task: TaskRequest, index: number): TaskRequest {
	return {
		...task,
		requirements: normalizeText(task.requirements, `tasks[${index}].requirements`),
		deliverable: normalizeText(task.deliverable, `tasks[${index}].deliverable`),
		dependsOn: [...task.dependsOn],
		checks: task.checks.map((check, checkIndex) => normalizeCheck(check, `tasks[${index}].checks[${checkIndex}]`)),
		...(task.judgment ? { judgment: normalizeJudgment(task.judgment, `tasks[${index}].judgment`)! } : {}),
	};
}

export function validateGraph(tasks: readonly TaskRequest[]): void {
	const byId = new Map<string, TaskRequest>();
	for (const task of tasks) {
		if (byId.has(task.id)) throw new Error(`Duplicate task ID: ${task.id}.`);
		byId.set(task.id, task);
		const dependencies = new Set<string>();
		for (const dependency of task.dependsOn) {
			if (dependency === task.id) throw new Error(`Task ${task.id} cannot depend on itself.`);
			if (dependencies.has(dependency)) throw new Error(`Task ${task.id} has duplicate dependency ${dependency}.`);
			dependencies.add(dependency);
		}
	}
	for (const task of tasks) {
		for (const dependency of task.dependsOn) {
			if (!byId.has(dependency)) throw new Error(`Task ${task.id} has unknown dependency ${dependency}.`);
		}
	}
	const visiting = new Set<string>();
	const visited = new Set<string>();
	const visit = (id: string): void => {
		if (visiting.has(id)) throw new Error(`Task dependency cycle includes ${id}.`);
		if (visited.has(id)) return;
		visiting.add(id);
		for (const dependency of byId.get(id)!.dependsOn) visit(dependency);
		visiting.delete(id);
		visited.add(id);
	};
	for (const task of tasks) visit(task.id);
}

export function parseExecuteRequest(value: unknown): ExecuteRequest {
	if (!Check(ExecuteRequestSchema, value)) throw new Error("orchestrate_execute request must match the strict v1 schema.");
	const input = value as ExecuteRequest;
	const request: ExecuteRequest = {
		...input,
		goal: normalizeText(input.goal, "goal"),
		tasks: input.tasks.map(normalizeTask),
		finalChecks: input.finalChecks.map((check, index) => normalizeCheck(check, `finalChecks[${index}]`)),
		...(input.finalJudgment ? { finalJudgment: normalizeJudgment(input.finalJudgment, "finalJudgment")! } : {}),
	};
	if (Buffer.byteLength(JSON.stringify(request), "utf8") > MAX_EXECUTE_REQUEST_BYTES) {
		throw new Error(`orchestrate_execute normalized request exceeds ${MAX_EXECUTE_REQUEST_BYTES} bytes.`);
	}
	validateGraph(request.tasks);
	return request;
}

export function parseResumeRequest(value: unknown): ResumeRequest {
	if (!Check(ResumeRequestSchema, value)) throw new Error("orchestrate_resume request must match one strict v1 action.");
	return value as ResumeRequest;
}

export function launchKey(role: Role, modelClass: ModelClass): string {
	return `${role}/${modelClass}`;
}

export function requiredLaunchKeys(request: ExecuteRequest): Map<string, { role: Role; modelClass: ModelClass }> {
	const required = new Map<string, { role: Role; modelClass: ModelClass }>();
	for (const task of request.tasks) {
		required.set(launchKey("implementer", task.modelClass), { role: "implementer", modelClass: task.modelClass });
		if (task.judgment) required.set(launchKey("reviewer", task.judgment.modelClass), { role: "reviewer", modelClass: task.judgment.modelClass });
	}
	if (request.finalJudgment) {
		required.set(launchKey("reviewer", request.finalJudgment.modelClass), { role: "reviewer", modelClass: request.finalJudgment.modelClass });
	}
	return required;
}

export function validateLaunchRecords(request: ExecuteRequest, records: readonly LaunchRecord[]): Record<string, LaunchRecord> {
	const required = requiredLaunchKeys(request);
	const keyed: Record<string, LaunchRecord> = {};
	for (const record of records) {
		if (keyed[record.key]) throw new Error(`Duplicate launch record ${record.key}.`);
		const expected = required.get(record.key);
		if (!expected || record.role !== expected.role || record.modelClass !== expected.modelClass) {
			throw new Error(`Unexpected launch record ${record.key}.`);
		}
		if (!new RegExp(SHA256_PATTERN).test(record.fingerprint)) throw new Error(`Launch record ${record.key} has an invalid fingerprint.`);
		keyed[record.key] = { ...record };
	}
	for (const key of required.keys()) {
		if (!keyed[key]) throw new Error(`Missing launch record ${key}.`);
	}
	return keyed;
}

export function sameIdentity(left: WorkspaceIdentity, right: WorkspaceIdentity): boolean {
	return left.branch === right.branch && left.head === right.head && left.index === right.index && left.tree === right.tree;
}

export function isCleanCommitted(identity: WorkspaceIdentity): boolean {
	return identity.head === identity.index && identity.head === identity.tree;
}

function sameCheck(left: CheckCommand, right: CheckCommand): boolean {
	return left.command === right.command
		&& left.args.length === right.args.length
		&& left.args.every((arg, index) => arg === right.args[index]);
}

export function checkBatchPasses(evidence: CheckBatchEvidence | undefined, checks: readonly CheckCommand[], candidate: WorkspaceIdentity): boolean {
	return Boolean(evidence
		&& evidence.passed
		&& sameIdentity(evidence.candidate, candidate)
		&& sameIdentity(evidence.identityAfter, candidate)
		&& evidence.results.length === checks.length
		&& evidence.results.every((result, index) => sameCheck(result, checks[index]!) && result.code === 0 && !result.killed));
}

function reviewPasses(
	evidence: ReviewEvidence | undefined,
	phase: ReviewEvidence["phase"],
	criterion: string,
	launchRecordKey: string,
	base: WorkspaceIdentity,
	tip: WorkspaceIdentity,
): boolean {
	return Boolean(evidence
		&& evidence.phase === phase
		&& evidence.passed
		&& evidence.verdict.trim() === "PASS"
		&& evidence.criterion === criterion
		&& evidence.launchKey === launchRecordKey
		&& sameIdentity(evidence.base, base)
		&& sameIdentity(evidence.tip, tip)
		&& sameIdentity(evidence.identityAfter, tip));
}

function requireCompletedTaskEvidence(taskState: TaskState, request: TaskRequest): void {
	const attempt = taskState.attempts.at(-1);
	if (!attempt?.candidate || !attempt.integrationCandidate || !attempt.integrationBase) {
		throw new Error(`Completed task ${request.id} has no integration candidate.`);
	}
	if (attempt.termination?.status !== "terminated") {
		throw new Error(`Completed task ${request.id} has no recorded worker termination.`);
	}
	if (attempt.authoritativeChecks?.phase !== "authoritative"
		|| !checkBatchPasses(attempt.authoritativeChecks, request.checks, attempt.integrationCandidate)) {
		throw new Error(`Completed task ${request.id} lacks authoritative passing checks on its exact candidate.`);
	}
	if (request.judgment && !reviewPasses(
		attempt.authoritativeReview,
		"authoritative",
		request.judgment.criterion,
		taskState.judgmentLaunchKey!,
		attempt.integrationBase,
		attempt.integrationCandidate,
	)) throw new Error(`Completed task ${request.id} lacks an exact authoritative passing review.`);
	if (attempt.integration?.status !== "integrated"
		|| !sameIdentity(attempt.integration.expectedMain, attempt.integrationBase)
		|| !sameIdentity(attempt.integration.candidate, attempt.integrationCandidate)
		|| !attempt.integration.mainAfter
		|| attempt.integration.mainAfter.branch !== attempt.integrationBase.branch
		|| attempt.integration.mainAfter.head !== attempt.integrationCandidate.head
		|| !isCleanCommitted(attempt.integration.mainAfter)) {
		throw new Error(`Completed task ${request.id} lacks exact integration evidence.`);
	}
	if (attempt.cleanup.length !== 4 || attempt.cleanup.some((step) => step.status !== "completed")) {
		throw new Error(`Completed task ${request.id} has incomplete cleanup.`);
	}
}

export function parseRunState(value: unknown): RunState {
	if (!Check(RunStateSchema, value)) {
		const first = Errors(RunStateSchema, value)[0];
		const detail = first ? ` at ${first.instancePath || "/"}: ${first.message}` : "";
		throw new Error(`Unsupported or malformed pi-orchestrator v1 state${detail}.`);
	}
	const state = value as RunState;
	const request = parseExecuteRequest(state.request);
	if (state.deadlineStartedAt < state.createdAt
		|| state.deadlineStartedAt > state.updatedAt
		|| state.deadline !== state.deadlineStartedAt + request.budgetMs) {
		throw new Error("Malformed pi-orchestrator v1 deadline.");
	}
	const records = validateLaunchRecords(request, Object.values(state.launchRecords));
	if (!isDeepStrictEqual(records, state.launchRecords)) throw new Error("Malformed pi-orchestrator v1 launch record keys.");
	if (state.tasks.length !== request.tasks.length) throw new Error("Malformed pi-orchestrator v1 task count.");
	for (let index = 0; index < request.tasks.length; index += 1) {
		const definition = request.tasks[index]!;
		const taskState = state.tasks[index]!;
		if (taskState.taskId !== definition.id) throw new Error("Malformed pi-orchestrator v1 task order.");
		if (taskState.implementerLaunchKey !== launchKey("implementer", definition.modelClass)) {
			throw new Error(`Malformed implementer launch key for ${definition.id}.`);
		}
		const judgmentKey = definition.judgment ? launchKey("reviewer", definition.judgment.modelClass) : undefined;
		if (taskState.judgmentLaunchKey !== judgmentKey) throw new Error(`Malformed Reviewer launch key for ${definition.id}.`);
		for (const [attemptIndex, attempt] of taskState.attempts.entries()) {
			if (attempt.number !== attemptIndex + 1) throw new Error(`Malformed attempt order for ${definition.id}.`);
			if (attempt.prompts[0]?.kind === "correction" || (attempt.prompts[1] && attempt.prompts[1].kind !== "correction")) {
				throw new Error(`Malformed correction history for ${definition.id}.`);
			}
			if (attempt.cleanup.some((step, cleanupIndex) => step.kind !== CLEANUP_KINDS[cleanupIndex])) {
				throw new Error(`Malformed cleanup sequence for ${definition.id}.`);
			}
		}
		if (taskState.status === "completed") requireCompletedTaskEvidence(taskState, definition);
	}
	if (state.recovery && !state.tasks.some((task) => task.taskId === state.recovery!.taskId)) {
		throw new Error("Malformed cleanup-only recovery task.");
	}
	if (state.status === "completed" && !state.accepted) {
		throw new Error("A completed request must be accepted with exact final evidence.");
	}
	if (state.final.status === "passed" && !state.accepted) {
		throw new Error("A passed final gate must belong to an accepted request.");
	}
	if (state.accepted) {
		if (state.status !== "completed" || state.final.status !== "passed" || state.tasks.some((task) => task.status !== "completed")) {
			throw new Error("Malformed accepted pi-orchestrator state.");
		}
		if (!state.final.identity || !isCleanCommitted(state.final.identity)) {
			throw new Error("Accepted request lacks a clean final identity.");
		}
		if (state.final.checks?.phase !== "final"
			|| !checkBatchPasses(state.final.checks, request.finalChecks, state.final.identity)) {
			throw new Error("Accepted request lacks passing final checks on its exact identity.");
		}
		if (request.finalJudgment && !reviewPasses(
			state.final.review,
			"final",
			request.finalJudgment.criterion,
			launchKey("reviewer", request.finalJudgment.modelClass),
			state.requestStartMain,
			state.final.identity,
		)) throw new Error("Accepted request lacks an exact passing final review.");
		if (!sameIdentity(state.main, state.final.identity) || state.acceptedAt === undefined) {
			throw new Error("Accepted request does not match its final-gate identity.");
		}
	} else if (state.acceptedAt !== undefined) {
		throw new Error("Unaccepted request cannot have acceptedAt.");
	}
	if (state.status === "final_failed" && state.final.status !== "final_failed") throw new Error("Malformed final_failed state.");
	if (state.status === "superseded" && state.final.status !== "superseded") throw new Error("Malformed superseded state.");
	return { ...state, request, launchRecords: records };
}
