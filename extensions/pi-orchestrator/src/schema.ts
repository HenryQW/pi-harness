import { isAbsolute } from "node:path";
import { parseRoleName, type RoleName } from "@henryqw/pi-subagent";
import { Type, type Static } from "typebox";
import { Check, Errors } from "typebox/value";

export const RUN_STATE_VERSION = 2;
export const MAX_TASKS = 8;
export const MAX_EXECUTE_REQUEST_BYTES = 256 * 1024;
export const MAX_PERSISTED_RUNTIME_TEXT_BYTES = 8 * 1024;
export const MAX_POSSIBLE_RESOURCES = 32;

export const MODEL_CLASSES = ["fast", "balanced", "frontier", "fav"] as const;
export type ModelClass = Static<typeof ModelClassSchema>;

const ID_PATTERN = "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$";
const OID_PATTERN = "^(?:[0-9a-f]{40}|[0-9a-f]{64})$";
const TOKEN_PATTERN = "^[A-Za-z0-9_-]{16,128}$";
const IdSchema = Type.String({ minLength: 1, maxLength: 80, pattern: ID_PATTERN });
const TextSchema = Type.String({ minLength: 1, maxLength: 32_000 });
const RoleNameSchema = Type.String({ minLength: 1, maxLength: 32_000 });
const RuntimeTextSchema = Type.String({ minLength: 1, maxLength: MAX_PERSISTED_RUNTIME_TEXT_BYTES });
const OptionalRuntimeTextSchema = Type.Optional(Type.String({ maxLength: MAX_PERSISTED_RUNTIME_TEXT_BYTES }));
const TimestampSchema = Type.Integer({ minimum: 0 });
const ModelClassSchema = Type.Union([
	Type.Literal("fast"),
	Type.Literal("balanced"),
	Type.Literal("frontier"),
	Type.Literal("fav"),
]);

export const CheckCommandSchema = Type.Object({
	command: TextSchema,
	args: Type.Array(Type.String({ maxLength: 16_000 }), { maxItems: 128 }),
}, { additionalProperties: false });

export const JudgmentSchema = Type.Object({
	role: RoleNameSchema,
	modelClass: ModelClassSchema,
	criterion: TextSchema,
}, { additionalProperties: false });

const TaskRequestBaseFields = {
	role: RoleNameSchema,
	modelClass: ModelClassSchema,
	requirements: TextSchema,
	deliverable: TextSchema,
	dependsOn: Type.Array(IdSchema, { maxItems: MAX_TASKS }),
	contextFrom: Type.Array(IdSchema, { maxItems: MAX_TASKS }),
};

const TextTaskRequestSchema = Type.Object({
	id: IdSchema,
	kind: Type.Literal("text"),
	...TaskRequestBaseFields,
}, { additionalProperties: false });

const ChangesetTaskRequestSchema = Type.Object({
	id: IdSchema,
	kind: Type.Literal("changeset"),
	...TaskRequestBaseFields,
	checks: Type.Array(CheckCommandSchema, { minItems: 1, maxItems: 32 }),
	judgment: Type.Optional(JudgmentSchema),
}, { additionalProperties: false });

export const TaskRequestSchema = Type.Union([TextTaskRequestSchema, ChangesetTaskRequestSchema]);

export const ExecuteRequestSchema = Type.Object({
	id: IdSchema,
	goal: TextSchema,
	budgetMs: Type.Integer({ minimum: 1_000, maximum: 2_147_483_647 }),
	tasks: Type.Array(TaskRequestSchema, { minItems: 1, maxItems: MAX_TASKS }),
	finalChecks: Type.Array(CheckCommandSchema, { minItems: 1, maxItems: 32 }),
	finalJudgment: Type.Optional(JudgmentSchema),
}, { additionalProperties: false });

export const IdOnlySchema = Type.Object({ id: IdSchema }, { additionalProperties: false });

export const ResumeRequestSchema = Type.Union([
	Type.Object({ id: IdSchema, action: Type.Literal("retry"), taskId: IdSchema }, { additionalProperties: false }),
	Type.Object({ id: IdSchema, action: Type.Literal("verify"), taskId: IdSchema }, { additionalProperties: false }),
	Type.Object({ id: IdSchema, action: Type.Literal("finalize") }, { additionalProperties: false }),
]);

export type IdOnly = Static<typeof IdOnlySchema>;
export type CheckCommand = Static<typeof CheckCommandSchema>;
export type Judgment = Static<typeof JudgmentSchema>;
export type TextTaskRequest = Static<typeof TextTaskRequestSchema>;
export type ChangesetTaskRequest = Static<typeof ChangesetTaskRequestSchema>;
export type TaskRequest = Static<typeof TaskRequestSchema>;
export type ExecuteRequest = Static<typeof ExecuteRequestSchema>;
export type ResumeRequest = Static<typeof ResumeRequestSchema>;

