import { mkdir, rmdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const LOCK_WAIT_MS = 5 * 60_000;
const INIT_TIMEOUT_MS = 10 * 60_000;
const WIDGET_KEY = "pi-codegraph";
const SUCCESS_TTL_MS = 5000;

async function hasIndex(root: string): Promise<boolean> {
	try {
		return (await stat(join(root, ".codegraph", "codegraph.db"))).isFile();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

async function git(pi: ExtensionAPI, cwd: string, args: string[]): Promise<string> {
	const result = await pi.exec("git", args, { cwd, timeout: 10_000 });
	if (result.code !== 0 || result.killed) {
		throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim() || `exit ${result.code}`}`);
	}
	return result.stdout.replace(/\r?\n$/, "");
}

async function initialize(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	const prerequisites: string[] = [];
	if (!pi.getAllTools().some((tool) => tool.name === "mcp")) {
		prerequisites.push("Install and enable pi-mcp-adapter >=2.36.0: pi install npm:pi-mcp-adapter");
	}
	const version = await pi.exec("codegraph", ["--version"], { cwd: ctx.cwd, timeout: 10_000 });
	if (version.code !== 0 || version.killed) {
		const detail = version.killed ? "timed out or killed" : version.stderr.trim().slice(-1000) || `exit ${version.code}`;
		prerequisites.push(`codegraph --version failed (${detail}). Install CodeGraph: npm install -g @colbymchenry/codegraph. If already installed, check that codegraph runs on Pi's PATH.`);
	}
	if (prerequisites.length) {
		const message = `pi-codegraph: setup skipped.\n${prerequisites.join("\n")}\nThen restart Pi or /reload.`;
		ctx.ui.setStatus("pi-codegraph", "pi-codegraph: prerequisites missing");
		if (ctx.hasUI) ctx.ui.notify(message, "warning");
		else console.warn(message);
		return;
	}
	ctx.ui.setStatus("pi-codegraph", "pi-codegraph: missing");
	const rootResult = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd: ctx.cwd, timeout: 10_000 });
	if (rootResult.code !== 0 || rootResult.killed) {
		if (!rootResult.killed && rootResult.stderr.includes("not a git repository")) return;
		throw new Error(`Cannot locate Git worktree: ${rootResult.stderr.trim() || `exit ${rootResult.code}`}`);
	}
	const root = rootResult.stdout.replace(/\r?\n$/, "");
	if (!root) throw new Error("Git returned an empty worktree root.");
	if (process.env.CODEGRAPH_DIR && process.env.CODEGRAPH_DIR !== ".codegraph") {
		throw new Error("pi-codegraph requires the default CODEGRAPH_DIR (.codegraph). Unset CODEGRAPH_DIR before launching Pi.");
	}
	const gitDir = await git(pi, root, ["rev-parse", "--absolute-git-dir"]);
	if (!gitDir) throw new Error("Git returned an empty metadata directory.");
	const lock = join(gitDir, "pi-codegraph-init.lock");
	// Check the lock before the database: an in-progress/failed init can leave a partial DB.
	const recovery = `Inspect CodeGraph in ${root}. If no initializer is running, run codegraph index in that directory, then remove ${lock} with rmdir and /reload.`;
	const deadline = Date.now() + LOCK_WAIT_MS;
	ctx.ui.setStatus("pi-codegraph", "pi-codegraph: checking index…");
	let indexed = false;
	try {
		while (true) {
			try {
				await mkdir(lock);
				break;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				if (Date.now() >= deadline) throw new Error(`Timed out waiting for CodeGraph initialization. ${recovery}`);
				ctx.ui.setStatus("pi-codegraph", "pi-codegraph: indexing…");
				await delay(250);
			}
		}
		let attempted = false;
		let succeeded = false;
		try {
			if (await hasIndex(root)) {
				indexed = true;
				return;
			}
			const worktrees = await git(pi, root, ["worktree", "list", "--porcelain", "-z"]);
			const first = worktrees.split("\0", 1)[0];
			if (!first?.startsWith("worktree ")) throw new Error("Git returned an invalid primary worktree.");
			const primary = first.slice("worktree ".length);
			if (!primary || primary === root || !(await hasIndex(primary))) return;
			ctx.ui.setStatus("pi-codegraph", "pi-codegraph: indexing…");
			attempted = true;
			const result = await pi.exec("codegraph", ["init", "--yes", root], { cwd: root, timeout: INIT_TIMEOUT_MS });
			if (result.code !== 0 || result.killed || !(await hasIndex(root))) {
				throw new Error(`CodeGraph init failed (${result.killed ? "timed out or killed" : `exit ${result.code}`}): ${(result.stderr || result.stdout).trim().slice(-2000)}`);
			}
			succeeded = true;
			indexed = true;
			if (ctx.hasUI) {
				ctx.ui.setWidget(WIDGET_KEY, ["pi-codegraph: index ready"]);
				setTimeout(() => ctx.ui.setWidget(WIDGET_KEY, undefined), SUCCESS_TTL_MS);
			} else {
				ctx.ui.notify("CodeGraph worktree index ready.", "info");
			}
		} catch (error) {
			if (attempted) throw new Error(`${error instanceof Error ? error.message : String(error)}\n${recovery}`, { cause: error });
			throw error;
		} finally {
			// A failed or interrupted init stays locked; never accept its partial DB on reload.
			if (!attempted || succeeded) await rmdir(lock);
		}
	} finally {
		ctx.ui.setStatus("pi-codegraph", indexed ? "pi-codegraph: indexed" : "pi-codegraph: missing");
	}
}

export default function codegraphExtension(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		try {
			await initialize(pi, ctx);
		} catch (error) {
			const message = `pi-codegraph: ${error instanceof Error ? error.message : String(error)}`;
			ctx.ui.setStatus("pi-codegraph", "pi-codegraph: setup failed");
			if (ctx.hasUI) ctx.ui.notify(message, "error");
			else throw new Error(message, { cause: error });
		}
	});
}
