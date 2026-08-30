import { StringEnum } from "@earendil-works/pi-ai";
import { PROFILE_NAMES } from "@henryqw/pi-task-models";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { TaskNameSchema, normalizeTaskName } from "./task-name.ts";

export const MAX_WORKFLOW_ENTRIES = 8;

const RoleSchema = Type.String({ minLength: 1, description: "Configured Subagent role name" });
const TaskSchema = Type.String({ minLength: 1, description: "Bounded task packet" });
const ModelSchema = Type.String({ minLength: 1, description: "Designated model as provider/modelId; replaces the selected route model" });
const ModelClassSchema = StringEnum(PROFILE_NAMES, { description: "Task model profile" });

export const DelegationSchema = Type.Object({
	role: RoleSchema,
	name: TaskNameSchema,
	task: TaskSchema,
	model: Type.Optional(ModelSchema),
	modelClass: Type.Optional(ModelClassSchema),
}, { additionalProperties: false });

export const WorkflowSchema = Type.Object({
	role: Type.Optional(RoleSchema),
	name: Type.Optional(TaskNameSchema),
	task: Type.Optional(TaskSchema),
	model: Type.Optional(ModelSchema),
	modelClass: Type.Optional(ModelClassSchema),
	tasks: Type.Optional(Type.Array(DelegationSchema, {
		minItems: 1,
		maxItems: MAX_WORKFLOW_ENTRIES,
		description: "Independent delegations to run concurrently",
	})),
	chain: Type.Optional(Type.Array(DelegationSchema, {
		minItems: 1,
		maxItems: MAX_WORKFLOW_ENTRIES,
		description: "Dependent delegations to run sequentially",
	})),
	background: Type.Optional(Type.Boolean({ description: "Run the selected workflow without blocking" })),
}, {
	additionalProperties: false,
	description: "Exactly one mode: role, name, and task; tasks; or chain",
});

export type Delegation = Static<typeof DelegationSchema>;
export type WorkflowMode = "single" | "parallel" | "chain";
export type ParsedWorkflow =
	| { mode: "single"; background: boolean; delegations: [Delegation] }
	| { mode: "parallel"; background: boolean; delegations: Delegation[] }
	| { mode: "chain"; background: boolean; delegations: Delegation[] };

type WorkflowInput = Static<typeof WorkflowSchema>;

const DELEGATION_KEYS = ["role", "name", "task", "model", "modelClass"] as const;

function text(value: string, path: string): string {
	const normalized = value.trim();
	if (!normalized || value.includes("\0")) throw new Error(`${path} must be non-empty text without NUL.`);
	return normalized;
}

function normalizeDelegation(value: Delegation, path: string): Delegation {
	return {
		role: text(value.role, `${path}.role`),
		name: normalizeTaskName(value.name, `${path}.name`),
		task: text(value.task, `${path}.task`),
		...(value.model === undefined ? {} : { model: text(value.model, `${path}.model`) }),
		...(value.modelClass === undefined ? {} : { modelClass: value.modelClass }),
	};
}

function hasDelegation(value: WorkflowInput): value is WorkflowInput & Delegation {
	return Object.hasOwn(value, "role") && Object.hasOwn(value, "name") && Object.hasOwn(value, "task");
}

function workflowMode(value: unknown): WorkflowMode | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return;
	const single = DELEGATION_KEYS.some((key) => Object.hasOwn(value, key));
	const parallel = Object.hasOwn(value, "tasks");
	const chain = Object.hasOwn(value, "chain");
	if (Number(single) + Number(parallel) + Number(chain) !== 1) {
		throw new Error("workflow must select exactly one mode: role, name, and task; tasks; or chain.");
	}
	return single ? "single" : parallel ? "parallel" : "chain";
}

export function parseWorkflow(value: unknown): ParsedWorkflow {
	const mode = workflowMode(value);
	if (!Check(WorkflowSchema, value)) throw new Error("workflow must match the declared tool schema.");
	if (!mode) throw new Error("workflow must select exactly one mode: role, name, and task; tasks; or chain.");
	const input = value;
	const background = input.background ?? false;
	if (mode === "single") {
		if (!hasDelegation(input)) throw new Error("workflow requires role, name, and task.");
		return { mode, background, delegations: [normalizeDelegation(input, "workflow")] };
	}
	if (mode === "parallel") return {
		mode,
		background,
		delegations: input.tasks!.map((delegation, index) => normalizeDelegation(delegation, `tasks[${index}]`)),
	};
	return {
		mode,
		background,
		delegations: input.chain!.map((delegation, index) => normalizeDelegation(delegation, `chain[${index}]`)),
	};
}

export type WorkflowEntry = {
	id: string;
	mode: WorkflowMode;
	index: number;
	delegation: Delegation;
};

export function identifyWorkflowEntries(toolCallId: string, workflow: ParsedWorkflow): WorkflowEntry[] {
	return workflow.delegations.map((delegation, index) => ({
		id: `${toolCallId}:${workflow.mode}:${index}`,
		mode: workflow.mode,
		index,
		delegation,
	}));
}

export type DelegationExecution<T> =
	| { ok: true; assistantOutput: string; result: T }
	| { ok: false; result: T };

export type DelegationRunner<T> = (
	entry: WorkflowEntry,
) => DelegationExecution<T> | Promise<DelegationExecution<T>>;

export type WorkflowEntryOutcome<T> =
	| { status: "succeeded"; entry: WorkflowEntry; assistantOutput: string; result: T }
	| { status: "failed"; entry: WorkflowEntry; result: T }
	| { status: "rejected"; entry: WorkflowEntry; reason: unknown };

async function runEntry<T>(entry: WorkflowEntry, run: DelegationRunner<T>): Promise<WorkflowEntryOutcome<T>> {
	try {
		const execution = await run(entry);
		return execution.ok
			? { status: "succeeded", entry, assistantOutput: execution.assistantOutput, result: execution.result }
			: { status: "failed", entry, result: execution.result };
	} catch (reason) {
		return { status: "rejected", entry, reason };
	}
}

/** Run only foreground policy. Callback failures are `rejected`; parent aborts are rethrown after started work settles. */
export async function runForegroundWorkflow<T>(
	toolCallId: string,
	workflow: ParsedWorkflow,
	run: DelegationRunner<T>,
	signal?: AbortSignal,
): Promise<WorkflowEntryOutcome<T>[]> {
	if (workflow.background) throw new Error("Background workflows cannot use foreground orchestration.");
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
		const chained = {
			...entry,
			delegation: {
				...entry.delegation,
				task: entry.delegation.task.replaceAll("{previous}", () => previous),
			},
		};
		const outcome = await runEntry(chained, run);
		signal?.throwIfAborted();
		outcomes.push(outcome);
		if (outcome.status !== "succeeded") break;
		previous = outcome.assistantOutput;
	}
	return outcomes;
}
