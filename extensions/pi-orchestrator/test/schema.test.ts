import assert from "node:assert/strict";
import test from "node:test";
import {
	MAX_PERSISTED_RUNTIME_TEXT_BYTES,
	MAX_TASKS,
	parseExecuteRequest,
	parseRunState,
	RUN_STATE_VERSION,
	taskDependencies,
	type ChangesetTaskRequest,
	type ExecuteRequest,
	type RunState,
	type TaskRequest,
	type TextTaskAttempt,
	type TextTaskRequest,
	type TextTaskState,
	type WorkspaceIdentity,
} from "../src/schema.ts";

type TaskOptions = {
	dependsOn?: string[];
	contextFrom?: string[];
	role?: string;
};

function textTask(id: string, options: TaskOptions = {}): TextTaskRequest {
	return {
		id,
		kind: "text",
		role: options.role ?? "researcher",
		modelClass: "fast",
		requirements: `Research ${id}.`,
		deliverable: `Explain ${id}.`,
		dependsOn: options.dependsOn ?? [],
		contextFrom: options.contextFrom ?? [],
	};
}

function changesetTask(id: string, options: TaskOptions & { judgment?: ChangesetTaskRequest["judgment"] } = {}): ChangesetTaskRequest {
	return {
		id,
		kind: "changeset",
		role: options.role ?? "implementer",
		modelClass: "balanced",
		requirements: `Implement ${id}.`,
		deliverable: `Deliver ${id}.`,
		dependsOn: options.dependsOn ?? [],
		contextFrom: options.contextFrom ?? [],
		checks: [{ command: `check-${id}`, args: [] }],
		...(options.judgment ? { judgment: options.judgment } : {}),
	};
}

function request(tasks: TaskRequest[], finalJudgment?: ExecuteRequest["finalJudgment"]): ExecuteRequest {
	return {
		id: "request-one",
		goal: "Deliver checked work.",
		budgetMs: 1_000,
		tasks,
		finalChecks: [{ command: "check-final", args: [] }],
		...(finalJudgment ? { finalJudgment } : {}),
	};
}

function identity(): WorkspaceIdentity {
	return {
		branch: "refs/heads/main",
		head: "a".repeat(40),
		index: "a".repeat(40),
		tree: "a".repeat(40),
	};
}

function state(requestValue: ExecuteRequest): RunState {
	const main = identity();
	return {
		version: RUN_STATE_VERSION,
		request: requestValue,
		root: "/repo",
		requestStartMain: main,
		main,
		deadlineStartedAt: 1,
		deadline: 1_001,
		status: "pending",
		tasks: requestValue.tasks.map((task): RunState["tasks"][number] => task.kind === "text"
			? {
				taskId: task.id,
				kind: "text",
				status: "completed",
				attempts: [{ number: 1, status: "completed", output: { text: "Research result." } }],
			}
			: { taskId: task.id, kind: "changeset", status: "pending", attempts: [] }),
		waves: [],
		final: { status: "pending" },
		accepted: false,
		createdAt: 1,
		updatedAt: 1,
	};
}

test("task variants require explicit Role names and preserve text context order", () => {
	const parsed = parseExecuteRequest(request([
		textTask("plan", { role: "  planner  " }),
		textTask("research", { role: "  custom role/v2  " }),
		textTask("notes"),
		changesetTask("change", {
			dependsOn: ["plan"],
			contextFrom: ["research", "notes"],
			role: "  maintainer  ",
			judgment: { role: "  reviewer  ", modelClass: "frontier", criterion: "Review exactly." },
		}),
	], { role: "  final reviewer  ", modelClass: "fav", criterion: "Accept only complete work." }));

	assert.equal(parsed.tasks[0]!.role, "planner");
	assert.equal(parsed.tasks[1]!.role, "custom role/v2");
	const change = parsed.tasks[3]!;
	assert.equal(change.kind, "changeset");
	if (change.kind !== "changeset") throw new Error("Expected a changeset task.");
	assert.equal(change.role, "maintainer");
	assert.equal(change.judgment?.role, "reviewer");
	assert.equal(parsed.finalJudgment?.role, "final reviewer");
	assert.deepEqual(change.contextFrom, ["research", "notes"]);
	assert.deepEqual(taskDependencies(change), ["plan", "research", "notes"]);

	const changeset = changesetTask("change");
	const { checks: _checks, ...changesetWithoutChecks } = changeset;
	const { role: _role, ...textWithoutRole } = textTask("text");
	const strictFailures: unknown[] = [
		request([{ ...textTask("text"), checks: [{ command: "forbidden", args: [] }] } as unknown as TaskRequest]),
		request([{ ...textTask("text"), judgment: { role: "reviewer", modelClass: "fast", criterion: "forbidden" } } as unknown as TaskRequest]),
		request([changesetWithoutChecks as unknown as TaskRequest]),
		request([textWithoutRole as unknown as TaskRequest]),
		request([changesetTask("change", { judgment: { modelClass: "fast", criterion: "missing role" } as unknown as ChangesetTaskRequest["judgment"] })]),
		request([textTask("text")], { modelClass: "fast", criterion: "missing role" } as unknown as ExecuteRequest["finalJudgment"]),
	];
	for (const value of strictFailures) assert.throws(() => parseExecuteRequest(value), /strict task schema/);
	assert.throws(() => parseExecuteRequest(request([textTask("text", { role: "bad\nrole" })])), /name must not contain C0\/C1 control characters/);
});

