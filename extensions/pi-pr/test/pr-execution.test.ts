import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	assertOnlyDeclaredStatusChanged,
	inspectWorktree,
	parseStatusSnapshot,
	spawnBounded,
	withWorktreeLock,
} from "../extensions/pr-execution.ts";

const LOCK_REF_PREFIX = "refs/pi-pr/worktree-locks";

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

async function worktreeLockRef(root: string): Promise<string> {
	const canonical = await realpath(root);
	return `${LOCK_REF_PREFIX}/${createHash("sha256").update(canonical).digest("hex")}`;
}

async function writeLockOwner(root: string, pid: number, nonce: string): Promise<string> {
	const oid = (await git(root, ["hash-object", "-w", "--stdin", "--no-filters"], `pid=${pid}\nnonce=${nonce}\n`)).trim();
	assert.match(oid, /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
	return oid;
}

async function readRef(root: string, ref: string): Promise<string | null> {
	const result = await spawnBounded("git", ["rev-parse", "--verify", "--quiet", ref], { cwd: root });
	assert.equal(result.killed, false);
	if (result.code === 1) {
		assert.equal(result.stdout, "");
		assert.equal(result.stderr, "");
		return null;
	}
	assert.equal(result.code, 0, result.stderr || result.stdout);
	assert.equal(result.stderr, "");
	const oid = result.stdout.trim();
	assert.match(oid, /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
	return oid;
}

function missingProcess(): NodeJS.ErrnoException {
	const error = new Error("no such process") as NodeJS.ErrnoException;
	error.code = "ESRCH";
	return error;
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
	t.after(() => rm(root, { recursive: true, force: true }));
	await mkdir(subdirectory);
	let release!: () => void;
	const held = new Promise<void>((resolve) => { release = resolve; });
	let entered!: () => void;
	const started = new Promise<void>((resolve) => { entered = resolve; });
	const first = withWorktreeLock(root, async () => {
		entered();
		await held;
	});
	await started;
	await assert.rejects(
		withWorktreeLock(subdirectory, async () => {}),
		/Another pi-pr mutation is active/,
	);
	release();
	await first;
	await withWorktreeLock(subdirectory, async () => {});
});

test("worktree lock reclaims an orphan Git ref with a dead owner", async (t) => {
	const root = await temporaryGitRepository("pi-pr-orphan-lock-");
	t.after(() => rm(root, { recursive: true, force: true }));
	const ref = await worktreeLockRef(root);
	const deadPid = 999_999_991;
	const orphan = await writeLockOwner(root, deadPid, "11111111-1111-1111-1111-111111111111");
	await git(root, ["update-ref", ref, orphan]);
	const originalKill = process.kill;
	process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
		if (pid === deadPid && signal === 0) throw missingProcess();
		return originalKill(pid, signal);
	}) as typeof process.kill;
	t.after(() => { process.kill = originalKill; });
	let calls = 0;
	await withWorktreeLock(root, async () => {
		calls += 1;
		assert.notEqual(await readRef(root, ref), orphan);
	});
	assert.equal(calls, 1);
	assert.equal(await readRef(root, ref), null);
});

test("worktree lock cannot delete a competing replacement during stale recovery", async (t) => {
	const root = await temporaryGitRepository("pi-pr-lock-cas-");
	t.after(() => rm(root, { recursive: true, force: true }));
	const ref = await worktreeLockRef(root);
	const deadPid = 999_999_992;
	const orphan = await writeLockOwner(root, deadPid, "22222222-2222-2222-2222-222222222222");
	const replacement = await writeLockOwner(root, process.pid, "33333333-3333-3333-3333-333333333333");
	await git(root, ["update-ref", ref, orphan]);
	const originalKill = process.kill;
	let replaced = false;
	process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
		if (pid === deadPid && signal === 0) {
			execFileSync("git", ["update-ref", ref, replacement, orphan], { cwd: root, encoding: "utf8" });
			replaced = true;
			throw missingProcess();
		}
		return originalKill(pid, signal);
	}) as typeof process.kill;
	t.after(() => { process.kill = originalKill; });
	let called = false;
	await assert.rejects(
		withWorktreeLock(root, async () => { called = true; }),
		/Another pi-pr mutation is active/,
	);
	assert.equal(replaced, true);
	assert.equal(called, false);
	assert.equal(await readRef(root, ref), replacement);
});

test("worktree lock release cannot delete a competing replacement", async (t) => {
	const root = await temporaryGitRepository("pi-pr-lock-release-");
	t.after(() => rm(root, { recursive: true, force: true }));
	const ref = await worktreeLockRef(root);
	const replacement = await writeLockOwner(root, process.pid, "44444444-4444-4444-4444-444444444444");
	await assert.rejects(
		withWorktreeLock(root, async () => {
			const owner = await readRef(root, ref);
			assert.ok(owner);
			await git(root, ["update-ref", ref, replacement, owner]);
		}),
		/git update-ref .* failed/,
	);
	assert.equal(await readRef(root, ref), replacement);
});

test("worktree lock rejects a live Git-ref owner", async (t) => {
	const root = await temporaryGitRepository("pi-pr-live-lock-");
	t.after(() => rm(root, { recursive: true, force: true }));
	const ref = await worktreeLockRef(root);
	const owner = await writeLockOwner(root, process.pid, "55555555-5555-5555-5555-555555555555");
	await git(root, ["update-ref", ref, owner]);
	let called = false;
	await assert.rejects(
		withWorktreeLock(root, async () => { called = true; }),
		/Another pi-pr mutation is active/,
	);
	assert.equal(called, false);
	assert.equal(await readRef(root, ref), owner);
});

test("worktree lock retains a BOM-prefixed malformed Git-ref owner", async (t) => {
	const root = await temporaryGitRepository("pi-pr-bom-lock-");
	t.after(() => rm(root, { recursive: true, force: true }));
	const ref = await worktreeLockRef(root);
	const deadPid = 999_999_993;
	const owner = (await git(root, ["hash-object", "-w", "--stdin", "--no-filters"],
		`\uFEFFpid=${deadPid}\nnonce=66666666-6666-6666-6666-666666666666\n`)).trim();
	await git(root, ["update-ref", ref, owner]);
	const originalKill = process.kill;
	process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
		if (pid === deadPid && signal === 0) throw missingProcess();
		return originalKill(pid, signal);
	}) as typeof process.kill;
	t.after(() => { process.kill = originalKill; });
	let called = false;
	await assert.rejects(
		withWorktreeLock(root, async () => { called = true; }),
		/Git worktree lock owner object is invalid/,
	);
	assert.equal(called, false);
	assert.equal(await readRef(root, ref), owner);
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
