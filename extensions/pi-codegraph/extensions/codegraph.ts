import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const LOCK_WAIT_MS = 5 * 60_000;
const INIT_TIMEOUT_MS = 10 * 60_000;
const EXPLORE_TIMEOUT_MS = 120_000;
const STATUS_KEY = "pi-codegraph";
const MCP_SERVER = "pi-codegraph";
const SPINNER_INTERVAL_MS = 100;
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function showProgress(ctx: ExtensionContext, action: string, signal: AbortSignal): () => void {
	if (!ctx.hasUI) return () => {};
	signal.throwIfAborted();
	const startedAt = Date.now();
	const update = () => {
		const frame = SPINNER_FRAMES[Math.floor(Date.now() / SPINNER_INTERVAL_MS) % SPINNER_FRAMES.length]!;
		const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
		const elapsed = seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", `${frame} CG · ${action} ${elapsed}`));
	};
	update();
	const timer = ctx.mode === "tui" ? setInterval(update, SPINNER_INTERVAL_MS) : undefined;
	timer?.unref();
	const stop = () => {
		if (timer) clearInterval(timer);
		signal.removeEventListener("abort", stop);
		ctx.ui.setStatus(STATUS_KEY, undefined);
	};
	signal.addEventListener("abort", stop, { once: true });
	return stop;
}

