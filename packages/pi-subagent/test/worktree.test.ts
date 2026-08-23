import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import test from "node:test";
import { createChildWorktree, finalizeChildWorktree, type GitRunner } from "../src/worktree.ts";
import { loadRoles } from "../src/index.ts";

const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
const fail = (stderr = "") => ({ code: 1, stdout: "", stderr });

/** Fake runner keyed on `args.join(" ")` prefix; unlisted calls succeed with empty output. */
async function tempDir(t: import("node:test").TestContext): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "pi-subagent-wt-"));
	t.after(async () => { await rm(path, { recursive: true, force: true }); });
	return path;
}

function worktreeInfo(path: string) {
	return { path, cwd: path, branch: "pi-subagent/subagent-x", repoRoot: "/repo", baseCommit: "abc123" };
}

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function initializedRepository(t: import("node:test").TestContext): Promise<string> {
	const repo = await mkdtemp(join(tmpdir(), "pi-subagent-real-repo-"));
	t.after(async () => { await rm(repo, { recursive: true, force: true }); });
	git(repo, "init", "-q");
	git(repo, "config", "user.name", "Test");
	git(repo, "config", "user.email", "test@example.com");
	await writeFile(join(repo, "README.md"), "test\n");
	git(repo, "add", ".");
	git(repo, "commit", "-qm", "init");
	return repo;
}

function fakeGit(
	responses: Record<string, { code?: number; stdout?: string; stderr?: string }>,
	calls: string[][] = [],
): GitRunner {
	return async (args) => {
		calls.push(args);
		const key = Object.keys(responses).find((candidate) => args.join(" ").startsWith(candidate));
		const response = key === undefined ? undefined : responses[key];
		return response ? { code: response.code ?? 0, stdout: response.stdout ?? "", stderr: response.stderr ?? "" } : ok();
	};
}

test("finalizeChildWorktree prunes a worktree with zero commits and a clean tree", async (t) => {
	const info = worktreeInfo(await tempDir(t));
	const { path } = info;
	const calls: string[][] = [];
	const payload = await finalizeChildWorktree(info, fakeGit({
		"rev-list --count abc123..pi-subagent/subagent-x": ok("0\n"),
		"status --porcelain": ok(""),
		"symbolic-ref --quiet HEAD": ok("refs/heads/pi-subagent/subagent-x\n"),
	}, calls));

	assert.deepEqual(payload, { path, branch: info.branch, commits: 0, dirty: false, pruned: true });
	assert.deepEqual(calls.filter((args) => args[0] === "worktree"), [["worktree", "remove", "--force", path]]);
	assert.deepEqual(calls.filter((args) => args[0] === "branch"), [["branch", "-D", info.branch]]);
	// Clean-tree proof must override config that hides untracked, ignored, or submodule changes.
	assert.deepEqual(calls.find((args) => args[0] === "status"), [
		"status", "--porcelain", "--untracked-files=all", "--ignored=matching", "--ignore-submodules=none",
	]);
});

test("finalizeChildWorktree keeps dirty and committed worktrees", async (t) => {
	const info = worktreeInfo(await tempDir(t));
	const dirty = await finalizeChildWorktree(info, fakeGit({
		"rev-list --count abc123..pi-subagent/subagent-x": ok("0\n"),
		"status --porcelain": ok(" M file.txt\n"),
	}));
	assert.equal(dirty.dirty, true);
	assert.equal(dirty.pruned, false);

	const committed = await finalizeChildWorktree(info, fakeGit({
		"rev-list --count abc123..pi-subagent/subagent-x": ok("3\n"),
		"status --porcelain": ok(""),
	}));
	assert.equal(committed.commits, 3);
	assert.equal(committed.pruned, false);
});

test("finalizeChildWorktree keeps the worktree when it is missing from disk", async (t) => {
	const path = join(await tempDir(t), "gone");
	const calls: string[][] = [];
	const payload = await finalizeChildWorktree(
		{ ...worktreeInfo(path), repoRoot: "/repo" },
		fakeGit({ "rev-list --count abc123..pi-subagent/subagent-x": ok("0\n") }, calls),
	);
	assert.deepEqual(payload, { path, branch: "pi-subagent/subagent-x", commits: 0, dirty: false, pruned: true });
	// The branch probe runs from the repo root even though the checkout is gone.
	assert.equal(calls[0]![2], "abc123..pi-subagent/subagent-x");
	assert.ok(calls.every((args) => !args.includes(path) || args[0] === "worktree"));
});

test("finalizeChildWorktree keeps the worktree with inspection_failed on probe failure", async (t) => {
	const info = worktreeInfo(await tempDir(t));
	const payload = await finalizeChildWorktree(info, fakeGit({
		"rev-list --count abc123..pi-subagent/subagent-x": fail("fatal: bad revision"),
		"status --porcelain": ok(" M file.txt\n"),
	}));

	assert.equal(payload.pruned, false);
	assert.equal(payload.inspection_failed, true);
	assert.match(payload.note!, /UNKNOWN/);
	assert.match(payload.note!, /preserved/);
});

