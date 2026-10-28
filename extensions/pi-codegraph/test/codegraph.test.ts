import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, rmdir, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";
import { setImmediate, setTimeout as delay } from "node:timers/promises";
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
	init?: (signal?: AbortSignal, root?: string) => Promise<{ code: number; stdout: string; stderr: string; killed: boolean }>;
	gitProbe?: (args: string[], signal?: AbortSignal) => Promise<Awaited<ReturnType<ExtensionAPI["exec"]>> | undefined>;
	explore?: Awaited<ReturnType<ExtensionAPI["exec"]>>;
	onStatus?: (text: string | undefined) => void;
	confirm?: boolean | ((signal?: AbortSignal) => Promise<boolean>);
	reindexRecommended?: boolean;
} = {}) {
	let start!: (event: unknown, ctx: ExtensionContext) => Promise<void> | void;
	let shutdown!: typeof start;
	const notices: { message: string; level: string }[] = [];
	const calls: { command: string; args: string[]; cwd: string; timeout?: number }[] = [];
	const servers = new Map<string, { cwd: string }>();
	const registrations: string[] = [];
	const removals: string[] = [];
	const prompts: string[] = [];
	let tool!: ToolDefinition;
	const pi = {
		registerMcpServer: (name: string, config: { cwd: string }) => { registrations.push(name); servers.set(name, config); },
		unregisterMcpServer: (name: string) => { removals.push(name); servers.delete(name); },
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
				if (args[0] === "status") {
					const index = { state: "complete", reindexRecommended: options.reindexRecommended ?? false };
					return { code: 0, stdout: JSON.stringify({ index }), stderr: "", killed: false };
				}
				if (options.init) return options.init(opts.signal, opts.cwd);
				if (args[0] === "init") await index(opts.cwd);
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
	const statuses: (string | undefined)[] = [];
	const ctx = {
		cwd,
		mode: options.mode ?? "rpc",
		hasUI: options.hasUI ?? true,
		ui: {
			theme: { fg: (color: string, text: string) => `<${color}>${text}</${color}>` },
			notify: (message: string, level: string) => notices.push({ message, level }),
			confirm: async (title: string, _message: string, opts?: { signal?: AbortSignal }) => {
				prompts.push(title);
				return typeof options.confirm === "function" ? options.confirm(opts?.signal) : options.confirm ?? false;
			},
			setStatus: (_key: string, text: string | undefined) => { statuses.push(text); options.onStatus?.(text); },
		},
	} as unknown as ExtensionContext;
	codegraphExtension(pi);
	const explore = (params: Record<string, unknown>, signal?: AbortSignal) => tool.execute("call", params, signal, undefined, ctx as never);
	return { start: () => start({}, ctx), shutdown: (reason = "quit") => shutdown({ reason }, ctx), explore, tool, notices, calls, statuses, servers, registrations, removals, prompts };
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
	assert.ok(run.statuses.some((text) => text?.includes("CG · indexing")));
	assert.equal(run.statuses.at(-1), "<success>✓</success> CG");
	assert.deepEqual(run.servers.get("pi-codegraph"), { command: "codegraph", args: ["serve", "--mcp", "--path", worktree], cwd: worktree, exposure: "hidden" });
	await assert.rejects(rmdir(lock), { code: "ENOENT" });
});

test("offers one time to index the primary checkout, then seeds the worktree from it", async (t) => {
	const declined = await fixture(t);
	// Non-TUI modes await setup during session_start, so a dialog there could never be answered.
	const headless = harness(declined.worktree, { confirm: true });
	await headless.start();
	assert.deepEqual(headless.prompts, []);
	const no = harness(declined.worktree, { mode: "tui" });
	no.start();
	await no.shutdown("new");
	no.start();
	await no.shutdown("new");
	assert.equal(no.prompts.length, 1);
	assert.equal(no.calls.some(({ args }) => args[0] === "init"), false);
	assert.equal(no.statuses.at(-1), "<dim>○</dim> CG");
	assert.equal(no.servers.size, 0);
	const { primary, worktree } = await fixture(t);
	const yes = harness(worktree, { mode: "tui", confirm: true });
	yes.start();
	await yes.shutdown("new");
	assert.deepEqual(yes.calls.filter(({ command }) => command === "codegraph").map(({ args }) => args.join(" ")), ["--version", `init --yes ${primary}`, `init --yes ${worktree}`]);
	assert.equal(yes.statuses.at(-1), "<success>✓</success> CG");
});

