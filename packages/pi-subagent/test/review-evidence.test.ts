import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadBuiltinRole, loadRoles } from "../src/index.ts";
import { prepareExactReviewEvidence, REVIEW_MAX_PATCH_BYTES } from "../src/review-evidence.ts";

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function repository(t: import("node:test").TestContext): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "pi-subagent-review-test-"));
	t.after(async () => { await rm(path, { recursive: true, force: true }); });
	git(path, "init", "-q");
	git(path, "config", "user.name", "Test");
	git(path, "config", "user.email", "test@example.com");
	await writeFile(join(path, "tracked.txt"), "base\n");
	git(path, "add", ".");
	git(path, "commit", "-qm", "base");
	return path;
}

async function candidate(
	t: import("node:test").TestContext,
	repo: string,
	name: string,
	change = true,
): Promise<{ base: string; tip: string; worktree: string }> {
	const base = git(repo, "rev-parse", "HEAD");
	const parent = await mkdtemp(join(tmpdir(), "pi-subagent-review-worktree-"));
	const worktree = join(parent, name);
	t.after(async () => { await rm(parent, { recursive: true, force: true }); });
	git(repo, "worktree", "add", "-qb", `test/${name}`, worktree, base);
	if (change) {
		await writeFile(join(worktree, "changed.txt"), "changed\n");
		git(worktree, "add", ".");
		git(worktree, "commit", "-qm", "change");
	}
	return { base, tip: git(worktree, "rev-parse", "HEAD"), worktree };
}

async function evidenceDirectories(): Promise<Set<string>> {
	return new Set((await readdir(tmpdir())).filter((name) => name.startsWith("pi-subagent-review-")));
}

test("exact evidence creates one private binary patch and idempotently cleans it up", async (t) => {
	const repo = await repository(t);
	const context = await candidate(t, repo, "patch");
	const evidence = await prepareExactReviewEvidence(context);

	assert.equal(evidence.base, context.base);
	assert.equal(evidence.tip, context.tip);
	assert.deepEqual(evidence.changedPaths, ["changed.txt"]);
	assert.deepEqual(await readdir(join(evidence.patchPath, "..")), ["review.patch"]);
	assert.equal((await stat(join(evidence.patchPath, ".."))).mode & 0o777, 0o700);
	assert.equal((await stat(evidence.patchPath)).mode & 0o777, 0o600);
	assert.deepEqual(
		await readFile(evidence.patchPath),
		execFileSync("git", ["--no-pager", "diff", "--no-ext-diff", "--no-textconv", "--ignore-submodules=none", "--binary", context.base, context.tip], { cwd: context.worktree }),
	);

	await evidence.cleanup();
	await evidence.cleanup();
	assert.equal(existsSync(evidence.patchPath), false);
});

test("exact evidence accepts an empty base-to-tip patch", async (t) => {
	const context = await candidate(t, await repository(t), "empty", false);
	const evidence = await prepareExactReviewEvidence(context);
	assert.deepEqual(evidence.changedPaths, []);
	assert.equal((await stat(evidence.patchPath)).size, 0);
	await evidence.cleanup();
});

test("exact evidence rejects dirty and wrong-tip registered worktrees", async (t) => {
	const context = await candidate(t, await repository(t), "invalid");
	await writeFile(join(context.worktree, "dirty.txt"), "dirty\n");
	await assert.rejects(prepareExactReviewEvidence(context), /not clean/);
	await rm(join(context.worktree, "dirty.txt"));

	await writeFile(join(context.worktree, "changed.txt"), "new tip\n");
	git(context.worktree, "commit", "-am", "new tip");
	await assert.rejects(prepareExactReviewEvidence(context), /not registered at the requested tip/);
});

test("a patch exactly one byte over the limit removes partial private evidence", async (t) => {
	const context = await candidate(t, await repository(t), "large");
	const target = REVIEW_MAX_PATCH_BYTES + 1;
	const changed = join(context.worktree, "changed.txt");
	await writeFile(changed, Buffer.alloc(target, "x"));
	git(context.worktree, "commit", "-am", "large patch");
	let patch = execFileSync("git", ["--no-pager", "diff", "--no-ext-diff", "--no-textconv", "--ignore-submodules=none", "--binary", context.base, "HEAD"], { cwd: context.worktree });
	await writeFile(changed, Buffer.alloc(target - (patch.length - target), "x"));
	git(context.worktree, "commit", "--amend", "-am", "large patch");
	context.tip = git(context.worktree, "rev-parse", "HEAD");
	patch = execFileSync("git", ["--no-pager", "diff", "--no-ext-diff", "--no-textconv", "--ignore-submodules=none", "--binary", context.base, context.tip], { cwd: context.worktree });
	assert.equal(patch.length, target);
	const before = await evidenceDirectories();
	await assert.rejects(prepareExactReviewEvidence(context), /exceeds 524288 bytes/);
	assert.deepEqual(await evidenceDirectories(), before);
});

