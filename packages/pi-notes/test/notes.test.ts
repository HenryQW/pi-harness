import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import notesExtension, { MAX_NOTES, parseNotes, renderNotes } from "../extensions/notes.ts";

test("parseNotes validates untrusted file content", () => {
	assert.deepEqual(parseNotes('["a","b"]'), ["a", "b"]);
	assert.deepEqual(parseNotes('["a", 42, null, "", "  ", "b", "c", "d", "e"]'), ["a", "b", "c", "d"]);
	assert.deepEqual(parseNotes('{"not":"an array"}'), []);
	assert.deepEqual(parseNotes("not json"), []);
});

test("renderNotes numbers entries and shows placeholder when empty", () => {
	assert.deepEqual(renderNotes(["a"]), ["1. a"]);
	assert.deepEqual(renderNotes([]), ["no notes"]);
});

test("note commands add, remove, and clear persisted notes", async (t) => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-notes-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	t.after(async () => {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(agentDir, { recursive: true, force: true });
	});

	const handlers: Record<string, (args: string, ctx: unknown) => Promise<void>> = {};
	const pi = {
		on(_event: string, _handler: unknown) { },
		registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) {
			handlers[name] = options.handler;
		},
	} as unknown as ExtensionAPI;

	let widget: string[] | undefined;
	const ctx = {
		ui: {
			setWidget(_key: string, content: string[]) { widget = content; },
			notify(message: string) { throw new Error(message); },
			select(_title: string, options: string[]) { return Promise.resolve(options[1]); },
		},
	} as unknown as ExtensionContext;

	notesExtension(pi);
	await handlers["note"]!("first", ctx);
	await handlers["note"]!("second", ctx);
	await handlers["note"]!("third", ctx);
	await handlers["note"]!("fourth", ctx);
	assert.deepEqual(widget, ["1. first", "2. second", "3. third", "4. fourth"]);

	// Fifth note rejected.
	await assert.rejects(handlers["note"]!("fifth", ctx), /full/i);

	const path = join(agentDir, "config", "pi-notes.json");
	assert.equal(JSON.parse(await readFile(path, "utf8")).length, MAX_NOTES);

	// Menu picks second option ("2. second") for removal.
	await handlers["note-rm"]!("", ctx);
	assert.deepEqual(widget, ["1. first", "2. third", "3. fourth"]);
	await handlers["note-clear"]!("", ctx);
	assert.deepEqual(widget, ["no notes"]);
	assert.deepEqual(JSON.parse(await readFile(path, "utf8")), []);

	await assert.rejects(handlers["note-rm"]!("", ctx), /no notes/i);
});