test("a dismissed prompt is not a decline, and a failed primary init keeps the primary lock", async (t) => {
	const { primary, worktree, lock: worktreeLock } = await fixture(t);
	const asked = Promise.withResolvers<void>();
	const dismissed = harness(worktree, { mode: "tui", confirm: (signal) => {
		asked.resolve();
		return new Promise((resolve) => signal?.addEventListener("abort", () => resolve(false), { once: true }));
	} });
	dismissed.start();
	await asked.promise;
	// An open dialog holds no lock: other sessions proceed, and a killed Pi leaves nothing stale.
	await assert.rejects(stat(worktreeLock), { code: "ENOENT" });
	await dismissed.shutdown();
	await assert.rejects(stat(join(primary, ".git", "pi-codegraph-declined")), { code: "ENOENT" });
	const failed = harness(worktree, { mode: "tui", confirm: true, init: async () => {
		await index(primary);
		return { code: 1, stdout: "", stderr: "primary init failed", killed: false };
	} });
	failed.start();
	await failed.shutdown("new");
	const lock = join(primary, ".git", "pi-codegraph-init.lock");
	assert.ok(failed.notices[0]!.message.includes(lock));
	// A partial primary database must not authorize a linked-worktree initializer.
	t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
	const waiting = Promise.withResolvers<void>();
	const retry = harness(worktree, { onStatus: (text) => {
		if (text?.includes("waiting for index")) waiting.resolve();
	} });
	const blocked = assert.rejects(retry.explore({ query: "q" }), (error: Error) => {
		assert.match(error.message, /Timed out waiting/);
		assert.ok(error.message.includes(lock));
		return true;
	});
	await waiting.promise;
	t.mock.timers.tick(5 * 60_000);
	await blocked;
	assert.equal(retry.calls.some(({ args }) => args[0] === "init" || args[0] === "explore"), false);
	assert.equal(retry.servers.size, 0);
	await rmdir(lock); // Explicit recovery after repair of the primary index.
	await retry.explore({ query: "q" });
	assert.equal(retry.servers.size, 1);
	await retry.shutdown();
});

test("does not offer to index a bare repository", async (t) => {
	const { base, primary } = await fixture(t);
	const bare = join(base, "bare.git");
	const worktree = join(base, "bare-worktree");
	await exec("git", ["clone", "-q", "--bare", primary, bare]);
	await exec("git", ["-C", bare, "worktree", "add", "-q", "--detach", worktree]);
	const run = harness(worktree, { mode: "tui", confirm: true });
	run.start();
	await run.shutdown("new");
	assert.deepEqual(run.prompts, []);
	assert.equal(run.calls.some(({ args }) => args[0] === "init"), false);
});

