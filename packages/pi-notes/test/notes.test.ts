import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import notesExtension, { MAX_NOTES, parseNotes, renderNotes } from "../extensions/notes.ts";

test("parseNotes validates untrusted file content", () => {
	assert.deepEqual(parseNotes('["a","b"]'), ["a", "b"]);
	assert.deepEqual(parseNotes('["a", 42, null, "", "  ", "b", "c", "d", "e"]'), ["a", "b", "c", "d"]);
	assert.throws(() => parseNotes('{"not":"an array"}'), TypeError);
	assert.throws(() => parseNotes("not json"), SyntaxError);
	assert.throws(() => parseNotes('{broken'), SyntaxError);
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
	let picked: string | undefined;
	const ctx = {
		ui: {
			setWidget(_key: string, content: string[]) { widget = content; },
			notify(message: string) { throw new Error(message); },
			select(_title: string, _options: string[]) { return Promise.resolve(picked ?? widget![1]); },
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

	// Menu picks second option for removal.
	await handlers["note-rm"]!("", ctx);
	assert.deepEqual(widget, ["1. first", "2. third", "3. fourth"]);
	await handlers["note-clear"]!("", ctx);
	assert.deepEqual(widget, ["no notes"]);
	assert.deepEqual(JSON.parse(await readFile(path, "utf8")), []);

	await assert.rejects(handlers["note-rm"]!("", ctx), /no notes/i);
});

test("duplicate removal targets selected number and stale picks retry safely", async (t) => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-notes-dup-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	t.after(async () => {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(agentDir, { recursive: true, force: true });
	});

	const path = join(agentDir, "config", "pi-notes.json");
	const handlers: Record<string, (args: string, ctx: unknown) => Promise<void>> = {};
	const pi = {
		on(_event: string, _handler: unknown) { },
		registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) {
			handlers[name] = options.handler;
		},
	} as unknown as ExtensionAPI;

	let widget: string[] | undefined;
	let notified: string | undefined;
	let picked: (() => Promise<string | undefined>) | undefined;
	const ctx = {
		ui: {
			setWidget(_key: string, content: string[]) { widget = content; },
			notify(message: string) { notified = message; },
			select() { return picked ? picked() : Promise.resolve(undefined); },
		},
	} as unknown as ExtensionContext;

	notesExtension(pi);
	for (const text of ["todo", "middle", "todo"]) await handlers["note"]!(text, ctx);

	// Selecting "3. todo" removes the third entry, not the first matching value.
	picked = () => Promise.resolve(widget![2]);
	await handlers["note-rm"]!("", ctx);
	assert.deepEqual(widget, ["1. todo", "2. middle"]);
	assert.deepEqual(JSON.parse(await readFile(path, "utf8")), ["todo", "middle"]);

	// Another session rewrites the file while the menu is open; stale pick retries.
	picked = async () => {
		await writeFile(path, JSON.stringify(["from other session"]));
		return "2. middle";
	};
	notified = undefined;
	await handlers["note-rm"]!("", ctx);
	assert.match(notified!, /changed elsewhere/i);
	assert.deepEqual(JSON.parse(await readFile(path, "utf8")), ["from other session"]);
});

test("mutating commands refuse to overwrite malformed notes file", async (t) => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-notes-bad-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	t.after(async () => {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(agentDir, { recursive: true, force: true });
	});

	const path = join(agentDir, "config", "pi-notes.json");
	await mkdir(dirname(path), { recursive: true });
	const malformed = "{broken json from user data";
	await writeFile(path, malformed);

	const handlers: Record<string, (args: string, ctx: unknown) => Promise<void>> = {};
	const pi = {
		on(_event: string, _handler: unknown) { },
		registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) {
			handlers[name] = options.handler;
		},
	} as unknown as ExtensionAPI;

	let widget: string[] | undefined;
	let notified: string | undefined;
	const ctx = {
		ui: {
			setWidget(_key: string, content: string[]) { widget = content; },
			notify(message: string) { notified = message; },
			select(_title: string, _options: string[]) { throw new Error("select must not open"); },
		},
	} as unknown as ExtensionContext;

	notesExtension(pi);
	await handlers["note"]!("x", ctx);
	assert.match(notified!, /malformed/i);
	await handlers["note-rm"]!("", ctx);
	assert.match(notified!, /malformed/i);

	// Malformed file preserved verbatim.
	assert.equal(await readFile(path, "utf8"), malformed);

	// /note-clear is the explicit reset.
	await handlers["note-clear"]!("", ctx);
	assert.deepEqual(JSON.parse(await readFile(path, "utf8")), []);
	assert.deepEqual(widget, ["no notes"]);

	notified = undefined;
	await handlers["note"]!("after reset", ctx);
	assert.equal(notified, undefined);
	assert.deepEqual(JSON.parse(await readFile(path, "utf8")), ["after reset"]);
});
