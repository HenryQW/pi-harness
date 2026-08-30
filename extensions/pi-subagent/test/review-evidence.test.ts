import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, type Mode, type PathLike } from "node:fs";
import fs, { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock } from "node:test";
import { loadBuiltinRole, loadRoles, prepareExactReviewEvidence, REVIEW_MAX_PATCH_BYTES } from "../src/index.ts";

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

function trackEvidenceDirectories(t: import("node:test").TestContext): string[] {
	const directories: string[] = [];
	const evidencePrefix = join(tmpdir(), "pi-subagent-review-");
	const originalMkdtemp = fs.mkdtemp.bind(fs);
	const trackedMkdtemp = mock.method(fs, "mkdtemp", async (prefix: string) => {
		const directory = await originalMkdtemp(prefix);
		if (String(prefix) === evidencePrefix) directories.push(directory);
		return directory;
	});
	t.after(() => trackedMkdtemp.mock.restore());
	return directories;
}

function assertEvidenceDirectoriesRemoved(directories: readonly string[]): void {
	assert.ok(directories.length > 0, "review evidence did not create a temporary directory");
	for (const directory of directories) assert.equal(existsSync(directory), false);
}

test("exact evidence creates one private binary patch and idempotently cleans it up", async (t) => {
	const repo = await repository(t);
	const context = await candidate(t, repo, "patch");
	const directories = trackEvidenceDirectories(t);
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
	assert.equal(directories.length, 1);
	assertEvidenceDirectoriesRemoved(directories);
});

test("exact evidence accepts an empty base-to-tip patch", async (t) => {
	const context = await candidate(t, await repository(t), "empty", false);
	const evidence = await prepareExactReviewEvidence(context);
	assert.deepEqual(evidence.changedPaths, []);
	assert.equal((await stat(evidence.patchPath)).size, 0);
	await evidence.cleanup();
});

test("exact evidence cleans up failed temporary artifact setup", async (t) => {
	const context = await candidate(t, await repository(t), "chmod");
	const directories = trackEvidenceDirectories(t);
	const chmod = fs.chmod.bind(fs);
	const directoryChmod = mock.method(fs, "chmod", async (path: PathLike, mode: Mode) => {
		if (String(path).startsWith(join(tmpdir(), "pi-subagent-review-"))) throw new Error("directory chmod failed");
		return await chmod(path, mode);
	});
	t.after(() => directoryChmod.mock.restore());
	await assert.rejects(prepareExactReviewEvidence(context), /directory chmod failed/);
	assert.equal(directories.length, 1);
	assertEvidenceDirectoriesRemoved(directories);

	directoryChmod.mock.restore();
	let closed = false;
	const open = fs.open.bind(fs);
	const fileOpen = mock.method(fs, "open", async (path: PathLike, flags?: string | number, mode?: Mode) => {
		const file = await open(path, flags, mode);
		const close = file.close.bind(file);
		file.close = async () => {
			closed = true;
			await close();
			return undefined;
		};
		return file;
	});
	const fileChmod = mock.method(fs, "chmod", async (path: PathLike, mode: Mode) => {
		if (String(path).endsWith("review.patch")) throw new Error("file chmod failed");
		return await chmod(path, mode);
	});
	t.after(() => fileOpen.mock.restore());
	t.after(() => fileChmod.mock.restore());
	await assert.rejects(prepareExactReviewEvidence(context), /file chmod failed/);
	assert.equal(closed, true);
	assert.equal(directories.length, 2);
	assertEvidenceDirectoriesRemoved(directories);
});

test("exact evidence rejects assume-unchanged and skip-worktree tracked changes", async (t) => {
	for (const [enable, disable] of [
		["--assume-unchanged", "--no-assume-unchanged"],
		["--skip-worktree", "--no-skip-worktree"],
	] as const) {
		const context = await candidate(t, await repository(t), enable);
		git(context.worktree, "update-index", enable, "tracked.txt");
		await assert.rejects(prepareExactReviewEvidence(context), /assume-unchanged or skip-worktree/);
		git(context.worktree, "update-index", disable, "tracked.txt");
	}
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
	const directories = trackEvidenceDirectories(t);
	await assert.rejects(prepareExactReviewEvidence(context), /exceeds 524288 bytes/);
	assert.equal(directories.length, 1);
	assertEvidenceDirectoriesRemoved(directories);
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

test("loadBuiltinRole bypasses same-name user overrides", async (t) => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-subagent-role-test-"));
	t.after(async () => { await rm(agentDir, { recursive: true, force: true }); });
	const rolesDir = join(agentDir, "config", "pi-subagent");
	await mkdir(rolesDir, { recursive: true });
	await writeFile(join(rolesDir, "implementer.md"), "---\nname: implementer\ndescription: override\ntools: []\nextensions: []\nskills: []\n---\nOverride.\n");

	assert.equal(loadRoles(agentDir).find((role) => role.name === "implementer")!.description, "override");
	assert.equal(loadBuiltinRole("implementer").description, "Implements and validates one bounded change, requesting worktree isolation");
	assert.equal(loadBuiltinRole("reviewer").name, "reviewer");
});
