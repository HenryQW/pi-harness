import { StringEnum } from "@earendil-works/pi-ai";
import { DISPLAY_TEXT_CONTRACT } from "@henryqw/pi-subagent";
import { PROFILE_NAMES } from "@henryqw/pi-task-models";
import { Type, type Static } from "typebox";
import { Check, Errors } from "typebox/value";
import { CheckCommandSchema, ExecuteRequestSchema, JudgmentSchema, parseExecuteRequest, type ExecuteRequest } from "../src/schema.ts";
import { TaskNameSchema, normalizeTaskName } from "./task-name.ts";

export const MAX_WORKFLOW_ENTRIES = 8;

const RoleSchema = Type.String({ minLength: 1, pattern: DISPLAY_TEXT_CONTRACT.pattern, description: "Configured Subagent role name" });
const TaskSchema = Type.String({ minLength: 1, description: "Bounded task packet" });
const ModelSchema = Type.String({ minLength: 1, pattern: DISPLAY_TEXT_CONTRACT.pattern, description: "Designated model as provider/modelId; replaces the selected route model" });
const ModelClassSchema = StringEnum(PROFILE_NAMES, { description: "Task model profile" });
const DirectKindSchema = StringEnum(["text", "changeset"] as const);

export const DelegationSchema = Type.Object({
	role: RoleSchema,
	name: TaskNameSchema,
	task: TaskSchema,
	kind: Type.Optional(DirectKindSchema),
	checks: Type.Optional(Type.Array(CheckCommandSchema, { minItems: 1, maxItems: 32 })),
	judgment: Type.Optional(JudgmentSchema),
	model: Type.Optional(ModelSchema),
	modelClass: Type.Optional(ModelClassSchema),
}, { additionalProperties: false });

export const DirectWorkflowSchema = Type.Object({
	mode: Type.Literal("direct"),
	role: Type.Optional(RoleSchema),
	name: Type.Optional(TaskNameSchema),
	task: Type.Optional(TaskSchema),
	kind: Type.Optional(DirectKindSchema),
	checks: Type.Optional(Type.Array(CheckCommandSchema, { minItems: 1, maxItems: 32 })),
	judgment: Type.Optional(JudgmentSchema),
	model: Type.Optional(ModelSchema),
	modelClass: Type.Optional(ModelClassSchema),
	tasks: Type.Optional(Type.Array(DelegationSchema, { minItems: 1, maxItems: MAX_WORKFLOW_ENTRIES })),
	chain: Type.Optional(Type.Array(DelegationSchema, { minItems: 1, maxItems: MAX_WORKFLOW_ENTRIES })),
}, { additionalProperties: false, description: "Direct mode: exactly one compact single, tasks, or chain workflow" });

export const DelegateTaskSchema = Type.Union([DirectWorkflowSchema, ExecuteRequestSchema]);
export const WorkflowSchema = DirectWorkflowSchema;

export type Delegation = Static<typeof DelegationSchema> & { kind: "text" | "changeset" };
export type WorkflowMode = "single" | "parallel" | "chain";
export type ParsedWorkflow =
	| { mode: "single"; delegations: [Delegation] }
	| { mode: "parallel"; delegations: Delegation[] }
	| { mode: "chain"; delegations: Delegation[] };
export type ParsedDelegateTask = { mode: "direct"; workflow: ParsedWorkflow } | { mode: "isolated"; request: ExecuteRequest };

type DirectInput = Static<typeof DirectWorkflowSchema>;
const DELEGATION_KEYS = ["role", "name", "task", "kind", "checks", "judgment", "model", "modelClass"] as const;

function text(value: string, path: string): string {
	const normalized = value.trim();
	if (!normalized || value.includes("\0")) throw new Error(`${path} must be non-empty text without NUL.`);
	return normalized;
}

function normalizeDelegation(value: Static<typeof DelegationSchema>, path: string): Delegation {
	const kind = value.kind ?? "text";
	if (kind === "changeset") throw new Error(`${path}.kind=changeset requires mode isolated; direct delegation is read-only.`);
	if (kind === "text" && value.checks !== undefined) throw new Error(`${path}.checks is only valid for a direct changeset.`);
	if (kind === "text" && value.judgment !== undefined) throw new Error(`${path}.judgment is only valid for a direct changeset.`);
	return {
		role: text(value.role, `${path}.role`),
		name: normalizeTaskName(value.name, `${path}.name`),
		task: text(value.task, `${path}.task`),
		kind,
		...(value.checks === undefined ? {} : { checks: value.checks.map((check) => ({ command: text(check.command, `${path}.checks.command`), args: [...check.args] })) }),
		...(value.judgment === undefined ? {} : { judgment: { ...value.judgment, role: text(value.judgment.role, `${path}.judgment.role`), criterion: text(value.judgment.criterion, `${path}.judgment.criterion`) } }),
		...(value.model === undefined ? {} : { model: text(value.model, `${path}.model`) }),
		...(value.modelClass === undefined ? {} : { modelClass: value.modelClass }),
	};
}

