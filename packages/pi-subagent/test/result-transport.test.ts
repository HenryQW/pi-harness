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
	return { id: `call:parallel:${index}`, index, role: `role-${index}`, task: `task-${index}`, status: "succeeded", assistantOutput, ...extra } as WorkflowTransportEntry;
}

function failed(index: number, failure: string, extra: Partial<WorkflowTransportEntry> = {}): WorkflowTransportEntry {
	return { id: `call:parallel:${index}`, index, role: `role-${index}`, task: `task-${index}`, status: "failed", failure, ...extra } as WorkflowTransportEntry;
}

function usage(factor: number): Usage {
	return { input: factor, output: factor * 2, cacheRead: 0, cacheWrite: 0, totalTokens: factor * 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: factor } };
}

test("keeps complete bounded model-facing content and recovery evidence", () => {
	const worktree = { path: "/repo/.worktrees/retained", branch: "pi-subagent/retained", commits: 1, dirty: false, pruned: false };
	const result = formatWorkflowResult("parallel", [
		succeeded(1, "second evidence"),
		failed(0, "failure evidence", { model: "provider/one", thinkingLevel: "high", worktreePayload: worktree }),
	]);
	assert.equal(result.text, `Workflow failed.\nMode: parallel\nEntries:\n- [0] id="call:parallel:0" role="role-0" status=failed\n- [1] id="call:parallel:1" role="role-1" status=succeeded\nRetained worktrees:\n- [0] path="/repo/.worktrees/retained" branch="pi-subagent/retained"\nEvidence:\n- [0] "call:parallel:0" failure:\nfailure evidence\n- [1] "call:parallel:1" assistant:\nsecond evidence`);
	assert.deepEqual(result.details.entries, [
		{ id: "call:parallel:0", index: 0, role: "role-0", status: "failed", task: "task-0", summary: "failure evidence", model: "provider/one", thinkingLevel: "high", worktree },
		{ id: "call:parallel:1", index: 1, role: "role-1", status: "succeeded", task: "task-1", summary: "second evidence" },
	]);
});

test("orders details and sums usage", () => {
	const entries = [succeeded(2, "two", { model: "provider/two", thinkingLevel: "low", usage: usage(2) }), succeeded(0, "zero", { usage: usage(1) })];
	const result = formatWorkflowResult("parallel", entries);
	assert.deepEqual(result.details.entries.map(({ id, index, role }) => ({ id, index, role })), [
		{ id: "call:parallel:0", index: 0, role: "role-0" },
		{ id: "call:parallel:2", index: 2, role: "role-2" },
	]);
	assert.equal(result.details.entries[1]!.model, "provider/two");
	assert.equal(result.details.entries[1]!.thinkingLevel, "low");
	assert.deepEqual(result.usage, { input: 3, output: 6, cacheRead: 0, cacheWrite: 0, totalTokens: 9, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 3 } });
});

test("bounds aggregate output on valid UTF-8 boundaries and rejects non-terminal finals", () => {
	const result = formatWorkflowResult("parallel", Array.from({ length: 8 }, (_, index) => succeeded(index, String(index).repeat(80 * 1024))));
	assert.ok(Buffer.byteLength(result.text, "utf8") <= MAX_OUTPUT_BYTES);
	assert.match(result.text, /\n\n\[Output truncated: \d+ bytes omitted\]$/);
	const unicode = formatWorkflowResult("single", [succeeded(0, "🙂界".repeat(30_000))]);
	assert.ok(Buffer.byteLength(unicode.text, "utf8") <= MAX_OUTPUT_BYTES);
	assert.equal(unicode.text.includes("�"), false);
	assert.equal(Buffer.from(unicode.text, "utf8").toString("utf8"), unicode.text);
	const running: WorkflowTransportEntry = { id: "call:0", index: 0, role: "worker", task: "work", status: "running", assistantOutput: "partial" };
	assert.throws(() => formatWorkflowResult("single", [running]), /terminal/);
	assert.throws(() => formatBackgroundWorkflowResult("single", [running]), /terminal/);
	assert.equal(formatWorkflowUpdate("single", [running]).details.entries[0]!.summary, "partial");
});

test("failure and abort errors retain bounded transport", () => {
	const entries = [failed(0, "broken", { usage: usage(1) })];
	const formatted = formatWorkflowResult("single", entries);
	const failure = new WorkflowFailureError("single", entries);
	assert.equal(failure.message, formatted.text);
	assert.deepEqual(failure.details, formatted.details);
	const cause = new Error("stopped");
	const aborted = new WorkflowAbortedError("single", entries, cause);
	assert.equal(aborted.cause, cause);
	assert.deepEqual(aborted.usage, usage(1));
});
