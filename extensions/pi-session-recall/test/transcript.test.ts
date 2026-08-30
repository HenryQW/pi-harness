/** Regression for the shared transcript trust boundary: first valid id wins
 *  across all entry types, id-less/invalid-id data is retained, order is kept,
 *  and the boundary stays lazy/non-array so consumers never rematerialize it. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { readTranscriptEntries } from "../extensions/transcript.ts";

test("readTranscriptEntries preserves order, skips blank/malformed lines, reserves first valid id across entry types, and retains id-less entries", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-session-transcript-"));
	const file = path.join(dir, "session.jsonl");
	try {
		fs.writeFileSync(file, [
			JSON.stringify({ type: "message", id: "e1", parentId: null, message: { role: "user", content: "first" } }),
			"",
			"{not json",
			JSON.stringify({ type: "session" }), // header without id stays for index projection
			JSON.stringify({ type: "message", id: "e1", parentId: null, message: { role: "user", content: "duplicate" } }), // duplicate dropped entirely
			JSON.stringify({ type: "message", id: "", parentId: null }), // invalid id → retained as id-less
			JSON.stringify({ type: "message", id: "e2", parentId: 42 }), // invalid parent → treated as id-less
			JSON.stringify({ type: "message", id: "e3", parentId: null }),
			42, // JSON primitive line parses but carries no validated fields
		].join("\n") + "\n");

		const entries = [...readTranscriptEntries(file)];
		assert.deepEqual(entries.map((e) => e.id), ["e1", undefined, undefined, undefined, "e3", undefined]);
		assert.deepEqual(entries[0], { data: entries[0].data, id: "e1", parentId: null });
		assert.equal((entries[0].data as any).message.content, "first", "first occurrence wins");
		assert.ok(!entries.some((e) => (e.data as any)?.message?.content === "duplicate"), "later duplicate dropped entirely");
		assert.deepEqual(entries[1].data, { type: "session" }, "id-less header retained for index projection");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("readTranscriptEntries is lazy and never returns an array: entries are produced on demand", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-session-lazy-"));
	const file = path.join(dir, "session.jsonl");
	try {
		fs.writeFileSync(file, [
			JSON.stringify({ type: "message", id: "m1", parentId: null }),
			"{definitely not json",
		].join("\n"));

		const stream = readTranscriptEntries(file);
		assert.equal(Array.isArray(stream), false, "boundary must not rematerialize into an array");
		// Laziness: entries are produced on demand. Pulling one entry suspends
		// mid-snapshot — the trailing malformed line is only touched when the
		// consumer asks for more.
		const first = stream.next();
		assert.ok(!first.done);
		assert.equal((first.value as any).id, "m1");
		// One-shot stream: draining skips the malformed line and finishes.
		let count = 1;
		while (!stream.next().done) count++;
		assert.equal(count, 1);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
