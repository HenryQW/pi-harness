import assert from "node:assert/strict";
import test from "node:test";
import type { Usage } from "@earendil-works/pi-ai";
import {
	formatBackgroundWorkflowResult,
	formatWorkflowResult,
	formatWorkflowUpdate,
	WorkflowAbortedError,
	WorkflowFailureError,
	type WorkflowTransportEntry,
} from "../extensions/result-transport.ts";

const MAX_OUTPUT_BYTES = 50 * 1024;

function succeeded(index: number, assistantOutput: string, extra: Partial<WorkflowTransportEntry> = {}): WorkflowTransportEntry {
	return {
		id: `call:parallel:${index}`,
		index,
		role: `role-${index}`,
		task: `task-${index}`,
		aborted: false,
		status: "succeeded",
		assistantOutput,
		...extra,
	} as WorkflowTransportEntry;
}

function failed(index: number, failure: string, extra: Partial<WorkflowTransportEntry> = {}): WorkflowTransportEntry {
	return {
		id: `call:parallel:${index}`,
		index,
		role: `role-${index}`,
		task: `task-${index}`,
		aborted: false,
		status: "failed",
		failure,
		...extra,
	} as WorkflowTransportEntry;
}

function skipped(index: number): WorkflowTransportEntry {
	return { id: `call:chain:${index}`, index, role: `role-${index}`, task: `task-${index}`, aborted: false, status: "skipped" };
}

function usage(factor: number, optional = true): Usage {
	return {
		input: factor,
		output: factor * 2,
		cacheRead: factor * 3,
		cacheWrite: factor * 4,
		...(optional ? { cacheWrite1h: factor * 5, reasoning: factor * 6 } : {}),
		totalTokens: factor * 10,
		cost: {
			input: factor * 0.1,
			output: factor * 0.2,
			cacheRead: factor * 0.3,
			cacheWrite: factor * 0.4,
			total: factor,
		},
	};
}

