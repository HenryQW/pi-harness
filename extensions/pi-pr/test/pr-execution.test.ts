import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { extensionConfigDir } from "@henryqw/pi-config-store";
import { spawnBounded } from "@henryqw/pi-process";
import {
	assertOnlyDeclaredStatusChanged,
	inspectWorktreeState,
	parseSingleOutputLine,
	parseStatusSnapshot,
	recordRemoteTrackingRef,
	validatePaths,
	withWorktreeLock,
} from "../extensions/pr-execution.ts";

async function git(root: string, args: string[], stdin?: string): Promise<string> {
	const result = await spawnBounded("git", args, { cwd: root, stdin });
	assert.equal(result.killed, false, `git ${args.join(" ")} was killed`);
	assert.equal(result.code, 0, result.stderr || result.stdout);
	return result.stdout;
}

async function temporaryGitRepository(prefix: string): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), prefix));
	await git(root, ["init", "--quiet"]);
	return root;
}

async function worktreeLockPath(root: string, agentDir: string): Promise<string> {
	const canonical = await realpath(root);
	const lockNamespace = resolve(extensionConfigDir("pi-pr", agentDir));
	return join(lockNamespace, "worktree-locks", `${createHash("sha256").update(canonical).digest("hex")}.lock`);
}

test("tracking repair uses the saved lease and preserves concurrent fetches", async (t) => {
	const root = await temporaryGitRepository("pi-pr-tracking-");
	t.after(() => rm(root, { recursive: true, force: true }));
	const tree = (await git(root, ["mktree"])).trim();
	const commit = async (message: string, parent?: string) => (await git(root, [
		"-c", "user.name=Tracking Test", "-c", "user.email=tracking@example.test",
		"commit-tree", tree, "-m", message, ...(parent ? ["-p", parent] : []),
	])).trim();
	const lease = await commit("original");
	const head = await commit("published", lease);
	const rewritten = await commit("rewritten");
	const concurrent = await commit("concurrent", head);
	const ref = "refs/remotes/origin/feature";
	for (const published of [head, rewritten]) {
		for (const initial of [lease, null]) {
			await git(root, ["update-ref", "-d", ref]);
			if (initial) await git(root, ["update-ref", ref, initial]);
			await recordRemoteTrackingRef(spawnBounded, { cwd: root }, "origin", "feature", published, lease);
			assert.equal((await git(root, ["rev-parse", ref])).trim(), published);
		}
	}
	await git(root, ["update-ref", "-d", ref]);
	await recordRemoteTrackingRef(spawnBounded, { cwd: root }, "origin", "feature", head, null);
	assert.equal((await git(root, ["rev-parse", ref])).trim(), head);
	for (const timing of ["before-helper", "before-update", "before-create"] as const) {
		await git(root, ["update-ref", ref, timing === "before-helper" ? concurrent : lease]);
		let calls = 0;
		await recordRemoteTrackingRef(async (command, args, options) => {
			calls += 1;
			if (timing === "before-update" || timing === "before-create" && calls === 2) {
				await git(root, ["update-ref", ref, concurrent]);
			} else if (timing === "before-create" && calls === 1) {
				await git(root, ["update-ref", "-d", ref]);
			}
			return await spawnBounded(command, args, options);
		}, { cwd: root }, "origin", "feature", head, lease);
		assert.equal((await git(root, ["rev-parse", ref])).trim(), concurrent, timing);
	}
});

test("parses only one nonempty CRLF-normalized output line", () => {
	assert.equal(parseSingleOutputLine("value\r\n", "sample"), "value");
	assert.equal(parseSingleOutputLine("value\n", "sample"), "value");
	for (const output of ["", "\n", "value\n\n", "value\r\nnext"]) {
		assert.throws(
			() => parseSingleOutputLine(output, "sample"),
			(error: unknown) => error instanceof Error && error.message === "sample returned invalid output",
			output,
		);
	}
});

test("validates repository paths with shared safety limits", () => {
	assert.deepEqual(validatePaths(["src/file.ts"], "Resolved conflict paths"), ["src/file.ts"]);
	for (const { paths, message } of [
		{ paths: ["../outside.ts"], message: "Resolved conflict paths returned an unsafe path" },
		{ paths: ["src/file.ts", "src/file.ts"], message: "Resolved conflict paths returned duplicate paths" },
		{ paths: Array.from({ length: 129 }, (_, index) => `src/${index}.ts`), message: "Resolved conflict paths returned more than 128 paths" },
		{ paths: ["x".repeat(1_025)], message: "Resolved conflict paths returned an overlong path" },
		{
			paths: Array.from({ length: 33 }, (_, index) => `${index.toString().padStart(2, "0")}${"x".repeat(1_022)}`),
			message: "Resolved conflict paths returned too much path data",
		},
	]) {
		assert.throws(
			() => validatePaths(paths, "Resolved conflict paths"),
			(error: unknown) => error instanceof Error && error.message === message,
			message,
		);
	}
});

test("worktree inspection treats an empty-status Git operation as dirty", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-pr-operation-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await mkdir(join(root, ".git"));
	await writeFile(join(root, ".git", "MERGE_HEAD"), "a".repeat(40));
	const operationPaths = ["MERGE_HEAD", "rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD", "REVERT_HEAD", "sequencer"]
		.map((state) => `.git/${state}`)
		.join("\n") + "\n";
	const exec = async (_command: string, args: string[]) => ({
		stdout: args[0] === "status" ? "" : operationPaths,
		stderr: "",
		code: 0,
		killed: false,
	});
	assert.equal(await inspectWorktreeState(exec, { cwd: root }), "operation");
});

