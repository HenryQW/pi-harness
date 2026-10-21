import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GitConflicts, parseConflicts, resolveConflicts } from "../extensions/git-conflict.ts";

test("parses two-way and diff3 blocks and resolves @both and @base", () => {
	const twoWay = "a\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> main\nb\n";
	const [block] = parseConflicts(twoWay.split("\n"), "f");
	assert.deepEqual({ ...block!, id: undefined }, { block: 1, id: undefined, start: 1, end: 5, oursLabel: "HEAD", theirsLabel: "main", ours: ["ours"], theirs: ["theirs"] });
	assert.equal(resolveConflicts(twoWay, "f", [{ block: 1, id: block!.id, side: "@both" }]), "a\nours\ntheirs\nb\n");
	assert.throws(() => resolveConflicts(twoWay, "f", [{ block: 1, id: block!.id, side: "@base" }]), /no base section.*merge\.conflictStyle/);

	// conflict-marker-size=9: seven-character markers inside the block stay content.
	const diff3 = "<<<<<<<<< HEAD\nours\n=======\n||||||||| base\nbase\n=========\ntheirs\n>>>>>>>>> main";
	const [withBase] = parseConflicts(diff3.split("\n"), "f");
	assert.deepEqual([withBase!.ours, withBase!.base], [["ours", "======="], ["base"]]);
	assert.equal(resolveConflicts(diff3, "f", [{ block: 1, id: withBase!.id, side: "@base" }]), "base");
	// A same-width opener inside a side makes block extents uncertain: refuse the file instead of guessing.
	assert.throws(() => parseConflicts("<<<<<<< HEAD\n<<<<<<< literal\n=======\nb\n>>>>>>> main".split("\n"), "f"), /ambiguous conflict markers at line 2/);
});

test("batch-resolves unmerged blocks, rejects stale ids and non-UTF-8 files without writing, and never stages", async (t) => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "git-conflict-")));
	t.after(() => rm(root, { recursive: true, force: true }));
	const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
	const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: root, env, stdio: "pipe" });
	const file = join(root, "f.txt");
	const write = (first: string, last: string) => writeFile(file, [first, ...Array.from({ length: 8 }, (_, i) => `ctx${i}`), last, ""].join("\n"));
	git("init", "-q", "-b", "main");
	await write("base1", "base2");
	git("add", "f.txt");
	git("commit", "-qm", "base");
	git("checkout", "-qb", "topic");
	await write("topic1", "topic2");
	git("commit", "-qam", "topic");
	git("checkout", "-q", "main");
	await write("main1", "main2");
	git("commit", "-qam", "main");
	assert.throws(() => git("merge", "-q", "topic"));

	const conflicts = new GitConflicts();
	const [listed] = (await conflicts.list(root)).files;
	assert.equal(listed!.path, "f.txt");
	assert.equal(listed!.blocks.length, 2);
	const resolutions = [{ block: 1, id: listed!.blocks[0]!.id, side: "@ours" as const }, { block: 2, id: listed!.blocks[1]!.id, side: "@theirs" as const }];

	const shifted = `new\n${await readFile(file, "utf8")}`;
	const invalid = Buffer.concat([Buffer.from(shifted), Buffer.from([0xff])]);
	await writeFile(file, invalid);
	await assert.rejects(conflicts.resolve(root, "f.txt", resolutions), /binary or not UTF-8/);
	assert.deepEqual(await readFile(file), invalid);

	await writeFile(file, shifted);
	await assert.rejects(conflicts.resolve(root, "f.txt", resolutions), /Conflict block 1 in f\.txt changed/);
	assert.equal(await readFile(file, "utf8"), shifted);

	const fresh = (await conflicts.list(root)).files[0]!.blocks;
	const result = await conflicts.resolve(root, "f.txt", resolutions.map((resolution, index) => ({ ...resolution, id: fresh[index]!.id })));
	assert.deepEqual(result, { path: "f.txt", resolved: [1, 2], remaining: [] });
	assert.equal(await readFile(file, "utf8"), ["new", "main1", ...Array.from({ length: 8 }, (_, i) => `ctx${i}`), "topic2", ""].join("\n"));
	assert.equal(git("diff", "--name-only", "--diff-filter=U").toString(), "f.txt\n");
});
