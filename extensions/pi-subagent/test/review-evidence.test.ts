import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, type Mode, type PathLike } from "node:fs";
import fs, { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock } from "node:test";
import { loadBuiltinRole, loadRoles, prepareExactReviewEvidence, REVIEW_MAX_PATCH_BYTES, ROLE_TOOL_POLICY_FLAG } from "../src/index.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import gitRead from "../extensions/git-read.ts";

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

function gitReadTool() {
	let tool!: { execute: (...args: any[]) => Promise<{ content: { text: string }[]; structuredContent: { output: string; stderr: string; truncated: boolean } }> };
	const argv = process.argv;
	try {
		process.argv = ["node", "pi", `--${ROLE_TOOL_POLICY_FLAG}`, '["git_read"]'];
		gitRead({ registerTool(value: typeof tool) { tool = value; } } as unknown as ExtensionAPI);
	} finally { process.argv = argv; }
	return (cwd: string, params: unknown, signal?: AbortSignal) => tool.execute("git-evidence", params, signal, undefined, { cwd });
}

const inspectGit = gitReadTool();

test("git_read obtains exact committed, staged, working, and historical evidence without changing Git", async (t) => {
	const repo = await repository(t);
	const base = git(repo, "rev-parse", "HEAD");
	await writeFile(join(repo, "tracked.txt"), "candidate\nsecond line\n");
	await mkdir(join(repo, "nested"));
	await writeFile(join(repo, "nested", "*.txt"), "literal path\n");
	git(repo, "add", ".");
	git(repo, "commit", "-qm", "candidate");
	const tip = git(repo, "rev-parse", "HEAD");
	await writeFile(join(repo, "tracked.txt"), "staged\nsecond line\n");
	git(repo, "add", "tracked.txt");
	await writeFile(join(repo, "tracked.txt"), "working\nsecond line\n");
	await writeFile(join(repo, "untracked.txt"), "untracked\n");
	const index = await readFile(join(repo, ".git", "index"));
	const indexTime = (await stat(join(repo, ".git", "index"))).mtimeMs;
	const output = async (params: unknown, cwd = repo) => (await inspectGit(cwd, params)).structuredContent.output;
	assert.match(await output({ operation: "status" }), /MM tracked.txt\n\?\? untracked.txt/);
	assert.match(await output({ operation: "diff", mode: "committed", base, tip, path: "tracked.txt" }), /-base\n\+candidate\n\+second line/);
	assert.match(await output({ operation: "diff", mode: "staged" }), /-candidate\n\+staged/);
	assert.match(await output({ operation: "diff" }), /-staged\n\+working/);
	assert.equal(await output({ operation: "show", revision: "HEAD~1", path: "tracked.txt" }), "base\n");
	assert.match(await output({ operation: "show", revision: tip }), /candidate[\s\S]*\+second line/);
	assert.equal(await output({ operation: "show", path: "*.txt" }, join(repo, "nested")), "literal path\n");
	assert.match(await output({ operation: "log", maxCount: 1, path: "tracked.txt" }), /candidate/);
	assert.doesNotMatch(await output({ operation: "log", maxCount: 1 }), /    base/);
	assert.match(await output({ operation: "blame", revision: tip, path: "tracked.txt", startLine: 2, endLine: 2 }), new RegExp(`^${tip} 2 2 1[\\s\\S]*\\tsecond line`));
	assert.equal(await output({ operation: "rev-parse", revision: "HEAD^" }), `${base}\n`);
	assert.equal(git(repo, "rev-parse", "HEAD"), tip);
	assert.deepEqual(await readFile(join(repo, ".git", "index")), index);
	assert.equal((await stat(join(repo, ".git", "index"))).mtimeMs, indexTime);
});

test("git_read rejects malicious revisions, paths, and mixed operation arguments before Git", async () => {
	for (const revision of ["--output=owned", "HEAD:tracked.txt", "HEAD..other", "HEAD@{1}", "HEAD;touch owned", "HEAD\n--help", ":/search", "-cfoo=bar"]) {
		await assert.rejects(inspectGit("/nonexistent", { operation: "show", revision }), /git_read revision/);
	}
	for (const path of ["--output=owned", "../outside", "a/../../outside", "/tmp/outside", "a/./b", ".git/config", "a/.GIT/config", ":(top)*", "a\0b", "C:\\outside"]) {
		await assert.rejects(inspectGit("/nonexistent", { operation: "show", path }), /git_read path/);
	}
	for (const params of [
		{ operation: "checkout", revision: "HEAD" }, { operation: "status", args: ["--help"] },
		{ operation: "status", revision: "HEAD" }, { operation: "diff", mode: "committed", base: "HEAD" },
		{ operation: "diff", mode: "working", base: "HEAD", tip: "HEAD" },
		{ operation: "blame" }, { operation: "blame", path: "a", startLine: 2, endLine: 1 },
		{ operation: "blame", path: "a", startLine: 1 }, { operation: "log", maxCount: 101 },
	]) await assert.rejects(inspectGit("/nonexistent", params), /git_read/);
});

