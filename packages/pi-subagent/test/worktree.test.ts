import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
	return { path, branch: "pi-subagent/subagent-x", repoRoot: "/repo", baseCommit: "abc123" };
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
		"rev-list --count abc123..HEAD": ok("0\n"),
		"status --porcelain": ok(""),
	}, calls));

	assert.deepEqual(payload, { path, branch: info.branch, commits: 0, dirty: false, pruned: true });
	assert.deepEqual(calls.filter((args) => args[0] === "worktree"), [["worktree", "remove", "--force", path]]);
	assert.deepEqual(calls.filter((args) => args[0] === "branch"), [["branch", "-D", info.branch]]);
});

test("finalizeChildWorktree keeps dirty and committed worktrees", async (t) => {
	const info = worktreeInfo(await tempDir(t));
	const dirty = await finalizeChildWorktree(info, fakeGit({
		"rev-list --count abc123..HEAD": ok("0\n"),
		"status --porcelain": ok(" M file.txt\n"),
	}));
	assert.equal(dirty.dirty, true);
	assert.equal(dirty.pruned, false);

	const committed = await finalizeChildWorktree(info, fakeGit({
		"rev-list --count abc123..HEAD": ok("3\n"),
		"status --porcelain": ok(""),
	}));
	assert.equal(committed.commits, 3);
	assert.equal(committed.pruned, false);
});

test("finalizeChildWorktree keeps the worktree when it is missing from disk", async (t) => {
	const path = join(await tempDir(t), "gone");
	const payload = await finalizeChildWorktree(worktreeInfo(path), fakeGit({}));
	assert.deepEqual(payload, { path, branch: "pi-subagent/subagent-x", commits: 0, dirty: false, pruned: true });
});

test("finalizeChildWorktree keeps the worktree with inspection_failed on probe failure", async (t) => {
	const info = worktreeInfo(await tempDir(t));
	const payload = await finalizeChildWorktree(info, fakeGit({
		"rev-list --count abc123..HEAD": fail("fatal: bad revision"),
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
	}, calls);
	const info = await createChildWorktree(repo, "tool-1/abc def", run);

	assert.ok(info);
	assert.equal(info.branch, "pi-subagent/subagent-tool-1_abc_def");
	assert.equal(info.path, join(repo, ".worktrees", "subagent-tool-1_abc_def"));
	assert.equal(info.repoRoot, repo);
	assert.equal(info.baseCommit, "abc123");
	assert.deepEqual(calls.find((args) => args[0] === "worktree"), ["worktree", "add", info.path, "-b", info.branch, "HEAD"]);
	assert.equal(await readFile(join(repo, ".gitignore"), "utf8"), ".worktrees/\n");

	assert.equal(await createChildWorktree(repo, "x", fakeGit({ "rev-parse --show-toplevel": fail() })), undefined);
	assert.equal(await createChildWorktree(repo, "x", fakeGit({
		"rev-parse --show-toplevel": ok(`${repo}\n`),
		"rev-parse HEAD": ok("abc123\n"),
		"worktree add": fail("fatal: not a valid object name: 'HEAD'"),
	})), undefined);
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
