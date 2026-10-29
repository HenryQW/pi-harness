import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import notesExtension, { parseNotes } from "../extensions/notes.ts";

test("explicit worktree paths keep sibling notes and the session widget separate", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-notes-workspace-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
	t.after(async () => {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		await rm(root, { recursive: true, force: true });
	});
	const first = join(root, "first repo"), second = join(root, "second"), linked = join(root, "linked");
	const exec = async (command: string, args: string[], options: { cwd: string }) => {
		const result = spawnSync(command, args, { ...options, encoding: "utf8" });
		return { code: result.status ?? 1, killed: result.signal !== null, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
	};
	const git = async (cwd: string, args: string[]) => {
		const result = await exec("git", args, { cwd });
		assert.equal(result.code, 0, result.stderr);
	};
	for (const repo of [first, second]) { await mkdir(repo); await git(repo, ["init", "-q"]); }
	await git(first, ["-c", "commit.gpgsign=false", "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-qm", "initial"]);
	await git(first, ["worktree", "add", "-q", "--detach", linked]);
	await symlink(first, join(root, "alias"));
	const handlers = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>();
	let start: (event: unknown, ctx: ExtensionContext) => Promise<void>;
	let widget: string[] | undefined;
	const notices: string[] = [];
	notesExtension({ exec,
		on: (_event: string, handler: typeof start) => { start = handler; },
		registerCommand: (name: string, command: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => handlers.set(name, command.handler),
	} as unknown as ExtensionAPI);
	const ctx = { cwd: root, mode: "rpc", ui: {
		setWidget: (_key: string, value: string[] | undefined) => { widget = value; },
		notify: (message: string) => notices.push(message),
		select: async (_title: string, choices: string[]) => choices[0],
	} } as unknown as ExtensionContext;
	const run = (name: string, args: string, cwd = root) => handlers.get(name)!(args, { ...ctx, cwd });
	const records = async () => Promise.all((await readdir(join(root, "agent/config/pi-notes"))).map(async (name) =>
		parseNotes(await readFile(join(root, "agent/config/pi-notes", name), "utf8"))));
	await start!({}, ctx);
	await run("note", "no implicit child");
	await assert.rejects(readdir(join(root, "agent/config/pi-notes")), { code: "ENOENT" });
	await run("note", "--project first repo -- first");
	await run("note", "--project second -- second");
	await run("note", "--project linked -- linked");
	await run("note", "--project alias -- alias");
	assert.equal(widget, undefined);
	assert.match(notices.at(-1)!, /first repo/);
	const before = await records();
	assert.equal(before.length, 3);
	const firstPath = await realpath(first);
	assert.deepEqual(before.find((record) => record.worktree === firstPath)?.notes, ["first", "alias"]);
	for (const args of ["--project", "--project first repo --", "--project missing -- bad"]) await run("note", args);
	assert.deepEqual(await records(), before);
	await start!({}, { ...ctx, cwd: first });
	await run("note-rm", "--project ../second", first);
	assert.deepEqual(widget, ["1. first", "2. alias"]);
	await run("note-clear", "--project linked");
	assert.deepEqual((await records()).map((record) => record.notes).sort(), [[], ["first", "alias"]].sort());
	await run("note", "default remains first", first);
	assert.deepEqual(widget, ["1. first", "2. alias", "3. default remains first"]);
});