test("caps one eight-entry aggregate at 50 KiB", () => {
	const entries = Array.from({ length: 8 }, (_, index) => succeeded(index, String(index).repeat(80 * 1024)));
	const result = formatWorkflowResult("parallel", entries);
	assert.ok(Buffer.byteLength(result.text, "utf8") <= MAX_OUTPUT_BYTES);
	assert.match(result.text, /\n\n\[Output truncated: \d+ bytes omitted\]$/);
	assert.equal((result.text.match(/\[Output truncated:/g) ?? []).length, 1);
});

test("truncates Unicode on a valid UTF-8 boundary", () => {
	const result = formatWorkflowResult("single", [succeeded(0, "🙂界".repeat(30_000))]);
	assert.ok(Buffer.byteLength(result.text, "utf8") <= MAX_OUTPUT_BYTES);
	assert.equal(result.text.includes("�"), false);
	assert.equal(Buffer.from(result.text, "utf8").toString("utf8"), result.text);
	assert.match(result.text, /\[Output truncated: \d+ bytes omitted\]$/);
});

test("orders entries by index without mutating input", () => {
	const entries = [
		succeeded(2, "evidence-two", { model: "provider/two", thinkingLevel: "high" }),
		succeeded(0, "evidence-zero"),
		failed(1, "failure-one"),
	];
	const before = structuredClone(entries);
	const result = formatWorkflowResult("parallel", entries);
	assert.deepEqual(entries, before);
	assert.deepEqual(result.details.entries.map(({ index }) => index), [0, 1, 2]);
	assert.ok(result.text.indexOf("call:parallel:0") < result.text.indexOf("call:parallel:1"));
	assert.ok(result.text.indexOf("call:parallel:1") < result.text.indexOf("call:parallel:2"));
	assert.deepEqual(result.details.entries[2], {
		id: "call:parallel:2",
		index: 2,
		role: "role-2",
		task: "task-2",
		status: "succeeded",
		summary: "evidence-two",
		model: "provider/two",
		thinkingLevel: "high",
		aborted: false,
	});
});

test("keeps successful sibling evidence visible on partial failure", () => {
	const result = formatWorkflowResult("parallel", [
		failed(0, "failure detail ".repeat(8_000)),
		succeeded(1, "successful sibling one"),
		succeeded(2, "successful sibling two"),
	]);
	assert.equal(result.failed, true);
	assert.match(result.text, /^Workflow failed\./);
	assert.match(result.text, /status=failed/);
	assert.match(result.text, /status=succeeded/);
	assert.match(result.text, /successful sibling one/);
	assert.match(result.text, /successful sibling two/);
});

test("puts every identity, status, and retained worktree location before evidence", () => {
	const worktree = {
		path: "/repo/.worktrees/subagent-abc",
		branch: "pi-subagent/subagent-abc",
		commits: 1,
		dirty: false,
		pruned: false,
	};
	const result = formatWorkflowResult("chain", [
		succeeded(1, "second excerpt"),
		succeeded(0, "first excerpt", { worktreePayload: worktree }),
	]);
	const evidenceAt = result.text.indexOf("Evidence:");
	for (const expected of ["call:parallel:0", "status=succeeded", worktree.path, worktree.branch, "call:parallel:1"]) {
		assert.ok(result.text.indexOf(expected) >= 0 && result.text.indexOf(expected) < evidenceAt, expected);
	}
	assert.deepEqual(result.details.entries[0]!.worktree, worktree);
});

test("sums complete Usage and cost fields without mutating them", () => {
	const first = usage(1);
	const second = usage(2, false);
	const entries = [succeeded(0, "one", { usage: first }), succeeded(1, "two", { usage: second })];
	const before = structuredClone(entries);
	const result = formatWorkflowResult("parallel", entries);
	assert.deepEqual(result.usage, {
		...usage(3, false),
		cacheWrite1h: 5,
		reasoning: 6,
	});
	assert.deepEqual(entries, before);
	assert.notEqual(result.usage, first);
	assert.notEqual(result.usage?.cost, first.cost);
});

test("uses deterministic success, failure, update, and background labels", () => {
	const success = [succeeded(0, "done")];
	const failure = [failed(0, "broken")];
	assert.match(formatWorkflowResult("single", success).text, /^Workflow succeeded\.\nMode: single/);
	assert.match(formatWorkflowResult("parallel", failure).text, /^Workflow failed\.\nMode: parallel/);
	assert.match(formatWorkflowUpdate("chain", [{
		id: "call:chain:0",
		index: 0,
		role: "worker",
		task: "work",
		aborted: false,
		status: "running",
		assistantOutput: "in progress",
	}]).text, /^Workflow update\.\nMode: chain/);
	assert.match(formatBackgroundWorkflowResult("parallel", success).text, /^Background workflow succeeded\./);
	assert.match(formatBackgroundWorkflowResult("parallel", failure).text, /^Background workflow failed\./);
});

test("final transports allow skipped entries without evidence and reject non-terminal states", () => {
	const result = formatWorkflowResult("chain", [failed(0, "stopped"), skipped(1)]);
	assert.deepEqual(result.details.entries.map(({ status }) => status), ["failed", "skipped"]);
	assert.match(result.text, /status=skipped/);
	assert.doesNotMatch(result.text, /call:chain:1 (?:assistant|failure):/);
	for (const status of ["pending", "running"] as const) {
		const entry = status === "pending"
			? { id: "call:chain:0", index: 0, role: "worker", task: "work", aborted: false, status }
			: { id: "call:chain:0", index: 0, role: "worker", task: "work", aborted: false, status, assistantOutput: "partial" };
		assert.throws(() => formatWorkflowResult("chain", [entry]), /terminal/);
		assert.throws(() => formatBackgroundWorkflowResult("chain", [entry]), /terminal/);
	}
});

test("WorkflowFailureError preserves the bounded aggregate details and usage", () => {
	const entries = [
		succeeded(0, "successful evidence", { usage: usage(1) }),
		failed(1, "failure evidence ".repeat(8_000), { usage: usage(2) }),
	];
	const formatted = formatWorkflowResult("parallel", entries);
	const error = new WorkflowFailureError("parallel", entries);
	assert.equal(error.name, "WorkflowFailureError");
	assert.equal(error.message, formatted.text);
	assert.deepEqual(error.details, formatted.details);
	assert.deepEqual(error.usage, formatted.usage);
	assert.equal(error.failed, true);
	assert.ok(Buffer.byteLength(error.message, "utf8") <= MAX_OUTPUT_BYTES);
	assert.throws(() => new WorkflowFailureError("single", [succeeded(0, "done")]), /requires a failed or rejected entry/);
});

test("WorkflowAbortedError preserves cause, usage, and recovery ordering", () => {
	const cause = new Error("parent stopped");
	const path = "/repo/.worktrees/retained";
	const entry = failed(0, "abort evidence", {
		status: "rejected",
		usage: usage(1),
		worktreePayload: {
			path,
			branch: "pi-subagent/retained",
			commits: 0,
			dirty: true,
			pruned: false,
		},
	});
	const error = new WorkflowAbortedError("single", [entry], cause);
	assert.equal(error.name, "AbortError");
	assert.equal(error.cause, cause);
	assert.deepEqual(error.usage, usage(1));
	assert.ok(error.message.indexOf(path) < error.message.indexOf("Evidence:"));
	assert.ok(Buffer.byteLength(error.message, "utf8") <= MAX_OUTPUT_BYTES);
});