test("the graph rejects invalid context edges and detects context cycles", () => {
	const invalidGraphs: TaskRequest[][] = [
		Array.from({ length: MAX_TASKS + 1 }, (_, index) => textTask(`task-${index}`)),
		[textTask("duplicate"), changesetTask("duplicate")],
		[changesetTask("change", { dependsOn: ["missing"] })],
		[changesetTask("change", { contextFrom: ["missing"] })],
		[textTask("source"), changesetTask("change", { dependsOn: ["source", "source"] })],
		[textTask("source"), changesetTask("change", { contextFrom: ["source", "source"] })],
		[textTask("self", { dependsOn: ["self"] })],
		[textTask("self", { contextFrom: ["self"] })],
		[textTask("source"), changesetTask("change", { dependsOn: ["source"], contextFrom: ["source"] })],
		[changesetTask("source"), changesetTask("change", { contextFrom: ["source"] })],
		[textTask("first", { contextFrom: ["second"] }), textTask("second", { contextFrom: ["first"] })],
	];
	for (const tasks of invalidGraphs) assert.throws(() => parseExecuteRequest(request(tasks)));
});

test("v2 state maps text task attempts exactly and rejects v1 and launch state", () => {
	const definition = parseExecuteRequest(request([
		textTask("research"),
		changesetTask("change", { contextFrom: ["research"] }),
	]));
	const valid = state(definition);
	const output = { text: "Research result." };
	type TextStateMapping = {
		name: string;
		status: TextTaskState["status"];
		attempts: TextTaskAttempt[];
		taskFailure?: string;
		accepted: boolean;
	};
	const mappings: TextStateMapping[] = [
		{ name: "pending with no attempts", status: "pending", attempts: [], accepted: true },
		{ name: "pending with a running attempt", status: "pending", attempts: [{ number: 1, status: "running" }], accepted: false },
		{ name: "pending with a completed attempt", status: "pending", attempts: [{ number: 1, status: "completed", output }], accepted: false },
		{ name: "pending with a failed attempt", status: "pending", attempts: [{ number: 1, status: "failed" }], accepted: false },
		{ name: "running with no attempts", status: "running", attempts: [], accepted: false },
		{ name: "running with a running attempt", status: "running", attempts: [{ number: 1, status: "running" }], accepted: true },
		{ name: "running with a completed attempt", status: "running", attempts: [{ number: 1, status: "completed", output }], accepted: false },
		{ name: "running with a failed attempt", status: "running", attempts: [{ number: 1, status: "failed" }], accepted: false },
		{ name: "completed with no attempts", status: "completed", attempts: [], accepted: false },
		{ name: "completed with a running attempt", status: "completed", attempts: [{ number: 1, status: "running" }], accepted: false },
		{ name: "completed with a completed attempt", status: "completed", attempts: [{ number: 1, status: "completed", output }], accepted: true },
		{ name: "completed with a failed attempt", status: "completed", attempts: [{ number: 1, status: "failed" }], accepted: false },
		{ name: "needs_attention with no attempts", status: "needs_attention", attempts: [], taskFailure: "Task failed.", accepted: false },
		{ name: "needs_attention with a running attempt", status: "needs_attention", attempts: [{ number: 1, status: "running" }], taskFailure: "Task failed.", accepted: false },
		{ name: "needs_attention with a completed attempt", status: "needs_attention", attempts: [{ number: 1, status: "completed", output }], taskFailure: "Task failed.", accepted: false },
		{ name: "needs_attention with a failed attempt", status: "needs_attention", attempts: [{ number: 1, status: "failed", failure: "Task failed." }], taskFailure: "Task failed.", accepted: true },
		{ name: "needs_attention with no latest attempt failure", status: "needs_attention", attempts: [{ number: 1, status: "failed" }], taskFailure: "Task failed.", accepted: false },
		{ name: "needs_attention with a mismatched latest attempt failure", status: "needs_attention", attempts: [{ number: 1, status: "failed", failure: "Attempt failed." }], taskFailure: "Task failed.", accepted: false },
		{ name: "pending with a task failure", status: "pending", attempts: [], taskFailure: "Unexpected failure.", accepted: false },
		{ name: "running with a task failure", status: "running", attempts: [{ number: 1, status: "running" }], taskFailure: "Unexpected failure.", accepted: false },
		{ name: "completed with a task failure", status: "completed", attempts: [{ number: 1, status: "completed", output }], taskFailure: "Unexpected failure.", accepted: false },
		{ name: "needs_attention without a task failure", status: "needs_attention", attempts: [{ number: 1, status: "failed" }], accepted: false },
		{ name: "running after a failed attempt", status: "running", attempts: [
			{ number: 1, status: "failed", failure: "First attempt failed." },
			{ number: 2, status: "running" },
		], accepted: true },
		{ name: "completed after a failed attempt", status: "completed", attempts: [
			{ number: 1, status: "failed" },
			{ number: 2, status: "completed", output },
		], accepted: true },
		{ name: "needs_attention after a failed attempt", status: "needs_attention", attempts: [
			{ number: 1, status: "failed" },
			{ number: 2, status: "failed", failure: "Retry failed." },
		], taskFailure: "Retry failed.", accepted: true },
		{ name: "running after a non-latest running attempt", status: "running", attempts: [
			{ number: 1, status: "running" },
			{ number: 2, status: "running" },
		], accepted: false },
		{ name: "completed after a non-latest completed attempt", status: "completed", attempts: [
			{ number: 1, status: "completed", output },
			{ number: 2, status: "completed", output },
		], accepted: false },
		{ name: "needs_attention after a non-latest failed output", status: "needs_attention", attempts: [
			{ number: 1, status: "failed", output },
			{ number: 2, status: "failed" },
		], taskFailure: "Retry failed.", accepted: false },
		{ name: "completed without output", status: "completed", attempts: [{ number: 1, status: "completed" }], accepted: false },
		{ name: "needs_attention with failed output", status: "needs_attention", attempts: [{ number: 1, status: "failed", output }], taskFailure: "Task failed.", accepted: false },
	];
	for (const mapping of mappings) {
		const candidate = structuredClone(valid);
		const task = candidate.tasks[0]!;
		if (task.kind !== "text") throw new Error("Expected a text task.");
		task.status = mapping.status;
		task.attempts = structuredClone(mapping.attempts);
		if (mapping.taskFailure === undefined) delete task.failure;
		else task.failure = mapping.taskFailure;
		if (mapping.accepted) assert.doesNotThrow(() => parseRunState(candidate), mapping.name);
		else assert.throws(() => parseRunState(candidate), mapping.name);
	}

	const oldTaskField = structuredClone(valid) as RunState & { tasks: Array<Record<string, unknown>> };
	oldTaskField.tasks[1]!.implementerLaunchKey = "implementer/balanced";
	assert.throws(() => parseRunState(oldTaskField), /Unsupported or malformed pi-orchestrator v2 state/);

	const oldLaunchState = { ...structuredClone(valid), launchRecords: {} };
	assert.throws(() => parseRunState(oldLaunchState), /Unsupported or malformed pi-orchestrator v2 state/);

	const v1 = { ...structuredClone(valid), version: 1, launchRecords: {} };
	assert.throws(() => parseRunState(v1), /Unsupported pi-orchestrator state version 1; expected 2/);
});

