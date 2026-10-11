import assert from "node:assert/strict";
import test from "node:test";
import { formatWorkflowResult, type WorkflowTransportEntry } from "../extensions/result-transport.ts";

const MAX_OUTPUT_BYTES = 50 * 1024;

function succeeded(index: number, assistantOutput: string, extra: Partial<WorkflowTransportEntry> = {}): WorkflowTransportEntry {
	return { id: `call:parallel:${index}`, index, name: `Task ${index + 1}`, role: `role-${index}`, status: "succeeded", assistantOutput, ...extra } as WorkflowTransportEntry;
}

function rejected(index: number, failure: string, extra: Partial<WorkflowTransportEntry> = {}): WorkflowTransportEntry {
	return { id: `call:parallel:${index}`, index, name: `Task ${index + 1}`, role: `role-${index}`, status: "rejected", failure, ...extra } as WorkflowTransportEntry;
}

test("formats ordered success and partial failure with exact follow-up details and per-worker usage", () => {
	const result = formatWorkflowResult("parallel", [
		succeeded(1, "second evidence", { model: "provider/two", thinkingLevel: "low", tokens: 1_540, elapsedMs: 65_000 }),
		rejected(0, "failure evidence", { model: "provider/one", thinkingLevel: "high", elapsedMs: 3_000 }),
		{ id: "call:parallel:2", index: 2, name: "Task 3", role: "role-2", status: "skipped" },
	]);
	assert.equal(result.text, `Parallel delegation failed · 1 failed · 1 completed · 1 skipped\n✗ [1/3] Task 1 · role-0 · provider/one · thinking high · tokens unknown · 3s — failure evidence\n✓ [2/3] Task 2 · role-1 · provider/two · thinking low · 1.5k tok · 1m 5s — second evidence\n– [3/3] Task 3 · role-2 — skipped\nResults:\n- [1/3] Task 1 · role-0 · failure:\nfailure evidence\n- [2/3] Task 2 · role-1 · result:\nsecond evidence`);
	assert.equal(result.failed, true);
	assert.deepEqual(result.details.entries, [
		{ id: "call:parallel:0", index: 0, name: "Task 1", role: "role-0", status: "rejected", summary: "failure evidence", model: "provider/one", thinkingLevel: "high", elapsedMs: 3_000 },
		{ id: "call:parallel:1", index: 1, name: "Task 2", role: "role-1", status: "succeeded", summary: "second evidence", model: "provider/two", thinkingLevel: "low", tokens: 1_540, elapsedMs: 65_000 },
		{ id: "call:parallel:2", index: 2, name: "Task 3", role: "role-2", status: "skipped" },
	]);
});

test("bounds aggregate output on valid UTF-8 boundaries and rejects non-terminal finals", () => {
	const result = formatWorkflowResult("parallel", Array.from({ length: 8 }, (_, index) => succeeded(index, String(index).repeat(80 * 1024))));
	assert.ok(Buffer.byteLength(result.text, "utf8") <= MAX_OUTPUT_BYTES);
	assert.match(result.text, /\n\n\[Output truncated: \d+ bytes omitted\]$/);
	const unicode = formatWorkflowResult("single", [succeeded(0, "🙂界".repeat(30_000))]);
	assert.ok(Buffer.byteLength(unicode.text, "utf8") <= MAX_OUTPUT_BYTES);
	assert.equal(unicode.text.includes("�"), false);
	const running: WorkflowTransportEntry = { id: "call:0", index: 0, name: "Inspect auth", role: "worker", status: "running", assistantOutput: "partial" };
	assert.throws(() => formatWorkflowResult("single", [running]), /terminal/);
});
