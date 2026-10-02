import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";
import { setImmediate } from "node:timers/promises";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
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
	hasUI?: boolean;
	mode?: "tui" | "rpc";
	version?: Awaited<ReturnType<ExtensionAPI["exec"]>>;
	init?: (signal?: AbortSignal) => Promise<{ code: number; stdout: string; stderr: string; killed: boolean }>;
	gitProbe?: (args: string[], signal?: AbortSignal) => Promise<Awaited<ReturnType<ExtensionAPI["exec"]>> | undefined>;
	explore?: Awaited<ReturnType<ExtensionAPI["exec"]>>;
	onStatus?: (text: string | undefined) => void;
} = {}) {
	let start!: (event: unknown, ctx: ExtensionContext) => Promise<void> | void;
	let shutdown!: typeof start;
	const notices: { message: string; level: string }[] = [];
	const calls: { command: string; args: string[]; cwd: string; timeout?: number }[] = [];
	let tool!: ToolDefinition;
	const pi = {
		on: (name: string, handler: typeof start) => {
			if (name === "session_start") start = handler;
			else if (name === "session_shutdown") shutdown = handler;
		},
		registerTool: (definition: ToolDefinition) => { tool = definition; },
		exec: async (command: string, args: string[], opts: { cwd: string; timeout?: number; signal?: AbortSignal }) => {
			calls.push({ command, args, cwd: opts.cwd, ...(args[0] === "explore" && { timeout: opts.timeout }) });
			if (command === "codegraph") {
				if (args[0] === "--version") return options.version ?? { code: 0, stdout: "1.6.0", stderr: "", killed: false };
				if (args[0] === "explore") return options.explore ?? { code: 0, stdout: "explored", stderr: "", killed: false };
				if (options.init) return options.init(opts.signal);
				await index(opts.cwd);
				return { code: 0, stdout: "", stderr: "", killed: false };
			}
			if (command === "git" && options.gitProbe) {
				const result = await options.gitProbe(args, opts.signal);
				if (result) return result;
			}
			try {
				const result = await exec(command, args, { cwd: opts.cwd, signal: opts.signal });
				return { ...result, code: 0, killed: false };
			} catch (error) {
				return error;
			}
		},
	} as unknown as ExtensionAPI;
	const widgets: { key: string; content: string | string[] | undefined }[] = [];
	const statuses: (string | undefined)[] = [];
	const ctx = {
		cwd,
		mode: options.mode ?? "rpc",
		hasUI: options.hasUI ?? true,
		ui: {
			theme: { fg: (color: string, text: string) => `<${color}>${text}</${color}>` },
			notify: (message: string, level: string) => notices.push({ message, level }),
			setWidget: (_key: string, content: string | string[] | undefined) => widgets.push({ key: _key, content }),
			setStatus: (_key: string, text: string | undefined) => { statuses.push(text); options.onStatus?.(text); },
		},
	} as unknown as ExtensionContext;
	codegraphExtension(pi);
	const explore = (params: Record<string, unknown>) => tool.execute("call", params, undefined, undefined, ctx as never);
	return { start: () => start({}, ctx), shutdown: (reason = "quit") => shutdown({ reason }, ctx), explore, tool, notices, calls, widgets, statuses };
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
	assert.deepEqual(run.widgets, []);
	assert.ok(run.statuses.some((text) => text?.includes("codegraph · indexing")));
	assert.equal(run.statuses.at(-1), undefined);
	await assert.rejects(rmdir(lock), { code: "ENOENT" });
});

test("TUI indexing survives session replacement and silently stops its dim animation", async (t) => {
	const { primary, worktree, lock } = await fixture(t);
	await index(primary);
	t.mock.timers.enable({ apis: ["Date", "setInterval"] });
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const cleared = Promise.withResolvers<void>();
	let indexing = false;
	let initSignal: AbortSignal | undefined;
	const run = harness(worktree, {
		mode: "tui",
		onStatus: (text) => {
			if (text?.includes("indexing")) indexing = true;
			else if (indexing && text === undefined) cleared.resolve();
		},
		init: async (signal) => {
			initSignal = signal;
			entered.resolve();
			await release.promise;
			await index(worktree);
			return { code: 0, stdout: "", stderr: "", killed: false };
		},
	});
	t.after(() => run.shutdown());
	assert.equal(run.start(), undefined);
	await entered.promise;
	assert.equal(run.statuses.at(-1), "<dim>⠋ codegraph · indexing 0s</dim>");
	t.mock.timers.tick(100);
	assert.equal(run.statuses.at(-1), "<dim>⠙ codegraph · indexing 0s</dim>");
	t.mock.timers.tick(1100);
	assert.match(run.statuses.at(-1)!, /indexing 1s/);
	assert.equal(run.start(), undefined); // Repeated starts reuse this initializer.
	let replaced = false;
	const replacement = Promise.resolve(run.shutdown("new")).then(() => { replaced = true; });
	await setImmediate();
	assert.equal(replaced, false);
	assert.equal(initSignal?.aborted, false);
	assert.equal(run.calls.filter(({ args }) => args[0] === "init").length, 1);
	release.resolve();
	await replacement;
	await cleared.promise;
	await assert.rejects(rmdir(lock), { code: "ENOENT" });
	await setImmediate();
	const count = run.statuses.length;
	t.mock.timers.tick(1000);
	assert.equal(run.statuses.length, count);
	assert.deepEqual(run.widgets, []);
	assert.deepEqual(run.notices, []);
});