test("finalizeChildWorktree keeps the worktree when base_commit is missing", async (t) => {
	const calls: string[][] = [];
	const payload = await finalizeChildWorktree({ ...worktreeInfo(await tempDir(t)), baseCommit: "" }, fakeGit({}, calls));

	assert.equal(payload.commits, 0);
	assert.equal(payload.pruned, false);
	assert.equal(payload.inspection_failed, true);
	assert.match(payload.note!, /base_commit/);
	assert.equal(calls.some((args) => args[0] === "rev-list"), false);
});

test("createChildWorktree sanitizes child ids, degrades on non-git repos, and records base commit", async (t) => {
	const repo = await mkdtemp(join(tmpdir(), "pi-subagent-repo-"));
	t.after(async () => { await rm(repo, { recursive: true, force: true }); });
	const calls: string[][] = [];
	const run = fakeGit({
		"rev-parse --show-toplevel": ok(`${repo}\n`),
		"rev-parse HEAD": ok("abc123\n"),
		"rev-parse --git-common-dir": ok(`${repo}/.git\n`),
	}, calls);
	const info = await createChildWorktree(repo, "tool-1/abc def", run);

	assert.ok(info);
	assert.match(info.branch, /^pi-subagent\/subagent-[0-9a-f]{24}$/);
	assert.equal(info.path, join(repo, ".worktrees", info.branch.slice("pi-subagent/".length)));
	assert.equal(info.cwd, info.path);
	assert.equal(info.repoRoot, repo);
	assert.equal(info.baseCommit, "abc123");
	assert.deepEqual(calls.find((args) => args[0] === "worktree"), ["worktree", "add", info.path, "-b", info.branch, "abc123"]);
	// Exclusion goes through the repository-local exclude file, never the tracked .gitignore.
	assert.equal(await readFile(join(repo, ".git", "info", "exclude"), "utf8"), ".worktrees/\n");
	assert.equal(await readFile(join(repo, ".gitignore"), "utf8").then(() => true, () => false), false);

	assert.equal(await createChildWorktree(repo, "x", fakeGit({
		"rev-parse --show-toplevel": fail("fatal: not a git repository (or any of the parent directories)"),
	})), undefined);
});

test("createChildWorktree degrades on unborn HEAD and fails closed on setup errors", async (t) => {
	const repo = await mkdtemp(join(tmpdir(), "pi-subagent-repo-"));
	t.after(async () => { await rm(repo, { recursive: true, force: true }); });

	// Unborn HEAD: nothing to branch from — documented silent degradation.
	assert.equal(await createChildWorktree(repo, "x", fakeGit({
		"rev-parse --show-toplevel": ok(`${repo}\n`),
		"rev-parse HEAD": fail("fatal: ambiguous argument 'HEAD'"),
	})), undefined);

	// Expected non-repository stderr degrades; every other probe failure fails closed.
	assert.equal(await createChildWorktree(repo, "x", fakeGit({
		"rev-parse --show-toplevel": fail("fatal: not a git repository (or any of the parent directories)"),
	})), undefined);
	await assert.rejects(
		createChildWorktree(repo, "x", fakeGit({
			"rev-parse --show-toplevel": fail("fatal: detected dubious ownership in repository"),
		})),
		/dubious ownership/,
	);

	// Setup failure in a real git repository: reject instead of losing isolation.
	await assert.rejects(
		createChildWorktree(repo, "x", fakeGit({
			"rev-parse --show-toplevel": ok(`${repo}\n`),
			"rev-parse HEAD": ok("abc123\n"),
			"rev-parse --git-common-dir": ok(`${repo}/.git\n`),
			"worktree add": fail("fatal: branch already exists"),
		}), ),
		/worktree add failed/,
	);
});

test("createChildWorktree counts the dedicated branch, not the checkout HEAD", async (t) => {
	const info = worktreeInfo(await tempDir(t));
	// Child detached HEAD back to base after committing: HEAD-based counting
	// would read zero and branch -D would destroy the committed work.
	const payload = await finalizeChildWorktree(info, fakeGit({
		"rev-list --count abc123..pi-subagent/subagent-x": ok("2\n"),
		"status --porcelain": ok(""),
	}));
	assert.equal(payload.commits, 2);
	assert.equal(payload.pruned, false);
});

