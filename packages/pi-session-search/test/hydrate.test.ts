import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, truncateSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { test } from "node:test";
import { getWindow, readSession } from "../extensions/hydrate.ts";
import { MAX_SESSION_FILE_BYTES } from "../extensions/search-core.ts";

const FIX = join(dirname(new URL(import.meta.url).pathname), "fixtures");

function write(name: string, lines: object[]) {
	const p = join(FIX, name);
	mkdirSync(FIX, { recursive: true });
	writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
	return p;
}

// Per-fixture message factory so ids are deterministic (e01, e02, …) within one file.
function mkMsgs() {
	let n = 0;
	return function msg(
		parentId: string | null,
		role: string,
		text: string,
		type = "message",
	): Record<string, unknown> {
		n++;
		const id = `e${String(n).padStart(2, "0")}`;
		return {
			type,
			id,
			parentId,
			timestamp: `2024-01-01T00:00:${String(n).padStart(2, "0")}.000Z`,
			...(type === "message"
				? { message: { role, content: [{ type: "text", text }] } }
				: {}),
		};
	};
}

test("hydration rejects a session larger than the indexing cap", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-session-hydrate-"));
	const session = join(dir, "oversized.jsonl");
	try {
		writeFileSync(session, "");
		truncateSync(session, MAX_SESSION_FILE_BYTES + 1);
		assert.throws(
			() => readSession(session),
			/32 MiB hydration limit.*oversized\.jsonl/,
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("linear session: window and read", () => {
	const msg = mkMsgs();
	const p = write("linear.jsonl", [
		{ type: "session", version: 3, id: "s1", timestamp: "2024-01-01T00:00:00.000Z", cwd: "/tmp/x" },
		msg(null, "user", "q1"),
		msg("e01", "assistant", "a1"),
		msg("e02", "user", "q2"),
		msg("e03", "assistant", "a2"),
	]);
	const w = getWindow(p, "e02", 1);
	assert.deepEqual(w.messages.map((m) => m.entryId), ["e01", "e02", "e03"]);
	assert.equal(w.messages[1].anchor, true);
	assert.equal(w.messagesBefore, 1);
	assert.equal(w.messagesAfter, 2);
	const r = readSession(p);
	assert.equal(r.truncated, false);
	assert.equal(r.totalMessages, 4);
});

test("fork tree: window counts only messages on anchor branch", () => {
	const msg = mkMsgs();
	// e01..e03 shared, then branch A (e04,e05) and branch B (e06,e07); leaf = e07 (branch B)
	const p = write("fork.jsonl", [
		{ type: "session", version: 3, id: "s1", timestamp: "2024-01-01T00:00:00.000Z", cwd: "/tmp/x" },
		msg(null, "user", "q1"), // e01
		msg("e01", "assistant", "a1"), // e02
		msg("e02", "user", "q2"), // e03
		msg("e03", "assistant", "A-a1"), // e04 branch A
		msg("e04", "user", "A-q2"), // e05
		msg("e03", "assistant", "B-a1"), // e06 branch B
		msg("e06", "user", "B-q2"), // e07 leaf
	]);
	const w = getWindow(p, "e06", 5);
	assert.deepEqual(w.messages.map((m) => m.entryId), ["e01", "e02", "e03", "e06", "e07"]);
	assert.equal(w.messagesBefore, 3); // only message entries before on branch B
	assert.equal(w.messagesAfter, 1);
	assert.equal(w.messages.find((m) => m.entryId === "e06")?.anchor, true);
	// re-anchor forward at last window id
	const w2 = getWindow(p, "e07", 5);
	assert.equal(w2.messagesBefore, 4);
	assert.equal(w2.messagesAfter, 0);
	// re-anchor backward at first window id
	const w3 = getWindow(p, "e01", 5);
	assert.deepEqual(w3.messages.map((m) => m.entryId), ["e01", "e02", "e03", "e06", "e07"]);
	assert.equal(w3.messagesBefore, 0);
	// read follows leaf branch (B)
	const r = readSession(p, 2, 2);
	assert.equal(r.truncated, true);
	assert.equal(r.totalMessages, 5);
	assert.deepEqual(r.messages.map((m) => m.entryId), ["e01", "e02", "e06", "e07"]);
});

test("branchTip selects branch independently of aroundMessageId center", () => {
	const msg = mkMsgs();
	// e01..e03 shared, branch A e04,e05; branch B e06,e07 (leaf).
	const p = write("fork.jsonl", [
		{ type: "session", version: 3, id: "s1", timestamp: "2024-01-01T00:00:00.000Z", cwd: "/tmp/x" },
		msg(null, "user", "q1"), // e01
		msg("e01", "assistant", "a1"), // e02
		msg("e02", "user", "q2"), // e03
		msg("e03", "assistant", "A-a1"), // e04 branch A
		msg("e04", "user", "A-q2"), // e05
		msg("e03", "assistant", "B-a1"), // e06 branch B
		msg("e06", "user", "B-q2"), // e07 leaf
	]);
	// Scroll backward on inactive branch A: anchor moves to shared root while
	// branchTip keeps the window on A instead of jumping to leaf branch B.
	const w = getWindow(p, "e01", 5, { branchTip: "e05" });
	assert.deepEqual(w.messages.map((m) => m.entryId), ["e01", "e02", "e03", "e04", "e05"]);
	assert.equal(w.messagesBefore, 0);
	assert.equal(w.messagesAfter, 4);
	assert.equal(w.branchTip, "e05");
	// Anchor on the other branch must be rejected.
	assert.throws(() => getWindow(p, "e06", 5, { branchTip: "e05" }), /not on branch/);
	assert.throws(() => getWindow(p, "e01", 5, { branchTip: "nope" }), /not found/);
});

test("interleaved non-message entries are transparent", () => {
	const msg = mkMsgs();
	const p = write("interleaved.jsonl", [
		{ type: "session", version: 3, id: "s1", timestamp: "2024-01-01T00:00:00.000Z", cwd: "/tmp/x" },
		msg(null, "user", "q1"),
		msg("e01", "assistant", "a1"),
		msg("e02", "user", "q2"),
		msg("e03", "assistant", "a2"),
		{ type: "model_change", id: "mc1", parentId: "e04", timestamp: "2024-01-01T00:00:05.000Z", provider: "openai", modelId: "gpt-4o" },
		msg("mc1", "user", "q3"), // e05
	]);
	const w = getWindow(p, "e03", 1);
	assert.deepEqual(w.messages.map((m) => m.entryId), ["e02", "e03", "e04"]);
	assert.equal(w.messagesAfter, 2); // model_change doesn't count
	const r = readSession(p);
	assert.equal(r.totalMessages, 5);
	assert.deepEqual(r.messages.map((m) => m.entryId), ["e01", "e02", "e03", "e04", "e05"]);
});

test("non-message branch tip centers on its nearest message ancestor", () => {
	const msg = mkMsgs();
	const p = write("throw.jsonl", [
		{ type: "session", version: 3, id: "s1", timestamp: "2024-01-01T00:00:00.000Z", cwd: "/tmp/x" },
		msg(null, "user", "q1"),
		{ type: "model_change", id: "mc1", parentId: "e01", timestamp: "t", provider: "x", modelId: "y" },
		msg("e01", "assistant", "sibling branch"),
	]);
	assert.throws(() => getWindow(p, "nope", 1), /not found/);
	const window = getWindow(p, "mc1", 1);
	assert.deepEqual(window.messages.map((m) => m.entryId), ["e01"], "later sibling branch must stay excluded");
	assert.equal(window.messages[0].anchor, true);
	assert.equal(window.branchTip, "mc1");
});

test("duplicate ids use the first entry consistently with indexing", () => {
	const p = write("duplicate.jsonl", [
		{ type: "session", version: 3, id: "s1", timestamp: "2024-01-01T00:00:00.000Z", cwd: "/tmp/x" },
		{ type: "custom", id: "dup", parentId: null, timestamp: "2024-01-01T00:00:01.000Z" },
		{ type: "message", id: "dup", parentId: null, timestamp: "2024-01-01T00:00:02.000Z", message: { role: "user", content: [{ type: "text", text: "duplicate searchable copy" }] } },
		{ type: "message", id: "child", parentId: "dup", timestamp: "2024-01-01T00:00:03.000Z", message: { role: "assistant", content: [{ type: "text", text: "child" }] } },
	]);
	const result = readSession(p);
	assert.deepEqual(result.messages.map((m) => m.content), ["child"]);
});

test("oversized entry and parent ids are rejected without corrupting the branch", () => {
	const msg = mkMsgs();
	const p = write("oversized-ids.jsonl", [
		{ type: "session", version: 3, id: "s1", timestamp: "t", cwd: "/tmp/x" },
		msg(null, "user", "root"),
		{ type: "message", id: "x".repeat(257), parentId: "e01", timestamp: "t", message: { role: "assistant", content: "bad id" } },
		{ type: "message", id: "bad-parent", parentId: "x".repeat(257), timestamp: "t", message: { role: "assistant", content: "bad parent" } },
		msg("e01", "assistant", "valid child"),
	]);
	const result = readSession(p);
	assert.deepEqual(result.messages.map((m) => m.entryId), ["e01", "e02"]);
});

test("parentId cycle terminates (corrupt file)", () => {
	const msg = mkMsgs();
	const a = msg("e02", "user", "q2") as Record<string, string>; a.parentId = "e03";
	const b = msg("e03", "assistant", "a2") as Record<string, string>; b.parentId = "e02";
	const p = write("cycle.jsonl", [
		{ type: "session", version: 3, id: "s1", timestamp: "2024-01-01T00:00:00.000Z", cwd: "/tmp/x" },
		msg(null, "user", "q1"), a, b,
	]);
	// Must not hang; cycle broken at revisit.
	const r = readSession(p);
	assert.ok(r.messages.length >= 1);
});

test("windowN clamped to [0,50]", () => {
	const p = join(FIX, "linear.jsonl");
	assert.equal(getWindow(p, "e02", 99).messages.length, 4);
	assert.equal(getWindow(p, "e02", -5).messages.length, 1);
});

test("read truncation head/tail + totals", () => {
	const msg = mkMsgs();
	const lines: object[] = [{ type: "session", version: 3, id: "s1", timestamp: "2024-01-01T00:00:00.000Z", cwd: "/tmp/x" }];
	let parent: string | null = null;
	for (let i = 0; i < 35; i++) {
		const m = msg(parent, i % 2 ? "assistant" : "user", `m${i}`) as { id: string };
		lines.push(m);
		parent = m.id;
	}
	const p = write("big.jsonl", lines);
	const r = readSession(p, 5, 3);
	assert.equal(r.truncated, true);
	assert.equal(r.totalMessages, 35);
	assert.equal(r.messages.length, 8);
	assert.deepEqual(
		r.messages.map((m) => m.entryId),
		["e01", "e02", "e03", "e04", "e05", "e33", "e34", "e35"],
	);
});

test("legacy version 1 file: parsed fine, bytes unchanged after both calls", () => {
	const msg = mkMsgs();
	const p = write("legacy.jsonl", [
		{ type: "session", version: 1, id: "s1", timestamp: "2024-01-01T00:00:00.000Z", cwd: "/tmp/x" },
		msg(null, "user", "q1"),
		msg("e01", "assistant", "a1"),
	]);
	const before = readFileSync(p);
	const w = getWindow(p, "e01", 5);
	const r = readSession(p);
	assert.equal(readFileSync(p).equals(before), true);
	assert.equal(w.messages.length, 2);
	assert.equal(r.totalMessages, 2);
});

test("malformed message content: object and non-string text parts yield empty string, not throw", () => {
	const p = write("bad-content.jsonl", [
		{ type: "session", version: 3, id: "s1", timestamp: "2024-01-01T00:00:00.000Z", cwd: "/tmp/x" },
		{ type: "message", id: "e01", parentId: null, timestamp: "2024-01-01T00:00:01.000Z", message: { role: "user", content: {} } },
		{ type: "message", id: "e02", parentId: "e01", timestamp: "2024-01-01T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text" }, { type: "text", text: 123 }] } },
	]);
	const r = readSession(p);
	assert.deepEqual(r.messages.map((m) => m.content), ["", ""]);
	const w = getWindow(p, "e01", 1);
	assert.equal(w.messages[0].content, "");
});

test("real ids ending in #h/#t are anchored without suffix stripping", () => {
	const p = write("suffix-id-anchor.jsonl", [
		{ type: "session", version: 3, id: "s1", timestamp: "2024-01-01T00:00:00.000Z", cwd: "/tmp/x" },
		{ type: "message", id: "e01", parentId: null, timestamp: "t1", message: { role: "user", content: [{ type: "text", text: "q1" }] } },
		{ type: "message", id: "e02#t", parentId: "e01", timestamp: "t2", message: { role: "assistant", content: [{ type: "text", text: "a1" }] } },
		{ type: "message", id: "e03", parentId: "e02#t", timestamp: "t3", message: { role: "user", content: [{ type: "text", text: "q2" }] } },
	]);
	const w = getWindow(p, "e02#t", 5);
	assert.deepEqual(w.messages.map((m) => m.entryId), ["e01", "e02#t", "e03"]);
	assert.equal(w.messages.find((m) => m.entryId === "e02#t")?.anchor, true);
	assert.equal(w.messagesAfter, 1);
});