export type WorkspaceIdentity = Static<typeof WorkspaceSchema>;

const AllocationLifecycleFields = {
	generation: Type.Integer({ minimum: 1, maximum: 2 }),
	token: Type.String({ pattern: TOKEN_PATTERN }),
	status: Type.Union([
		Type.Literal("allocating"), Type.Literal("owned"), Type.Literal("absent"), Type.Literal("unknown"),
	]),
	possibleResources: Type.Optional(Type.Array(RuntimeTextSchema, { maxItems: MAX_POSSIBLE_RESOURCES })),
	failure: OptionalRuntimeTextSchema,
};

const WorktreeRecordSchema = Type.Object({
	path: RuntimeTextSchema,
	cwd: RuntimeTextSchema,
	branch: RuntimeTextSchema,
	repoRoot: RuntimeTextSchema,
	baseCommit: Type.String({ pattern: OID_PATTERN }),
}, { additionalProperties: false });

const WorktreeAllocationIntentSchema = Type.Object({
	kind: Type.Literal("worktree"),
	...AllocationLifecycleFields,
	worktree: Type.Optional(WorktreeRecordSchema),
}, { additionalProperties: false });

const WorkspaceAllocationIntentSchema = Type.Object({
	kind: Type.Literal("workspace"),
	...AllocationLifecycleFields,
	label: RuntimeTextSchema,
	worktreeCwd: RuntimeTextSchema,
	mainRoot: RuntimeTextSchema,
	repoKey: RuntimeTextSchema,
	herdrRepoRoot: RuntimeTextSchema,
	workspaceId: Type.Optional(RuntimeTextSchema),
	rootTabId: Type.Optional(RuntimeTextSchema),
	rootPaneId: Type.Optional(RuntimeTextSchema),
}, { additionalProperties: false });

const WorkerTabAllocationIntentSchema = Type.Object({
	kind: Type.Literal("worker_tab"),
	...AllocationLifecycleFields,
	label: RuntimeTextSchema,
	workspaceId: RuntimeTextSchema,
	workspaceRootTabId: RuntimeTextSchema,
	workspaceRootPaneId: RuntimeTextSchema,
	worktreeCwd: RuntimeTextSchema,
	leasePath: RuntimeTextSchema,
	tabId: Type.Optional(RuntimeTextSchema),
	paneId: Type.Optional(RuntimeTextSchema),
}, { additionalProperties: false });

const AgentAllocationIntentSchema = Type.Object({
	kind: Type.Literal("agent"),
	...AllocationLifecycleFields,
	agentName: RuntimeTextSchema,
	workspaceId: RuntimeTextSchema,
	tabId: RuntimeTextSchema,
	paneId: RuntimeTextSchema,
	worktreeCwd: RuntimeTextSchema,
	leasePath: RuntimeTextSchema,
}, { additionalProperties: false });

export const AllocationIntentSchema = Type.Union([
	WorktreeAllocationIntentSchema,
	WorkspaceAllocationIntentSchema,
	WorkerTabAllocationIntentSchema,
	AgentAllocationIntentSchema,
]);

export type WorktreeRecord = Static<typeof WorktreeRecordSchema>;
export type WorktreeAllocationIntent = Static<typeof WorktreeAllocationIntentSchema>;
export type WorkspaceAllocationIntent = Static<typeof WorkspaceAllocationIntentSchema>;
export type WorkerTabAllocationIntent = Static<typeof WorkerTabAllocationIntentSchema>;
export type AgentAllocationIntent = Static<typeof AgentAllocationIntentSchema>;
export type AllocationIntent = Static<typeof AllocationIntentSchema>;
export type AllocationKind = AllocationIntent["kind"];
export type AllocationStatus = AllocationIntent["status"];
export type WorktreeAllocationPlan = WorktreeRecord;
export type WorkspaceAllocationPlan = Pick<WorkspaceAllocationIntent, "kind" | "label" | "worktreeCwd" | "mainRoot" | "repoKey" | "herdrRepoRoot">;
export type WorkerTabAllocationPlan = Pick<WorkerTabAllocationIntent, "kind" | "label" | "workspaceId" | "workspaceRootTabId" | "workspaceRootPaneId" | "worktreeCwd" | "leasePath">;
export type AgentAllocationPlan = Pick<AgentAllocationIntent, "kind" | "agentName" | "workspaceId" | "tabId" | "paneId" | "worktreeCwd" | "leasePath">;
export type HostAllocationIntent = WorkspaceAllocationIntent | WorkerTabAllocationIntent | AgentAllocationIntent;
export type HostAllocationPlan = WorkspaceAllocationPlan | WorkerTabAllocationPlan | AgentAllocationPlan;
export type PromptRecord = Static<typeof PromptRecordSchema>;
export type CommandEvidence = Static<typeof CommandEvidenceSchema>;
export type CheckBatchEvidence = Static<typeof CheckBatchEvidenceSchema>;
export type ReviewEvidence = Static<typeof ReviewEvidenceSchema>;
export type WorkerTermination = Static<typeof WorkerTerminationSchema>;
export type IntegrationRecord = Static<typeof IntegrationRecordSchema>;