function hasDelegation(value: DirectInput): value is DirectInput & Static<typeof DelegationSchema> {
	return Object.hasOwn(value, "role") && Object.hasOwn(value, "name") && Object.hasOwn(value, "task");
}

function workflowMode(value: unknown): WorkflowMode | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return;
	const single = DELEGATION_KEYS.some((key) => Object.hasOwn(value, key));
	const parallel = Object.hasOwn(value, "tasks");
	const chain = Object.hasOwn(value, "chain");
	if (Number(single) + Number(parallel) + Number(chain) !== 1) throw new Error("direct workflow must select exactly one of single, tasks, or chain.");
	return single ? "single" : parallel ? "parallel" : "chain";
}

export function parseWorkflow(value: unknown): ParsedWorkflow {
	const mode = workflowMode(value);
	if (!Check(DirectWorkflowSchema, value)) {
		const issue = Errors(DirectWorkflowSchema, value)[0];
		throw new Error(`direct workflow must match the declared tool schema${issue ? ` at ${issue.instancePath || "/"}: ${issue.message}` : ""}.`);
	}
	if (!mode) throw new Error("direct workflow must select exactly one of single, tasks, or chain.");
	const input = value as DirectInput;
	if (mode === "single") {
		if (!hasDelegation(input)) throw new Error("direct workflow requires role, name, and task.");
		return { mode, delegations: [normalizeDelegation(input, "workflow")] };
	}
	if (mode === "parallel") return { mode, delegations: input.tasks!.map((item, index) => normalizeDelegation(item, `tasks[${index}]`)) };
	return { mode, delegations: input.chain!.map((item, index) => normalizeDelegation(item, `chain[${index}]`)) };
}

export function parseDelegateTask(value: unknown): ParsedDelegateTask {
	if (value && typeof value === "object" && !Array.isArray(value) && (value as { mode?: unknown }).mode === "isolated") {
		return { mode: "isolated", request: parseExecuteRequest(value) };
	}
	return { mode: "direct", workflow: parseWorkflow(value) };
}

export type WorkflowEntry = { id: string; index: number; delegation: Delegation };
export function identifyWorkflowEntries(toolCallId: string, workflow: ParsedWorkflow): WorkflowEntry[] {
	return workflow.delegations.map((delegation, index) => ({ id: `${toolCallId}:${workflow.mode}:${index}`, index, delegation }));
}

export type DelegationExecution<T> = { ok: true; assistantOutput: string; result: T } | { ok: false; result: T };
export type DelegationRunner<T> = (entry: WorkflowEntry) => DelegationExecution<T> | Promise<DelegationExecution<T>>;
export type WorkflowEntryOutcome<T> =
	| { status: "succeeded"; entry: WorkflowEntry; assistantOutput: string; result: T }
	| { status: "failed"; entry: WorkflowEntry; result: T }
	| { status: "rejected"; entry: WorkflowEntry; reason: unknown };

async function runEntry<T>(entry: WorkflowEntry, run: DelegationRunner<T>): Promise<WorkflowEntryOutcome<T>> {
	try {
		const execution = await run(entry);
		return execution.ok ? { status: "succeeded", entry, assistantOutput: execution.assistantOutput, result: execution.result }
			: { status: "failed", entry, result: execution.result };
	} catch (reason) {
		return { status: "rejected", entry, reason };
	}
}

export async function runForegroundWorkflow<T>(
	toolCallId: string,
	workflow: ParsedWorkflow,
	run: DelegationRunner<T>,
	signal?: AbortSignal,
): Promise<WorkflowEntryOutcome<T>[]> {
	signal?.throwIfAborted();
	const entries = identifyWorkflowEntries(toolCallId, workflow);
	if (workflow.mode === "single") {
		const outcome = await runEntry(entries[0]!, run);
		signal?.throwIfAborted();
		return [outcome];
	}
	if (workflow.mode === "parallel") {
		const outcomes = await Promise.all(entries.map((entry) => runEntry(entry, run)));
		signal?.throwIfAborted();
		return outcomes;
	}
	const outcomes: WorkflowEntryOutcome<T>[] = [];
	let previous = "";
	for (const entry of entries) {
		const selected = workflow.mode === "chain" ? {
			...entry,
			delegation: { ...entry.delegation, task: entry.delegation.task.replaceAll("{previous}", () => previous) },
		} : entry;
		const outcome = await runEntry(selected, run);
		signal?.throwIfAborted();
		outcomes.push(outcome);
		if (outcome.status !== "succeeded" && workflow.mode === "chain") break;
		if (outcome.status === "succeeded") previous = outcome.assistantOutput;
	}
	return outcomes;
}
