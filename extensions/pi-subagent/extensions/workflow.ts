import { StringEnum } from "@earendil-works/pi-ai";
import { DISPLAY_TEXT_CONTRACT } from "@henryqw/pi-subagent";
import { PROFILE_NAMES } from "@henryqw/pi-task-models";
import { Type, type Static } from "typebox";
import { Check, Errors } from "typebox/value";
import { ExecuteRequestSchema, parseExecuteRequest, type ExecuteRequest } from "../dist/schema.js";

export const MAX_WORKFLOW_ENTRIES = 8;

const TASK_NAME_MAX_LENGTH = 29;
const TaskNameSchema = Type.String({
	minLength: 1,
	maxLength: TASK_NAME_MAX_LENGTH,
	description: `Short descriptive task name, about five words and fewer than ${TASK_NAME_MAX_LENGTH + 1} characters; C0/C1 control characters are rejected.`,
	pattern: DISPLAY_TEXT_CONTRACT.pattern,
});

const RoleSchema = Type.String({ minLength: 1, pattern: DISPLAY_TEXT_CONTRACT.pattern, description: "Configured Subagent role name" });
const TaskSchema = Type.String({ minLength: 1, description: "Bounded task packet" });
const ModelSchema = Type.String({ minLength: 1, pattern: DISPLAY_TEXT_CONTRACT.pattern, description: "Designated model as provider/modelId; replaces the selected route model" });
const ModelClassSchema = StringEnum(PROFILE_NAMES, { description: "Task model profile" });
const DirectKindSchema = StringEnum(["text"] as const);

export const DelegationSchema = Type.Object({
	role: RoleSchema,
	name: TaskNameSchema,
	task: TaskSchema,
	kind: Type.Optional(DirectKindSchema),
	model: Type.Optional(ModelSchema),
	modelClass: Type.Optional(ModelClassSchema),
}, { additionalProperties: false });

export const DirectWorkflowSchema = Type.Object({
	mode: Type.Literal("direct"),
	role: Type.Optional(RoleSchema),
	name: Type.Optional(TaskNameSchema),
	task: Type.Optional(TaskSchema),
	kind: Type.Optional(DirectKindSchema),
	model: Type.Optional(ModelSchema),
	modelClass: Type.Optional(ModelClassSchema),
	tasks: Type.Optional(Type.Array(DelegationSchema, { minItems: 1, maxItems: MAX_WORKFLOW_ENTRIES })),
	chain: Type.Optional(Type.Array(DelegationSchema, { minItems: 1, maxItems: MAX_WORKFLOW_ENTRIES })),
}, { additionalProperties: false, description: "Direct mode: exactly one compact single, tasks, or chain workflow" });

export const DelegateTaskSchema = Type.Union([DirectWorkflowSchema, ExecuteRequestSchema]);
export const WorkflowSchema = DirectWorkflowSchema;

export type Delegation = Static<typeof DelegationSchema> & { kind: "text" };
export type WorkflowMode = "single" | "parallel" | "chain";
export type ParsedWorkflow =
	| { mode: "single"; delegations: [Delegation] }
	| { mode: "parallel"; delegations: Delegation[] }
	| { mode: "chain"; delegations: Delegation[] };
export type ParsedDelegateTask = { mode: "direct"; workflow: ParsedWorkflow } | { mode: "isolated"; request: ExecuteRequest };

type DirectInput = Static<typeof DirectWorkflowSchema>;
const DELEGATION_KEYS = ["role", "name", "task", "kind", "model", "modelClass"] as const;

function text(value: string, path: string): string {
	const normalized = value.trim();
	if (!normalized || value.includes("\0")) throw new Error(`${path} must be non-empty text without NUL.`);
	return normalized;
}

function normalizeTaskName(value: string, path: string): string {
	const normalized = value.trim();
	if (!normalized) throw new Error(`${path} must be non-empty text.`);
	return normalized;
}

function normalizeDelegation(value: Static<typeof DelegationSchema>, path: string): Delegation {
	return {
		role: text(value.role, `${path}.role`),
		name: normalizeTaskName(value.name, `${path}.name`),
		task: text(value.task, `${path}.task`),
		kind: "text",
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
		throw new Error(`direct workflow must match the declared tool schema${issue ? ` at ${issue.instancePath || "/"}: ${issue.message}` : ""}. Direct mode is read-only; use mode isolated for changesets.`);
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

export type DelegationRunner = (entry: WorkflowEntry) => string | Promise<string>;

async function runEntry(entry: WorkflowEntry, run: DelegationRunner): Promise<string | undefined> {
	try {
		return await run(entry);
	} catch {
		return undefined;
	}
}

export async function runForegroundWorkflow(
	mode: WorkflowMode,
	entries: readonly WorkflowEntry[],
	run: DelegationRunner,
	signal?: AbortSignal,
): Promise<void> {
	signal?.throwIfAborted();
	if (mode === "single") {
		await runEntry(entries[0]!, run);
		signal?.throwIfAborted();
		return;
	}
	if (mode === "parallel") {
		await Promise.all(entries.map((entry) => runEntry(entry, run)));
		signal?.throwIfAborted();
		return;
	}
	let previous = "";
	for (const entry of entries) {
		const selected = {
			...entry,
			delegation: { ...entry.delegation, task: entry.delegation.task.replaceAll("{previous}", () => previous) },
		};
		const output = await runEntry(selected, run);
		signal?.throwIfAborted();
		if (output === undefined) break;
		previous = output;
	}
}
