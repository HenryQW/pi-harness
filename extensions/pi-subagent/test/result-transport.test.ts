import assert from "node:assert/strict";
import test from "node:test";
import { formatWorkflowResult, type WorkflowTransportEntry } from "../extensions/result-transport.ts";

const MAX_OUTPUT_BYTES = 50 * 1024;

function succeeded(index: number, assistantOutput: string, extra: Partial<WorkflowTransportEntry> = {}): WorkflowTransportEntry {
	return { id: `call:parallel:${index}`, index, name: `Task ${index + 1}`, role: `role-${index}`, status: "succeeded", assistantOutput, ...extra } as WorkflowTransportEntry;
}

function failed(index: number, failure: string, extra: Partial<WorkflowTransportEntry> = {}): WorkflowTransportEntry {
	return { id: `call:parallel:${index}`, index, name: `Task ${index + 1}`, role: `role-${index}`, status: "failed", failure, ...extra } as WorkflowTransportEntry;
}

test("formats ordered success and partial failure with exact follow-up details", () => {
	const result = formatWorkflowResult("parallel", [
		succeeded(1, "second evidence"),
		failed(0, "failure evidence", { model: "provider/one", thinkingLevel: "high" }),
	]);
	assert.equal(result.text, `Parallel delegation failed · 1 failed · 1 completed\n✗ [1/2] Task 1 · role-0 — failure evidence\n✓ [2/2] Task 2 · role-1 — second evidence\nResults:\n- [1/2] Task 1 · role-0 · failure:\nfailure evidence\n- [2/2] Task 2 · role-1 · result:\nsecond evidence`);
	assert.equal(result.failed, true);
	assert.deepEqual(result.details.entries, [
		{ id: "call:parallel:0", index: 0, name: "Task 1", role: "role-0", status: "failed", summary: "failure evidence", model: "provider/one", thinkingLevel: "high" },
		{ id: "call:parallel:1", index: 1, name: "Task 2", role: "role-1", status: "succeeded", summary: "second evidence" },
	]);
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
});
