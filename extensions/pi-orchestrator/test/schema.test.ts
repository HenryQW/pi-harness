import assert from "node:assert/strict";
import test from "node:test";
import {
	MAX_TASKS,
	parseExecuteRequest,
	type ExecuteRequest,
	type TaskRequest,
} from "../src/schema.ts";

function task(id: string, dependsOn: string[] = []): TaskRequest {
	return {
		id,
		modelClass: "fast",
		requirements: `Implement ${id}.`,
		deliverable: `Deliver ${id}.`,
		dependsOn,
		checks: [{ command: `check-${id}`, args: [] }],
	};
}

function request(tasks: TaskRequest[]): ExecuteRequest {
	return {
		id: "request-one",
		goal: "Deliver checked work.",
		budgetMs: 10_000,
		tasks,
		finalChecks: [{ command: "check-final", args: [] }],
	};
}

test("the strict graph rejects excess, unknown, duplicate, self, and cyclic dependencies", () => {
	const invalidGraphs: TaskRequest[][] = [
		Array.from({ length: MAX_TASKS + 1 }, (_, index) => task(`task-${index}`)),
		[task("task-a", ["missing"])],
		[task("task-a", ["task-b", "task-b"]), task("task-b")],
		[task("task-a", ["task-a"])],
		[task("task-a", ["task-b"]), task("task-b", ["task-a"])],
	];
	for (const tasks of invalidGraphs) assert.throws(() => parseExecuteRequest(request(tasks)));

	assert.throws(() => parseExecuteRequest({
		...request([task("task-a")]),
		tasks: [{ ...task("task-a"), role: "custom" }],
	}), /strict v1 schema/);
});