export const CLEANUP_KINDS = ["worker_tab", "workspace", "worktree", "branch"] as const;
export type CleanupStep = Static<typeof CleanupStepSchema>;
export type CleanupKind = CleanupStep["kind"];
export type ChangesetTaskAttempt = Static<typeof TaskAttemptSchema>;
export type TaskAttempt = ChangesetTaskAttempt;
export type TextTaskOutput = Static<typeof TextTaskOutputSchema>;
export type TextTaskAttempt = Static<typeof TextTaskAttemptSchema>;
export type ChangesetTaskState = Static<typeof ChangesetTaskStateSchema>;
export type TextTaskState = Static<typeof TextTaskStateSchema>;
export type TaskState = Static<typeof TaskStateSchema>;
export type TaskStatus = TaskState["status"];
export type WaveState = Static<typeof WaveStateSchema>;
export type FinalGateState = Static<typeof FinalGateSchema>;
export type RunState = Static<typeof RunStateSchema>;
export type RequestStatus = RunState["status"];
export type CleanupRecovery = NonNullable<RunState["recovery"]>;

const WorkspaceSchema = Type.Object({
	branch: RuntimeTextSchema,
	head: Type.String({ pattern: OID_PATTERN }),
	index: Type.String({ pattern: OID_PATTERN }),
	tree: Type.String({ pattern: OID_PATTERN }),
}, { additionalProperties: false });

const PromptRecordSchema = Type.Object({
	kind: Type.Union([Type.Literal("initial"), Type.Literal("correction")]),
	status: Type.Union([Type.Literal("submitting"), Type.Literal("not_sent"), Type.Literal("settled"), Type.Literal("ambiguous")]),
	preCandidate: WorkspaceSchema,
	candidate: Type.Optional(WorkspaceSchema),
	failure: OptionalRuntimeTextSchema,
	at: TimestampSchema,
}, { additionalProperties: false });

const CommandEvidenceSchema = Type.Object({
	command: TextSchema,
	args: Type.Array(Type.String({ maxLength: 16_000 }), { maxItems: 128 }),
	code: Type.Integer(),
	killed: Type.Boolean(),
	stdout: Type.String({ maxLength: MAX_PERSISTED_RUNTIME_TEXT_BYTES }),
	stderr: Type.String({ maxLength: MAX_PERSISTED_RUNTIME_TEXT_BYTES }),
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
	phase: Type.Union([Type.Literal("authoritative"), Type.Literal("final")]),
	criterion: TextSchema,
	base: WorkspaceSchema,
	tip: WorkspaceSchema,
	identityAfter: WorkspaceSchema,
	verdict: Type.String({ maxLength: MAX_PERSISTED_RUNTIME_TEXT_BYTES }),
	passed: Type.Boolean(),
	at: TimestampSchema,
}, { additionalProperties: false });

const WorkerTerminationSchema = Type.Object({
	status: Type.Union([Type.Literal("terminating"), Type.Literal("terminated"), Type.Literal("unknown")]),
	workerId: RuntimeTextSchema,
	candidate: WorkspaceSchema,
	at: Type.Optional(TimestampSchema),
	failure: OptionalRuntimeTextSchema,
}, { additionalProperties: false });

const IntegrationRecordSchema = Type.Object({
	status: Type.Union([Type.Literal("integrating"), Type.Literal("integrated"), Type.Literal("failed"), Type.Literal("unknown")]),
	expectedMain: WorkspaceSchema,
	candidate: WorkspaceSchema,
	mainAfter: Type.Optional(WorkspaceSchema),
	failure: OptionalRuntimeTextSchema,
}, { additionalProperties: false });

const CleanupStepSchema = Type.Object({
	kind: Type.Union([
		Type.Literal("worker_tab"), Type.Literal("workspace"), Type.Literal("worktree"), Type.Literal("branch"),
	]),
	status: Type.Union([Type.Literal("pending"), Type.Literal("running"), Type.Literal("completed")]),
	failure: OptionalRuntimeTextSchema,
}, { additionalProperties: false });