test("exact evidence accepts changed symbolic links", async (t) => {
	const context = await candidate(t, await repository(t), "symlink");
	await rm(join(context.worktree, "changed.txt"));
	await symlink("target.txt", join(context.worktree, "changed.txt"));
	git(context.worktree, "add", "-A");
	git(context.worktree, "commit", "-qm", "symlink");
	context.tip = git(context.worktree, "rev-parse", "HEAD");

	const evidence = await prepareExactReviewEvidence(context);
	assert.deepEqual(evidence.changedPaths, ["changed.txt"]);
	await evidence.cleanup();
});

test("exact evidence rejects over-limit paths and changed gitlinks", async (t) => {
	const pathLimit = await candidate(t, await repository(t), "path-limit");
	await rm(join(pathLimit.worktree, "changed.txt"));
	for (let index = 0; index <= 1_000; index++) await writeFile(join(pathLimit.worktree, `f${index}`), "");
	git(pathLimit.worktree, "add", "-A");
	git(pathLimit.worktree, "commit", "--amend", "-qm", "path limit");
	pathLimit.tip = git(pathLimit.worktree, "rev-parse", "HEAD");
	await assert.rejects(prepareExactReviewEvidence(pathLimit), /exceeds 1000 paths/);

	const gitlink = await candidate(t, await repository(t), "gitlink");
	const module = join(gitlink.worktree, "module");
	await mkdir(module);
	git(module, "init", "-q");
	git(module, "config", "user.name", "Test");
	git(module, "config", "user.email", "test@example.com");
	await writeFile(join(module, "nested.txt"), "nested\n");
	git(module, "add", ".");
	git(module, "commit", "-qm", "nested");
	await rm(join(gitlink.worktree, "changed.txt"));
	git(gitlink.worktree, "update-index", "--add", "--cacheinfo", `160000,${git(module, "rev-parse", "HEAD")},module`);
	git(gitlink.worktree, "add", "-u");
	git(gitlink.worktree, "commit", "-qm", "gitlink");
	gitlink.tip = git(gitlink.worktree, "rev-parse", "HEAD");
	await assert.rejects(prepareExactReviewEvidence(gitlink), /changed gitlinks/);
});

test("exact evidence ignores unrelated bare and stale worktree registrations", async (t) => {
	const repo = await repository(t);
	const context = await candidate(t, repo, "registered");
	const stale = await candidate(t, repo, "stale");
	await rm(stale.worktree, { recursive: true, force: true });
	const evidence = await prepareExactReviewEvidence(context);
	await evidence.cleanup();

	const parent = await mkdtemp(join(tmpdir(), "pi-subagent-review-bare-"));
	t.after(async () => { await rm(parent, { recursive: true, force: true }); });
	const bare = join(parent, "repo.git");
	git(repo, "clone", "--bare", repo, bare);
	git(bare, "config", "user.name", "Test");
	git(bare, "config", "user.email", "test@example.com");
	const bareContext = await candidate(t, bare, "bare");
	const bareEvidence = await prepareExactReviewEvidence(bareContext);
	await bareEvidence.cleanup();
});

test("package-shipped Roles bypass same-name user overrides", async (t) => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-subagent-role-test-"));
	t.after(async () => { await rm(agentDir, { recursive: true, force: true }); });
	const rolesDir = join(agentDir, "config", "pi-subagent");
	await mkdir(rolesDir, { recursive: true });
	await writeFile(join(rolesDir, "implementer.md"), "---\nname: implementer\ndescription: override\n---\nOverride.\n");

	assert.equal(loadRoles(agentDir).find((role) => role.name === "implementer")!.description, "override");
	assert.equal(loadBuiltinRole("implementer").description, "Implements and validates one bounded change, requesting worktree isolation");
	assert.equal(loadBuiltinRole("reviewer").name, "reviewer");
});