test("createChildWorktree preserves ambiguous state after a failed worktree add", async (t) => {
	const repo = await mkdtemp(join(tmpdir(), "pi-subagent-repo-"));
	t.after(async () => { await rm(repo, { recursive: true, force: true }); });
	const calls: string[][] = [];
	await assert.rejects(
		createChildWorktree(repo, "x", fakeGit({
			"rev-parse --show-toplevel": ok(`${repo}\n`),
			"rev-parse HEAD": ok("abc123\n"),
			"rev-parse --git-common-dir": ok(join(repo, ".git") + "\n"),
			"worktree add": fail("error: smudge filter died"),
		}, calls)),
		/worktree add failed; preserved/,
	);
	assert.equal(calls.some((args) => args[0] === "worktree" && args[1] === "remove"), false);
	assert.equal(calls.some((args) => args[0] === "branch"), false);
});

test("createChildWorktree preserves whitespace in repository paths and cwd prefixes", async (t) => {
	const parent = await tempDir(t);
	const repo = join(parent, "repo ");
	const nested = join(repo, " nested ");
	await mkdir(nested, { recursive: true });
	git(repo, "init", "-q");
	git(repo, "config", "user.name", "Test");
	git(repo, "config", "user.email", "test@example.com");
	await writeFile(join(repo, "README.md"), "test\n");
	await writeFile(join(nested, "tracked.txt"), "test\n");
	git(repo, "add", ".");
	git(repo, "commit", "-qm", "init");

	const info = await createChildWorktree(nested, "whitespace");
	assert.ok(info);
	const canonicalRepo = await realpath(repo);
	assert.equal(info.repoRoot, canonicalRepo);
	assert.equal(info.path.startsWith(join(canonicalRepo, ".worktrees")), true);
	assert.equal(info.cwd, `${join(info.path, " nested ")}${sep}`);
	assert.equal((await finalizeChildWorktree(info)).pruned, true);
});

test("createChildWorktree keeps children outside a removable linked checkout", async (t) => {
	const repo = await initializedRepository(t);
	const linked = `${repo}-linked`;
	t.after(async () => { await rm(linked, { recursive: true, force: true }); });
	git(repo, "worktree", "add", "-qb", "linked", linked);

	const info = await createChildWorktree(linked, "linked-child");
	const clean = await createChildWorktree(linked, "linked-clean-child");
	assert.ok(info);
	assert.ok(clean);
	const primary = await realpath(repo);
	assert.equal(info.repoRoot, primary);
	assert.equal(info.path.startsWith(join(primary, ".worktrees")), true);
	assert.equal(info.path.startsWith(await realpath(linked)), false);
	await writeFile(join(info.path, "keep.txt"), "keep me\n");
	git(repo, "worktree", "remove", "--force", linked);
	assert.equal(await readFile(join(info.path, "keep.txt"), "utf8"), "keep me\n");
	assert.equal((await finalizeChildWorktree(info)).dirty, true);
	assert.equal((await finalizeChildWorktree(clean)).pruned, true);
});

test("createChildWorktree preserves a dirty existing worktree on ID collision", async (t) => {
	const repo = await initializedRepository(t);
	const first = await createChildWorktree(repo, "same-id");
	assert.ok(first);
	await writeFile(join(first.path, "dirty.txt"), "keep me\n");

	await assert.rejects(createChildWorktree(repo, "same-id"), /worktree add failed; preserved/);
	assert.equal(await readFile(join(first.path, "dirty.txt"), "utf8"), "keep me\n");
	assert.equal(git(repo, "branch", "--list", first.branch).includes(first.branch), true);
});

test("createChildWorktree hashes opaque IDs into valid bounded refs", async (t) => {
	const repo = await initializedRepository(t);
	for (const id of ["a..b", "x.lock", "z".repeat(1_000)]) {
		const info = await createChildWorktree(repo, id);
		assert.ok(info);
		assert.match(info.branch, /^pi-subagent\/subagent-[0-9a-f]{24}$/);
		git(repo, "check-ref-format", "--branch", info.branch);
		assert.equal((await finalizeChildWorktree(info)).pruned, true);
	}
});

test("finalizeChildWorktree preserves a clean detached-HEAD commit", async (t) => {
	const repo = await initializedRepository(t);
	const info = await createChildWorktree(repo, "detached");
	assert.ok(info);
	git(info.path, "checkout", "--detach", "-q");
	await writeFile(join(info.path, "detached.txt"), "committed\n");
	git(info.path, "add", ".");
	git(info.path, "commit", "-qm", "detached work");
	const detachedCommit = git(info.path, "rev-parse", "HEAD");

	const payload = await finalizeChildWorktree(info);
	assert.equal(payload.pruned, false);
	assert.equal(payload.inspection_failed, true);
	assert.equal(existsSync(info.path), true);
	assert.equal(git(info.path, "rev-parse", "HEAD"), detachedCommit);
});