const TaskAttemptSchema = Type.Object({
	number: Type.Integer({ minimum: 1, maximum: 2 }),
	waveNumber: Type.Integer({ minimum: 1 }),
	waveBase: WorkspaceSchema,
	correlationToken: Type.String({ pattern: TOKEN_PATTERN }),
	allocationGeneration: Type.Integer({ minimum: 1, maximum: 2 }),
	allocations: Type.Array(AllocationIntentSchema, { maxItems: 5 }),
	prompts: Type.Array(PromptRecordSchema, { maxItems: 2 }),
	candidate: Type.Optional(WorkspaceSchema),
	preliminaryChecks: Type.Optional(CheckBatchEvidenceSchema),
	termination: Type.Optional(WorkerTerminationSchema),
	integrationBase: Type.Optional(WorkspaceSchema),
	integrationCandidate: Type.Optional(WorkspaceSchema),
	authoritativeChecks: Type.Optional(CheckBatchEvidenceSchema),
	authoritativeReview: Type.Optional(ReviewEvidenceSchema),
	integration: Type.Optional(IntegrationRecordSchema),
	cleanup: Type.Array(CleanupStepSchema, { minItems: CLEANUP_KINDS.length, maxItems: CLEANUP_KINDS.length }),
}, { additionalProperties: false });

const ChangesetTaskStateSchema = Type.Object({
	taskId: IdSchema,
	kind: Type.Literal("changeset"),
	status: Type.Union([
		Type.Literal("pending"), Type.Literal("allocating"), Type.Literal("working"), Type.Literal("ready_to_integrate"),
		Type.Literal("integrating"), Type.Literal("cleanup"), Type.Literal("completed"), Type.Literal("needs_attention"),
	]),
	attempts: Type.Array(TaskAttemptSchema, { maxItems: 2 }),
	failure: OptionalRuntimeTextSchema,
}, { additionalProperties: false });

const TextTaskOutputSchema = Type.Object({
	text: RuntimeTextSchema,
}, { additionalProperties: false });

const TextTaskAttemptSchema = Type.Object({
	number: Type.Integer({ minimum: 1, maximum: 2 }),
	status: Type.Union([Type.Literal("running"), Type.Literal("completed"), Type.Literal("failed")]),
	failure: OptionalRuntimeTextSchema,
	output: Type.Optional(TextTaskOutputSchema),
}, { additionalProperties: false });

const TextTaskStateSchema = Type.Object({
	taskId: IdSchema,
	kind: Type.Literal("text"),
	status: Type.Union([
		Type.Literal("pending"), Type.Literal("running"), Type.Literal("completed"), Type.Literal("needs_attention"),
	]),
	attempts: Type.Array(TextTaskAttemptSchema, { maxItems: 2 }),
	failure: OptionalRuntimeTextSchema,
}, { additionalProperties: false });

const TaskStateSchema = Type.Union([TextTaskStateSchema, ChangesetTaskStateSchema]);

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
	failure: OptionalRuntimeTextSchema,
}, { additionalProperties: false });