test("shutdown stops a waiting TUI spinner without removing another initializer's lock", async (t) => {
	const { primary, worktree, lock } = await fixture(t);
	await index(primary);
	await mkdir(lock);
	t.mock.timers.enable({ apis: ["Date", "setInterval"] });
	const waiting = Promise.withResolvers<void>();
	const run = harness(worktree, { mode: "tui", onStatus: (text) => {
		if (text?.includes("waiting for index")) waiting.resolve();
	} });
	run.start();
	await waiting.promise;
	await run.shutdown();
	await setImmediate();
	assert.equal(run.statuses.at(-1), undefined);
	const count = run.statuses.length;
	t.mock.timers.tick(1000);
	assert.equal(run.statuses.length, count);
	assert.deepEqual(run.notices, []);
	await rmdir(lock);
});

test("shutdown cancels every Git probe without starting more setup work", async (t) => {
	const { primary, worktree, lock } = await fixture(t);
	await index(primary);
	for (const probe of ["--show-toplevel", "--absolute-git-dir", "list"]) {
		const entered = Promise.withResolvers<void>();
		const run = harness(worktree, { mode: "tui", gitProbe: async (args, signal) => {
			if (!args.includes(probe)) return;
			assert.ok(signal);
			entered.resolve();
			return new Promise((resolve) => signal.addEventListener("abort", () => {
				resolve({ code: 0, stdout: "", stderr: "", killed: true });
			}, { once: true }));
		} });
		run.start();
		await entered.promise;
		const count = run.calls.length;
		await run.shutdown();
		assert.equal(run.calls.length, count);
		assert.deepEqual(run.notices, []);
		await assert.rejects(rmdir(lock), { code: "ENOENT" });
	}
});

test("does not index non-Git directories, unopted repositories, or existing indexes", async (t) => {
	const { base, primary, worktree, lock } = await fixture(t);
	for (const cwd of [base, primary, worktree]) {
		const run = harness(cwd);
		await run.start();
		assert.equal(run.calls.some(({ command, args }) => command === "codegraph" && args[0] === "init"), false);
		assert.deepEqual(run.notices, []);
		assert.equal(run.statuses.at(-1), undefined);
	}
	await index(worktree);
	const existing = harness(worktree);
	await existing.start();
	assert.equal(existing.calls.some(({ command, args }) => command === "codegraph" && args[0] === "init"), false);
	assert.deepEqual(existing.notices, []);
	assert.equal(existing.statuses.at(-1), undefined);
	await assert.rejects(rmdir(lock), { code: "ENOENT" });
});

test("warns with the install command when the CLI is unavailable without creating a lock", async (t) => {
	const { worktree, lock } = await fixture(t);
	// Even an existing index still needs a working CLI for codegraph_explore.
	await index(worktree);
	const options = { version: { code: 1, stdout: "", stderr: "", killed: false } };
	const run = harness(worktree, options);
	await run.start();
	assert.deepEqual(run.calls, [{ command: "codegraph", args: ["--version"], cwd: worktree }]);
	assert.equal(run.notices[0]!.level, "warning");
	assert.equal(run.statuses.at(-1), "<warning>!</warning> pi-codegraph: prerequisites missing");
	assert.ok(run.notices[0]!.message.includes("npm install -g @colbymchenry/codegraph"));
	await assert.rejects(rmdir(lock), { code: "ENOENT" });
	const headless = harness(worktree, { ...options, hasUI: false });
	const warn = t.mock.method(console, "warn", () => {});
	await headless.start();
	assert.deepEqual(warn.mock.calls[0]!.arguments, [run.notices[0]!.message]);
	warn.mock.restore();
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
		if (text?.includes("waiting for index")) waiting.resolve();
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
	assert.equal(failed.statuses.at(-1), "<error>!</error> pi-codegraph: setup failed");
	t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
	const waiting = Promise.withResolvers<void>();
	const retry = harness(worktree, { onStatus: (text) => {
		if (text?.includes("waiting for index")) waiting.resolve();
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

test("codegraph_explore passes the query, file cap, and project path to the CLI", async () => {
	const run = harness("/session");
	assert.equal(run.tool.name, "codegraph_explore");
	assert.deepEqual(await run.explore({ query: "how does init work" }), { content: [{ type: "text", text: "explored" }], details: undefined });
	await run.explore({ query: "initialize", maxFiles: 3, projectPath: "/project/src" });
	assert.deepEqual(run.calls, [
		{ command: "codegraph", args: ["explore", "--path", "/session", "--max-files", "12", "how does init work"], cwd: "/session", timeout: 120_000 },
		{ command: "codegraph", args: ["explore", "--path", "/project/src", "--max-files", "3", "initialize"], cwd: "/project/src", timeout: 120_000 },
	]);
});

test("codegraph_explore surfaces the CLI stderr tail on failure", async () => {
	const run = harness("/session", { explore: { code: 1, stdout: "", stderr: `${"x".repeat(3000)}CodeGraph not initialized\n`, killed: false } });
	await assert.rejects(run.explore({ query: "q" }), (error: Error) => {
		assert.match(error.message, /^codegraph explore failed \(exit 1\): x+CodeGraph not initialized$/);
		assert.ok(error.message.length < 2100);
		return true;
	});
});
