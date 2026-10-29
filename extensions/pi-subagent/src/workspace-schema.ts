import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { CheckCommandSchema, ExecutionPolicySnapshotSchema, ExecuteRequestSchema, parseExecuteRequest, TaskAttemptSchema, WorkspaceSchema, WorktreeRecordSchema, sameIdentity, type ChangesetTaskRequest, type WorkspaceIdentity } from "./schema.ts";
import { RepositorySelectionSchema, parseRepositorySelection } from "./workspace-scope.ts";

const Name = Type.String({ pattern: "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$", maxLength: 80 });
const Text = Type.String({ minLength: 1, maxLength: 8192 });
export const WorkspaceCheckSchema = Type.Object({ ...CheckCommandSchema.properties, repository: Name }, { additionalProperties: false });
export const WorkspaceTaskSchema = Type.Object({
	...ExecuteRequestSchema.properties.tasks.items.anyOf[1].properties,
	checks: Type.Array(WorkspaceCheckSchema, { minItems: 1, maxItems: 32 }),
	inputs: Type.Optional(RepositorySelectionSchema),
}, { additionalProperties: false });
export const WorkspaceRequestSchema = Type.Object({
	...ExecuteRequestSchema.properties,
	repositories: RepositorySelectionSchema,
	tasks: Type.Array(WorkspaceTaskSchema, { minItems: 1, maxItems: 1 }),
	finalChecks: Type.Array(WorkspaceCheckSchema, { minItems: 1, maxItems: 32 }),
}, { additionalProperties: false });
export type WorkspaceRequest = Static<typeof WorkspaceRequestSchema>;
export type WorkspaceCheck = Static<typeof WorkspaceCheckSchema>;
export const IdentitySetSchema = Type.Record(Name, WorkspaceSchema, { minProperties: 1, maxProperties: 8 });
export type IdentitySet = Static<typeof IdentitySetSchema>;
const ACTIONS = ["status", "stage", "validate", "promote", "reconcile", "abort", "cleanup"] as const;
const STATUSES = ["allocating", "working", "checking", "ready", "staging", "staged", "validating", "validated", "promoting", "partial", "promoted", "aborted", "attention", "cleaned"] as const;
export const WorkspaceActionSchema = Type.Object({
	id: ExecuteRequestSchema.properties.id,
	action: Type.Unsafe<typeof ACTIONS[number]>({ type: "string", enum: [...ACTIONS] }),
	expected: Type.Optional(IdentitySetSchema),
}, { additionalProperties: false });
export type WorkspaceAction = Static<typeof WorkspaceActionSchema>;

export function parseWorkspaceRequest(value: unknown): WorkspaceRequest {
	if (!Check(WorkspaceRequestSchema, value)) throw new Error("Workspace requests require one changeset task, explicit repositories, and repository-tagged checks.");
	parseRepositorySelection(value.repositories);
	const task = value.tasks[0]!;
	if (task.dependsOn.length || task.contextFrom.length || task.judgment || value.finalJudgment) throw new Error("Workspace requests do not support task dependencies, text tasks, or judgment. Use a single changeset task with explicit automated checks.");
	if (task.inputs) parseRepositorySelection(task.inputs);
	const strip = ({ repository: _repository, ...check }: WorkspaceCheck) => check;
	parseExecuteRequest({ mode: value.mode, id: value.id, goal: value.goal,
		tasks: [{ ...workerTask(value), checks: task.checks.map(strip) }], finalChecks: value.finalChecks.map(strip) });
	for (const check of [...task.checks, ...value.finalChecks]) {
		if (!Object.hasOwn(value.repositories, check.repository)) throw new Error(`Check selects unknown repository ${check.repository}.`);
	}
	for (const repository of Object.keys(value.repositories)) {
		if (!task.checks.some((check) => check.repository === repository)) throw new Error(`Task checks are missing for repository ${repository}.`);
	}
	return structuredClone(value);
}

