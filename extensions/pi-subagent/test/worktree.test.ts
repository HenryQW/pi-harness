import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import test from "node:test";
import { createChildWorktree, finalizeChildWorktree, WorktreeSetupError, type GitRunner, type WorktreePayload } from "../src/worktree.ts";
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
	return async (args, cwd) => {
		calls.push(args);
		const key = Object.keys(responses).find((candidate) => args.join(" ").startsWith(candidate));
		const response = key === undefined ? undefined : responses[key];
		if (response) return { code: response.code ?? 0, stdout: response.stdout ?? "", stderr: response.stderr ?? "" };
		if (args.join(" ") === "rev-parse --git-dir") return ok(`${cwd}/.git\n`);
		if (args.join(" ") === "worktree list --porcelain -z") return ok(`worktree ${cwd}\0\0`);
		return ok();
	};
}

function expectWorktreeOutcome<T extends WorktreePayload["outcome"]>(
	payload: WorktreePayload,
	outcome: T,
): Extract<WorktreePayload, { outcome: T }> {
	assert.equal(payload.outcome, outcome);
	return payload as Extract<WorktreePayload, { outcome: T }>;
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

	assert.deepEqual(payload, { outcome: "pruned", path, branch: info.branch });
	assert.deepEqual(calls.filter((args) => args[0] === "worktree"), [["worktree", "remove", path]]);
	assert.deepEqual(calls.filter((args) => args[0] === "update-ref"), [["update-ref", "-d", `refs/heads/${info.branch}`, info.baseCommit]]);
	// Clean-tree proof must override config that hides untracked, ignored, or submodule changes.
	assert.deepEqual(calls.find((args) => args[0] === "status"), [
		"status", "--porcelain", "--untracked-files=all", "--ignored=matching", "--ignore-submodules=none",
	]);
});

test("finalizeChildWorktree performs its final root recheck without initialized submodules", async (t) => {
	const info = worktreeInfo(await tempDir(t));
	const calls: string[][] = [];
	let statusCalls = 0;
	const run: GitRunner = async (args) => {
		calls.push(args);
		if (args[0] === "rev-list") return ok("0\n");
		if (args[0] === "status") return ok(statusCalls++ < 2 ? "" : "?? late.txt\n");
		if (args[0] === "symbolic-ref") return ok(`refs/heads/${info.branch}\n`);
		return ok();
	};

	const payload = expectWorktreeOutcome(await finalizeChildWorktree(info, run), "retained");
	assert.equal(payload.dirty, true);
	assert.equal(statusCalls, 3);
	assert.equal(calls.some((args) => args[0] === "worktree" && args[1] === "remove"), false);
});

test("finalizeChildWorktree omits stale measurements after a failed worktree removal", async (t) => {
	const info = worktreeInfo(await tempDir(t));
	const calls: string[][] = [];
	const payload = expectWorktreeOutcome(await finalizeChildWorktree(info, fakeGit({
		"rev-list --count": ok("0\n"),
		"status --porcelain": ok(""),
		"symbolic-ref --quiet HEAD": ok(`refs/heads/${info.branch}\n`),
		"worktree remove": fail("worktree contains unexpected changes"),
	}, calls)), "recovery");

	assert.equal("commits" in payload, false);
	assert.equal("dirty" in payload, false);
	assert.match(payload.note, /worktree remove exit 1/);
	assert.match(payload.note, /Inspect/);
	assert.equal(calls.some((args) => args[0] === "update-ref"), false);
});

test("finalizeChildWorktree preserves a branch updated during cleanup without stale measurements", async (t) => {
	const info = worktreeInfo(await tempDir(t));
	const payload = expectWorktreeOutcome(await finalizeChildWorktree(info, fakeGit({
		"rev-list --count": ok("0\n"),
		"status --porcelain": ok(""),
		"symbolic-ref --quiet HEAD": ok(`refs/heads/${info.branch}\n`),
		"update-ref -d": fail("cannot lock ref: reference already changed"),
	})), "recovery");

	assert.equal("commits" in payload, false);
	assert.equal("dirty" in payload, false);
	assert.match(payload.note, /reference already changed/);
	assert.match(payload.note, /Inspect branch/);
});

