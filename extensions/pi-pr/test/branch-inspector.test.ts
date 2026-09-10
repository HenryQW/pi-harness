import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const INSPECTOR = new URL("../skills/pi-pr-create/scripts/inspect-branch.mjs", import.meta.url);

type Inspection = {
	schemaVersion: 1;
	status: "ready" | "blocked";
	branch?: string;
	head?: string;
	base?: { remote: string; ref: string; oid: string; mergeBase: string };
	ahead?: number;
	blocker?: { code: string; message: string; candidates?: string[] };
};

function git(cwd: string, ...args: string[]): string {
	const result = spawnSync("git", args, { cwd, encoding: "utf8" });
	assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
	return result.stdout.trim();
}

function repository(): { root: string; worktree: string; remote: string } {
	const root = mkdtempSync(join(tmpdir(), "pi-pr-branch-inspector-"));
	const worktree = join(root, "worktree");
	const remote = join(root, "remote.git");
	git(root, "init", "--bare", "-q", remote);
	git(root, "init", "-q", "-b", "main", worktree);
	git(worktree, "config", "user.name", "Pi PR Test");
	git(worktree, "config", "user.email", "pi-pr@example.com");
	writeFileSync(join(worktree, "tracked.txt"), "base\n");
	git(worktree, "add", "tracked.txt");
	git(worktree, "commit", "-q", "-m", "base");
	git(worktree, "remote", "add", "origin", remote);
	git(worktree, "push", "-q", "-u", "origin", "main");
	return { root, worktree, remote };
}

function inspect(worktree: string, remote: string): Inspection {
	const result = spawnSync(process.execPath, [INSPECTOR.pathname, "--remote", "origin", "--fetch-source", remote], {
		cwd: worktree,
		encoding: "utf8",
		timeout: 20_000,
		maxBuffer: 32_768,
	});
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stderr, "");
	return JSON.parse(result.stdout) as Inspection;
}

function commit(worktree: string, content: string, message: string): void {
	writeFileSync(join(worktree, "tracked.txt"), `${content}\n`);
	git(worktree, "commit", "-q", "-am", message);
}

test("inspector reports equal, ahead, dirty-only, fast-forwarded, and reset branch states", (t) => {
	const repo = repository();
	t.after(() => rmSync(repo.root, { recursive: true, force: true }));
	git(repo.worktree, "switch", "-q", "-c", "feature", "main");

	let result = inspect(repo.worktree, repo.remote);
	assert.equal(result.status, "ready");
	assert.equal(result.base?.ref, "main");
	assert.equal(result.ahead, 0, "equal parent");

	writeFileSync(join(repo.worktree, "dirty.txt"), "dirty\n");
	result = inspect(repo.worktree, repo.remote);
	assert.equal(result.ahead, 0, "dirty tree alone");
	rmSync(join(repo.worktree, "dirty.txt"));

	commit(repo.worktree, "feature", "feature change");
	result = inspect(repo.worktree, repo.remote);
	assert.equal(result.ahead, 1, "one branch-only commit");
	git(repo.worktree, "reset", "-q", "--hard", "origin/main");
	assert.equal(inspect(repo.worktree, repo.remote).ahead, 0, "reset to parent");

	git(repo.worktree, "switch", "-q", "main");
	commit(repo.worktree, "advanced", "advance main");
	git(repo.worktree, "push", "-q", "origin", "main");
	git(repo.worktree, "switch", "-q", "feature");
	git(repo.worktree, "fetch", "-q", "origin");
	git(repo.worktree, "merge", "-q", "--ff-only", "origin/main");
	assert.equal(inspect(repo.worktree, repo.remote).ahead, 0, "fast-forward to parent");
});

test("inspector preserves a feature branch parent", (t) => {
	const repo = repository();
	t.after(() => rmSync(repo.root, { recursive: true, force: true }));
	git(repo.worktree, "switch", "-q", "-c", "feature-parent", "main");
	commit(repo.worktree, "parent", "parent change");
	git(repo.worktree, "push", "-q", "-u", "origin", "feature-parent");
	git(repo.worktree, "switch", "-q", "-c", "feature-child", "feature-parent");
	commit(repo.worktree, "child", "child change");

	const result = inspect(repo.worktree, repo.remote);
	assert.equal(result.status, "ready");
	assert.equal(result.branch, "feature-child");
	assert.equal(result.base?.ref, "feature-parent");
	assert.equal(result.ahead, 1);
});

test("inspector blocks ambiguous and missing parent evidence", (t) => {
	const ambiguous = repository();
	const missing = repository();
	t.after(() => {
		rmSync(ambiguous.root, { recursive: true, force: true });
		rmSync(missing.root, { recursive: true, force: true });
	});

	git(ambiguous.worktree, "branch", "release", "main");
	git(ambiguous.worktree, "push", "-q", "origin", "release");
	git(ambiguous.worktree, "switch", "-q", "-c", "feature", "main");
	const ambiguousResult = inspect(ambiguous.worktree, ambiguous.remote);
	assert.equal(ambiguousResult.status, "blocked");
	assert.equal(ambiguousResult.blocker?.code, "ambiguous-parent");
	assert.deepEqual(ambiguousResult.blocker?.candidates, ["origin/main", "origin/release"]);

	git(missing.worktree, "switch", "-q", "-c", "local-parent", "main");
	commit(missing.worktree, "local parent", "unpublished parent");
	git(missing.worktree, "switch", "-q", "-c", "feature", "local-parent");
	const missingResult = inspect(missing.worktree, missing.remote);
	assert.equal(missingResult.status, "blocked");
	assert.equal(missingResult.blocker?.code, "missing-parent-evidence");
});