test("seeds from the closest usable index, then syncs", async (t) => {
	const scenarios = [
		{ built: "1.6.0", calls: ["status", "sync"], seed: "closest" },
		{ built: "1.5.0", calls: ["init"] },
		// A CodeGraph writer holds the closest index, so its snapshot could fall inside a sync.
		{ built: "1.6.0", busy: true, calls: ["status", "sync"], seed: "older" },
		// CodeGraph reports that its current extraction engine would rebuild the copied index.
		{ built: "1.6.0", reindexRecommended: true, calls: ["status", "status", "init"] },
		// Different extension mappings change how unchanged files parse, which sync does not redo.
		{ built: "1.6.0", config: true, calls: ["init"] },
	];
	for (const { built, busy, reindexRecommended, config, calls, seed } of scenarios) {
		const { base, primary, worktree } = await fixture(t);
		const old = (await exec("git", ["-C", worktree, "rev-parse", "HEAD"])).stdout.trim();
		await writeFile(join(worktree, "a.ts"), "export const a = 1;\n");
		await exec("git", ["-C", worktree, "add", "a.ts"]);
		await exec("git", ["-C", worktree, "-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit", "-qm", "a"]);
		const head = (await exec("git", ["-C", worktree, "rev-parse", "HEAD"])).stdout.trim();
		const other = join(base, "other");
		await exec("git", ["-C", primary, "worktree", "add", "-q", "--detach", other, "worker"]);
		for (const [root, sha] of [[primary, old], [other, head]]) {
			await mkdir(join(root, ".codegraph"));
			const db = new DatabaseSync(join(root, ".codegraph", "codegraph.db"));
			db.exec(`CREATE TABLE project_metadata (key TEXT PRIMARY KEY, value TEXT);
				INSERT INTO project_metadata VALUES ('index_state', 'complete'), ('indexed_with_version', '${built}'), ('indexed_at_commit', '${sha}');`);
			db.close();
		}
		const writerLock = join(other, ".codegraph", "codegraph.lock");
		if (busy) await writeFile(writerLock, "1");
		if (config) await writeFile(join(worktree, "codegraph.json"), '{"extensions":{".tpl":"html"}}');
		const run = harness(worktree, { reindexRecommended });
		await run.start();
		assert.deepEqual(run.calls.filter(({ args }) => args.includes(worktree)).map(({ args }) => args[0]), calls);
		assert.equal(run.statuses.at(-1), "<success>✓</success> CG");
		// Only the writer that took a lock releases it.
		if (busy) await stat(writerLock);
		else await assert.rejects(stat(writerLock), { code: "ENOENT" });
		if (!seed) continue;
		const seeded = new DatabaseSync(join(worktree, ".codegraph", "codegraph.db"), { readOnly: true });
		assert.equal(seeded.prepare("SELECT value FROM project_metadata WHERE key = 'indexed_at_commit'").get()?.value, seed === "closest" ? head : old);
		seeded.close();
	}
});

test("never passes indexed metadata to Git as an option", async (t) => {
	const { base, primary, worktree } = await fixture(t);
	const output = join(base, "overwritten");
	await mkdir(join(primary, ".codegraph"));
	const db = new DatabaseSync(join(primary, ".codegraph", "codegraph.db"));
	db.exec(`CREATE TABLE project_metadata (key TEXT PRIMARY KEY, value TEXT);
		INSERT INTO project_metadata VALUES ('index_state', 'complete'), ('indexed_with_version', '1.6.0'), ('indexed_at_commit', '--output=${output}');`);
	db.close();
	const run = harness(worktree);
	await run.start();
	assert.equal(run.calls.some(({ command, args }) => command === "git" && args[0] === "diff"), false);
	await assert.rejects(stat(output), { code: "ENOENT" });
	assert.equal(run.statuses.at(-1), "<success>✓</success> CG");
});

test("a failed session setup removes only that worktree's watcher", async (t) => {
	const { primary, worktree } = await fixture(t);
	await index(primary);
	await index(worktree);
	let fail = false;
	const run = harness(worktree, { gitProbe: async (args) => fail && args.includes("--absolute-git-dir") ? { code: 1, stdout: "", stderr: "boom", killed: false } : undefined });
	await run.start();
	await run.explore({ query: "q", projectPath: primary });
	assert.equal(run.servers.size, 2);
	fail = true;
	await run.start();
	assert.match(run.notices[0]!.message, /boom/);
	assert.deepEqual([...run.servers.values()].map(({ cwd }) => cwd), [primary]);
	await run.shutdown();
});

test("session replacement waits for active TUI initialization and its final indexed badge", async (t) => {
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
	assert.equal(run.statuses.at(-1), "<dim>⠋ CG · indexing 0s</dim>");
	t.mock.timers.tick(100);
	assert.equal(run.statuses.at(-1), "<dim>⠙ CG · indexing 0s</dim>");
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
	assert.equal(run.statuses.at(-1), "<success>✓</success> CG");
	await assert.rejects(rmdir(lock), { code: "ENOENT" });
	await setImmediate();
	const count = run.statuses.length;
	t.mock.timers.tick(1000);
	assert.equal(run.statuses.length, count);
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
		assert.equal(run.statuses.at(-1), cwd === base ? undefined : "<dim>○</dim> CG");
	}
	await index(worktree);
	const existing = harness(worktree);
	await existing.start();
	assert.equal(existing.calls.some(({ command, args }) => command === "codegraph" && args[0] === "init"), false);
	assert.deepEqual(existing.notices, []);
	assert.equal(existing.statuses.at(-1), "<success>✓</success> CG");
	await assert.rejects(rmdir(lock), { code: "ENOENT" });
});

