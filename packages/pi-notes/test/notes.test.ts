import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import notesExtension, { parseNotes, renderNotes } from "../extensions/notes.ts";

type CommandHandler = (args: string, ctx: ExtensionContext) => Promise<void>;
type Identity = { repository: string; worktree: string; gitDir: string };

async function harness(t: TestContext) {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-notes-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	t.after(async () => {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(agentDir, { recursive: true, force: true });
	});

	const repository = join(agentDir, "repo.git");
	const first = join(agentDir, "first");
	const second = join(agentDir, "second");
	const firstGitDir = join(repository, "worktrees", "first");
	const secondGitDir = join(repository, "worktrees", "second");
	await Promise.all([first, second, firstGitDir, secondGitDir].map((path) => mkdir(path, { recursive: true })));
	const canonicalRepository = await realpath(repository);
	const identities = new Map<string, Identity>([
		[first, { repository: canonicalRepository, worktree: await realpath(first), gitDir: await realpath(firstGitDir) }],
		[second, { repository: canonicalRepository, worktree: await realpath(second), gitDir: await realpath(secondGitDir) }],
	]);
	const handlers: Record<string, CommandHandler> = {};
	let sessionStart: ((event: unknown, ctx: ExtensionContext) => Promise<void> | void) | undefined;
	const pi = {
		exec: async (_command: string, _args: string[], options: { cwd?: string }) => {
			const identity = options.cwd
				? identities.get(options.cwd) ?? [...identities.values()].find((candidate) => candidate.worktree === options.cwd)
				: undefined;
			return identity
				? { code: 0, killed: false, stdout: `${identity.worktree}\n${identity.repository}\n${identity.gitDir}\n`, stderr: "" }
				: { code: 128, killed: false, stdout: "", stderr: "not a git worktree" };
		},
		on(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void) {
			if (event === "session_start") sessionStart = handler;
		},
		registerCommand(name: string, options: { handler: CommandHandler }) {
			handlers[name] = options.handler;
		},
	} as unknown as ExtensionAPI;

	let widget: string[] | undefined;
	let notified: string | undefined;
	let select: ((options: string[]) => Promise<string | undefined>) | undefined;
	const context = (cwd: string) => ({
		cwd,
		ui: {
			setWidget(_key: string, content: string[] | undefined) { widget = content; },
			notify(message: string) { notified = message; },
			select(_title: string, options: string[]) { return select ? select(options) : Promise.resolve(undefined); },
		},
	}) as unknown as ExtensionContext;

	notesExtension(pi);
	return {
		agentDir,
		first,
		second,
		firstGitDir,
		identities,
		handlers,
		context,
		runSessionStart: (ctx: ExtensionContext) => sessionStart!({}, ctx),
		widget: () => widget,
		notified: () => notified,
		resetNotification: () => { notified = undefined; },
		pickWith: (fn: (options: string[]) => Promise<string | undefined>) => { select = fn; },
	};
}

test("parseNotes validates safe worktree records", () => {
	const valid = {
		repository: "/repo/.git",
		worktree: "/repo",
		gitDir: "/repo/.git/worktrees/current",
		generation: "1:2:3",
		notes: [" a ", "b"],
	};
	assert.deepEqual(parseNotes(JSON.stringify(valid)), { ...valid, notes: ["a", "b"] });
	assert.throws(() => parseNotes(JSON.stringify({ ...valid, notes: ["a", "b", "c", "d", "e"] })), TypeError);
	assert.throws(() => parseNotes(JSON.stringify({ ...valid, repository: "relative" })), TypeError);
	assert.throws(() => parseNotes(JSON.stringify({ ...valid, notes: ["  "] })), TypeError);
	assert.throws(() => parseNotes(JSON.stringify({ ...valid, notes: ["safe", "\u001b]52;c;payload\u0007"] })), TypeError);
	assert.throws(() => parseNotes('{broken'), SyntaxError);
});

test("renderNotes numbers entries", () => {
	assert.deepEqual(renderNotes(["a"]), ["1. a"]);
	assert.deepEqual(renderNotes([]), []);
});

