import { mkdir, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
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

// Copies the usable worktree index closest to this HEAD. `codegraph sync` then re-extracts
// only the files that differ, which matches a fresh `codegraph init`.
async function seedIndex(pi: ExtensionAPI, root: string, worktrees: string[], version: string, signal: AbortSignal): Promise<boolean> {
	// Probe one worktree at a time: repositories can keep many worker worktrees.
	const candidates: { worktree: string; changes: number }[] = [];
	for (const worktree of worktrees) {
		if (worktree === root) continue;
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
			await backup(db, target);
			copied = true;
		} finally {
			db.close();
		}
	} catch {
		// The source can vanish after selection.
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

async function git(pi: ExtensionAPI, cwd: string, args: string[], signal: AbortSignal): Promise<string> {
	const result = await pi.exec("git", args, { cwd, timeout: 10_000, signal });
	signal.throwIfAborted();
	if (result.code !== 0 || result.killed) {
		throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim() || `exit ${result.code}`}`);
	}
	return result.stdout.replace(/\r?\n$/, "");
}

// Resolves to the worktree root when it has an index.
async function initialize(pi: ExtensionAPI, ctx: ExtensionContext, signal: AbortSignal): Promise<string | undefined> {
	ctx.ui.setStatus(STATUS_KEY, undefined);
	const version = await pi.exec("codegraph", ["--version"], { cwd: ctx.cwd, timeout: 10_000, signal });
	signal.throwIfAborted();
	if (version.code !== 0 || version.killed) {
		const detail = version.killed ? "timed out or killed" : version.stderr.trim().slice(-1000) || `exit ${version.code}`;
		const message = `pi-codegraph: setup skipped.\ncodegraph --version failed (${detail}). Install CodeGraph: npm install -g @colbymchenry/codegraph. If already installed, check that codegraph runs on Pi's PATH.\nThen restart Pi or /reload.`;
		ctx.ui.setStatus(STATUS_KEY, `${ctx.ui.theme.fg("warning", "!")} CG: prerequisites missing`);
		if (ctx.hasUI) ctx.ui.notify(message, "warning");
		else console.warn(message);
		return;
	}
	const rootResult = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd: ctx.cwd, timeout: 10_000, signal });
	signal.throwIfAborted();
	if (rootResult.code !== 0 || rootResult.killed) {
		if (!rootResult.killed && rootResult.stderr.includes("not a git repository")) return;
		throw new Error(`Cannot locate Git worktree: ${rootResult.stderr.trim() || `exit ${rootResult.code}`}`);
	}
	const root = rootResult.stdout.replace(/\r?\n$/, "");
	if (!root) throw new Error("Git returned an empty worktree root.");
	if (process.env.CODEGRAPH_DIR && process.env.CODEGRAPH_DIR !== ".codegraph") {
		throw new Error("pi-codegraph requires the default CODEGRAPH_DIR (.codegraph). Unset CODEGRAPH_DIR before launching Pi.");
	}
	const gitDir = await git(pi, root, ["rev-parse", "--absolute-git-dir"], signal);
	if (!gitDir) throw new Error("Git returned an empty metadata directory.");
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
		// Ask before taking the lock, so an open dialog neither blocks other sessions nor leaves a stale lock.
		// A bare repository has no primary checkout to index.
		const accepted = primary !== root && !first.includes("bare") && !(await hasIndex(root)) && !(await hasIndex(primary))
			&& await acceptPrimaryIndex(ctx, commonDir, primary, signal);
		await acquireLock(lock, recovery, signal, () => { stopProgress = showProgress(ctx, "waiting for index", signal); });
		let attempted = false;
		try {
			if (await hasIndex(root)) {
				indexed = true;
				return root;
			}
			if (primary === root || first.includes("bare")) return;
			const primaryIndexed = await hasIndex(primary);
			if (!primaryIndexed && !accepted) return;
			stopProgress();
			stopProgress = showProgress(ctx, "indexing", signal);
			if (!primaryIndexed) {
				// The primary checkout's own lock: its sessions must not accept a partial DB either.
				const primaryLock = join(commonDir, "pi-codegraph-init.lock");
				const primaryRecovery = `Inspect CodeGraph in ${primary}. If no initializer is running, run codegraph index in that directory, then remove ${primaryLock} with rmdir and /reload.`;
				await acquireLock(primaryLock, primaryRecovery, signal, () => {});
				// Another session can index the primary checkout while this one waits.
				if (!(await hasIndex(primary))) {
					try {
						await codegraph(pi, primary, ["init", "--yes"], signal);
					} catch (error) {
						throw new Error(`${error instanceof Error ? error.message : String(error)}\n${primaryRecovery}`, { cause: error });
					}
				}
				await rmdir(primaryLock);
			}
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

export default function codegraphExtension(pi: ExtensionAPI): void {
	let initializer: AbortController | undefined;
	let setup: Promise<void> | undefined;
	pi.on("session_shutdown", (event) => {
		// Session replacement waits for worktree-scoped indexing instead of abandoning its lock.
		if (event.reason !== "new" && event.reason !== "resume" && event.reason !== "fork") initializer?.abort();
		return setup;
	});
	pi.registerTool({
		name: "codegraph_explore",
		label: "CodeGraph explore",
		description: "Primary code exploration tool. Call it first for how-does-X-work, architecture, bug, or where-is-X questions, and before editing. Returns the verbatim source of the relevant symbols grouped by file, plus the call path among them, in one capped call. Treat the shown source as already read.",
		parameters: Type.Object({
			query: Type.String({ description: "Symbol names, file names, short code terms, or a natural-language question." }),
			maxFiles: Type.Optional(Type.Number({ description: "Maximum files to include (default 12)." })),
			projectPath: Type.Optional(Type.String({ description: "Absolute path to the project or any directory inside it. Defaults to the session cwd." })),
		}),
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		async execute(_toolCallId, { query, maxFiles, projectPath }, signal, _onUpdate, ctx) {
			const path = projectPath ?? ctx.cwd;
			const result = await pi.exec("codegraph", ["explore", "--path", path, "--max-files", String(maxFiles ?? 12), query], { cwd: path, signal, timeout: EXPLORE_TIMEOUT_MS });
			if (result.code !== 0 || result.killed) {
				throw new Error(`codegraph explore failed (${result.killed ? "timed out or killed" : `exit ${result.code}`}): ${result.stderr.trim().slice(-2000)}`);
			}
			return { content: [{ type: "text", text: result.stdout }], details: undefined };
		},
	});
	// CodeGraph's MCP server runs the file watcher that keeps the index current; its tools stay
	// hidden because codegraph_explore covers them. Pi starts and stops the server.
	let watched: string | undefined;
	const watch = (root: string | undefined) => {
		if (root === watched) return;
		if (watched) pi.unregisterMcpServer(MCP_SERVER);
		watched = root;
		if (root) pi.registerMcpServer(MCP_SERVER, { command: "codegraph", args: ["serve", "--mcp", "--path", root], cwd: root, exposure: "hidden" });
	};
	pi.on("session_start", (_event, ctx) => {
		if (setup) return ctx.mode === "tui" ? undefined : setup;
		const controller = initializer = new AbortController();
		setup = initialize(pi, ctx, controller.signal).then(watch).catch((error) => {
			if (controller.signal.aborted) return;
			// Do not keep watching the checkout of an earlier session.
			watch(undefined);
			const message = `pi-codegraph: ${error instanceof Error ? error.message : String(error)}`;
			ctx.ui.setStatus(STATUS_KEY, `${ctx.ui.theme.fg("error", "!")} CG: setup failed`);
			if (ctx.hasUI) ctx.ui.notify(message, "error");
			else throw new Error(message, { cause: error });
		}).finally(() => {
			setup = undefined;
			initializer = undefined;
		});
		if (ctx.mode !== "tui") return setup;
	});
}
