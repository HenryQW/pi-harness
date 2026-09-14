import assert from "node:assert/strict";
import test from "node:test";
import {
	MAX_TASKS,
	parseExecuteRequest,
	parseRunState,
	RUN_STATE_VERSION,
	taskDependencies,
	type ChangesetTaskRequest,
	type ExecuteRequest,
	type RunState,
	type TaskRequest,
	type TextTaskRequest,
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

test("v2 state discriminates text tasks and rejects v1 and launch state", () => {
	const definition = parseExecuteRequest(request([
		textTask("research"),
		changesetTask("change", { contextFrom: ["research"] }),
	]));
	const valid = state(definition);
	assert.doesNotThrow(() => parseRunState(structuredClone(valid)));

	const completedWithoutOutput = structuredClone(valid) as RunState;
	const completedTextAttempt = completedWithoutOutput.tasks[0]!;
	if (completedTextAttempt.kind !== "text") throw new Error("Expected a text task.");
	delete completedTextAttempt.attempts[0]!.output;
	assert.throws(() => parseRunState(completedWithoutOutput), /completed text attempt.*lacks output/i);

	const completedAttemptWithoutTaskCompletion = structuredClone(valid) as RunState;
	const textTaskWithOutput = completedAttemptWithoutTaskCompletion.tasks[0]!;
	if (textTaskWithOutput.kind !== "text") throw new Error("Expected a text task.");
	textTaskWithOutput.status = "running";
	assert.throws(() => parseRunState(completedAttemptWithoutTaskCompletion), /must be completed when its latest attempt is completed/i);

	const outputWithoutCompletion = structuredClone(valid) as RunState;
	const textAttempt = outputWithoutCompletion.tasks[0]!;
	if (textAttempt.kind !== "text") throw new Error("Expected a text task.");
	textAttempt.attempts[0]!.status = "failed";
	assert.throws(() => parseRunState(outputWithoutCompletion), /output without completion/);
	delete textAttempt.attempts[0]!.output;
	assert.throws(() => parseRunState(outputWithoutCompletion), /completed text task.*latest completed attempt/i);

	const oldTaskField = structuredClone(valid) as RunState & { tasks: Array<Record<string, unknown>> };
	oldTaskField.tasks[1]!.implementerLaunchKey = "implementer/balanced";
	assert.throws(() => parseRunState(oldTaskField), /Unsupported or malformed pi-orchestrator v2 state/);

	const oldLaunchState = { ...structuredClone(valid), launchRecords: {} };
	assert.throws(() => parseRunState(oldLaunchState), /Unsupported or malformed pi-orchestrator v2 state/);

	const v1 = { ...structuredClone(valid), version: 1, launchRecords: {} };
	assert.throws(() => parseRunState(v1), /Unsupported pi-orchestrator state version 1; expected 2/);
});