test("finalizeChildWorktree prunes stale metadata before deleting an empty branch", async (t) => {
	const repo = await initializedRepository(t);
	const info = await createChildWorktree(repo, "missing");
	assert.ok(info);
	await rm(info.path, { recursive: true, force: true });

	const payload = await finalizeChildWorktree(info);
	assert.equal(payload.pruned, true);
	assert.equal(git(repo, "branch", "--list", info.branch), "");
	assert.equal(git(repo, "worktree", "list", "--porcelain").includes(info.path), false);
});

test("finalizeChildWorktree preserves ignored files", async (t) => {
	const repo = await initializedRepository(t);
	await writeFile(join(repo, ".gitignore"), "*.cache\n");
	git(repo, "add", ".gitignore");
	git(repo, "commit", "-qm", "ignore cache files");
	const info = await createChildWorktree(repo, "ignored");
	assert.ok(info);
	await writeFile(join(info.path, "result.cache"), "keep me\n");

	const payload = await finalizeChildWorktree(info);
	assert.equal(payload.dirty, true);
	assert.equal(payload.pruned, false);
	assert.equal(await readFile(join(info.path, "result.cache"), "utf8"), "keep me\n");
});

test("finalizeChildWorktree detects edits hidden by submodule ignore config", async (t) => {
	const source = await initializedRepository(t);
	await writeFile(join(source, "tracked.txt"), "original\n");
	git(source, "add", ".");
	git(source, "commit", "-qm", "submodule content");
	const repo = await initializedRepository(t);
	git(repo, "-c", "protocol.file.allow=always", "submodule", "add", "-q", source, "mod");
	git(repo, "commit", "-qm", "add submodule");
	const info = await createChildWorktree(repo, "submodule");
	assert.ok(info);
	git(info.path, "-c", "protocol.file.allow=always", "submodule", "update", "--init", "-q");
	git(info.path, "config", "submodule.mod.ignore", "all");
	await writeFile(join(info.path, "mod", "tracked.txt"), "changed\n");

	const payload = await finalizeChildWorktree(info);
	assert.equal(payload.dirty, true);
	assert.equal(payload.pruned, false);
	assert.equal(await readFile(join(info.path, "mod", "tracked.txt"), "utf8"), "changed\n");
});

test("finalizeChildWorktree counts the dedicated branch when the checkout is gone", async (t) => {
	const path = join(await tempDir(t), "gone");
	// External cleanup removed the checkout but the child had committed:
	// branch work must be reported, never read as empty.
	const committed = await finalizeChildWorktree(
		{ ...worktreeInfo(path), repoRoot: "/repo" },
		fakeGit({ "rev-list --count abc123..pi-subagent/subagent-x": ok("4\n") }),
	);
	assert.equal(committed.commits, 4);
	assert.equal(committed.pruned, false);

	// Genuinely empty: branch dropped, reported pruned.
	const calls: string[][] = [];
	const empty = await finalizeChildWorktree(
		{ ...worktreeInfo(path), repoRoot: "/repo" },
		fakeGit({ "rev-list --count abc123..pi-subagent/subagent-x": ok("0\n") }, calls),
	);
	assert.equal(empty.commits, 0);
	assert.equal(empty.pruned, true);
	assert.deepEqual(calls.find((args) => args[0] === "worktree"), ["worktree", "prune", "--expire", "now"]);
	assert.deepEqual(calls.find((args) => args[0] === "branch"), ["branch", "-D", "pi-subagent/subagent-x"]);

	// Unmeasurable count: keep everything and say so.
	const unproven = await finalizeChildWorktree(
		{ ...worktreeInfo(path), repoRoot: "/repo" },
		fakeGit({ "rev-list --count abc123..pi-subagent/subagent-x": fail("fatal: bad object") }),
	);
	assert.equal(unproven.pruned, false);
	assert.equal(unproven.inspection_failed, true);
});

test("loadRoles accepts isolation worktree and rejects other values", async (t) => {
	const acceptDir = join(tmpdir(), "pi-subagent-iso-ok-");
	const rejectDir = join(tmpdir(), "pi-subagent-iso-bad-");
	await Promise.all([acceptDir, rejectDir].map((dir) => mkdir(join(dir, "config", "pi-subagent"), { recursive: true })));
	t.after(async () => {
		await Promise.all([acceptDir, rejectDir].map((dir) => rm(dir, { recursive: true, force: true })));
	});
	await writeFile(join(acceptDir, "config", "pi-subagent", "iso.md"), "---\nname: iso\ndescription: d\nisolation: worktree\n---\nBody.\n");
	await writeFile(join(rejectDir, "config", "pi-subagent", "iso.md"), "---\nname: iso\ndescription: d\nisolation: bogus\n---\nBody.\n");

	const roles = loadRoles(acceptDir);
	assert.equal(roles.length, 1);
	assert.equal(roles[0]!.isolation, "worktree");
	assert.throws(() => loadRoles(rejectDir), /isolation must be "worktree"/);
});