test("git_read disables repository external diff, textconv, clean/process filters, and fsmonitor", async (t) => {
	const repo = await repository(t);
	const marker = join(repo, "helper-ran");
	const helper = join(repo, "helper.sh");
	await writeFile(helper, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
	await chmod(helper, 0o755);
	await writeFile(join(repo, ".gitattributes"), "tracked.txt diff=unsafe filter=unsafe\n");
	git(repo, "config", "diff.external", helper);
	git(repo, "config", "diff.unsafe.textconv", helper);
	git(repo, "config", "filter.unsafe.clean", helper);
	git(repo, "config", "filter.unsafe.process", helper);
	git(repo, "config", "filter.unsafe.required", "true");
	git(repo, "config", "core.fsmonitor", helper);
	await writeFile(join(repo, "tracked.txt"), "changed\n");
	for (const params of [
		{ operation: "status" }, { operation: "diff" }, { operation: "diff", mode: "staged" },
		{ operation: "show" }, { operation: "blame", path: "tracked.txt" },
	]) await inspectGit(repo, params);
	assert.equal(existsSync(marker), false);

	git(repo, "config", "filter.unsafe=name.clean", helper);
	await writeFile(join(repo, ".gitattributes"), "tracked.txt filter=unsafe=name\n");
	for (const params of [{ operation: "status" }, { operation: "diff" }]) {
		await assert.rejects(inspectGit(repo, params), /git_read cannot safely disable filter/);
	}
	assert.equal(existsSync(marker), false);
});

test("git_read refuses missing partial-clone objects without invoking a remote helper", async (t) => {
	const repo = await repository(t);
	const blob = git(repo, "rev-parse", "HEAD:tracked.txt");
	const marker = join(repo, "remote-ran");
	const helper = join(repo, "remote.sh");
	await writeFile(helper, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
	await chmod(helper, 0o755);
	git(repo, "config", "remote.origin.url", `ext::${helper}`);
	git(repo, "config", "remote.origin.promisor", "true");
	git(repo, "config", "protocol.ext.allow", "always");
	await rm(join(repo, ".git", "objects", blob.slice(0, 2), blob.slice(2)));
	await assert.rejects(inspectGit(repo, { operation: "show", path: "tracked.txt" }), /git_read show.*exited 128/);
	assert.equal(existsSync(marker), false);
});

test("git_read reports Git failures and truncation and honors cancellation", async (t) => {
	const repo = await repository(t);
	await assert.rejects(inspectGit(repo, { operation: "show", revision: "missing-ref" }), /git_read show.*rev-parse exited 128/);
	await assert.rejects(inspectGit(repo, { operation: "show", path: "missing.txt" }), /git_read show.*exited 128.*does not exist/);
	const outside = await mkdtemp(join(tmpdir(), "pi-subagent-no-git-"));
	t.after(() => rm(outside, { recursive: true, force: true }));
	await assert.rejects(inspectGit(outside, { operation: "status" }), /not a git repository/);
	await writeFile(join(repo, "large.txt"), `${"large line\n".repeat(10_000)}end\n`);
	git(repo, "add", ".");
	git(repo, "commit", "-qm", "large");
	const result = await inspectGit(repo, { operation: "show", path: "large.txt" });
	assert.equal(result.structuredContent.truncated, true);
	assert.ok(Buffer.byteLength(result.structuredContent.output) <= 32768);
	assert.match(result.structuredContent.output, /end\n$/);
	assert.match(result.content[0]!.text, /TRUNCATED.*narrow the request/);
	const controller = new AbortController();
	const pending = inspectGit(repo, { operation: "status" }, controller.signal);
	controller.abort(new Error("review cancelled"));
	await assert.rejects(pending, /review cancelled/);
});

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

async function withFakeGit<T>(t: import("node:test").TestContext, stderr: string, operation: () => Promise<T>): Promise<T> {
	const root = await mkdtemp(join(tmpdir(), "pi-subagent-review-git-"));
	const bin = join(root, "bin");
	await mkdir(bin);
	await writeFile(join(bin, "git"), `#!${process.execPath}
require("node:fs").writeSync(2, ${JSON.stringify(stderr)});
process.exit(7);
`);
	await chmod(join(bin, "git"), 0o755);
	t.after(() => rm(root, { recursive: true, force: true }));
	const originalPath = process.env.PATH;
	process.env.PATH = `${bin}${process.platform === "win32" ? ";" : ":"}${originalPath ?? ""}`;
	try {
		return await operation();
	} finally {
		if (originalPath === undefined) delete process.env.PATH;
		else process.env.PATH = originalPath;
	}
}

test("exact evidence preserves its 200-character ordinary Git diagnostic cap", async (t) => {
	const context = await candidate(t, await repository(t), "diagnostic");
	const stderr = "x".repeat(201);
	await withFakeGit(t, stderr, async () => {
		await assert.rejects(prepareExactReviewEvidence(context), (error: unknown) => {
			assert.ok(error instanceof Error);
			assert.ok([context.base, context.tip].some((commit) =>
				error.message === `git rev-parse --verify --end-of-options ${commit}^{commit} failed with exit 7: ${stderr.slice(0, 200)}`));
			return true;
		});
	});
});

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
	assert.equal(loadBuiltinRole("implementer").description, "Implements and validates one bounded change in the checkout selected by Main");
	assert.equal(loadBuiltinRole("reviewer").name, "reviewer");
});