test("finalizeChildWorktree keeps dirty and committed worktrees", async (t) => {
	const info = worktreeInfo(await tempDir(t));
	const dirty = expectWorktreeOutcome(await finalizeChildWorktree(info, fakeGit({
		"rev-list --count abc123..pi-subagent/subagent-x": ok("0\n"),
		"status --porcelain": ok(" M file.txt\n"),
	})), "retained");
	assert.equal(dirty.dirty, true);

	const committed = expectWorktreeOutcome(await finalizeChildWorktree(info, fakeGit({
		"rev-list --count abc123..pi-subagent/subagent-x": ok("3\n"),
		"status --porcelain": ok(""),
	})), "retained");
	assert.equal(committed.commits, 3);
});

test("finalizeChildWorktree keeps the worktree when it is missing from disk", async (t) => {
	const path = join(await tempDir(t), "gone");
	const calls: string[][] = [];
	const payload = await finalizeChildWorktree(
		{ ...worktreeInfo(path), repoRoot: "/repo" },
		fakeGit({ "rev-list --count abc123..pi-subagent/subagent-x": ok("0\n") }, calls),
	);
	assert.deepEqual(payload, { outcome: "pruned", path, branch: "pi-subagent/subagent-x" });
	// The branch probe runs from the repo root even though the checkout is gone.
	assert.equal(calls[0]![2], "abc123..pi-subagent/subagent-x");
	assert.ok(calls.every((args) => !args.includes(path) || args[0] === "worktree"));
});

test("finalizeChildWorktree returns recovery with only established probe measurements", async (t) => {
	const info = worktreeInfo(await tempDir(t));
	const payload = expectWorktreeOutcome(await finalizeChildWorktree(info, fakeGit({
		"rev-list --count abc123..pi-subagent/subagent-x": fail("fatal: bad revision"),
		"status --porcelain": ok(" M file.txt\n"),
	})), "recovery");

	assert.equal(payload.commits, undefined);
	assert.equal(payload.dirty, true);
	assert.match(payload.note, /commits UNKNOWN/);
	assert.match(payload.note, /Inspect/);

	const statusFailed = expectWorktreeOutcome(await finalizeChildWorktree(info, fakeGit({
		"rev-list --count abc123..pi-subagent/subagent-x": ok("3\n"),
		"status --porcelain": fail("fatal: status failed"),
	})), "recovery");
	assert.equal(statusFailed.commits, 3);
	assert.equal(statusFailed.dirty, undefined);

	const refreshFailed = expectWorktreeOutcome(await finalizeChildWorktree(info, fakeGit({
		"rev-list --count abc123..pi-subagent/subagent-x": ok("0\n"),
		"update-index --really-refresh": { code: -1, stdout: "", stderr: "timed out" },
	})), "recovery");
	assert.equal(refreshFailed.commits, 0);
	assert.equal(refreshFailed.dirty, undefined);
	assert.match(refreshFailed.note, /update-index/);
});

test("finalizeChildWorktree keeps the worktree when base_commit is missing", async (t) => {
	const calls: string[][] = [];
	const payload = expectWorktreeOutcome(await finalizeChildWorktree({ ...worktreeInfo(await tempDir(t)), baseCommit: "" }, fakeGit({}, calls)), "recovery");

	assert.equal(payload.commits, undefined);
	assert.equal(payload.dirty, undefined);
	assert.match(payload.note, /base_commit/);
	assert.equal(calls.some((args) => args[0] === "rev-list"), false);
});

test("createChildWorktree sanitizes child ids and records the base commit", async (t) => {
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
	assert.deepEqual(calls.find((args) => args[0] === "worktree" && args[1] === "add"), ["worktree", "add", info.path, "-b", info.branch, "abc123"]);
	// Exclusion goes through the repository-local exclude file, never the tracked .gitignore.
	assert.equal(await readFile(join(repo, ".git", "info", "exclude"), "utf8"), "/.worktrees/\n");
	assert.equal(await readFile(join(repo, ".gitignore"), "utf8").then(() => true, () => false), false);
});

test("createChildWorktree anchors its local exclude at the repository root", async (t) => {
	const repo = await initializedRepository(t);
	await mkdir(join(repo, "pkg", ".worktrees"), { recursive: true });
	await writeFile(join(repo, "pkg", ".worktrees", "data.txt"), "keep visible\n");
	assert.ok(await createChildWorktree(repo, "anchored-exclude"));

	assert.equal((await readFile(join(repo, ".git", "info", "exclude"), "utf8")).endsWith("/.worktrees/\n"), true);
	assert.match(git(repo, "status", "--porcelain", "--untracked-files=all"), /\?\? pkg\/\.worktrees\/data\.txt/);
});

