import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { spawnBounded, type Exec } from "@henryqw/pi-process";
import { GitConflicts, parseConflicts, resolveConflicts } from "../extensions/git-conflict.ts";

test("parses two-way and diff3 blocks and resolves @both and @base", () => {
	const twoWay = "a\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> main\nb\n";
	const [block] = parseConflicts(twoWay.split("\n"), "f");
	assert.deepEqual({ ...block!, id: undefined }, { block: 1, id: undefined, start: 1, end: 5, oursLabel: "HEAD", theirsLabel: "main", ours: ["ours"], theirs: ["theirs"] });
	assert.equal(resolveConflicts(twoWay, "f", [{ block: 1, id: block!.id, side: "@both" }]), "a\nours\ntheirs\nb\n");
	assert.throws(() => resolveConflicts(twoWay, "f", [{ block: 1, id: block!.id, side: "@base" }]), /no base section.*merge\.conflictStyle/);

	// conflict-marker-size=9: seven-character markers inside the block stay content.
	const diff3 = "<<<<<<<<< HEAD\nours\n=======\n||||||||| base\nbase\n=========\ntheirs\n>>>>>>>>> main";
	const [withBase] = parseConflicts(diff3.split("\n"), "f", 9);
	assert.deepEqual([withBase!.ours, withBase!.base], [["ours", "======="], ["base"]]);
	assert.equal(resolveConflicts(diff3, "f", [{ block: 1, id: withBase!.id, side: "@base" }], 9), "base");
	// Literal same-width markers inside a side make block extents uncertain: refuse the file instead of guessing.
	assert.throws(() => parseConflicts("<<<<<<< HEAD\n<<<<<<< literal\n=======\nb\n>>>>>>> main".split("\n"), "f"), /ambiguous conflict markers at line 2/);
	assert.throws(() => parseConflicts("<<<<<<< HEAD\na\n=======\n>>>>>>> literal\nb\n>>>>>>> main".split("\n"), "f"), /ambiguous conflict markers at line 6/);
});

