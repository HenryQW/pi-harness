import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import codegraphExtension from "../extensions/codegraph.ts";

const exec = promisify(execFile);

async function fixture(t: TestContext) {
	const base = await realpath(await mkdtemp(join(tmpdir(), "pi-codegraph-test-")));
	t.after(() => rm(base, { recursive: true, force: true }));
	const primary = join(base, "primary with spaces");
	const worktree = join(base, "worktree with spaces");
	await mkdir(primary);
	await exec("git", ["init", "-q", primary]);
	await exec("git", ["-C", primary, "-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "initial"]);
	await exec("git", ["-C", primary, "worktree", "add", "-qb", "worker", worktree]);
	const { stdout } = await exec("git", ["-C", worktree, "rev-parse", "--absolute-git-dir"]);
	return { base, primary, worktree, lock: join(stdout.trim(), "pi-codegraph-init.lock") };
}

async function index(root: string) {
	await mkdir(join(root, ".codegraph"), { recursive: true });
	await writeFile(join(root, ".codegraph", "codegraph.db"), "index");
}

function harness(cwd: string, options: {
	adapter?: boolean;
	hasUI?: boolean;
	version?: Awaited<ReturnType<ExtensionAPI["exec"]>>;
	init?: () => Promise<{ code: number; stdout: string; stderr: string; killed: boolean }>;
	onStatus?: (text: string | undefined) => void;
} = {}) {
	let start!: (event: unknown, ctx: ExtensionContext) => Promise<void>;
	const notices: { message: string; level: string }[] = [];
	const calls: { command: string; args: string[]; cwd: string }[] = [];
	const pi = {
		on: (name: string, handler: typeof start) => { assert.equal(name, "session_start"); start = handler; },
		getAllTools: () => options.adapter === false ? [] : [{ name: "mcp" }],
		exec: async (command: string, args: string[], opts: { cwd: string }) => {
			calls.push({ command, args, cwd: opts.cwd });
			if (command === "codegraph") {
				if (args[0] === "--version") return options.version ?? { code: 0, stdout: "1.6.0", stderr: "", killed: false };
				if (options.init) return options.init();
				await index(opts.cwd);
				return { code: 0, stdout: "", stderr: "", killed: false };
			}
			try {
				const result = await exec(command, args, { cwd: opts.cwd });
				return { ...result, code: 0, killed: false };
			} catch (error) {
				return error;
			}
		},
	} as unknown as ExtensionAPI;
	const ctx = {
		cwd,
		hasUI: options.hasUI ?? true,
		ui: {
			notify: (message: string, level: string) => notices.push({ message, level }),
			setStatus: (_key: string, text: string | undefined) => options.onStatus?.(text),
		},
	} as unknown as ExtensionContext;
	codegraphExtension(pi);
	return { start: () => start({}, ctx), notices, calls };
}

test("initializes an opted-in linked worktree at its root once, including nested launches", async (t) => {
	const { primary, worktree, lock } = await fixture(t);
	await index(primary);
	const nested = join(worktree, "src");
	await mkdir(nested);
	const run = harness(nested);
	await run.start();
	await run.start();
	assert.deepEqual(run.calls.filter(({ command, args }) => command === "codegraph" && args[0] === "init"), [
		{ command: "codegraph", args: ["init", "--yes", worktree], cwd: worktree },
	]);
	assert.deepEqual(run.notices, [{ message: "CodeGraph worktree index ready.", level: "info" }]);
	await assert.rejects(rmdir(lock), { code: "ENOENT" });
});

test("does not index non-Git directories, unopted repositories, or existing indexes", async (t) => {
	const { base, primary, worktree } = await fixture(t);
	for (const cwd of [base, primary, worktree]) {
		const run = harness(cwd);
		await run.start();
		assert.equal(run.calls.some(({ command, args }) => command === "codegraph" && args[0] === "init"), false);
		assert.deepEqual(run.notices, []);
	}
	await index(worktree);
	const existing = harness(worktree);
	await existing.start();
	assert.equal(existing.calls.some(({ command, args }) => command === "codegraph" && args[0] === "init"), false);
	assert.deepEqual(existing.notices, []);
});

test("warns with install commands for either or both unavailable prerequisites without creating a lock", async (t) => {
	const { worktree, lock } = await fixture(t);
	// Even an existing index still needs a working CLI for MCP calls.
	await index(worktree);
	for (const [adapter, codegraph] of [[false, true], [true, false], [false, false]]) {
		const options = { adapter, version: { code: codegraph ? 0 : 1, stdout: "", stderr: "", killed: false } };
		const run = harness(worktree, options);
		await run.start();
		assert.deepEqual(run.calls, [{ command: "codegraph", args: ["--version"], cwd: worktree }]);
		assert.equal(run.notices[0]!.level, "warning");
		assert.equal(run.notices[0]!.message.includes("pi install npm:pi-mcp-adapter"), !adapter);
		assert.equal(run.notices[0]!.message.includes("npm install -g @colbymchenry/codegraph"), !codegraph);
		await assert.rejects(rmdir(lock), { code: "ENOENT" });
		const headless = harness(worktree, { ...options, hasUI: false });
		const warn = t.mock.method(console, "warn", () => {});
		await headless.start();
		assert.deepEqual(warn.mock.calls[0]!.arguments, [run.notices[0]!.message]);
		warn.mock.restore();
	}
	const timeout = harness(worktree, { version: { code: 0, stdout: "", stderr: "", killed: true } });
	await timeout.start();
	assert.match(timeout.notices[0]!.message, /timed out or killed/);
	assert.equal(timeout.notices[0]!.level, "warning");
});

test("serializes simultaneous sessions and does not accept an in-progress partial database", async (t) => {
	const { primary, worktree } = await fixture(t);
	await index(primary);
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const waiting = Promise.withResolvers<void>();
	let attempts = 0;
	const first = harness(worktree, { init: async () => {
		attempts++;
		await index(worktree);
		entered.resolve();
		await release.promise;
		return { code: 0, stdout: "", stderr: "", killed: false };
	} });
	const second = harness(worktree, { onStatus: (text) => {
		if (text?.includes("waiting")) waiting.resolve();
	} });
	const firstRun = first.start();
	await entered.promise;
	const secondRun = second.start();
	await waiting.promise;
	release.resolve();
	await Promise.all([firstRun, secondRun]);
	assert.equal(attempts, 1);
	assert.equal(second.calls.some(({ command, args }) => command === "codegraph" && args[0] === "init"), false);
	assert.deepEqual(second.notices, []);
});

test("failed init preserves its lock, reports recovery, and a later launch rejects the partial DB", async (t) => {
	const { primary, worktree, lock } = await fixture(t);
	await index(primary);
	const failed = harness(worktree, { init: async () => {
		await index(worktree);
		return { code: 1, stderr: "index worker failed", stdout: "", killed: false };
	} });
	await failed.start();
	assert.match(failed.notices[0]!.message, /index worker failed/);
	assert.ok(failed.notices[0]!.message.includes(lock));
	assert.equal(failed.notices[0]!.level, "error");
	t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
	const waiting = Promise.withResolvers<void>();
	const retry = harness(worktree, { onStatus: (text) => {
		if (text?.includes("waiting")) waiting.resolve();
	} });
	const retryRun = retry.start();
	await waiting.promise;
	t.mock.timers.tick(5 * 60_000);
	await retryRun;
	assert.match(retry.notices[0]!.message, /Timed out waiting/);
	assert.equal(retry.calls.some(({ command, args }) => command === "codegraph" && args[0] === "init"), false);
	await rmdir(lock); // explicit recovery, never automatic deletion
});

test("missing CLI, killed init, and success without a database all report setup failure", async (t) => {
	const { primary, worktree, lock } = await fixture(t);
	await index(primary);
	for (const init of [
		async () => { throw new Error("spawn codegraph ENOENT"); },
		async () => ({ code: 0, stdout: "", stderr: "", killed: true }),
		async () => ({ code: 0, stdout: "", stderr: "", killed: false }),
	]) {
		const run = harness(worktree, { init });
		await run.start();
		assert.equal(run.notices[0]!.level, "error");
		assert.ok(run.notices[0]!.message.includes(lock));
		await rmdir(lock);
	}
});

test("rejects an alternate CODEGRAPH_DIR instead of indexing a different directory", async (t) => {
	const { worktree } = await fixture(t);
	const original = process.env.CODEGRAPH_DIR;
	process.env.CODEGRAPH_DIR = ".custom-codegraph";
	t.after(() => { if (original === undefined) delete process.env.CODEGRAPH_DIR; else process.env.CODEGRAPH_DIR = original; });
	const run = harness(worktree);
	await run.start();
	assert.match(run.notices[0]!.message, /requires the default CODEGRAPH_DIR/);
	assert.equal(run.calls.some(({ command, args }) => command === "codegraph" && args[0] === "init"), false);
});
