import type { Usage } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";

export const ID_PATTERN = "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$";
export const MAX_TASKS = 32;
export const MAX_EXECUTE_REQUEST_BYTES = 256 * 1024;
export const RUN_STATE_VERSION = 9;

const IdSchema = Type.String({ minLength: 1, maxLength: 80, pattern: ID_PATTERN });
const TextSchema = Type.String({ minLength: 1, maxLength: 32_000 });
const RoleNameSchema = Type.String({ minLength: 1, maxLength: 256 });
const ModelClassSchema = Type.Union([Type.Literal("fast"), Type.Literal("balanced")]);
const StatusSchema = Type.Union([
	Type.Literal("pending"),
	Type.Literal("running"),
	Type.Literal("completed"),
	Type.Literal("needs_attention"),
]);

export const CheckCommandSchema = Type.Object({
	command: TextSchema,
	args: Type.Array(Type.String({ maxLength: 16_000 }), { maxItems: 128 }),
}, { additionalProperties: false });

const JudgmentSchema = Type.Object({
	criterion: TextSchema,
	role: RoleNameSchema,
	modelClass: ModelClassSchema,
}, { additionalProperties: false });

export const TaskRequestSchema = Type.Object({
	id: IdSchema,
	role: RoleNameSchema,
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
	commitsAllowed: Type.Boolean(),
	budgetMs: Type.Integer({ minimum: 1_000, maximum: 2_147_483_647 }),
	tasks: Type.Array(TaskRequestSchema, { minItems: 1, maxItems: MAX_TASKS }),
	finalChecks: Type.Array(CheckCommandSchema, { minItems: 1, maxItems: 32 }),
	finalJudgment: Type.Optional(JudgmentSchema),
}, { additionalProperties: false });

export const ResumeRequestSchema = Type.Union([
	Type.Object({ id: IdSchema, action: Type.Literal("retry"), taskId: IdSchema }, { additionalProperties: false }),
	Type.Object({ id: IdSchema, action: Type.Literal("replace"), task: TaskRequestSchema }, { additionalProperties: false }),
	Type.Object({ id: IdSchema, action: Type.Literal("verify"), taskId: IdSchema }, { additionalProperties: false }),
	Type.Object({ id: IdSchema, action: Type.Literal("finalize") }, { additionalProperties: false }),
	Type.Object({ id: IdSchema, action: Type.Literal("approve_final_judgment") }, { additionalProperties: false }),
]);

export const IdOnlySchema = Type.Object({ id: IdSchema }, { additionalProperties: false });

export type CheckCommand = Static<typeof CheckCommandSchema>;
export type Judgment = Static<typeof JudgmentSchema>;
export type TaskRequest = Static<typeof TaskRequestSchema>;
export type ExecuteRequest = Static<typeof ExecuteRequestSchema>;
export type ResumeRequest = Static<typeof ResumeRequestSchema>;
export type RunStatus = Static<typeof StatusSchema>;

export interface WorkspaceIdentity {
	branch: string;
	head: string;
	index: string;
	tree: string;
}

export interface CheckEvidence extends CheckCommand {
	workspace: WorkspaceIdentity;
	code: number;
	stdout: string;
	stderr: string;
	passed: boolean;
	at: number;
}

export interface TaskState {
	request: TaskRequest;
	status: RunStatus;
	attempts: number;
	checks: CheckEvidence[];
	output?: string;
	failure?: string;
	verifiedWorkspace?: WorkspaceIdentity;
}

export interface FinalState {
	status: RunStatus;
	checks: CheckEvidence[];
	failure?: string;
	verifiedWorkspace?: WorkspaceIdentity;
}

export interface RunState {
	version: typeof RUN_STATE_VERSION;
	request: ExecuteRequest;
	root: string;
	baseHead: string;
	status: RunStatus;
	tasks: TaskState[];
	final: FinalState;
	workspace: WorkspaceIdentity;
	usage?: Usage;
	elapsedMs: number;
	activeSince?: number;
	manualInterventions: number;
	accepted: boolean;
	acceptedAt?: number;
	createdAt: number;
	updatedAt: number;
}

const WorkspaceSchema = Type.Object({
	branch: TextSchema,
	head: Type.String({ pattern: "^(?:[0-9a-f]{40}|[0-9a-f]{64})$" }),
	index: Type.String({ pattern: "^(?:[0-9a-f]{40}|[0-9a-f]{64})$" }),
	tree: Type.String({ pattern: "^(?:[0-9a-f]{40}|[0-9a-f]{64})$" }),
}, { additionalProperties: false });

const UsageSchema = Type.Object({
	input: Type.Number({ minimum: 0 }),
	output: Type.Number({ minimum: 0 }),
	cacheRead: Type.Number({ minimum: 0 }),
	cacheWrite: Type.Number({ minimum: 0 }),
	cacheWrite1h: Type.Optional(Type.Number({ minimum: 0 })),
	reasoning: Type.Optional(Type.Number({ minimum: 0 })),
	totalTokens: Type.Number({ minimum: 0 }),
	cost: Type.Object({
		input: Type.Number({ minimum: 0 }),
		output: Type.Number({ minimum: 0 }),
		cacheRead: Type.Number({ minimum: 0 }),
		cacheWrite: Type.Number({ minimum: 0 }),
		total: Type.Number({ minimum: 0 }),
	}, { additionalProperties: false }),
}, { additionalProperties: false });

