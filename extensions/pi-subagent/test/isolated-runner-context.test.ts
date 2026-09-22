import assert from "node:assert/strict";
import test from "node:test";
import {
	buildChangesetTaskPrompt,
	buildTextTaskPrompt,
	formatTextTaskContexts,
	readyPendingTasks,
	resolveTextTaskContexts,
} from "../src/runner.ts";
import {
	parseRunState,
	RUN_STATE_VERSION,
	type ChangesetTaskRequest,
	type ChangesetTaskState,
	type RunState,
	type TaskRequest,
	type TaskState,
	type TextTaskRequest,
	type TextTaskState,
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
	const main = {
		branch: "refs/heads/main",
		head: "a".repeat(40),
		index: "a".repeat(40),
		tree: "a".repeat(40),
	};
	return parseRunState({
		version: RUN_STATE_VERSION,
		request: {
			id: "context-readiness",
			goal: "Test dependency readiness.",
			mode: "isolated",
			tasks: definitions,
			finalChecks: [{ command: "check", args: [] }],
		},
		policy: {
			maxSubagents: 5,
			maxTurns: 50,
			childIdleMs: 600_000,
			childMaxMs: 1_800_000,
			maxCorrections: 1,
		},
		correctionCount: 0,
		root: "/repo",
		requestStartMain: main,
		main,
		status: "pending",
		tasks,
		waves: [],
		final: { status: "pending" },
		accepted: false,
		createdAt: 1,
		updatedAt: 1,
	});
}

test("ready tasks include text and wait for every dependency source", () => {
	const source = textTask("research");
	const dependency = textTask("dependency");
	const textConsumer = textTask("summary", { dependsOn: [dependency.id], contextFrom: [source.id] });
	const changesetConsumer = changesetTask("change", { dependsOn: [dependency.id], contextFrom: [source.id] });
	const definitions = [source, dependency, textConsumer, changesetConsumer];

	assert.deepEqual(
		readyPendingTasks(runnerState(definitions, [
			pendingTextState(source.id),
			completedTextState(dependency.id, "Dependency result."),
			pendingTextState(textConsumer.id),
			changesetState(changesetConsumer.id, "pending"),
		])).map(({ taskId }) => taskId),
		[source.id],
	);
	assert.deepEqual(
		readyPendingTasks(runnerState(definitions, [
			completedTextState(source.id, "Research result."),
			pendingTextState(dependency.id),
			pendingTextState(textConsumer.id),
			changesetState(changesetConsumer.id, "pending"),
		])).map(({ taskId }) => taskId),
		[dependency.id],
	);
	assert.deepEqual(
		readyPendingTasks(runnerState(definitions, [
			completedTextState(source.id, "Research result."),
			completedTextState(dependency.id, "Dependency result."),
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

test("changeset prompts preserve ordered context as bounded task data", () => {
	const task = changesetTask("change", { dependsOn: ["dependency"] });
	const prompt = buildChangesetTaskPrompt({
		goal: "Implement the researched change.",
		contexts: [
			{ taskId: "second", text: "Second result." },
			{ taskId: "first", text: "First result." },
		],
		task,
		kind: "initial",
		worktreeCwd: "/repo/worktree",
	});

	assert.ok(prompt.indexOf("Context from task second:\nSecond result.") < prompt.indexOf("Context from task first:\nFirst result."));
	assert.match(prompt, /Integrated dependencies: dependency/);
	assert.throws(
		() => buildChangesetTaskPrompt({
			goal: "Implement the researched change.",
			contexts: [{ taskId: "research", text: "界".repeat(33_000) }],
			task,
			kind: "initial",
			worktreeCwd: "/repo/worktree",
		}),
		/exceeds .* UTF-8 bytes|Worker assignment exceeds/,
	);
});

test("changeset follow-ups reuse task context with a bounded revision prompt", () => {
	const task = changesetTask("change");
	const prompt = buildChangesetTaskPrompt({
		goal: "Implement the researched change.",
		contexts: [],
		task,
		kind: "followup",
		instruction: "Adjust the implementation based on the live review.",
		worktreeCwd: "/repo/worktree",
	});

	assert.match(prompt, /Follow-up:\nAdjust the implementation based on the live review\./);
	assert.match(prompt, /Continue the same task/);
	assert.doesNotMatch(prompt, /Goal:\n/);
	assert.throws(
		() => buildChangesetTaskPrompt({
			goal: "Implement the researched change.",
			contexts: [],
			task,
			kind: "followup",
			instruction: "  invalid  ",
			worktreeCwd: "/repo/worktree",
		}),
		/follow-up instruction/,
	);
});

test("text task prompts preserve ordered context as task data", () => {
	const task = textTask("summary");
	assert.equal(
		buildTextTaskPrompt("Summarize the research.", task, [
			{ taskId: "second", text: "Second result." },
			{ taskId: "first", text: "First result." },
		]),
		[
			"Task: summary",
			"Goal:",
			"Summarize the research.",
			"",
			"Requirements:",
			"Research summary.",
			"",
			"Deliverable:",
			"Explain summary.",
			"",
			"Task data:",
			"Context from task second:\nSecond result.",
			"",
			"Context from task first:\nFirst result.",
		].join("\n"),
	);
});

test("text task prompts cap total multibyte UTF-8 bytes without truncation", () => {
	const task = textTask("summary");
	const goal = "Summarize the research.";
	const maxBytes = 64 * 1024;
	const prefix = `${[
		`Task: ${task.id}`,
		"Goal:",
		goal,
		"",
		"Requirements:",
		task.requirements,
		"",
		"Deliverable:",
		task.deliverable,
		"",
		"Task data:",
		"Context from task research:",
	].join("\n")}\n`;
	const availableBytes = maxBytes - Buffer.byteLength(prefix, "utf8");
	const character = "界";
	const repeated = character.repeat(Math.floor(availableBytes / Buffer.byteLength(character, "utf8")));
	const output = `${repeated}${"a".repeat(availableBytes - Buffer.byteLength(repeated, "utf8"))}`;

	const prompt = buildTextTaskPrompt(goal, task, [{ taskId: "research", text: output }]);
	assert.equal(Buffer.byteLength(prompt, "utf8"), maxBytes);
	assert.ok(prompt.endsWith(output));
	assert.throws(
		() => buildTextTaskPrompt(goal, task, [{ taskId: "research", text: `${output}a` }]),
		/exceeds .* UTF-8 bytes/,
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