export function workerTask(request: WorkspaceRequest): ChangesetTaskRequest {
	const { inputs: _inputs, checks, ...task } = request.tasks[0]!;
	return { ...task, checks: checks.map(({ repository: _repository, ...check }) => check) };
}
export function sameSet(left: IdentitySet, right: IdentitySet): boolean {
	return Object.keys(left).length === Object.keys(right).length && Object.keys(left).every((name) => right[name] && sameIdentity(left[name]!, right[name]!));
}
const Receipt = Type.Object({ previous: WorkspaceSchema, worker: WorkspaceSchema, tip: WorkspaceSchema }, { additionalProperties: false });
const RepoState = Type.Object({
	root: Text, common: Text, base: WorkspaceSchema, testScript: Text, attempt: TaskAttemptSchema,
	integration: Type.Optional(WorktreeRecordSchema),
	allocation: Type.Optional(Type.Union([Type.Literal("allocating"), Type.Literal("owned")])),
	stage: Type.Optional(Type.Union([Type.Literal("staging"), Type.Literal("staged"), Type.Literal("unchanged")])),
	receipt: Type.Optional(Receipt),
	promotion: Type.Optional(Type.Object({
		status: Type.Union([Type.Literal("pending"), Type.Literal("promoting"), Type.Literal("promoted")]),
		expected: WorkspaceSchema, tip: WorkspaceSchema, mainAfter: Type.Optional(WorkspaceSchema),
	}, { additionalProperties: false })),
	cleanup: Type.Optional(Type.Array(Type.String({ enum: ["worker_tab", "workspace", "worker", "worker_branch", "integration", "integration_branch"] }), { uniqueItems: true, maxItems: 6 })),
}, { additionalProperties: false });
const CheckResult = Type.Object({ ...WorkspaceCheckSchema.properties, code: Type.Integer(), killed: Type.Boolean(), stdout: Type.String({ maxLength: 8192 }), stderr: Type.String({ maxLength: 8192 }) }, { additionalProperties: false });
const Evidence = Type.Object({ before: IdentitySetSchema, after: IdentitySetSchema, results: Type.Array(CheckResult, { maxItems: 40 }) }, { additionalProperties: false });
export const WorkspaceStateSchema = Type.Object({
	version: Type.Literal(1), root: Text, request: WorkspaceRequestSchema,
	status: Type.Unsafe<typeof STATUSES[number]>({ type: "string", enum: [...STATUSES] }),
	policy: ExecutionPolicySnapshotSchema,
	repositories: Type.Record(Name, RepoState, { minProperties: 1, maxProperties: 8 }),
	inputs: Type.Record(Name, Type.Object({ source: Text, path: Text, digest: Type.String({ pattern: "^[a-f0-9]{64}$" }) }, { additionalProperties: false }), { maxProperties: 8 }),
	candidates: Type.Optional(IdentitySetSchema), tips: Type.Optional(IdentitySetSchema),
	preliminary: Type.Optional(Evidence), final: Type.Optional(Evidence),
	failure: Type.Optional(Text),
}, { additionalProperties: false });
export type WorkspaceState = Static<typeof WorkspaceStateSchema>;
export type WorkspaceEvidence = NonNullable<WorkspaceState["final"]>;
export function parseWorkspaceState(value: unknown): WorkspaceState {
	if (!Check(WorkspaceStateSchema, value)) throw new Error("Workspace state is invalid; preserve the file and all resources.");
	parseWorkspaceRequest(value.request);
	const names = Object.keys(value.repositories);
	const complete = (set: Record<string, unknown>) => names.length === Object.keys(set).length && names.every((name) => Object.hasOwn(set, name));
	if (!complete(value.request.repositories) || value.candidates && !complete(value.candidates) || value.tips && !complete(value.tips)) throw new Error("Workspace state has an incomplete repository set.");
	for (const [name, repo] of Object.entries(value.repositories)) {
		if (repo.root !== value.request.repositories[name] || !sameIdentity(repo.base, repo.attempt.waveBase)) throw new Error("Workspace repository base or root changed.");
		if (repo.promotion && (!value.tips || !sameIdentity(repo.promotion.tip, value.tips[name]!) || !sameIdentity(repo.promotion.expected, repo.base))) throw new Error("Workspace promotion intent changed.");
		if (repo.promotion?.status === "promoted" && (!repo.promotion.mainAfter || !sameIdentity(repo.promotion.mainAfter, { ...repo.promotion.tip, branch: repo.base.branch }))) throw new Error("Workspace promotion receipt is invalid.");
	}
	for (const evidence of [value.preliminary, value.final]) if (evidence && (!complete(evidence.before) || !complete(evidence.after))) throw new Error("Workspace checks have an incomplete input set.");
	return value;
}
export function setFrom(state: WorkspaceState, field: "base" | "candidate"): IdentitySet {
	return Object.fromEntries(Object.entries(state.repositories).map(([name, repo]) => {
		const identity: WorkspaceIdentity | undefined = field === "base" ? repo.base : repo.attempt.candidate;
		if (!identity) throw new Error(`Repository ${name} has no ${field}.`);
		return [name, identity];
	}));
}
