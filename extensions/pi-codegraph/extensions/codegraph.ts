import { mkdir, rmdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const LOCK_WAIT_MS = 5 * 60_000;
const INIT_TIMEOUT_MS = 10 * 60_000;
const EXPLORE_TIMEOUT_MS = 120_000;
const STATUS_KEY = "pi-codegraph";
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

async function git(pi: ExtensionAPI, cwd: string, args: string[], signal: AbortSignal): Promise<string> {
	const result = await pi.exec("git", args, { cwd, timeout: 10_000, signal });
	signal.throwIfAborted();
	if (result.code !== 0 || result.killed) {
		throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim() || `exit ${result.code}`}`);
	}
	return result.stdout.replace(/\r?\n$/, "");
}

async function initialize(pi: ExtensionAPI, ctx: ExtensionContext, signal: AbortSignal): Promise<void> {
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
	const deadline = Date.now() + LOCK_WAIT_MS;
	let stopProgress = () => {};
	let waiting = false;
	let indexed = false;
	try {
		while (true) {
			signal.throwIfAborted();
			try {
				await mkdir(lock);
				break;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				if (Date.now() >= deadline) throw new Error(`Timed out waiting for CodeGraph initialization. ${recovery}`);
				if (!waiting) {
					stopProgress = showProgress(ctx, "waiting for index", signal);
					waiting = true;
				}
				await delay(250, undefined, { signal });
			}
		}
		let attempted = false;
		try {
			if (await hasIndex(root)) {
				indexed = true;
				return;
			}
			const worktrees = await git(pi, root, ["worktree", "list", "--porcelain", "-z"], signal);
			const first = worktrees.split("\0", 1)[0];
			if (!first.startsWith("worktree ")) throw new Error("Git returned an invalid primary worktree.");
			const primary = first.slice("worktree ".length);
			if (primary === root || !(await hasIndex(primary))) return;
			stopProgress();
			stopProgress = showProgress(ctx, "indexing", signal);
			attempted = true;
			const result = await pi.exec("codegraph", ["init", "--yes", root], { cwd: root, timeout: INIT_TIMEOUT_MS, signal });
			signal.throwIfAborted();
			if (result.code !== 0 || result.killed || !(await hasIndex(root))) {
				throw new Error(`CodeGraph init failed (${result.killed ? "timed out or killed" : `exit ${result.code}`}): ${(result.stderr || result.stdout).trim().slice(-2000)}`);
			}
			indexed = true;
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
	pi.on("session_start", (_event, ctx) => {
		if (setup) return ctx.mode === "tui" ? undefined : setup;
		const controller = initializer = new AbortController();
		setup = initialize(pi, ctx, controller.signal).catch((error) => {
			if (controller.signal.aborted) return;
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