test("v2 state bounds multibyte text task runtime fields by UTF-8 bytes", () => {
	const definition = parseExecuteRequest(request([textTask("research")]));
	const valid = state(definition);
	const character = "界";
	const repeated = character.repeat(Math.floor(MAX_PERSISTED_RUNTIME_TEXT_BYTES / Buffer.byteLength(character, "utf8")));
	const atLimit = `${repeated}${"a".repeat(MAX_PERSISTED_RUNTIME_TEXT_BYTES - Buffer.byteLength(repeated, "utf8"))}`;
	const tooLong = `${atLimit}${character}`;
	assert.equal(Buffer.byteLength(atLimit, "utf8"), MAX_PERSISTED_RUNTIME_TEXT_BYTES);
	assert.ok(tooLong.length <= MAX_PERSISTED_RUNTIME_TEXT_BYTES);

	const outputAtLimit = structuredClone(valid);
	const outputTask = outputAtLimit.tasks[0]!;
	if (outputTask.kind !== "text") throw new Error("Expected a text task.");
	outputTask.attempts[0]!.output = { text: atLimit };
	assert.doesNotThrow(() => parseRunState(outputAtLimit));

	const invalidFields: Array<{ name: string; mutate: (task: TextTaskState) => void }> = [
		{
			name: "attempt failure",
			mutate: (task) => {
				task.status = "needs_attention";
				task.attempts = [{ number: 1, status: "failed", failure: tooLong }];
				task.failure = "Task failed.";
			},
		},
		{
			name: "task failure",
			mutate: (task) => {
				task.status = "needs_attention";
				task.attempts = [{ number: 1, status: "failed" }];
				task.failure = tooLong;
			},
		},
		{
			name: "output",
			mutate: (task) => {
				task.status = "completed";
				task.attempts = [{ number: 1, status: "completed", output: { text: tooLong } }];
			},
		},
	];
	for (const { name, mutate } of invalidFields) {
		const candidate = structuredClone(valid);
		const task = candidate.tasks[0]!;
		if (task.kind !== "text") throw new Error("Expected a text task.");
		mutate(task);
		assert.throws(() => parseRunState(candidate), new RegExp(`exceeds ${MAX_PERSISTED_RUNTIME_TEXT_BYTES} UTF-8 bytes`), name);
	}
});