const RunStateSchema = Type.Object({
	version: Type.Literal(RUN_STATE_VERSION),
	request: ExecuteRequestSchema,
	root: TextSchema,
	requestStartMain: WorkspaceSchema,
	main: WorkspaceSchema,
	deadlineStartedAt: TimestampSchema,
	deadline: TimestampSchema,
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

function normalizeRole(value: string, field: string): RoleName {
	return parseRoleName(value, field);
}

function normalizeJudgment(judgment: Judgment | undefined, field: string): Judgment | undefined {
	if (!judgment) return;
	return {
		...judgment,
		role: normalizeRole(judgment.role, `${field}.role`),
		criterion: normalizeText(judgment.criterion, `${field}.criterion`),
	};
}

function normalizeTask(task: TaskRequest, index: number): TaskRequest {
	const fields = {
		id: task.id,
		role: normalizeRole(task.role, `tasks[${index}].role`),
		modelClass: task.modelClass,
		requirements: normalizeText(task.requirements, `tasks[${index}].requirements`),
		deliverable: normalizeText(task.deliverable, `tasks[${index}].deliverable`),
		dependsOn: [...task.dependsOn],
		contextFrom: [...task.contextFrom],
	};
	if (task.kind === "text") return { ...fields, kind: "text" };
	return {
		...fields,
		kind: "changeset",
		checks: task.checks.map((check, checkIndex) => normalizeCheck(check, `tasks[${index}].checks[${checkIndex}]`)),
		...(task.judgment ? { judgment: normalizeJudgment(task.judgment, `tasks[${index}].judgment`)! } : {}),
	};
}

export function taskDependencies(task: TaskRequest): string[] {
	return [...task.dependsOn, ...task.contextFrom];
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
		const context = new Set<string>();
		for (const source of task.contextFrom) {
			if (source === task.id) throw new Error(`Task ${task.id} cannot depend on itself.`);
			if (context.has(source)) throw new Error(`Task ${task.id} has duplicate context source ${source}.`);
			if (dependencies.has(source)) throw new Error(`Task ${task.id} has overlapping dependsOn and contextFrom edge ${source}.`);
			context.add(source);
		}
	}
	for (const task of tasks) {
		for (const dependency of task.dependsOn) {
			if (!byId.has(dependency)) throw new Error(`Task ${task.id} has unknown dependency ${dependency}.`);
		}
		for (const source of task.contextFrom) {
			const sourceTask = byId.get(source);
			if (!sourceTask) throw new Error(`Task ${task.id} has unknown context source ${source}.`);
			if (sourceTask.kind !== "text") throw new Error(`Task ${task.id} context source ${source} must be a text task.`);
		}
	}
	const visiting = new Set<string>();
	const visited = new Set<string>();
	const visit = (id: string): void => {
		if (visiting.has(id)) throw new Error(`Task dependency cycle includes ${id}.`);
		if (visited.has(id)) return;
		visiting.add(id);
		for (const dependency of taskDependencies(byId.get(id)!)) visit(dependency);
		visiting.delete(id);
		visited.add(id);
	};
	for (const task of tasks) visit(task.id);
}

export function parseExecuteRequest(value: unknown): ExecuteRequest {
	if (!Check(ExecuteRequestSchema, value)) throw new Error("orchestrate_execute request must match the strict task schema.");
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

export function parseIdOnly(value: unknown): IdOnly {
	if (!Check(IdOnlySchema, value)) throw new Error("orchestrate request ID must match the strict v1 schema.");
	return value as IdOnly;
}

export function parseResumeRequest(value: unknown): ResumeRequest {
	if (!Check(ResumeRequestSchema, value)) throw new Error("orchestrate_resume request must match one strict v1 action.");
	return value as ResumeRequest;
}

export function sameIdentity(left: WorkspaceIdentity, right: WorkspaceIdentity): boolean {
	return left.branch === right.branch && left.head === right.head && left.index === right.index && left.tree === right.tree;
}

export function isCleanCommitted(identity: WorkspaceIdentity): boolean {
	return identity.index === identity.tree;
}

function sameCheck(left: CheckCommand, right: CheckCommand): boolean {
	return left.command === right.command
		&& left.args.length === right.args.length
		&& left.args.every((arg, index) => arg === right.args[index]);
}

type PreparedWorktreeAllocation = WorktreeAllocationIntent & { worktree: WorktreeRecord };

function hasWorktreePlan(allocation: WorktreeAllocationIntent): allocation is PreparedWorktreeAllocation {
	return allocation.worktree !== undefined;
}

function requireExactAllocationText(value: string, field: string): void {
	if (!value.trim() || value.trim() !== value || value.includes("\0")) {
		throw new Error(`${field} must be exact non-empty text.`);
	}
}

function requireAbsoluteAllocationPath(value: string, field: string): void {
	requireExactAllocationText(value, field);
	if (!isAbsolute(value)) throw new Error(`${field} must be an absolute path.`);
}

function validateCheckBatchEvidence(evidence: CheckBatchEvidence, checks: readonly CheckCommand[], field: string): void {
	if (evidence.results.length !== checks.length
		|| evidence.results.some((result, index) => !sameCheck(result, checks[index]!))) {
		throw new Error(`${field} does not retain every exact declared command and argv.`);
	}
	const commandsPassed = evidence.results.every((result) => result.code === 0 && !result.killed);
	const identityMatches = sameIdentity(evidence.candidate, evidence.identityAfter);
	if (evidence.passed !== (commandsPassed && identityMatches)) {
		throw new Error(`${field} has an inconsistent pass result.`);
	}
	let diagnosticIndex = evidence.passed
		? -1
		: evidence.results.findIndex((result) => result.code !== 0 || result.killed);
	if (diagnosticIndex < 0 && commandsPassed && !identityMatches) diagnosticIndex = evidence.results.length - 1;
	if (evidence.results.some((result, index) => index !== diagnosticIndex && (result.stdout !== "" || result.stderr !== ""))) {
		throw new Error(`${field} retains non-diagnostic command output.`);
	}
}

export function checkBatchPasses(evidence: CheckBatchEvidence | undefined, checks: readonly CheckCommand[], candidate: WorkspaceIdentity): boolean {
	return Boolean(evidence
		&& evidence.passed
		&& sameIdentity(evidence.candidate, candidate)
		&& sameIdentity(evidence.identityAfter, candidate)
		&& evidence.results.length === checks.length
		&& evidence.results.every((result, index) => sameCheck(result, checks[index]!) && result.code === 0 && !result.killed));
}

export function reviewEvidencePasses(
	evidence: ReviewEvidence | undefined,
	phase: ReviewEvidence["phase"],
	criterion: string,
	base: WorkspaceIdentity,
	tip: WorkspaceIdentity,
): boolean {
	return Boolean(evidence
		&& evidence.phase === phase
		&& evidence.passed
		&& evidence.verdict === "PASS"
		&& evidence.criterion === criterion
		&& sameIdentity(evidence.base, base)
		&& sameIdentity(evidence.tip, tip)
		&& sameIdentity(evidence.identityAfter, tip));
}

function requireCompletedTaskEvidence(taskState: ChangesetTaskState, request: ChangesetTaskRequest): void {
	const attempt = taskState.attempts.at(-1);
	const worktree = [...(attempt?.allocations ?? [])].reverse().find(
		(allocation): allocation is WorktreeAllocationIntent => allocation.kind === "worktree" && allocation.status === "owned",
	);
	if (!worktree || !hasWorktreePlan(worktree)) {
		throw new Error(`Completed task ${request.id} lacks an exact owned worktree record.`);
	}
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
	if (request.judgment && !reviewEvidencePasses(
		attempt.authoritativeReview,
		"authoritative",
		request.judgment.criterion,
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

function validateTextTaskState(taskState: TextTaskState): void {
	const latest = taskState.attempts.at(-1);
	for (const [attemptIndex, attempt] of taskState.attempts.entries()) {
		if (attempt.number !== attemptIndex + 1) throw new Error(`Malformed text attempt order for ${taskState.taskId}.`);
		if (attemptIndex !== taskState.attempts.length - 1) {
			if (attempt.status !== "failed" || attempt.output) {
				throw new Error(`Non-latest text attempt ${attempt.number} for ${taskState.taskId} must be failed with no output.`);
			}
		} else if (attempt.status === "completed") {
			if (!attempt.output) throw new Error(`Completed text attempt ${attempt.number} for ${taskState.taskId} lacks output.`);
		} else if (attempt.output) {
			throw new Error(`Text attempt ${attempt.number} for ${taskState.taskId} has output without completion.`);
		}
		if (attempt.failure !== undefined && attempt.status !== "failed") {
			throw new Error(`Text attempt ${attempt.number} for ${taskState.taskId} has failure without failure status.`);
		}
	}
	if (latest?.status === "completed") {
		if (taskState.status !== "completed") {
			throw new Error(`Completed text attempt ${latest.number} for ${taskState.taskId} must be the latest attempt of a completed task.`);
		}
	} else if (taskState.status === "completed") {
		throw new Error(`Completed text task ${taskState.taskId} lacks a latest completed attempt.`);
	}
}

export function parseRunState(value: unknown): RunState {
	if (value && typeof value === "object" && !Array.isArray(value)
		&& "version" in value && (value as { version?: unknown }).version !== RUN_STATE_VERSION) {
		throw new Error(`Unsupported pi-orchestrator state version ${String((value as { version?: unknown }).version)}; expected ${RUN_STATE_VERSION}.`);
	}
	if (!Check(RunStateSchema, value)) {
		const first = Errors(RunStateSchema, value)[0];
		const detail = first ? ` at ${first.instancePath || "/"}: ${first.message}` : "";
		throw new Error(`Unsupported or malformed pi-orchestrator v${RUN_STATE_VERSION} state${detail}.`);
	}
	const state = value as RunState;
	const request = parseExecuteRequest(state.request);
	if (state.deadlineStartedAt > state.createdAt
		|| state.createdAt > state.updatedAt
		|| state.deadline !== state.deadlineStartedAt + request.budgetMs) {
		throw new Error(`Malformed pi-orchestrator v${RUN_STATE_VERSION} deadline.`);
	}
	if (state.tasks.length !== request.tasks.length) throw new Error(`Malformed pi-orchestrator v${RUN_STATE_VERSION} task count.`);
	for (let index = 0; index < request.tasks.length; index += 1) {
		const definition = request.tasks[index]!;
		const taskState = state.tasks[index]!;
		if (taskState.taskId !== definition.id) throw new Error(`Malformed pi-orchestrator v${RUN_STATE_VERSION} task order.`);
		if (definition.kind === "text") {
			if (taskState.kind !== "text") throw new Error(`Malformed task kind for ${definition.id}.`);
			validateTextTaskState(taskState);
			continue;
		}
		if (taskState.kind !== "changeset") throw new Error(`Malformed task kind for ${definition.id}.`);
		for (const [attemptIndex, attempt] of taskState.attempts.entries()) {
			if (attempt.number !== attemptIndex + 1) throw new Error(`Malformed attempt order for ${definition.id}.`);
			if (attempt.preliminaryChecks) {
				if (attempt.preliminaryChecks.phase !== "preliminary") throw new Error(`Malformed preliminary check phase for ${definition.id}.`);
				validateCheckBatchEvidence(attempt.preliminaryChecks, definition.checks, `Preliminary checks for ${definition.id}`);
			}
			if (attempt.authoritativeChecks) {
				if (attempt.authoritativeChecks.phase !== "authoritative") throw new Error(`Malformed authoritative check phase for ${definition.id}.`);
				validateCheckBatchEvidence(attempt.authoritativeChecks, definition.checks, `Authoritative checks for ${definition.id}`);
			}
			if (attempt.prompts[0]?.kind === "correction" || (attempt.prompts[1] && attempt.prompts[1].kind !== "correction")) {
				throw new Error(`Malformed correction history for ${definition.id}.`);
			}
			const correction = attempt.prompts[1];
			const initialPrompt = attempt.prompts[0];
			if (attempt.prompts.some((prompt) => !isCleanCommitted(prompt.preCandidate))
				|| (initialPrompt && initialPrompt.preCandidate.head !== attempt.waveBase.head)) {
				throw new Error(`Prompt history for ${definition.id} lacks a clean exact pre-prompt candidate.`);
			}
			const retainedCandidate = initialPrompt?.candidate ?? initialPrompt?.preCandidate;
			if (correction && retainedCandidate && !sameIdentity(correction.preCandidate, retainedCandidate)) {
				throw new Error(`Correction for ${definition.id} did not fence the exact retained candidate.`);
			}
			if (attempt.cleanup.some((step, cleanupIndex) => step.kind !== CLEANUP_KINDS[cleanupIndex])) {
				throw new Error(`Malformed cleanup sequence for ${definition.id}.`);
			}
			if (attempt.allocations.filter((allocation) => allocation.status === "unknown").length > 1) {
				throw new Error(`Attempt for ${definition.id} has more than one ambiguous allocation result.`);
			}
			for (const allocation of attempt.allocations) {
				if (allocation.token !== attempt.correlationToken) {
					throw new Error(`${allocation.kind} allocation for ${definition.id} has the wrong correlation token.`);
				}
				if (allocation.status === "unknown") {
					if (!allocation.failure?.trim()) throw new Error(`Unknown ${allocation.kind} allocation for ${definition.id} lacks a failure.`);
					for (const resource of allocation.possibleResources ?? []) {
						requireExactAllocationText(resource, `Unknown ${allocation.kind} allocation possible resource`);
					}
				} else if (allocation.possibleResources) {
					throw new Error(`Only unknown allocations may record possible resources for ${definition.id}.`);
				}

				if (allocation.kind === "worktree") {
					if (allocation.status === "owned" && !hasWorktreePlan(allocation)) {
						throw new Error(`Owned worktree allocation for ${definition.id} lacks exact plan fields.`);
					}
					if (hasWorktreePlan(allocation)) {
						requireAbsoluteAllocationPath(allocation.worktree.path, `Worktree allocation path for ${definition.id}`);
						requireAbsoluteAllocationPath(allocation.worktree.cwd, `Worktree allocation cwd for ${definition.id}`);
						requireAbsoluteAllocationPath(allocation.worktree.repoRoot, `Worktree allocation repository root for ${definition.id}`);
						requireExactAllocationText(allocation.worktree.branch, `Worktree allocation branch for ${definition.id}`);
						if (allocation.worktree.path !== allocation.worktree.cwd) throw new Error(`Worktree path and cwd for ${definition.id} must match exactly.`);
						if (allocation.worktree.baseCommit !== attempt.waveBase.head) {
							throw new Error(`Worktree plan for ${definition.id} does not match its recorded wave base.`);
						}
					}
					continue;
				}

				const worktree = attempt.allocations.find((candidate): candidate is PreparedWorktreeAllocation =>
					candidate.kind === "worktree" && candidate.status === "owned" && hasWorktreePlan(candidate));
				if (!worktree) throw new Error(`${allocation.kind} allocation for ${definition.id} lacks its exact owned worktree parent.`);
				if (allocation.kind === "workspace") {
					for (const [field, value] of Object.entries({
						label: allocation.label, worktreeCwd: allocation.worktreeCwd, mainRoot: allocation.mainRoot,
						repoKey: allocation.repoKey, herdrRepoRoot: allocation.herdrRepoRoot,
					})) requireExactAllocationText(value, `Workspace allocation ${field} for ${definition.id}`);
					for (const [field, value] of Object.entries({
						worktreeCwd: allocation.worktreeCwd, mainRoot: allocation.mainRoot,
						repoKey: allocation.repoKey, herdrRepoRoot: allocation.herdrRepoRoot,
					})) requireAbsoluteAllocationPath(value, `Workspace allocation ${field} for ${definition.id}`);
					if (allocation.worktreeCwd !== worktree.worktree.cwd || allocation.mainRoot !== worktree.worktree.repoRoot) {
						throw new Error(`Workspace allocation for ${definition.id} drifted from its exact worktree parent.`);
					}
					const results = [allocation.workspaceId, allocation.rootTabId, allocation.rootPaneId];
					if (allocation.status === "owned" && results.some((value) => value === undefined)) {
						throw new Error(`Owned workspace allocation for ${definition.id} lacks exact result fields.`);
					}
					if (allocation.status !== "owned" && results.some((value) => value !== undefined)) {
						throw new Error(`Unowned workspace allocation for ${definition.id} must not claim result fields.`);
					}
					for (const value of results) if (value !== undefined) requireExactAllocationText(value, `Workspace allocation result for ${definition.id}`);
					continue;
				}

				const workspace = attempt.allocations.find(
					(candidate): candidate is WorkspaceAllocationIntent => candidate.kind === "workspace" && candidate.status === "owned",
				);
				if (!workspace?.workspaceId || !workspace.rootTabId || !workspace.rootPaneId) {
					throw new Error(`${allocation.kind} allocation for ${definition.id} lacks its exact owned workspace parent.`);
				}
				if (allocation.kind === "worker_tab") {
					for (const [field, value] of Object.entries({
						label: allocation.label, workspaceId: allocation.workspaceId,
						workspaceRootTabId: allocation.workspaceRootTabId, workspaceRootPaneId: allocation.workspaceRootPaneId,
						worktreeCwd: allocation.worktreeCwd, leasePath: allocation.leasePath,
					})) requireExactAllocationText(value, `Worker-tab allocation ${field} for ${definition.id}`);
					if (allocation.workspaceId !== workspace.workspaceId
						|| allocation.workspaceRootTabId !== workspace.rootTabId
						|| allocation.workspaceRootPaneId !== workspace.rootPaneId
						|| allocation.worktreeCwd !== worktree.worktree.cwd) {
						throw new Error(`Worker-tab allocation for ${definition.id} drifted from its exact parents.`);
					}
					const results = [allocation.tabId, allocation.paneId];
					if (allocation.status === "owned" && results.some((value) => value === undefined)) {
						throw new Error(`Owned worker-tab allocation for ${definition.id} lacks exact result fields.`);
					}
					if (allocation.status !== "owned" && results.some((value) => value !== undefined)) {
						throw new Error(`Unowned worker-tab allocation for ${definition.id} must not claim result fields.`);
					}
					for (const value of results) if (value !== undefined) requireExactAllocationText(value, `Worker-tab allocation result for ${definition.id}`);
					continue;
				}

				const workerTab = attempt.allocations.find(
					(candidate): candidate is WorkerTabAllocationIntent => candidate.kind === "worker_tab" && candidate.status === "owned",
				);
				if (!workerTab?.tabId || !workerTab.paneId) throw new Error(`Agent allocation for ${definition.id} lacks its exact owned worker-tab parent.`);
				for (const [field, value] of Object.entries({
					agentName: allocation.agentName, workspaceId: allocation.workspaceId, tabId: allocation.tabId,
					paneId: allocation.paneId, worktreeCwd: allocation.worktreeCwd, leasePath: allocation.leasePath,
				})) requireExactAllocationText(value, `Agent allocation ${field} for ${definition.id}`);
				if (allocation.workspaceId !== workspace.workspaceId
					|| allocation.tabId !== workerTab.tabId
					|| allocation.paneId !== workerTab.paneId
					|| allocation.worktreeCwd !== worktree.worktree.cwd
					|| allocation.leasePath !== workerTab.leasePath) {
					throw new Error(`Agent allocation for ${definition.id} drifted from its exact parents.`);
				}
			}
		}
		if (taskState.status === "completed") requireCompletedTaskEvidence(taskState, definition);
	}
	if (state.final.checks) {
		if (state.final.checks.phase !== "final") throw new Error("Malformed final check phase.");
		validateCheckBatchEvidence(state.final.checks, request.finalChecks, "Final checks");
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
			throw new Error(`Malformed accepted pi-orchestrator v${RUN_STATE_VERSION} state.`);
		}
		if (!state.final.identity || !isCleanCommitted(state.final.identity)) {
			throw new Error("Accepted request lacks a clean final identity.");
		}
		if (state.final.checks?.phase !== "final"
			|| !checkBatchPasses(state.final.checks, request.finalChecks, state.final.identity)) {
			throw new Error("Accepted request lacks passing final checks on its exact identity.");
		}
		if (request.finalJudgment && !reviewEvidencePasses(
			state.final.review,
			"final",
			request.finalJudgment.criterion,
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
	return { ...state, request };
}