test("worktree inspection includes untracked files as ordinary dirty work", async (t) => {
	const root = await temporaryGitRepository("pi-pr-untracked-");
	t.after(() => rm(root, { recursive: true, force: true }));
	await writeFile(join(root, "pending.ts"), "pending\n");
	assert.equal(await inspectWorktreeState(spawnBounded, { cwd: root }), "dirty");
});

test("worktree lock canonicalizes root and subdirectory calls", async (t) => {
	const root = await temporaryGitRepository("pi-pr-lock-");
	const subdirectory = join(root, "nested");
	const agentDir = await mkdtemp(join(tmpdir(), "pi-pr-lock-agent-"));
	t.after(() => Promise.all([
		rm(root, { recursive: true, force: true }),
		rm(agentDir, { recursive: true, force: true }),
	]));
	await mkdir(subdirectory);
	let release!: () => void;
	const held = new Promise<void>((resolve) => { release = resolve; });
	let entered!: () => void;
	const started = new Promise<void>((resolve) => { entered = resolve; });
	const first = withWorktreeLock(root, async () => {
		entered();
		await held;
	}, { agentDir });
	await started;
	await assert.rejects(
		withWorktreeLock(subdirectory, async () => {}, { agentDir }),
		/Another pi-pr mutation is active/,
	);
	release();
	await first;
	await withWorktreeLock(subdirectory, async () => {}, { agentDir });
});

test("worktree lock namespaces explicit agent directories independently", async (t) => {
	const root = await temporaryGitRepository("pi-pr-lock-namespaces-");
	const firstAgentDir = await mkdtemp(join(tmpdir(), "pi-pr-lock-agent-first-"));
	const secondAgentDir = await mkdtemp(join(tmpdir(), "pi-pr-lock-agent-second-"));
	t.after(() => Promise.all([
		rm(root, { recursive: true, force: true }),
		rm(firstAgentDir, { recursive: true, force: true }),
		rm(secondAgentDir, { recursive: true, force: true }),
	]));
	let release!: () => void;
	const held = new Promise<void>((resolve) => { release = resolve; });
	let entered!: () => void;
	const started = new Promise<void>((resolve) => { entered = resolve; });
	const first = withWorktreeLock(root, async () => {
		entered();
		await held;
	}, { agentDir: firstAgentDir });
	await started;
	try {
		let called = false;
		await withWorktreeLock(root, async () => { called = true; }, { agentDir: secondAgentDir });
		assert.equal(called, true);
	} finally {
		release();
		await first;
	}
});

test("worktree lock recovers a stale lock", async (t) => {
	const root = await temporaryGitRepository("pi-pr-stale-lock-");
	const agentDir = await mkdtemp(join(tmpdir(), "pi-pr-stale-agent-"));
	t.after(() => Promise.all([
		rm(root, { recursive: true, force: true }),
		rm(agentDir, { recursive: true, force: true }),
	]));
	const lockPath = await worktreeLockPath(root, agentDir);
	await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
	await mkdir(lockPath);
	const stale = new Date(Date.now() - 60_000);
	await utimes(lockPath, stale, stale);
	let calls = 0;
	await withWorktreeLock(root, async () => { calls += 1; }, { agentDir });
	assert.equal(calls, 1);
});

test("worktree lock releases safely after operation failure", async (t) => {
	const root = await temporaryGitRepository("pi-pr-release-lock-");
	const agentDir = await mkdtemp(join(tmpdir(), "pi-pr-release-agent-"));
	t.after(() => Promise.all([
		rm(root, { recursive: true, force: true }),
		rm(agentDir, { recursive: true, force: true }),
	]));
	await assert.rejects(
		withWorktreeLock(root, async () => { throw new Error("operation failed"); }, { agentDir }),
		/operation failed/,
	);
	await withWorktreeLock(root, async () => {}, { agentDir });
});

test("porcelain-v2 baseline preserves merge-produced staging outside declared conflicts", () => {
	const staged = `1 M. N... 100644 100644 100644 ${"a".repeat(40)} ${"b".repeat(40)} generated.lock\0`;
	const conflict = `u UU N... 100644 100644 100644 100644 ${"a".repeat(40)} ${"b".repeat(40)} ${"c".repeat(40)} source.ts\0`;
	const resolved = `1 M. N... 100644 100644 100644 ${"a".repeat(40)} ${"d".repeat(40)} source.ts\0`;
	assert.equal(parseStatusSnapshot(staged + conflict).size, 2);
	assert.doesNotThrow(() => assertOnlyDeclaredStatusChanged(staged + conflict, staged + resolved, ["source.ts"]));
	assert.throws(
		() => assertOnlyDeclaredStatusChanged(staged + conflict, conflict, ["source.ts"]),
		/changed outside declared conflict paths: generated\.lock/,
	);
});

test("porcelain-v2 snapshots retain both rename paths", () => {
	const rename = `2 R. N... 100644 100644 100644 ${"a".repeat(40)} ${"b".repeat(40)} R100 destination.ts\0source.ts\0`;
	const snapshot = parseStatusSnapshot(rename);
	assert.deepEqual([...snapshot.keys()], ["destination.ts", "source.ts"]);
	assert.equal(snapshot.get("destination.ts"), rename);
	assert.equal(snapshot.get("source.ts"), rename);
	assert.throws(
		() => assertOnlyDeclaredStatusChanged(rename, "", ["destination.ts"]),
		/changed outside declared conflict paths: source\.ts/,
	);
	assert.doesNotThrow(() => assertOnlyDeclaredStatusChanged(rename, "", ["destination.ts", "source.ts"]));
});