async function hasIndex(root: string): Promise<boolean> {
	try {
		return (await stat(join(root, ".codegraph", "codegraph.db"))).isFile();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

// Returns the commit of a complete index built by the running CodeGraph version.
function indexedCommit(worktree: string, version: string): string | undefined {
	let db: DatabaseSync | undefined;
	try {
		db = new DatabaseSync(join(worktree, ".codegraph", "codegraph.db"), { readOnly: true });
		const rows = db.prepare("SELECT key, value FROM project_metadata WHERE key IN ('index_state', 'indexed_with_version', 'indexed_at_commit')").all();
		const metadata = Object.fromEntries(rows.map(({ key, value }) => [key, value]));
		const commit = metadata.indexed_at_commit;
		// The value goes to Git; only a full object ID cannot be read as an option.
		const valid = typeof commit === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit);
		return metadata.index_state === "complete" && metadata.indexed_with_version === version && valid ? commit : undefined;
	} catch {
		// A missing, unreadable, or foreign index cannot seed.
		return undefined;
	} finally {
		db?.close();
	}
}

// Extension mappings in codegraph.json change how unchanged files parse, which sync does not redo.
async function projectConfig(dir: string): Promise<string | undefined> {
	try {
		return await readFile(join(dir, "codegraph.json"), "utf8");
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? "" : undefined;
	}
}

// Copies the usable worktree index closest to this HEAD. `codegraph sync` then re-extracts
// only the files that differ, which matches a fresh `codegraph init`.
async function seedIndex(pi: ExtensionAPI, root: string, worktrees: string[], version: string, signal: AbortSignal): Promise<boolean> {
	const config = await projectConfig(root);
	// Probe one worktree at a time: repositories can keep many worker worktrees.
	const candidates: { worktree: string; changes: number }[] = [];
	for (const worktree of worktrees) {
		if (worktree === root || config === undefined || await projectConfig(worktree) !== config) continue;
		const commit = indexedCommit(worktree, version);
		if (!commit) continue;
		const diff = await pi.exec("git", ["diff", "--name-only", "-z", commit, "HEAD"], { cwd: root, timeout: 10_000, signal });
		signal.throwIfAborted();
		if (diff.code === 0 && !diff.killed) candidates.push({ worktree, changes: diff.stdout.split("\0").length });
	}
	for (const { worktree } of candidates.sort((a, b) => a.changes - b.changes)) {
		if (await copyIndex(pi, worktree, root, signal)) return true;
	}
	return false;
}

async function copyIndex(pi: ExtensionAPI, source: string, root: string, signal: AbortSignal): Promise<boolean> {
	const target = join(root, ".codegraph", "codegraph.db");
	const lock = join(source, ".codegraph", "codegraph.lock");
	try {
		// CodeGraph's writer lock keeps the snapshot out of a sync's separately committed phases.
		// Its watcher retries a busy lock; a stale lock with this PID is removed once Pi exits.
		await writeFile(lock, String(process.pid), { flag: "wx" });
	} catch {
		// A writer holds the source, or the source vanished.
		return false;
	}
	let copied = false;
	try {
		const db = new DatabaseSync(join(source, ".codegraph", "codegraph.db"), { readOnly: true });
		try {
			await mkdir(join(root, ".codegraph"), { recursive: true });
			// Throwing from the progress callback stops the copy when Pi quits or reloads.
			await backup(db, target, { progress: () => signal.throwIfAborted() });
			copied = true;
		} finally {
			db.close();
		}
	} catch {
		// The source can vanish after selection, or Pi can quit during the copy.
	} finally {
		await rm(lock, { force: true });
	}
	if (copied) {
		// CodeGraph decides whether the copy is complete and built by its current extraction engine.
		const status = await pi.exec("codegraph", ["status", "--json", root], { cwd: root, timeout: 30_000, signal });
		signal.throwIfAborted();
		try {
			const { index } = JSON.parse(status.stdout) as { index?: { state?: string; reindexRecommended?: boolean } };
			if (status.code === 0 && index?.state === "complete" && index.reindexRecommended === false) return true;
		} catch {
			// No usable status: treat the copy as unusable.
		}
	}
	// codegraph init does not rebuild over an existing database.
	await Promise.all(["", "-wal", "-shm"].map((suffix) => rm(`${target}${suffix}`, { force: true })));
	signal.throwIfAborted();
	return false;
}

// Waits for an exclusive initialization lock; `onWait` runs once when another session holds it.
async function acquireLock(lock: string, recovery: string, signal: AbortSignal, onWait: () => void): Promise<void> {
	const deadline = Date.now() + LOCK_WAIT_MS;
	let waiting = false;
	while (true) {
		signal.throwIfAborted();
		try {
			await mkdir(lock);
			return;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			if (Date.now() >= deadline) throw new Error(`Timed out waiting for CodeGraph initialization. ${recovery}`);
			if (!waiting) onWait();
			waiting = true;
			await delay(250, undefined, { signal });
		}
	}
}

async function codegraph(pi: ExtensionAPI, root: string, args: string[], signal: AbortSignal): Promise<void> {
	const result = await pi.exec("codegraph", [...args, root], { cwd: root, timeout: INIT_TIMEOUT_MS, signal });
	signal.throwIfAborted();
	if (result.code !== 0 || result.killed || !(await hasIndex(root))) {
		throw new Error(`CodeGraph ${args[0]} failed (${result.killed ? "timed out or killed" : `exit ${result.code}`}): ${(result.stderr || result.stdout).trim().slice(-2000)}`);
	}
}

// Asks one time per repository; a primary index lets every later worktree copy an index.
async function acceptPrimaryIndex(ctx: ExtensionContext, commonDir: string, primary: string, signal: AbortSignal): Promise<boolean> {
	// Other modes await setup during session_start, before an RPC client's answer can be read.
	if (ctx.mode !== "tui") return false;
	const declined = join(commonDir, "pi-codegraph-declined");
	try {
		await stat(declined);
		return false;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const accepted = await ctx.ui.confirm(
		"Index this repository with CodeGraph?",
		`pi-codegraph builds one CodeGraph index in ${primary} (CodeGraph creates .codegraph/ there). Each new worktree then copies an index and starts in seconds. If you decline, pi-codegraph does not ask again; remove ${declined} to be asked again.`,
		{ signal },
	);
	signal.throwIfAborted();
	if (!accepted) await writeFile(declined, "");
	return accepted;
}

// Consent and primary initialization form one shared operation for this repository.
async function initializePrimary(pi: ExtensionAPI, ctx: ExtensionContext, commonDir: string, primary: string, signal: AbortSignal): Promise<boolean> {
	const indexed = await hasIndex(primary);
	// No initialization lock is held while the user answers.
	const accepted = !indexed && await acceptPrimaryIndex(ctx, commonDir, primary, signal);
	if (!indexed && !accepted) return false;
	const lock = join(commonDir, "pi-codegraph-init.lock");
	const recovery = `Inspect CodeGraph in ${primary}. If no initializer is running, run codegraph index in that directory, then remove ${lock} with rmdir and /reload.`;
	let stopProgress = () => {};
	try {
		// Check the lock even when a database exists: it can be a failed or pending init.
		await acquireLock(lock, recovery, signal, () => { stopProgress = showProgress(ctx, "waiting for index", signal); });
		let ready = await hasIndex(primary);
		if (!ready && accepted) {
			stopProgress();
			stopProgress = showProgress(ctx, "indexing", signal);
			try {
				await codegraph(pi, primary, ["init", "--yes"], signal);
			} catch (error) {
				// Preserve the primary lock after failed or interrupted initialization.
				throw new Error(`${error instanceof Error ? error.message : String(error)}\n${recovery}`, { cause: error });
			}
			ready = true;
		}
		await rmdir(lock);
		return ready;
	} finally {
		stopProgress();
	}
}

async function git(pi: ExtensionAPI, cwd: string, args: string[], signal: AbortSignal): Promise<string> {
	const result = await pi.exec("git", args, { cwd, timeout: 10_000, signal });
	signal.throwIfAborted();
	if (result.code !== 0 || result.killed) {
		throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim() || `exit ${result.code}`}`);
	}
	return result.stdout.replace(/\r?\n$/, "");
}

async function worktreeRoot(pi: ExtensionAPI, path: string, signal: AbortSignal): Promise<string | undefined> {
	signal.throwIfAborted();
	try {
		if (!(await stat(path)).isDirectory()) throw new Error("not a directory");
	} catch (error) {
		throw new Error(`Invalid project directory ${path}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
	}
	const result = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd: path, timeout: 10_000, signal });
	signal.throwIfAborted();
	if (result.code !== 0 || result.killed) {
		if (!result.killed && result.stderr.includes("not a git repository")) return;
		throw new Error(`Cannot locate Git worktree in ${path}: ${result.stderr.trim() || `exit ${result.code}`}`);
	}
	const root = result.stdout.replace(/\r?\n$/, "");
	if (!root) throw new Error("Git returned an empty worktree root.");
	return realpath(root);
}

