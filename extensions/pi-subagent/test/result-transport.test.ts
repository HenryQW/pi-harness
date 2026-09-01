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
	return { id: `call:parallel:${index}`, index, name: `Task ${index + 1}`, role: `role-${index}`, status: "succeeded", assistantOutput, ...extra } as WorkflowTransportEntry;
}

function failed(index: number, failure: string, extra: Partial<WorkflowTransportEntry> = {}): WorkflowTransportEntry {
	return { id: `call:parallel:${index}`, index, name: `Task ${index + 1}`, role: `role-${index}`, status: "failed", failure, ...extra } as WorkflowTransportEntry;
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
	assert.equal(result.text, `Parallel delegation failed · 1 failed · 1 completed\n✗ [1/2] Task 1 · role-0 — failure evidence\n✓ [2/2] Task 2 · role-1 — second evidence\nRecovery:\n- [1/2] Task 1 · worktree "/repo/.worktrees/retained" · branch "pi-subagent/retained"\nResults:\n- [1/2] Task 1 · role-0 · failure:\nfailure evidence\n- [2/2] Task 2 · role-1 · result:\nsecond evidence`);
	assert.deepEqual(result.details.entries, [
		{ id: "call:parallel:0", index: 0, name: "Task 1", role: "role-0", status: "failed", summary: "failure evidence", model: "provider/one", thinkingLevel: "high", worktree },
		{ id: "call:parallel:1", index: 1, name: "Task 2", role: "role-1", status: "succeeded", summary: "second evidence" },
	]);
});

test("orders details and sums usage", () => {
	const entries = [succeeded(2, "two", { model: "provider/two", thinkingLevel: "low", usage: usage(2) }), succeeded(0, "zero", { usage: usage(1) })];
	const result = formatWorkflowResult("parallel", entries);
	assert.deepEqual(result.details.entries.map(({ id, index, name, role }) => ({ id, index, name, role })), [
		{ id: "call:parallel:0", index: 0, name: "Task 1", role: "role-0" },
		{ id: "call:parallel:2", index: 2, name: "Task 3", role: "role-2" },
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
	const running: WorkflowTransportEntry = { id: "call:0", index: 0, name: "Inspect auth", role: "worker", status: "running", assistantOutput: "partial" };
	assert.throws(() => formatWorkflowResult("single", [running]), /terminal/);
	assert.throws(() => formatBackgroundWorkflowResult("single", [running]), /terminal/);
	const update = formatWorkflowUpdate("parallel", [
		running,
		{ id: "call:1", index: 1, name: "Map callers", role: "scout", status: "pending" },
	]);
	assert.equal(update.text, "Parallel delegation · 1 running · 1 queued\n◌ [1/2] Inspect auth · worker — partial\n○ [2/2] Map callers · scout — queued");
	assert.equal(update.details.entries[0]!.summary, "partial");
	assert.doesNotMatch(update.text, /call:|Evidence:|no output yet/);
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