test("createChildWorktree rejects when its local exclusion cannot be established", async (t) => {
	const repo = await initializedRepository(t);
	const exclude = join(repo, ".git", "info", "exclude");
	await rm(exclude, { force: true });
	await mkdir(exclude);

	await assert.rejects(createChildWorktree(repo, "exclude-failure"), /Could not update .*info.*exclude/);
	assert.equal(git(repo, "branch", "--list", "pi-subagent/*"), "");
	assert.equal(git(repo, "worktree", "list", "--porcelain").includes(join(repo, ".worktrees")), false);
});

test("createChildWorktree degrades on unborn HEAD and fails closed on setup errors", async (t) => {
	const repo = await mkdtemp(join(tmpdir(), "pi-subagent-repo-"));
	t.after(async () => { await rm(repo, { recursive: true, force: true }); });

	// Unborn HEAD: nothing to branch from — documented silent degradation.
	assert.equal(await createChildWorktree(repo, "x", fakeGit({
		"rev-parse --show-toplevel": ok(`${repo}\n`),
		"rev-parse HEAD": fail("fatal: unbekannte Revision HEAD"),
		"symbolic-ref --quiet HEAD": ok("refs/heads/main\n"),
		"show-ref --verify --quiet refs/heads/main": fail(),
	})), undefined);
	await assert.rejects(createChildWorktree(repo, "x", fakeGit({
		"rev-parse --show-toplevel": ok(`${repo}\n`),
		"rev-parse HEAD": fail("fatal: Zeitüberschreitung"),
		"symbolic-ref --quiet HEAD": ok("refs/heads/main\n"),
		"show-ref --verify --quiet refs/heads/main": { code: -1, stdout: "", stderr: "timed out" },
	})), /Zeitüberschreitung/);

	// Localized non-repository diagnostics degrade; failures inside a discovered repository fail closed.
	assert.equal(await createChildWorktree(repo, "x", fakeGit({
		"rev-parse --show-toplevel": fail("fatal: kein Git-Repository"),
		"-c safe.directory=* rev-parse --show-toplevel": fail("fatal: kein Git-Repository"),
	})), undefined);
	await mkdir(join(repo, ".git"));
	await assert.rejects(
		createChildWorktree(repo, "x", fakeGit({
			"rev-parse --show-toplevel": fail("fatal: beschädigte Konfiguration"),
			"-c safe.directory=* rev-parse --show-toplevel": fail("fatal: beschädigte Konfiguration"),
		})),
		/beschädigte Konfiguration/,
	);
	await assert.rejects(
		createChildWorktree(repo, "x", fakeGit({
			"rev-parse --show-toplevel": fail("fatal: fragwürdiger Besitz im Repository"),
			"-c safe.directory=* rev-parse --show-toplevel": ok(`${repo}\n`),
		})),
		/fragwürdiger Besitz/,
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

test("createChildWorktree never degrades aborted repository classification", async (t) => {
	const repo = await tempDir(t);
	const rootAbort = new AbortController();
	await assert.rejects(createChildWorktree(repo, "root-abort", async (args) => {
		if (args[0] === "-c") rootAbort.abort();
		return fail();
	}, rootAbort.signal), { name: "AbortError" });

	const headAbort = new AbortController();
	await assert.rejects(createChildWorktree(repo, "head-abort", async (args) => {
		const command = args.join(" ");
		if (command === "rev-parse --show-toplevel") return ok(`${repo}\n`);
		if (command === "rev-parse HEAD") return fail();
		if (command === "symbolic-ref --quiet HEAD") return ok("refs/heads/main\n");
		if (command.startsWith("show-ref ")) headAbort.abort();
		return command.startsWith("show-ref ") ? fail() : ok();
	}, headAbort.signal), { name: "AbortError" });
});

test("createChildWorktree counts the dedicated branch, not the checkout HEAD", async (t) => {
	const info = worktreeInfo(await tempDir(t));
	// Child detached HEAD back to base after committing: HEAD-based counting
	// would read zero and branch -D would destroy the committed work.
	const payload = expectWorktreeOutcome(await finalizeChildWorktree(info, fakeGit({
		"rev-list --count abc123..pi-subagent/subagent-x": ok("2\n"),
		"status --porcelain": ok(""),
	})), "retained");
	assert.equal(payload.commits, 2);
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
		(error) => {
			assert.ok(error instanceof WorktreeSetupError);
			assert.equal(error.worktree.repoRoot, repo);
			assert.equal(error.worktree.baseCommit, "abc123");
			assert.match(error.message, /path=.*branch=.*base=abc123/);
			return true;
		},
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
	assert.equal((await finalizeChildWorktree(info)).outcome, "pruned");
});

test("createChildWorktree resolves the primary checkout with a separate git directory", async (t) => {
	const parent = await tempDir(t);
	const repo = join(parent, "checkout");
	const gitDir = join(parent, "metadata.git");
	git(parent, "init", "-q", `--separate-git-dir=${gitDir}`, repo);
	git(repo, "config", "user.name", "Test");
	git(repo, "config", "user.email", "test@example.com");
	await writeFile(join(repo, "README.md"), "test\n");
	git(repo, "add", ".");
	git(repo, "commit", "-qm", "init");

	const info = await createChildWorktree(repo, "separate-git-dir");
	assert.ok(info);
	const primary = await realpath(repo);
	assert.equal(info.repoRoot, primary);
	assert.equal(info.path.startsWith(join(primary, ".worktrees")), true);
	assert.equal((await finalizeChildWorktree(info)).outcome, "pruned");
});

test("createChildWorktree rejects submodules whose parent cleanup can remove Git metadata", async (t) => {
	const source = await initializedRepository(t);
	const repo = await initializedRepository(t);
	git(repo, "-c", "protocol.file.allow=always", "submodule", "add", "-q", source, "mod");
	git(repo, "commit", "-qm", "add submodule");
	const linked = `${repo}-linked-submodule`;
	t.after(async () => { await rm(linked, { recursive: true, force: true }); });
	git(repo, "worktree", "add", "-qb", "linked-submodule", linked);
	git(linked, "-c", "protocol.file.allow=always", "submodule", "update", "--init", "-q");

	const submodule = join(linked, "mod");
	await assert.rejects(createChildWorktree(submodule, "unsafe-submodule"), /unavailable inside Git submodules/);
	assert.equal(git(submodule, "branch", "--list", "pi-subagent/*"), "");
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
	assert.equal(expectWorktreeOutcome(await finalizeChildWorktree(info), "retained").dirty, true);
	assert.equal((await finalizeChildWorktree(clean)).outcome, "pruned");
});

test("createChildWorktree preserves a dirty existing worktree on ID collision", async (t) => {
	const repo = await initializedRepository(t);
	const first = await createChildWorktree(repo, "same-id");
	assert.ok(first);
	await writeFile(join(first.path, "dirty.txt"), "keep me\n");

	await assert.rejects(createChildWorktree(repo, "same-id"), /worktree add failed after attempting/);
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
		assert.equal((await finalizeChildWorktree(info)).outcome, "pruned");
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

	const payload = expectWorktreeOutcome(await finalizeChildWorktree(info), "recovery");
	assert.match(payload.note, /HEAD is detached/);
	assert.equal(existsSync(info.path), true);
	assert.equal(git(info.path, "rev-parse", "HEAD"), detachedCommit);
});

test("finalizeChildWorktree removes only its stale metadata before deleting an empty branch", async (t) => {
	const repo = await initializedRepository(t);
	const info = await createChildWorktree(repo, "missing");
	const unrelated = await createChildWorktree(repo, "unrelated-missing");
	assert.ok(info);
	assert.ok(unrelated);
	await Promise.all([info.path, unrelated.path].map((path) => rm(path, { recursive: true, force: true })));

	const payload = await finalizeChildWorktree(info);
	assert.equal(payload.outcome, "pruned");
	assert.equal(git(repo, "branch", "--list", info.branch), "");
	const listed = git(repo, "worktree", "list", "--porcelain");
	assert.equal(listed.includes(info.path), false);
	assert.equal(listed.includes(unrelated.path), true);
});

test("finalizeChildWorktree prunes a clean submodule worktree without changing shared config", async (t) => {
	const source = await initializedRepository(t);
	const repo = await initializedRepository(t);
	git(repo, "-c", "protocol.file.allow=always", "submodule", "add", "-q", source, "mod");
	git(repo, "commit", "-qm", "add submodule");
	git(repo, "config", "submodule.mod.update", "rebase");
	const config = git(repo, "config", "--get-regexp", "^submodule\\.");
	const info = await createChildWorktree(repo, "clean-submodule");
	assert.ok(info);
	git(info.path, "-c", "protocol.file.allow=always", "submodule", "update", "--init", "-q");

	const payload = await finalizeChildWorktree(info);
	assert.equal(payload.outcome, "pruned");
	assert.equal(existsSync(info.path), false);
	assert.equal(git(repo, "branch", "--list", info.branch), "");
	assert.equal(git(repo, "config", "--get-regexp", "^submodule\\."), config);
});

test("finalizeChildWorktree preserves submodule edits hidden by index flags", async (t) => {
	const source = await initializedRepository(t);
	await writeFile(join(source, "tracked.txt"), "original\n");
	git(source, "add", ".");
	git(source, "commit", "-qm", "submodule content");
	const repo = await initializedRepository(t);
	git(repo, "-c", "protocol.file.allow=always", "submodule", "add", "-q", source, "mod");
	git(repo, "commit", "-qm", "add submodule");

	for (const flag of ["--assume-unchanged", "--skip-worktree"]) {
		const info = await createChildWorktree(repo, flag.slice(2));
		assert.ok(info);
		git(info.path, "-c", "protocol.file.allow=always", "submodule", "update", "--init", "-q");
		git(join(info.path, "mod"), "update-index", flag, "tracked.txt");
		await writeFile(join(info.path, "mod", "tracked.txt"), `${flag}\n`);

		const payload = await finalizeChildWorktree(info);
		if (flag === "--assume-unchanged") {
			const retained = expectWorktreeOutcome(payload, "retained");
			assert.equal(retained.commits, 0);
			assert.equal(retained.dirty, true);
		} else {
			const recovery = expectWorktreeOutcome(payload, "recovery");
			assert.equal(recovery.commits, 0);
			assert.equal(recovery.dirty, undefined);
			assert.match(recovery.note, /skip-worktree/);
		}
		assert.equal(await readFile(join(info.path, "mod", "tracked.txt"), "utf8"), `${flag}\n`);
	}
});

test("finalizeChildWorktree preserves ignored files inside initialized submodules", async (t) => {
	const source = await initializedRepository(t);
	await writeFile(join(source, ".gitignore"), "*.cache\n");
	git(source, "add", ".gitignore");
	git(source, "commit", "-qm", "ignore cache files");
	const repo = await initializedRepository(t);
	git(repo, "-c", "protocol.file.allow=always", "submodule", "add", "-q", source, "mod");
	git(repo, "commit", "-qm", "add submodule");
	const info = await createChildWorktree(repo, "ignored-submodule");
	assert.ok(info);
	git(info.path, "-c", "protocol.file.allow=always", "submodule", "update", "--init", "-q");
	await writeFile(join(info.path, "mod", "result.cache"), "keep me\n");

	const payload = expectWorktreeOutcome(await finalizeChildWorktree(info), "retained");
	assert.equal(payload.dirty, true);
	assert.equal(await readFile(join(info.path, "mod", "result.cache"), "utf8"), "keep me\n");
});

test("finalizeChildWorktree preserves ignored files", async (t) => {
	const repo = await initializedRepository(t);
	await writeFile(join(repo, ".gitignore"), "*.cache\n");
	git(repo, "add", ".gitignore");
	git(repo, "commit", "-qm", "ignore cache files");
	const info = await createChildWorktree(repo, "ignored");
	assert.ok(info);
	await writeFile(join(info.path, "result.cache"), "keep me\n");

	const payload = expectWorktreeOutcome(await finalizeChildWorktree(info), "retained");
	assert.equal(payload.dirty, true);
	assert.equal(await readFile(join(info.path, "result.cache"), "utf8"), "keep me\n");
});

test("finalizeChildWorktree preserves tracked edits hidden by assume-unchanged", async (t) => {
	const repo = await initializedRepository(t);
	const info = await createChildWorktree(repo, "assume-unchanged");
	assert.ok(info);
	git(info.path, "update-index", "--assume-unchanged", "README.md");
	await writeFile(join(info.path, "README.md"), "keep me\n");
	assert.equal(git(info.path, "status", "--porcelain"), "");

	const payload = expectWorktreeOutcome(await finalizeChildWorktree(info), "retained");
	assert.equal(payload.dirty, true);
	assert.equal(await readFile(join(info.path, "README.md"), "utf8"), "keep me\n");
});

test("finalizeChildWorktree preserves tracked edits hidden by skip-worktree", async (t) => {
	const repo = await initializedRepository(t);
	const info = await createChildWorktree(repo, "skip-worktree");
	assert.ok(info);
	git(info.path, "update-index", "--skip-worktree", "README.md");
	await writeFile(join(info.path, "README.md"), "keep me\n");
	assert.equal(git(info.path, "status", "--porcelain"), "");

	const payload = expectWorktreeOutcome(await finalizeChildWorktree(info), "recovery");
	assert.match(payload.note, /skip-worktree/);
	assert.equal(await readFile(join(info.path, "README.md"), "utf8"), "keep me\n");
});

test("finalizeChildWorktree refuses to prune while assume-unchanged remains", async (t) => {
	const info = worktreeInfo(await tempDir(t));
	const calls: string[][] = [];
	const payload = expectWorktreeOutcome(await finalizeChildWorktree(info, fakeGit({
		"rev-list --count abc123..pi-subagent/subagent-x": ok("0\n"),
		"symbolic-ref --quiet HEAD": ok("refs/heads/pi-subagent/subagent-x\n"),
		"ls-files -v -z": ok("h README.md\0"),
	}, calls)), "recovery");

	assert.match(payload.note, /assume-unchanged/);
	assert.equal(calls.some((args) => args[0] === "worktree"), false);
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

	const payload = expectWorktreeOutcome(await finalizeChildWorktree(info), "retained");
	assert.equal(payload.dirty, true);
	assert.equal(await readFile(join(info.path, "mod", "tracked.txt"), "utf8"), "changed\n");
});

test("finalizeChildWorktree counts the dedicated branch when the checkout is gone", async (t) => {
	const path = join(await tempDir(t), "gone");
	// External cleanup removed the checkout but the child had committed:
	// branch work must be reported, never read as empty.
	const committed = expectWorktreeOutcome(await finalizeChildWorktree(
		{ ...worktreeInfo(path), repoRoot: "/repo" },
		fakeGit({ "rev-list --count abc123..pi-subagent/subagent-x": ok("4\n") }),
	), "recovery");
	assert.equal(committed.commits, 4);
	assert.equal(committed.dirty, undefined);

	// Genuinely empty: branch dropped, reported pruned.
	const calls: string[][] = [];
	const empty = await finalizeChildWorktree(
		{ ...worktreeInfo(path), repoRoot: "/repo" },
		fakeGit({ "rev-list --count abc123..pi-subagent/subagent-x": ok("0\n") }, calls),
	);
	assert.equal(empty.outcome, "pruned");
	assert.deepEqual(calls.find((args) => args[0] === "worktree"), ["worktree", "remove", path]);
	assert.deepEqual(calls.find((args) => args[0] === "update-ref"), ["update-ref", "-d", "refs/heads/pi-subagent/subagent-x", "abc123"]);

	// Unmeasurable count: keep everything and say so.
	const unproven = expectWorktreeOutcome(await finalizeChildWorktree(
		{ ...worktreeInfo(path), repoRoot: "/repo" },
		fakeGit({ "rev-list --count abc123..pi-subagent/subagent-x": fail("fatal: bad object") }),
	), "recovery");
	assert.equal(unproven.commits, undefined);
	assert.equal(unproven.dirty, undefined);
});

test("loadRoles accepts isolation worktree and rejects other values", async (t) => {
	const acceptDir = join(tmpdir(), "pi-subagent-iso-ok-");
	const rejectDir = join(tmpdir(), "pi-subagent-iso-bad-");
	await Promise.all([acceptDir, rejectDir].map((dir) => mkdir(join(dir, "config", "pi-subagent"), { recursive: true })));
	t.after(async () => {
		await Promise.all([acceptDir, rejectDir].map((dir) => rm(dir, { recursive: true, force: true })));
	});
	await writeFile(join(acceptDir, "config", "pi-subagent", "iso.md"), "---\nname: iso\ndescription: d\nisolation: worktree\ntools: []\nextensions: []\nskills: []\n---\nBody.\n");
	await writeFile(join(rejectDir, "config", "pi-subagent", "iso.md"), "---\nname: iso\ndescription: d\nisolation: bogus\ntools: []\nextensions: []\nskills: []\n---\nBody.\n");

	const roles = loadRoles(acceptDir);
	assert.equal(roles.length, 4);
	assert.equal(roles.find(({ name }) => name === "iso")!.isolation, "worktree");
	assert.throws(() => loadRoles(rejectDir), /isolation must be "worktree"/);
});
