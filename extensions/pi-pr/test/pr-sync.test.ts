import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { spawnBounded, type Exec } from "@henryqw/pi-process";
import type { CurrentPullRequest } from "../extensions/pr-github.ts";
import { syncLocalHead } from "../extensions/pr-sync.ts";

const FETCH_SOURCE = "git@github.com:acme/project.git";

/** A feature branch whose PR head (two commits) is published; the local branch is reset to the first commit. */
function repository(t: { after(fn: () => void): void }) {
	const dir = mkdtempSync(join(tmpdir(), "pi-pr-sync-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const root = join(dir, "worktree");
	const bare = join(dir, "remote.git");
	const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
	execFileSync("git", ["init", "--bare", bare]);
	execFileSync("git", ["init", "--initial-branch=feature", root]);
	git("config", "user.name", "Sync Test");
	git("config", "user.email", "sync@example.test");
	writeFileSync(join(root, "shared.txt"), "one\n");
	writeFileSync(join(root, "other.txt"), "other\n");
	git("add", "-A");
	git("commit", "-m", "initial");
	const base = git("rev-parse", "HEAD");
	writeFileSync(join(root, "shared.txt"), "one\ntwo\n");
	git("commit", "-am", "remote work");
	const prHead = git("rev-parse", "HEAD");
	git("push", bare, `${prHead}:refs/heads/feature`);
	git("reset", "--hard", base);
	const authority: CurrentPullRequest = {
		id: "PR_123", number: 42, url: new URL("https://github.com/acme/project/pull/42"), host: "github.com",
		approved: true, lifecycle: "open", conditions: { draft: false, baseUpdateRequired: false, conflict: false,
			changesRequested: false, unresolvedThreads: 0, ci: "success", review: "ready", policy: "ready", mergeability: "known" },
		local: { worktree: "clean", head: "behind" },
		base: { repository: "acme/project", ref: "main", oid: base },
		head: { repository: "acme/project", ref: "feature", oid: prHead },
		headFetchSource: FETCH_SOURCE,
		target: { provenance: "configured", branch: "feature", remote: "origin", ref: "feature",
			repository: "acme/project", host: "github.com", fetchSource: FETCH_SOURCE, remoteOid: prHead },
	};
	const commands: string[][] = [];
	const hooks: { beforeFetch?: () => void } = {};
	const exec: Exec = async (command, args, options) => {
		commands.push([command, ...args]);
		if (command === "git" && args[0] === "fetch") {
			hooks.beforeFetch?.();
			args = args.map((value) => value === FETCH_SOURCE ? bare : value);
		}
		return await spawnBounded(command, args, options);
	};
	const sync = () => syncLocalHead({ cwd: root, agentDir: join(dir, "agent"), authority, exec,
		loadCurrentPullRequest: async () => ({ kind: "current", pullRequest: authority }) });
	return { root, git, base, prHead, authority, sync, commands, hooks };
}

test("fast-forwards a behind local branch, keeping non-overlapping local changes", async (t) => {
	const clean = repository(t);
	assert.deepEqual(await clean.sync(), { kind: "fast-forwarded", head: clean.prHead });
	assert.equal(clean.git("status", "--porcelain=v1"), "");
	assert.equal(clean.commands.some(([command, ...args]) => command === "git" && (args[0] === "push" || args[0] === "rebase")), false);

	const dirty = repository(t);
	writeFileSync(join(dirty.root, "other.txt"), "edited locally\n");
	assert.deepEqual(await dirty.sync(), { kind: "fast-forwarded", head: dirty.prHead });
	assert.equal(dirty.git("status", "--porcelain=v1"), "M other.txt");
	assert.equal(readFileSync(join(dirty.root, "other.txt"), "utf8"), "edited locally\n");
});

test("refuses to fast-forward over overlapping local changes, even with merge.autoStash enabled", async (t) => {
	for (const autoStash of [false, true]) {
		const repo = repository(t);
		if (autoStash) repo.git("config", "merge.autoStash", "true");
		writeFileSync(join(repo.root, "shared.txt"), "local edit\n");
		await assert.rejects(repo.sync(), /Local changes overlap the PR head update/, `autoStash=${autoStash}`);
		assert.equal(repo.git("rev-parse", "HEAD"), repo.base, `autoStash=${autoStash}`);
		assert.equal(readFileSync(join(repo.root, "shared.txt"), "utf8"), "local edit\n", `autoStash=${autoStash}`);
		assert.equal(repo.git("stash", "list"), "", `autoStash=${autoStash}`);
		assert.equal(repo.git("diff", "--name-only", "--diff-filter=U"), "", `autoStash=${autoStash}`);
	}
});

test("stops without mutating when the branch or HEAD changes during the fetch", async (t) => {
	const switched = repository(t);
	switched.hooks.beforeFetch = () => switched.git("checkout", "-b", "elsewhere");
	await assert.rejects(switched.sync(), /current branch changed/);
	assert.equal(switched.git("rev-parse", "HEAD"), switched.base);
	assert.equal(switched.git("rev-parse", "feature"), switched.base);

	const advanced = repository(t);
	advanced.hooks.beforeFetch = () => {
		writeFileSync(join(advanced.root, "other.txt"), "raced\n");
		advanced.git("commit", "-am", "raced during fetch");
	};
	await assert.rejects(advanced.sync(), /local HEAD moved during the fetch/);
	assert.equal(advanced.git("log", "--format=%s", "-1"), "raced during fetch");
	assert.equal(advanced.git("rev-parse", "HEAD^"), advanced.base, "the raced commit was neither rebased nor merged");
	for (const repo of [switched, advanced]) {
		assert.equal(repo.commands.some(([command, ...args]) => command === "git" && (args[0] === "merge" || args[0] === "rebase")), false);
	}
});

test("rebases diverged local commits onto the PR head and aborts a conflicting rebase", async (t) => {
	const diverged = repository(t);
	writeFileSync(join(diverged.root, "other.txt"), "local commit\n");
	diverged.git("commit", "-am", "local work");
	const synced = await diverged.sync();
	assert.equal(synced.kind, "rebased");
	assert.equal(diverged.git("rev-parse", "HEAD"), synced.head);
	assert.equal(diverged.git("merge-base", "--is-ancestor", diverged.prHead, "HEAD"), "");
	assert.equal(diverged.git("log", "--format=%s", "-1"), "local work");
	assert.equal(readFileSync(join(diverged.root, "shared.txt"), "utf8"), "one\ntwo\n");

	const conflicting = repository(t);
	writeFileSync(join(conflicting.root, "shared.txt"), "conflicting\n");
	conflicting.git("commit", "-am", "conflicting local work");
	const original = conflicting.git("rev-parse", "HEAD");
	await assert.rejects(conflicting.sync(), /Local commits conflict with the PR head/);
	assert.equal(conflicting.git("rev-parse", "HEAD"), original);
	assert.equal(conflicting.git("status", "--porcelain=v1"), "");
	assert.equal(existsSync(join(conflicting.root, ".git", "rebase-merge")), false);
});

test("never rebases a dirty diverged branch or local merge commits", async (t) => {
	const dirty = repository(t);
	writeFileSync(join(dirty.root, "other.txt"), "local commit\n");
	dirty.git("commit", "-am", "local work");
	writeFileSync(join(dirty.root, "other.txt"), "uncommitted\n");
	await assert.rejects(dirty.sync(), /clean worktree/);
	assert.equal(dirty.git("log", "--format=%s", "-1"), "local work");

	const merged = repository(t);
	merged.git("checkout", "-b", "side");
	writeFileSync(join(merged.root, "side.txt"), "side\n");
	merged.git("add", "-A");
	merged.git("commit", "-m", "side work");
	merged.git("checkout", "feature");
	writeFileSync(join(merged.root, "other.txt"), "local commit\n");
	merged.git("commit", "-am", "local work");
	merged.git("merge", "--no-ff", "-m", "merge side", "side");
	await assert.rejects(merged.sync(), /merge commits/);
});

test("leaves an equal or ahead branch unchanged", async (t) => {
	const repo = repository(t);
	repo.git("reset", "--hard", repo.prHead);
	assert.deepEqual(await repo.sync(), { kind: "unchanged", head: repo.prHead });
	writeFileSync(join(repo.root, "other.txt"), "ahead\n");
	repo.git("commit", "-am", "ahead work");
	assert.deepEqual(await repo.sync(), { kind: "unchanged", head: repo.git("rev-parse", "HEAD") });
});
