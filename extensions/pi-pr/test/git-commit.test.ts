import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { spawnBounded, type Exec } from "@henryqw/pi-process";
import { GitCommitter } from "../extensions/git-commit.ts";

function fixture(t: TestContext, exec?: Exec) {
	const root = mkdtempSync(join(tmpdir(), "pi-git-commit-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const cwd = join(root, "repo");
	execFileSync("git", ["init", "-q", "--initial-branch=main", cwd]);
	const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
	git("config", "user.name", "Commit Test"); git("config", "user.email", "test@example.invalid");
	const write = (path: string, value: string) => writeFileSync(join(cwd, path), value);
	write("file.txt", "base\n"); write("other.txt", "base\n");
	git("add", "-A"); git("commit", "-qm", "initial"); git("checkout", "-qb", "feature");
	const committer = new GitCommitter({ cwd, agentDir: join(root, "agent"), exec });
	return { cwd, git, write, committer };
}

test("standalone commit keeps unrelated changes, uses literal paths and accepts a message body", async (t) => {
	const { git, write, committer } = fixture(t);
	write("*.txt", "literal\n"); write("file.txt", "remaining\n");
	const snapshot = await committer.inspect("main");
	await assert.rejects(committer.commit(snapshot.inspectionId, ["*.txt"], "not conventional"), /Conventional/);
	const result = await committer.commit(snapshot.inspectionId, ["*.txt"], "feat: add literal path\n\nKeep unrelated work.");
	assert.equal(git("show", "--format=", "--name-only", result.head), "*.txt");
	assert.equal(git("status", "--porcelain=v1"), "M file.txt");
	await assert.rejects(committer.commit(snapshot.inspectionId, ["*.txt"], "feat: replay"), /consumed/);
	const next = await committer.inspect("main");
	await committer.commit(next.inspectionId, ["file.txt"], "fix: complete work");
	assert.equal(git("status", "--porcelain=v1"), "");
});

test("unrelated and partially staged work is not overwritten", async (t) => {
	const { git, write, committer } = fixture(t);
	write("other.txt", "staged\n"); git("add", "other.txt"); write("file.txt", "owned\n");
	let snapshot = await committer.inspect("main");
	const index = git("diff", "--cached");
	await assert.rejects(committer.commit(snapshot.inspectionId, ["file.txt"], "fix: scope"), /Unrelated staged/);
	assert.equal(git("diff", "--cached"), index);
	write("other.txt", "unstaged\n");
	snapshot = await committer.inspect("main");
	await assert.rejects(committer.commit(snapshot.inspectionId, ["file.txt", "other.txt"], "fix: scope"), /Partially staged/);
	assert.equal(git("diff", "--cached"), index);
});

test("coherent staged renames and deletions commit without restaging missing paths", async (t) => {
	const { git, committer } = fixture(t);
	git("mv", "file.txt", "renamed.txt");
	let snapshot = await committer.inspect("main");
	await assert.rejects(committer.commit(snapshot.inspectionId, ["renamed.txt"], "refactor: rename"), /Unrelated staged/);
	await committer.commit(snapshot.inspectionId, ["file.txt", "renamed.txt"], "refactor: rename");
	assert.equal(git("status", "--porcelain=v1"), "");
	git("rm", "renamed.txt");
	snapshot = await committer.inspect("main");
	await committer.commit(snapshot.inspectionId, ["renamed.txt"], "refactor: remove file");
	assert.equal(git("show", "--format=", "--name-status", "HEAD"), "D\trenamed.txt");
});

test("same-status byte changes, branch movement, Git operations, context and secret paths block commits", async (t) => {
	const { cwd, git, write, committer } = fixture(t);
	write("file.txt", "first\n");
	let snapshot = await committer.inspect("main");
	const status = git("status", "--porcelain=v2");
	write("file.txt", "later\n");
	assert.equal(git("status", "--porcelain=v2"), status);
	await assert.rejects(committer.commit(snapshot.inspectionId, ["file.txt"], "fix: changed"), /changed after inspection/);
	snapshot = await committer.inspect("main");
	git("checkout", "-qb", "other");
	await assert.rejects(committer.commit(snapshot.inspectionId, ["file.txt"], "fix: branch"), /branch changed/);
	mkdirSync(join(cwd, ".context")); write(".context/plan.md", "private\n"); write(".env", "SECRET=not-a-real-secret\n");
	snapshot = await committer.inspect("main");
	for (const path of [".context/plan.md", ".env", "./.context/plan.md", "../outside"]) {
		await assert.rejects(committer.commit(snapshot.inspectionId, [path], "fix: unsafe"), /context|secret|unsafe/);
	}
	write(".git/MERGE_HEAD", git("rev-parse", "HEAD") + "\n");
	await assert.rejects(committer.inspect("main"), /Git operation/);
	assert.equal(git("diff", "--cached"), "");
});

test("hook failure and a lost successful commit response cannot be replayed", async (t) => {
	for (const lostResponse of [false, true]) {
		let attempts = 0;
		const exec: Exec = async (command, args, options) => {
			if (command === "git" && args[0] === "commit") attempts++;
			const result = await spawnBounded(command, args, options);
			if (lostResponse && command === "git" && args[0] === "commit") throw new Error("commit response lost");
			return result;
		};
		const { cwd, git, write, committer } = fixture(t, exec);
		if (!lostResponse) writeFileSync(join(cwd, ".git/hooks/pre-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
		const before = git("rev-parse", "HEAD"); write("file.txt", "repair\n");
		const snapshot = await committer.inspect("main");
		await assert.rejects(committer.commit(snapshot.inspectionId, ["file.txt"], "fix: repair"), /failed|response lost/);
		assert.equal(git("rev-parse", "HEAD") !== before, lostResponse);
		await assert.rejects(committer.commit(snapshot.inspectionId, ["file.txt"], "fix: retry"), /consumed/);
		await assert.rejects(committer.inspect("main"), /manual review/);
		assert.equal(attempts, 1);
	}
});

test("cancellation before staging preserves the index and allows a fresh inspection", async (t) => {
	const { git, write, committer } = fixture(t);
	write("file.txt", "pending\n");
	const snapshot = await committer.inspect("main");
	const signal = AbortSignal.abort(new Error("cancelled"));
	await assert.rejects(committer.commit(snapshot.inspectionId, ["file.txt"], "fix: cancelled", signal), /cancelled/);
	assert.equal(git("diff", "--cached"), "");
	const fresh = await committer.inspect("main");
	await committer.commit(fresh.inspectionId, ["file.txt"], "fix: fresh attempt");
});

test("a hook that changes the commit tree fails closed without replay", async (t) => {
	const { cwd, git, write, committer } = fixture(t);
	write("file.txt", "owned\n"); write("other.txt", "unrelated\n");
	writeFileSync(join(cwd, ".git/hooks/pre-commit"), "#!/bin/sh\ngit add other.txt\n", { mode: 0o755 });
	const snapshot = await committer.inspect("main");
	await assert.rejects(committer.commit(snapshot.inspectionId, ["file.txt"], "fix: owned"), /Commit parent or tree changed/);
	assert.equal(git("show", "--format=", "--name-only", "HEAD"), "file.txt\nother.txt");
	await assert.rejects(committer.inspect("main"), /manual review/);
});