class PrerequisitesError extends Error {}

// Returns the worktree root only after its initialization lock is clear.
async function initialize(pi: ExtensionAPI, ctx: ExtensionContext, root: string, signal: AbortSignal, primaries: Map<string, Promise<boolean>>): Promise<string | undefined> {
	ctx.ui.setStatus(STATUS_KEY, undefined);
	const version = await pi.exec("codegraph", ["--version"], { cwd: root, timeout: 10_000, signal });
	signal.throwIfAborted();
	if (version.code !== 0 || version.killed) {
		const detail = version.killed ? "timed out or killed" : version.stderr.trim().slice(-1000) || `exit ${version.code}`;
		throw new PrerequisitesError(`setup skipped.\ncodegraph --version failed (${detail}). Install CodeGraph: npm install -g @colbymchenry/codegraph. If already installed, check that codegraph runs on Pi's PATH.\nThen restart Pi or /reload.`);
	}
	if (process.env.CODEGRAPH_DIR && process.env.CODEGRAPH_DIR !== ".codegraph") {
		throw new Error("pi-codegraph requires the default CODEGRAPH_DIR (.codegraph). Unset CODEGRAPH_DIR before launching Pi.");
	}
	const gitDir = await git(pi, root, ["rev-parse", "--absolute-git-dir"], signal);
	const lock = join(gitDir, "pi-codegraph-init.lock");
	// Check the lock before the database: an in-progress/failed init can leave a partial DB.
	const recovery = `Inspect CodeGraph in ${root}. If no initializer is running, run codegraph index in that directory, then remove ${lock} with rmdir and /reload.`;
	let stopProgress = () => {};
	let indexed = false;
	try {
		const worktrees = await git(pi, root, ["worktree", "list", "--porcelain", "-z"], signal);
		const first = worktrees.split("\0\0", 1)[0].split("\0");
		if (!first[0].startsWith("worktree ")) throw new Error("Git returned an invalid primary worktree.");
		const primary = first[0].slice("worktree ".length);
		const paths = worktrees.split("\0").filter((line) => line.startsWith("worktree ")).map((line) => line.slice("worktree ".length));
		const commonDir = await git(pi, root, ["rev-parse", "--path-format=absolute", "--git-common-dir"], signal);
		const preparePrimary = () => {
			const pending = primaries.get(commonDir);
			if (pending) return pending;
			const setup = initializePrimary(pi, ctx, commonDir, primary, signal).finally(() => primaries.delete(commonDir));
			primaries.set(commonDir, setup);
			return setup;
		};
		// Complete primary setup before taking this worktree's lock. A bare repository has no primary checkout.
		const primaryReady = primary !== root && !first.includes("bare") && !(await hasIndex(root)) && await preparePrimary();
		await acquireLock(lock, recovery, signal, () => { stopProgress = showProgress(ctx, "waiting for index", signal); });
		let attempted = false;
		try {
			if (await hasIndex(root)) {
				indexed = true;
				return root;
			}
			if (!primaryReady) return;
			stopProgress();
			stopProgress = showProgress(ctx, "indexing", signal);
			attempted = true;
			const seeded = await seedIndex(pi, root, paths, version.stdout.trim(), signal);
			signal.throwIfAborted();
			await codegraph(pi, root, seeded ? ["sync"] : ["init", "--yes"], signal);
			indexed = true;
			return root;
		} catch (error) {
			if (attempted) throw new Error(`${error instanceof Error ? error.message : String(error)}\n${recovery}`, { cause: error });
			throw error;
		} finally {
			// A failed or interrupted init stays locked; never accept its partial DB on reload.
			if (!attempted || indexed) await rmdir(lock);
		}
	} finally {
		if (!signal.aborted) {
			stopProgress();
			ctx.ui.setStatus(STATUS_KEY, indexed ? `${ctx.ui.theme.fg("success", "✓")} CG` : `${ctx.ui.theme.fg("dim", "○")} CG`);
		}
	}
}

