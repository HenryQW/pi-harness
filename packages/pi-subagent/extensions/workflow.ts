import { StringEnum } from "@earendil-works/pi-ai";
import { PROFILE_NAMES, THINKING_LEVELS, type ProfileName, type ThinkingLevel } from "@henryqw/pi-task-models";
import { Type, type Static } from "typebox";

export const MAX_WORKFLOW_ENTRIES = 8;

const RoleSchema = Type.String({ minLength: 1, description: "Configured Subagent role name" });
const TaskSchema = Type.String({ minLength: 1, description: "Bounded task packet" });
const ModelSchema = Type.String({ minLength: 1, description: "Designated model as provider/modelId; overrides modelClass" });
const ModelClassSchema = StringEnum(PROFILE_NAMES, { description: "Task model profile" });
const ThinkingSchema = StringEnum(THINKING_LEVELS, { description: "Task thinking-level override" });

export const DelegationSchema = Type.Object({
	role: RoleSchema,
	task: TaskSchema,
	model: Type.Optional(ModelSchema),
	modelClass: Type.Optional(ModelClassSchema),
	thinking: Type.Optional(ThinkingSchema),
}, { additionalProperties: false });

export const WorkflowSchema = Type.Object({
	role: Type.Optional(RoleSchema),
	task: Type.Optional(TaskSchema),
	model: Type.Optional(ModelSchema),
	modelClass: Type.Optional(ModelClassSchema),
	thinking: Type.Optional(ThinkingSchema),
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
	description: "Exactly one mode: role and task, tasks, or chain",
});

export type Delegation = Static<typeof DelegationSchema>;
export type WorkflowMode = "single" | "parallel" | "chain";
export type ParsedWorkflow =
	| { mode: "single"; background: boolean; delegations: [Delegation] }
	| { mode: "parallel"; background: boolean; delegations: Delegation[] }
	| { mode: "chain"; background: boolean; delegations: Delegation[] };

const DELEGATION_KEYS = ["role", "task", "model", "modelClass", "thinking"] as const;
const TOP_LEVEL_KEYS = [...DELEGATION_KEYS, "tasks", "chain", "background"] as const;

function record(value: unknown, path: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object.`);
	return value as Record<string, unknown>;
}

function rejectUnknown(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
	const unknown = Object.keys(value).find((key) => !allowed.includes(key));
	if (unknown) throw new Error(`${path} contains unknown property ${JSON.stringify(unknown)}.`);
}

function text(value: unknown, path: string): string {
	if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
		throw new Error(`${path} must be non-empty text without NUL.`);
	}
	return value.trim();
}

function enumValue<T extends string>(value: unknown, values: readonly T[], path: string): T {
	if (typeof value !== "string" || !values.includes(value as T)) {
		throw new Error(`${path} must be one of: ${values.join(", ")}.`);
	}
	return value as T;
}

function parseDelegation(value: unknown, path: string, extraKeys: readonly string[] = []): Delegation {
	const input = record(value, path);
	rejectUnknown(input, [...DELEGATION_KEYS, ...extraKeys], path);
	if (!Object.hasOwn(input, "role") || !Object.hasOwn(input, "task")) {
		throw new Error(`${path} requires both role and task.`);
	}
	const delegation: Delegation = {
		role: text(input.role, `${path}.role`),
		task: text(input.task, `${path}.task`),
	};
	if (Object.hasOwn(input, "model")) delegation.model = text(input.model, `${path}.model`);
	if (Object.hasOwn(input, "modelClass")) {
		delegation.modelClass = enumValue(input.modelClass, PROFILE_NAMES, `${path}.modelClass`) as ProfileName;
	}
	if (Object.hasOwn(input, "thinking")) {
		delegation.thinking = enumValue(input.thinking, THINKING_LEVELS, `${path}.thinking`) as ThinkingLevel;
	}
	return delegation;
}

function parseDelegations(value: unknown, path: "tasks" | "chain"): Delegation[] {
	if (!Array.isArray(value)) throw new Error(`${path} must be an array.`);
	if (value.length < 1 || value.length > MAX_WORKFLOW_ENTRIES) {
		throw new Error(`${path} must contain 1 to ${MAX_WORKFLOW_ENTRIES} delegations.`);
	}
	return value.map((delegation, index) => parseDelegation(delegation, `${path}[${index}]`));
}

export function parseWorkflow(value: unknown): ParsedWorkflow {
	const input = record(value, "workflow");
	rejectUnknown(input, TOP_LEVEL_KEYS, "workflow");
	const background = Object.hasOwn(input, "background") ? input.background : false;
	if (typeof background !== "boolean") throw new Error("workflow.background must be a boolean.");

	const single = DELEGATION_KEYS.some((key) => Object.hasOwn(input, key));
	const parallel = Object.hasOwn(input, "tasks");
	const chain = Object.hasOwn(input, "chain");
	if (Number(single) + Number(parallel) + Number(chain) !== 1) {
		throw new Error("workflow must select exactly one mode: role and task, tasks, or chain.");
	}
	if (single) {
		return { mode: "single", background, delegations: [parseDelegation(input, "workflow", ["background"])] };
	}
	if (parallel) return { mode: "parallel", background, delegations: parseDelegations(input.tasks, "tasks") };
	return { mode: "chain", background, delegations: parseDelegations(input.chain, "chain") };
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