const EvidenceSchema = Type.Object({
	command: TextSchema,
	args: Type.Array(Type.String()),
	workspace: WorkspaceSchema,
	code: Type.Integer(),
	stdout: Type.String(),
	stderr: Type.String(),
	passed: Type.Boolean(),
	at: Type.Number({ minimum: 0 }),
}, { additionalProperties: false });

const TaskStateSchema = Type.Object({
	request: TaskRequestSchema,
	status: StatusSchema,
	attempts: Type.Integer({ minimum: 0, maximum: 2 }),
	checks: Type.Array(EvidenceSchema),
	output: Type.Optional(Type.String()),
	failure: Type.Optional(Type.String()),
	verifiedWorkspace: Type.Optional(WorkspaceSchema),
}, { additionalProperties: false });

const RunStateSchema = Type.Object({
	version: Type.Literal(RUN_STATE_VERSION),
	request: ExecuteRequestSchema,
	root: TextSchema,
	baseHead: WorkspaceSchema.properties.head,
	status: StatusSchema,
	tasks: Type.Array(TaskStateSchema, { minItems: 1, maxItems: MAX_TASKS }),
	final: Type.Object({
		status: StatusSchema,
		checks: Type.Array(EvidenceSchema),
		failure: Type.Optional(Type.String()),
		verifiedWorkspace: Type.Optional(WorkspaceSchema),
	}, { additionalProperties: false }),
	workspace: WorkspaceSchema,
	usage: Type.Optional(UsageSchema),
	elapsedMs: Type.Number({ minimum: 0 }),
	activeSince: Type.Optional(Type.Number({ minimum: 0 })),
	manualInterventions: Type.Integer({ minimum: 0 }),
	accepted: Type.Boolean(),
	acceptedAt: Type.Optional(Type.Number({ minimum: 0 })),
	createdAt: Type.Number({ minimum: 0 }),
	updatedAt: Type.Number({ minimum: 0 }),
}, { additionalProperties: false });

function cleanText(value: string, field: string): string {
	const normalized = value.trim();
	if (!normalized || value.includes("\0")) throw new Error(`${field} must be non-empty text without NUL bytes.`);
	return normalized;
}

function normalizeCheck(check: CheckCommand, field: string): CheckCommand {
	return {
		command: cleanText(check.command, `${field}.command`),
		args: check.args.map((arg, index) => {
			if (arg.includes("\0")) throw new Error(`${field}.args[${index}] must not contain NUL bytes.`);
			return arg;
		}),
	};
}

function normalizeJudgment(judgment: Judgment | undefined, field: string): Judgment | undefined {
	if (!judgment) return;
	return {
		...judgment,
		criterion: cleanText(judgment.criterion, `${field}.criterion`),
		role: cleanText(judgment.role, `${field}.role`),
	};
}

function normalizeTask(task: TaskRequest, index: number): TaskRequest {
	return {
		...task,
		role: cleanText(task.role, `tasks[${index}].role`),
		requirements: cleanText(task.requirements, `tasks[${index}].requirements`),
		deliverable: cleanText(task.deliverable, `tasks[${index}].deliverable`),
		dependsOn: [...task.dependsOn],
		checks: task.checks.map((check, checkIndex) => normalizeCheck(check, `tasks[${index}].checks[${checkIndex}]`)),
		...(task.judgment === undefined ? {} : { judgment: normalizeJudgment(task.judgment, `tasks[${index}].judgment`)! }),
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
	if (!Check(ExecuteRequestSchema, value)) throw new Error("auto_dag_execute request must match the declared v9 schema.");
	const request: ExecuteRequest = {
		...value,
		goal: cleanText(value.goal, "goal"),
		tasks: value.tasks.map(normalizeTask),
		finalChecks: value.finalChecks.map((check, index) => normalizeCheck(check, `finalChecks[${index}]`)),
		...(value.finalJudgment === undefined ? {} : { finalJudgment: normalizeJudgment(value.finalJudgment, "finalJudgment")! }),
	};
	if (Buffer.byteLength(JSON.stringify(request), "utf8") > MAX_EXECUTE_REQUEST_BYTES) {
		throw new Error(`auto_dag_execute normalized request exceeds ${MAX_EXECUTE_REQUEST_BYTES} bytes.`);
	}
	validateGraph(request.tasks);
	return request;
}

export function parseResumeRequest(value: unknown): ResumeRequest {
	if (!Check(ResumeRequestSchema, value)) throw new Error("auto_dag_resume request must match one declared v9 action.");
	if (value.action !== "replace") return value;
	return { ...value, task: normalizeTask(value.task, 0) };
}

export function parseId(value: unknown): string {
	if (!Check(IdOnlySchema, value)) throw new Error("request must contain exactly one valid id.");
	return value.id;
}

export function parseRunState(value: unknown): RunState {
	if (!Check(RunStateSchema, value)) throw new Error("Unsupported or malformed pi-auto-dag v9 state.");
	const request = parseExecuteRequest(value.request);
	if (value.tasks.length !== request.tasks.length) throw new Error("Malformed pi-auto-dag v9 state task count.");
	for (const [index, task] of value.tasks.entries()) {
		if (task.request.id !== request.tasks[index]!.id) throw new Error("Malformed pi-auto-dag v9 state task order.");
	}
	return { ...value, request } as RunState;
}
