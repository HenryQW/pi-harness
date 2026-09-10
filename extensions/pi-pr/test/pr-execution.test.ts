import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { extensionConfigDir } from "@henryqw/pi-config-store";
import {
	assertOnlyDeclaredStatusChanged,
	inspectWorktree,
	parseStatusSnapshot,
	spawnBounded,
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

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForFile(path: string, timeoutMs: number): Promise<string> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			return await readFile(path, "utf8");
		} catch (error) {
			if (!error || typeof error !== "object" || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		await delay(20);
	}
	throw new Error(`Timed out waiting for ${path}`);
}

async function waitForExit(pid: number): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (Date.now() < deadline) {
		try {
			process.kill(pid, 0);
		} catch (error) {
			if (error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ESRCH") return;
			throw error;
		}
		await delay(20);
	}
	throw new Error(`SIGTERM-ignoring descendant ${pid} remained alive`);
}

test("bounded spawn rejects streaming output beyond its cap", async () => {
	await assert.rejects(
		spawnBounded(process.execPath, ["-e", "process.stdout.write('x'.repeat(33))"], {
			cwd: process.cwd(),
			stdoutLimitBytes: 32,
		}),
		/stdout exceeded 32 bytes/,
	);
});

test("bounded spawn kills a SIGTERM-ignoring descendant after its leader closes", { skip: process.platform === "win32" }, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-pr-process-group-"));
	const pidPath = join(root, "descendant.pid");
	let descendantPid: number | undefined;
	t.after(() => rm(root, { recursive: true, force: true }));
	t.after(() => {
		if (descendantPid === undefined) return;
		try {
			process.kill(descendantPid, "SIGKILL");
		} catch (error) {
			if (!error || typeof error !== "object" || (error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
		}
	});
	const descendant = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1_000);";
	const leader = [
		"const { spawn } = require('node:child_process');",
		"const { writeFileSync } = require('node:fs');",
		`const child = spawn(process.execPath, [\"-e\", ${JSON.stringify(descendant)}], { stdio: \"ignore\" });`,
		"writeFileSync(process.argv[1], String(child.pid));",
		"setInterval(() => {}, 1_000);",
	].join("\n");
	const timedOut = assert.rejects(
		spawnBounded(process.execPath, ["-e", leader, pidPath], { cwd: root, timeoutMs: 1_000 }),
		/timed out after 1000ms/,
	);
	const pidText = await waitForFile(pidPath, 500);
	descendantPid = Number(pidText);
	assert.ok(Number.isSafeInteger(descendantPid) && descendantPid > 0, `invalid descendant PID: ${pidText}`);
	await timedOut;
	await waitForExit(descendantPid);
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
	assert.equal(await inspectWorktree(exec, { cwd: root }), "dirty");
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
		/Lock file is already being held/,
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