test("notes persist independently per worktree without creating config on startup", async (t) => {
	const h = await harness(t);
	const firstCtx = h.context(h.first);
	const secondCtx = h.context(h.second);
	await h.runSessionStart(firstCtx);
	assert.equal(h.widget(), undefined);
	await assert.rejects(readdir(join(h.agentDir, "config", "pi-notes")), { code: "ENOENT" });

	await h.handlers.note!("\u001b[2J", firstCtx);
	assert.match(h.notified()!, /control characters/i);
	await assert.rejects(readdir(join(h.agentDir, "config", "pi-notes")), { code: "ENOENT" });

	await h.handlers.note!("first note", firstCtx);
	await h.runSessionStart(secondCtx);
	assert.equal(h.widget(), undefined);
	await h.handlers.note!("second note", secondCtx);
	assert.equal((await readdir(join(h.agentDir, "config", "pi-notes"))).filter((name) => name.endsWith(".json")).length, 2);

	await h.runSessionStart(firstCtx);
	assert.deepEqual(h.widget(), ["1. first note"]);
	await h.runSessionStart(secondCtx);
	assert.deepEqual(h.widget(), ["1. second note"]);
});

test("recreated worktree at same path does not inherit old notes", async (t) => {
	const h = await harness(t);
	const ctx = h.context(h.first);
	await h.handlers.note!("old generation", ctx);
	await rm(h.firstGitDir, { recursive: true });
	await mkdir(h.firstGitDir, { recursive: true });

	await h.runSessionStart(ctx);
	assert.equal(h.widget(), undefined);
});

test("duplicate removal and stale selections preserve correct worktree notes", async (t) => {
	const h = await harness(t);
	const ctx = h.context(h.first);
	for (const note of ["todo", "middle", "todo"]) await h.handlers.note!(note, ctx);
	const dir = join(h.agentDir, "config", "pi-notes");
	const path = join(dir, (await readdir(dir)).find((name) => name.endsWith(".json"))!);

	h.pickWith(async (options) => options[2]);
	await h.handlers["note-rm"]!("", ctx);
	assert.deepEqual(parseNotes(await readFile(path, "utf8")).notes, ["todo", "middle"]);

	h.pickWith(async (options) => {
		const record = parseNotes(await readFile(path, "utf8"));
		await writeFile(path, JSON.stringify({ ...record, notes: ["middle", "replacement"] }));
		return options[1];
	});
	h.resetNotification();
	await h.handlers["note-rm"]!("", ctx);
	assert.match(h.notified()!, /changed elsewhere/i);
	assert.deepEqual(parseNotes(await readFile(path, "utf8")).notes, ["middle", "replacement"]);
});

test("startup and mutations prune stale records, preserve malformed files, and clear current notes", async (t) => {
	const h = await harness(t);
	const firstCtx = h.context(h.first);
	await h.handlers.note!("keep", firstCtx);
	await h.handlers.note!("stale", h.context(h.second));
	const dir = join(h.agentDir, "config", "pi-notes");
	const records = await Promise.all((await readdir(dir)).filter((name) => name.endsWith(".json")).map(async (name) => ({
		path: join(dir, name),
		record: parseNotes(await readFile(join(dir, name), "utf8")),
	})));
	const stalePath = records.find(({ record }) => record.worktree === h.identities.get(h.second)!.worktree)!.path;
	const staleRecord = await readFile(stalePath, "utf8");
	const malformedPath = join(dir, "malformed.json");
	await writeFile(malformedPath, "{broken user data");

	h.identities.delete(h.second);
	await h.runSessionStart(firstCtx);
	assert.equal((await readdir(dir)).filter((name) => name.endsWith(".json")).length, 3);

	await rm(h.second, { recursive: true });
	await h.runSessionStart(firstCtx);
	assert.equal((await readdir(dir)).filter((name) => name.endsWith(".json")).length, 2);
	assert.equal(await readFile(malformedPath, "utf8"), "{broken user data");

	await writeFile(stalePath, staleRecord);
	await h.handlers.note!("mutation prunes", firstCtx);
	await assert.rejects(readFile(stalePath, "utf8"), { code: "ENOENT" });
	assert.equal(await readFile(malformedPath, "utf8"), "{broken user data");
	assert.equal(h.handlers["note-prune"], undefined);

	const currentPath = join(dir, (await readdir(dir)).find((name) => name.endsWith(".json") && name !== "malformed.json")!);
	await writeFile(currentPath, "{broken current data");
	await h.runSessionStart(firstCtx);
	assert.match(h.widget()![0]!, /malformed/i);
	h.resetNotification();
	await h.handlers.note!("blocked", firstCtx);
	assert.match(h.notified()!, /malformed/i);
	assert.equal(await readFile(currentPath, "utf8"), "{broken current data");

	await h.handlers["note-clear"]!("", firstCtx);
	assert.equal(h.widget(), undefined);
	await assert.rejects(readFile(currentPath, "utf8"), { code: "ENOENT" });
	assert.equal(await readFile(malformedPath, "utf8"), "{broken user data");
});
