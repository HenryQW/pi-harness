import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

test("bounded spawn rejects streaming output beyond its cap", async () => {
	await assert.rejects(
		spawnBounded(process.execPath, ["-e", "process.stdout.write('x'.repeat(33))"], {
			cwd: process.cwd(),
			stdoutLimitBytes: 32,
		}),
		/stdout exceeded 32 bytes/,
	);
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
	const root = await mkdtemp(join(tmpdir(), "pi-pr-lock-"));
	const subdirectory = join(root, "nested");
	const agentDir = join(root, "agent");
	t.after(() => rm(root, { recursive: true, force: true }));
	await spawnBounded("git", ["init", "--quiet"], { cwd: root });
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
