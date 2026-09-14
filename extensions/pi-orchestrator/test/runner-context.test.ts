import assert from "node:assert/strict";
import test from "node:test";
import {
	formatTextTaskContexts,
	readyPendingTasks,
	resolveTextTaskContexts,
} from "../src/runner.ts";
import type {
	ChangesetTaskRequest,
	ChangesetTaskState,
	RunState,
	TaskRequest,
	TaskState,
	TextTaskRequest,
	TextTaskState,
} from "../src/schema.ts";

function textTask(
	id: string,
	options: { dependsOn?: string[]; contextFrom?: string[] } = {},
): TextTaskRequest {
	return {
		id,
		kind: "text",
		role: "researcher",
		modelClass: "fast",
		requirements: `Research ${id}.`,
		deliverable: `Explain ${id}.`,
		dependsOn: options.dependsOn ?? [],
		contextFrom: options.contextFrom ?? [],
	};
}

function changesetTask(
	id: string,
	options: { dependsOn?: string[]; contextFrom?: string[] } = {},
): ChangesetTaskRequest {
	return {
		id,
		kind: "changeset",
		role: "implementer",
		modelClass: "fast",
		requirements: `Implement ${id}.`,
		deliverable: `Deliver ${id}.`,
		dependsOn: options.dependsOn ?? [],
		contextFrom: options.contextFrom ?? [],
		checks: [{ command: "check", args: [] }],
	};
}

function changesetState(taskId: string, status: ChangesetTaskState["status"]): ChangesetTaskState {
	return { taskId, kind: "changeset", status, attempts: [] };
}

function pendingTextState(taskId: string): TextTaskState {
	return { taskId, kind: "text", status: "pending", attempts: [] };
}

function runningTextState(taskId: string): TextTaskState {
	return { taskId, kind: "text", status: "running", attempts: [{ number: 1, status: "running" }] };
}

function completedTextState(taskId: string, text?: string): TextTaskState {
	return {
		taskId,
		kind: "text",
		status: "completed",
		attempts: [{ number: 1, status: "completed", ...(text === undefined ? {} : { output: { text } }) }],
	};
}

function runnerState(definitions: TaskRequest[], tasks: TaskState[]): RunState {
	return { request: { tasks: definitions }, tasks } as unknown as RunState;
}

test("ready tasks include text and wait for every dependency source", () => {
	const source = textTask("research");
	const dependency = changesetTask("dependency");
	const textConsumer = textTask("summary", { dependsOn: [dependency.id], contextFrom: [source.id] });
	const changesetConsumer = changesetTask("change", { dependsOn: [dependency.id], contextFrom: [source.id] });
	const definitions = [source, dependency, textConsumer, changesetConsumer];

	assert.deepEqual(
		readyPendingTasks(runnerState(definitions, [
			pendingTextState(source.id),
			changesetState(dependency.id, "completed"),
			pendingTextState(textConsumer.id),
			changesetState(changesetConsumer.id, "pending"),
		])).map(({ taskId }) => taskId),
		[source.id],
	);
	assert.deepEqual(
		readyPendingTasks(runnerState(definitions, [
			completedTextState(source.id, "Research result."),
			changesetState(dependency.id, "pending"),
			pendingTextState(textConsumer.id),
			changesetState(changesetConsumer.id, "pending"),
		])).map(({ taskId }) => taskId),
		[dependency.id],
	);
	assert.deepEqual(
		readyPendingTasks(runnerState(definitions, [
			completedTextState(source.id, "Research result."),
			changesetState(dependency.id, "completed"),
			pendingTextState(textConsumer.id),
			changesetState(changesetConsumer.id, "pending"),
		])).map(({ taskId }) => taskId),
		[textConsumer.id, changesetConsumer.id],
	);
});

test("text context resolution and formatting preserve declared source order", () => {
	const consumer = changesetTask("change", { contextFrom: ["second", "first"] });
	const contexts = resolveTextTaskContexts({
		tasks: [completedTextState("first", "First result."), completedTextState("second", "Second result.")],
	}, consumer);

	assert.deepEqual(contexts, [
		{ taskId: "second", text: "Second result." },
		{ taskId: "first", text: "First result." },
	]);
	assert.equal(
		formatTextTaskContexts(contexts, 1_024),
		"Context from task second:\nSecond result.\n\nContext from task first:\nFirst result.",
	);
});

test("text context resolution rejects absent, non-text, incomplete, and missing output sources", () => {
	const consumer = changesetTask("change", { contextFrom: ["research"] });
	for (const [name, tasks, pattern] of [
		["absent", [], /is absent/],
		["non-text", [changesetState("research", "completed")], /not a text task/],
		["incomplete", [runningTextState("research")], /is incomplete/],
		["missing output", [completedTextState("research")], /missing output/],
	] as const) {
		assert.throws(() => resolveTextTaskContexts({ tasks }, consumer), pattern, name);
	}
});

test("text context formatter caps total UTF-8 bytes without truncation", () => {
	const contexts = [{ taskId: "research", text: "界" }];
	const formatted = "Context from task research:\n界";
	const cap = Buffer.byteLength(formatted, "utf8");

	assert.equal(formatTextTaskContexts(contexts, cap), formatted);
	assert.throws(() => formatTextTaskContexts(contexts, cap - 1), /exceeds .* UTF-8 bytes/);
	assert.throws(() => formatTextTaskContexts(contexts, Number.NaN), /byte cap/);
});