// A cancelled caller stops waiting, but cannot cancel setup shared with another caller.
async function waitForSetup<T>(setup: Promise<T>, signal: AbortSignal): Promise<T> {
	let abort!: () => void;
	const cancelled = new Promise<never>((_resolve, reject) => {
		abort = () => reject(signal.reason);
		signal.addEventListener("abort", abort, { once: true });
		if (signal.aborted) abort();
	});
	try {
		return await Promise.race([setup, cancelled]);
	} finally {
		signal.removeEventListener("abort", abort);
	}
}

export default function codegraphExtension(pi: ExtensionAPI): void {
	const lifetime = new AbortController();
	const setups = new Map<string, Promise<string | undefined>>();
	const primaries = new Map<string, Promise<boolean>>();
	const watched = new Map<string, string>();
	let sessionRoot: string | undefined;
	let sessionDirectory: Promise<string | undefined> | undefined;
	let startup: Promise<void> | undefined;
	const unwatch = (root: string) => {
		const name = watched.get(root);
		if (name) pi.unregisterMcpServer(name);
		watched.delete(root);
	};
	const prepare = (root: string, ctx: ExtensionContext, refresh = false): Promise<string | undefined> => {
		lifetime.signal.throwIfAborted();
		const pending = setups.get(root);
		if (pending) return pending;
		if (!refresh && watched.has(root)) return Promise.resolve(root);
		const setup = initialize(pi, ctx, root, lifetime.signal, primaries).then((ready) => {
			lifetime.signal.throwIfAborted();
			if (ready && !watched.has(root)) {
				// Root identity keeps separate repositories and linked worktrees independent.
				const name = root === sessionRoot ? MCP_SERVER : `${MCP_SERVER}-${createHash("sha256").update(root).digest("hex").slice(0, 16)}`;
				pi.registerMcpServer(name, { command: "codegraph", args: ["serve", "--mcp", "--path", root], cwd: root, exposure: "hidden" });
				watched.set(root, name);
			} else if (!ready) unwatch(root);
			return ready;
		}).catch((error) => {
			unwatch(root);
			throw error;
		}).finally(() => setups.delete(root));
		setups.set(root, setup);
		return setup;
	};
	pi.on("session_shutdown", async (event) => {
		// Session replacement waits for setup instead of abandoning initialization locks.
		if (event.reason !== "new" && event.reason !== "resume" && event.reason !== "fork") {
			lifetime.abort();
			for (const root of watched.keys()) unwatch(root);
		}
		await Promise.allSettled([startup, ...setups.values()]);
	});
	pi.registerTool({
		name: "codegraph_explore",
		label: "CodeGraph explore",
		description: "Primary code exploration tool. Call it first for how-does-X-work, architecture, bug, or where-is-X questions, and before editing. Returns the verbatim source of the relevant symbols grouped by file, plus the call path among them, in one capped call. Treat the shown source as already read.",
		parameters: Type.Object({
			query: Type.String({ description: "Symbol names, file names, short code terms, or a natural-language question." }),
			maxFiles: Type.Optional(Type.Number({ description: "Maximum files to include (default 12)." })),
			projectPath: Type.Optional(Type.String({ minLength: 1, description: "Path to a Git worktree or any directory inside it. Relative paths use the session directory. Defaults to the session directory; does not search child repositories." })),
		}),
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		async execute(_toolCallId, { query, maxFiles, projectPath }, signal, _onUpdate, ctx) {
			const callSignal = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
			callSignal.throwIfAborted();
			if (projectPath !== undefined && !projectPath.trim()) throw new Error("projectPath must name a project directory.");
			const path = resolve(ctx.cwd, projectPath ?? ctx.cwd);
			const root = await worktreeRoot(pi, path, callSignal);
			if (!root) throw new Error(`No Git worktree contains ${path}. Set projectPath to a Git worktree or a directory inside it; child repositories are not searched.`);
			// The startup root determines which server keeps the existing pi-codegraph name.
			if (sessionDirectory) await waitForSetup(sessionDirectory.catch(() => undefined), callSignal);
			callSignal.throwIfAborted();
			if (!await waitForSetup(prepare(root, ctx), callSignal)) {
				throw new Error(`No CodeGraph index in ${root}. Run codegraph init --yes in that directory, or index the primary checkout to enable linked-worktree setup. Set projectPath to select another indexed worktree.`);
			}
			callSignal.throwIfAborted();
			const result = await pi.exec("codegraph", ["explore", "--path", root, "--max-files", String(maxFiles ?? 12), query], { cwd: root, signal: callSignal, timeout: EXPLORE_TIMEOUT_MS });
			callSignal.throwIfAborted();
			if (result.code !== 0 || result.killed) {
				throw new Error(`codegraph explore failed (${result.killed ? "timed out or killed" : `exit ${result.code}`}): ${result.stderr.trim().slice(-2000)}`);
			}
			return { content: [{ type: "text", text: result.stdout }], details: undefined };
		},
	});
	pi.on("session_start", (_event, ctx) => {
		if (startup) return ctx.mode === "tui" ? undefined : startup;
		lifetime.signal.throwIfAborted();
		ctx.ui.setStatus(STATUS_KEY, undefined);
		sessionDirectory = worktreeRoot(pi, ctx.cwd, lifetime.signal).then((root) => {
			if (sessionRoot && sessionRoot !== root) unwatch(sessionRoot);
			sessionRoot = root;
			return root;
		});
		startup = sessionDirectory.then(async (root) => {
			if (root) await prepare(root, ctx, true);
		}).catch((error) => {
			if (lifetime.signal.aborted) return;
			if (sessionRoot) unwatch(sessionRoot);
			const message = `pi-codegraph: ${error instanceof Error ? error.message : String(error)}`;
			const missing = error instanceof PrerequisitesError;
			const level = missing ? "warning" : "error";
			ctx.ui.setStatus(STATUS_KEY, `${ctx.ui.theme.fg(level, "!")} CG: ${missing ? "prerequisites missing" : "setup failed"}`);
			if (ctx.hasUI) ctx.ui.notify(message, level);
			else if (missing) console.warn(message);
			else throw new Error(message, { cause: error });
		}).finally(() => { startup = undefined; });
		if (ctx.mode !== "tui") return startup;
	});
}