test("warns with the install command when the CLI is unavailable without creating a lock", async (t) => {
	const { worktree, lock } = await fixture(t);
	// Even an existing index still needs a working CLI for codegraph_explore.
	await index(worktree);
	const options = { version: { code: 1, stdout: "", stderr: "", killed: false } };
	const run = harness(worktree, options);
	await run.start();
	assert.deepEqual(run.calls.filter(({ command }) => command === "codegraph"), [{ command: "codegraph", args: ["--version"], cwd: worktree }]);
	assert.equal(run.notices[0]!.level, "warning");
	assert.equal(run.statuses.at(-1), "<warning>!</warning> CG: prerequisites missing");
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
	assert.equal(failed.statuses.at(-1), "<error>!</error> CG: setup failed");
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

test("codegraph_explore resolves nested paths, passes arguments, and reports bounded errors", async (t) => {
	const { primary, worktree } = await fixture(t);
	await index(primary);
	await index(worktree);
	const nested = join(worktree, "src");
	await mkdir(nested);
	const run = harness(primary);
	await run.start();
	assert.equal(run.tool.name, "codegraph_explore");
	const parameters = JSON.parse(JSON.stringify(run.tool.parameters));
	assert.equal(parameters.type, "object");
	assert.ok(parameters.properties);
	assert.deepEqual(await run.explore({ query: "how does init work" }), { content: [{ type: "text", text: "explored" }], details: undefined });
	await run.explore({ query: "initialize", maxFiles: 3, projectPath: nested });
	assert.deepEqual(run.calls.filter(({ args }) => args[0] === "explore"), [
		{ command: "codegraph", args: ["explore", "--path", primary, "--max-files", "12", "how does init work"], cwd: primary, timeout: 120_000 },
		{ command: "codegraph", args: ["explore", "--path", worktree, "--max-files", "3", "initialize"], cwd: worktree, timeout: 120_000 },
	]);
	const failed = harness(primary, { explore: { code: 1, stdout: "", stderr: `${"x".repeat(3000)}CodeGraph not initialized\n`, killed: false } });
	await assert.rejects(failed.explore({ query: "q" }), (error: Error) => {
		assert.match(error.message, /^codegraph explore failed \(exit 1\): x+CodeGraph not initialized$/);
		assert.ok(error.message.length < 2100);
		return true;
	});
});

test("a workspace selects independent repositories on demand without scanning children", async (t) => {
	const { base, primary, worktree } = await fixture(t);
	const other = await fixture(t);
	await index(primary);
	await index(other.primary);
	const nested = join(other.primary, "src");
	await mkdir(nested);
	const alias = join(base, "alias");
	await symlink(other.primary, alias);
	let run = harness(base);
	await run.start();
	assert.equal(run.servers.size, 0);
	await assert.rejects(run.explore({ query: "q" }), /No Git worktree.*projectPath.*child repositories/s);
	await run.explore({ query: "q", projectPath: "primary with spaces" });
	await run.explore({ query: "q", projectPath: nested });
	await run.explore({ query: "q", projectPath: alias });
	assert.deepEqual([...run.servers.values()].map(({ cwd }) => cwd).sort(), [primary, other.primary].sort());
	assert.equal(run.registrations.length, 2);
	assert.equal(run.calls.some(({ args }) => args[0] === "init"), false);
	await assert.rejects(stat(join(worktree, ".codegraph")), { code: "ENOENT" });
	const names = [...run.servers.keys()];
	for (const reason of ["new", "resume", "fork"]) {
		await run.shutdown(reason);
		// Pi closes connections and recreates extensions during session replacement.
		run = harness(base);
		await run.start();
		assert.equal(run.servers.size, 0);
		await run.explore({ query: "q", projectPath: primary });
		assert.deepEqual([...run.servers.keys()], [names[0]]);
		await run.explore({ query: "q", projectPath: other.primary });
		assert.deepEqual([...run.servers.keys()], names);
	}
	await run.shutdown("reload");
	assert.equal(run.servers.size, 0);
	assert.deepEqual(run.removals, names);
	await assert.rejects(run.explore({ query: "q", projectPath: primary }), { name: "AbortError" });
	const reload = harness(base);
	await reload.start();
	await reload.explore({ query: "q", projectPath: primary });
	await reload.explore({ query: "q", projectPath: other.primary });
	assert.deepEqual([...reload.servers.keys()], names);
	await reload.shutdown();
	assert.equal(reload.servers.size, 0);
});

test("invalid paths and missing indexes fail before exploration without silent primary initialization", async (t) => {
	const { base, primary, worktree } = await fixture(t);
	const file = join(base, "file");
	await writeFile(file, "not a directory");
	const run = harness(base, { mode: "tui", confirm: true });
	run.start();
	await run.shutdown("new");
	for (const projectPath of [join(base, "absent"), file]) {
		await assert.rejects(run.explore({ query: "q", projectPath }), /Invalid project directory/);
	}
	await assert.rejects(run.explore({ query: "q", projectPath: " " }), /projectPath must name/);
	await assert.rejects(run.explore({ query: "q", projectPath: primary }), /No CodeGraph index.*codegraph init --yes.*projectPath/s);
	assert.equal(run.prompts.length, 0);
	assert.equal(run.calls.some(({ args }) => args[0] === "init" || args[0] === "explore"), false);
	const unscoped = harness(primary);
	await unscoped.start();
	await assert.rejects(unscoped.explore({ query: "q" }), /No CodeGraph index.*projectPath/s);
	const headless = harness(base, { confirm: true });
	await headless.start();
	await assert.rejects(headless.explore({ query: "q", projectPath: worktree }), /No CodeGraph index/);
	assert.equal(headless.prompts.length, 0);
	const declined = harness(base, { mode: "tui" });
	declined.start();
	await declined.shutdown("new");
	for (let i = 0; i < 2; i++) await assert.rejects(declined.explore({ query: "q", projectPath: worktree }), /No CodeGraph index/);
	assert.equal(declined.prompts.length, 1);
	assert.equal(declined.servers.size, 0);
	assert.equal(declined.calls.some(({ args }) => args[0] === "init" || args[0] === "explore"), false);
});

test("queries share startup setup, while cancellation does not interrupt another caller", async (t) => {
	const { primary, worktree } = await fixture(t);
	await index(primary);
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let setupSignal: AbortSignal | undefined;
	const run = harness(worktree, { mode: "tui", init: async (signal) => {
		setupSignal = signal;
		entered.resolve();
		await release.promise;
		await index(worktree);
		return { code: 0, stdout: "", stderr: "", killed: false };
	} });
	run.start();
	await entered.promise;
	const controller = new AbortController();
	const cancelled = run.explore({ query: "cancelled" }, controller.signal);
	const survivor = run.explore({ query: "survivor" });
	controller.abort();
	await assert.rejects(cancelled, { name: "AbortError" });
	assert.equal(setupSignal?.aborted, false);
	release.resolve();
	await survivor;
	assert.equal(run.calls.filter(({ args }) => args[0] === "init").length, 1);
	assert.equal(run.registrations.length, 1);
	assert.equal(run.registrations[0], "pi-codegraph");
	assert.deepEqual(run.calls.filter(({ args }) => args[0] === "explore").map(({ args }) => args.at(-1)), ["survivor"]);
	await run.shutdown();
});

test("on-demand setup is deduplicated without blocking a different worktree", async (t) => {
	const { base, primary, worktree } = await fixture(t);
	await index(primary);
	const nested = join(worktree, "src");
	await mkdir(nested);
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const run = harness(base, { init: async () => {
		entered.resolve();
		await release.promise;
		await index(worktree);
		return { code: 0, stdout: "", stderr: "", killed: false };
	} });
	await run.start();
	const controller = new AbortController();
	const first = run.explore({ query: "first", projectPath: worktree }, controller.signal);
	await entered.promise;
	const second = run.explore({ query: "second", projectPath: nested });
	await run.explore({ query: "independent", projectPath: primary });
	assert.equal(run.servers.size, 1);
	assert.equal([...run.servers.values()][0]!.cwd, primary);
	controller.abort();
	await assert.rejects(first, { name: "AbortError" });
	release.resolve();
	await second;
	assert.equal(run.calls.filter(({ args }) => args[0] === "init").length, 1);
	assert.equal(run.registrations.length, 2);
	await run.shutdown();
	assert.equal(run.servers.size, 0);
});

test("shutdown cancels primary or worktree setup and cannot register a late watcher", async (t) => {
	for (const primaryIndexed of [true, false]) {
		const { base, primary, worktree, lock } = await fixture(t);
		if (primaryIndexed) await index(primary);
		const entered = Promise.withResolvers<void>();
		const run = harness(base, { mode: "tui", confirm: true, init: async (signal, root) => {
			await index(root!); // An interrupted initializer can leave a partial database.
			entered.resolve();
			await new Promise<void>((resolve) => signal!.addEventListener("abort", () => resolve(), { once: true }));
			return { code: 0, stdout: "", stderr: "", killed: false };
		} });
		run.start();
		if (primaryIndexed) await run.explore({ query: "q", projectPath: primary });
		const pending = assert.rejects(run.explore({ query: "q", projectPath: worktree }), { name: "AbortError" });
		await entered.promise;
		await run.shutdown("reload");
		await pending;
		assert.equal(run.servers.size, 0);
		assert.equal(run.registrations.length, primaryIndexed ? 1 : 0);
		await stat(primaryIndexed ? lock : join(primary, ".git", "pi-codegraph-init.lock"));
		if (!primaryIndexed) await assert.rejects(stat(lock), { code: "ENOENT" });
		assert.deepEqual(run.notices, []);
	}
});

test("distinct linked worktrees share pending consent without holding initialization locks", async (t) => {
	for (const accepted of [true, false]) {
		const { base, primary, worktree, lock } = await fixture(t);
		const other = join(base, "other-worktree");
		await exec("git", ["-C", primary, "worktree", "add", "-q", "--detach", other]);
		const otherGit = (await exec("git", ["-C", other, "rev-parse", "--absolute-git-dir"])).stdout.trim();
		const commonDir = join(primary, ".git");
		const locks = [lock, join(otherGit, "pi-codegraph-init.lock"), join(commonDir, "pi-codegraph-init.lock")];
		const bothProbed = Promise.withResolvers<void>();
		let probes = 0;
		const run = harness(base, {
			mode: "tui",
			gitProbe: async (args) => {
				if (!args.includes("--git-common-dir")) return;
				if (++probes === 2) bothProbed.resolve();
				return { code: 0, stdout: `${commonDir}\n`, stderr: "", killed: false };
			},
			confirm: async () => {
				await bothProbed.promise;
				// Keep the dialog open while both callers finish their missing-index checks.
				await delay(50);
				for (const path of locks) await assert.rejects(stat(path), { code: "ENOENT" });
				return accepted;
			},
		});
		run.start();
		const results = await Promise.allSettled([
			run.explore({ query: "first", projectPath: worktree }),
			run.explore({ query: "second", projectPath: other }),
		]);
		assert.equal(run.prompts.length, 1);
		const initialized = run.calls.filter(({ args }) => args[0] === "init").map(({ cwd }) => cwd).sort();
		if (accepted) {
			assert.deepEqual(results.map(({ status }) => status), ["fulfilled", "fulfilled"]);
			assert.deepEqual(initialized, [primary, worktree, other].sort());
			assert.deepEqual([...run.servers.values()].map(({ cwd }) => cwd).sort(), [worktree, other].sort());
		} else {
			for (const result of results) {
				assert.equal(result.status, "rejected");
				if (result.status === "rejected") assert.match(result.reason.message, /No CodeGraph index/);
			}
			assert.deepEqual(initialized, []);
			assert.equal(run.servers.size, 0);
			await stat(join(commonDir, "pi-codegraph-declined"));
			await assert.rejects(run.explore({ query: "retry", projectPath: other }), /No CodeGraph index/);
			assert.equal(run.prompts.length, 1);
		}
		for (const path of locks) await assert.rejects(stat(path), { code: "ENOENT" });
		await run.shutdown();
	}
});

test("a failed consent request does not prevent a later request in the same extension", async (t) => {
	const { base, primary, worktree, lock } = await fixture(t);
	let fail = true;
	const run = harness(base, { mode: "tui", confirm: async () => {
		if (fail) throw new Error("dialog failed");
		return true;
	} });
	run.start();
	await assert.rejects(run.explore({ query: "q", projectPath: worktree }), /dialog failed/);
	await assert.rejects(stat(lock), { code: "ENOENT" });
	await assert.rejects(stat(join(primary, ".git", "pi-codegraph-declined")), { code: "ENOENT" });
	fail = false;
	await run.explore({ query: "retry", projectPath: worktree });
	assert.equal(run.prompts.length, 2);
	assert.equal(run.servers.size, 1);
	await run.shutdown();
});

test("later worktree queries share accepted consent until primary initialization settles", async (t) => {
	for (const failFirst of [false, true]) {
		const { base, primary, worktree } = await fixture(t);
		const other = join(base, "later-worktree");
		await exec("git", ["-C", primary, "worktree", "add", "-q", "--detach", other]);
		const commonDir = join(primary, ".git");
		const primaryLock = join(commonDir, "pi-codegraph-init.lock");
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const laterProbed = Promise.withResolvers<void>();
		let probes = 0;
		let pendingPrimary = false;
		let fail = failFirst;
		const run = harness(base, {
			mode: "tui",
			gitProbe: async (args) => {
				if (!args.includes("--git-common-dir")) return;
				if (++probes === 2) laterProbed.resolve();
				return { code: 0, stdout: `${commonDir}\n`, stderr: "", killed: false };
			},
			confirm: async () => {
				if (pendingPrimary) throw new Error("duplicate consent during primary initialization");
				return true;
			},
			init: async (_signal, root) => {
				if (root === primary) {
					pendingPrimary = true;
					entered.resolve();
					await release.promise;
					pendingPrimary = false;
					if (fail) return { code: 1, stdout: "", stderr: "primary init failed", killed: false };
				}
				await index(root!);
				return { code: 0, stdout: "", stderr: "", killed: false };
			},
		});
		run.start();
		const first = run.explore({ query: "first", projectPath: worktree });
		await entered.promise;
		await assert.rejects(stat(join(primary, ".codegraph", "codegraph.db")), { code: "ENOENT" });
		const results = Promise.allSettled([first, run.explore({ query: "later", projectPath: other })]);
		await laterProbed.promise;
		await delay(50); // The later query reaches setup while the primary still has no database.
		release.resolve();
		const settled = await results;
		assert.equal(run.prompts.length, 1);
		if (failFirst) {
			for (const result of settled) {
				assert.equal(result.status, "rejected");
				if (result.status === "rejected") {
					assert.match(result.reason.message, /primary init failed/);
					assert.ok(result.reason.message.includes(primaryLock));
				}
			}
			assert.equal(run.servers.size, 0);
			assert.deepEqual(run.calls.filter(({ args }) => args[0] === "init").map(({ cwd }) => cwd), [primary]);
			await stat(primaryLock);
			// Explicit recovery after the initializer stopped without creating a database.
			await rmdir(primaryLock);
			fail = false;
			await run.explore({ query: "retry", projectPath: other });
			assert.equal(run.prompts.length, 2);
			assert.deepEqual([...run.servers.values()].map(({ cwd }) => cwd), [other]);
		} else {
			assert.deepEqual(settled.map(({ status }) => status), ["fulfilled", "fulfilled"]);
			assert.deepEqual(run.calls.filter(({ args }) => args[0] === "init").map(({ cwd }) => cwd).sort(), [primary, worktree, other].sort());
			assert.equal(run.servers.size, 2);
		}
		await assert.rejects(stat(primaryLock), { code: "ENOENT" });
		await run.shutdown();
	}
});