test("batch-resolves unmerged blocks, refuses whole-file conflicts and stale ids without writing, and never stages", async (t) => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "git-conflict-")));
	t.after(() => rm(root, { recursive: true, force: true }));
	const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
	const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: root, env, stdio: "pipe" });
	const commit = async (message: string, files: Record<string, string>) => {
		await mkdir(join(root, "d"), { recursive: true });
		for (const [name, text] of Object.entries(files)) await writeFile(join(root, name), text);
		git("add", "-A");
		git("commit", "-qm", message);
	};
	const context = Array.from({ length: 8 }, (_, i) => `ctx${i}`);
	const text = (first: string, last: string) => [first, ...context, last, ""].join("\n");
	const file = join(root, "f.txt");
	// A marker fixture next to a real conflict is file content, not a block, also when a clean merge combines its edits.
	const fixture = (open: string, close: string, last: string) => [`<<<<<<< ${open}`, "A", "=======", "B", `>>>>>>> ${close}`, ...context, last, ""].join("\n");
	git("init", "-q", "-b", "main");
	await commit("base", { "f.txt": text("base1", "base2"), "b.bin": "a\nb\n", "c.txt": "a\n", "p.txt": "A\nX\n", "x.txt": fixture("base", "base", "base"), ".gitattributes": "c.txt merge=custom\n", "d/.gitattributes": "", "d/y.txt": "a\n" });
	git("checkout", "-qb", "topic");
	// Only theirs is binary: Git keeps the text ours without markers or NUL bytes.
	await commit("topic", { "f.txt": text("topic1", "topic2"), "b.bin": "a\0\nc\n", "c.txt": "c\n", "p.txt": "THEIRS\n", "x.txt": fixture("topic", "base", "topic"), "d/.gitattributes": "y.txt conflict-marker-size=12\n", "d/y.txt": "c\n" });
	git("checkout", "-q", "main");
	// A literal base-like line in two-way ours must not become a base section, even when the lines after it are in the base.
	await commit("main", { "f.txt": text("main1", "main2"), "b.bin": "a\nB\n", "c.txt": "b\n", "p.txt": "OURS\n||||||| literal\nX\n", "x.txt": fixture("base", "main", "main"), "d/.gitattributes": "y.txt conflict-marker-size=8\n", "d/y.txt": "b\n" });
	assert.throws(() => git("merge", "-q", "topic"));
	const gitlink = (stage: number) => `160000 ${String(stage).repeat(40)} ${stage}\tsub\n`;
	execFileSync("git", ["update-index", "--index-info"], { cwd: root, env, input: gitlink(1) + gitlink(2) + gitlink(3) });

	const conflicts = new GitConflicts({ agentDir: join(root, ".git", "pi-agent") });
	const files = new Map((await conflicts.list(root)).files.map((entry) => [entry.path, entry]));
	assert.match(files.get("b.bin")!.note!, /^b\.bin is binary/);
	assert.match(files.get("c.txt")!.note!, /^c\.txt uses a custom merge driver/);
	assert.match(files.get("p.txt")!.note!, /^p\.txt conflict block 1 has a marker line that is also in a merge side/);
	assert.match(files.get("d/y.txt")!.note!, /^d\/y\.txt is governed by an unmerged \.gitattributes/);
	assert.match(files.get("sub")!.note!, /^sub is a submodule or symlink conflict/);
	assert.match(files.get("x.txt")!.note!, /^x\.txt conflict block 1 has a marker line that is also in a merge side/);
	const listed = files.get("f.txt");
	git("config", "merge.default", "custom");
	assert.match((await conflicts.list(root, "f.txt")).files[0]!.note!, /uses a custom merge driver/);
	git("config", "--unset", "merge.default");
	// check-attr prints a driver named `set` like a bare attribute.
	git("config", "merge.set.driver", "false");
	await writeFile(join(root, ".gitattributes"), "c.txt merge=custom\nf.txt merge=set\n");
	assert.match((await conflicts.list(root, "f.txt")).files[0]!.note!, /uses a custom merge driver/);
	await writeFile(join(root, ".gitattributes"), "c.txt merge=custom\n");
	git("config", "--unset", "merge.set.driver");
	// Staging a resolved .gitattributes can change the marker width after Git wrote the markers.
	await writeFile(join(root, "d/.gitattributes"), "y.txt conflict-marker-size=12\n");
	git("add", "d/.gitattributes");
	assert.match((await conflicts.list(root, "d/y.txt")).files[0]!.note!, /^d\/y\.txt has merge attributes that differ from HEAD/);
	await assert.rejects(conflicts.resolve(root, "p.txt", [{ block: 1, id: "0".repeat(12), side: "@ours" }]), /also in a merge side/);
	assert.equal(listed!.blocks.length, 2);
	const resolutions = [{ block: 1, id: listed!.blocks[0]!.id, side: "@ours" as const }, { block: 2, id: listed!.blocks[1]!.id, side: "@theirs" as const }];

	const shifted = `new\n${await readFile(file, "utf8")}`;
	const invalid = Buffer.concat([Buffer.from(shifted), Buffer.from([0xff])]);
	await writeFile(file, invalid);
	await assert.rejects(conflicts.resolve(root, "f.txt", resolutions), /not UTF-8 text/);
	assert.deepEqual(await readFile(file), invalid);

	await writeFile(file, shifted);
	await assert.rejects(conflicts.resolve(root, "f.txt", resolutions), /Conflict block 1 in f\.txt changed/);
	assert.equal(await readFile(file, "utf8"), shifted);

	const fresh = (await conflicts.list(root, "f.txt")).files[0]!.blocks;
	const result = await conflicts.resolve(root, "f.txt", resolutions.map((resolution, index) => ({ ...resolution, id: fresh[index]!.id })));
	assert.deepEqual(result, { path: "f.txt", resolved: [1, 2], remaining: [] });
	assert.equal(await readFile(file, "utf8"), ["new", "main1", ...context, "topic2", ""].join("\n"));
	assert.equal(git("diff", "--name-only", "--diff-filter=U").toString(), "b.bin\nc.txt\nd/y.txt\nf.txt\np.txt\nsub\nx.txt\n");
});

test("lists an ordinary conflict without check-attr --source, which Git before 2.40 lacks", async (t) => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "git-conflict-")));
	t.after(() => rm(root, { recursive: true, force: true }));
	const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
	const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: root, env, stdio: "pipe" });
	const commit = async (message: string, text: string) => {
		await writeFile(join(root, "f.txt"), text);
		git("add", "-A");
		git("commit", "-qm", message);
	};
	git("init", "-q", "-b", "main");
	await commit("base", "base\n");
	git("checkout", "-qb", "topic");
	await commit("topic", "topic\n");
	git("checkout", "-q", "main");
	await commit("main", "main\n");
	assert.throws(() => git("merge", "-q", "topic"));
	const exec: Exec = async (command, args, options) => args.some((arg) => arg.startsWith("--source"))
		? { stdout: "", stderr: "error: unknown option `source'", code: 129, killed: false }
		: await spawnBounded(command, args, options);
	const [file] = (await new GitConflicts({ exec }).list(root)).files;
	assert.equal(file!.blocks.length, 1);
	assert.equal(file!.note, undefined);
});
