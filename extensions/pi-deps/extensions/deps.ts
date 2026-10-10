import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, rename, rm, writeFile, chmod } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

const hookSourcePath = fileURLToPath(new URL("../hooks/post-checkout.mjs", import.meta.url));
const managedHookMarker = "pi-deps-managed-hook";

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function toggleDependencyHook(commonGitDir: string): Promise<{ enabled: boolean; path: string }> {
	const source = await readFile(hookSourcePath, "utf8");
	const path = join(commonGitDir, "hooks", "post-checkout");
	let existing: string | undefined;
	try {
		existing = await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}

	if (existing !== undefined) {
		if (!existing.includes(managedHookMarker)) {
			throw new Error(`Refusing to modify unmanaged Git hook: ${path}`);
		}
		// Rename first so the content check happens on the exact inode being removed.
		const staging = `${path}.pi-deps-${process.pid}-${randomUUID()}`;
		await rename(path, staging);
		try {
			const removed = await readFile(staging, "utf8");
			if (!removed.includes(managedHookMarker)) {
				await rename(staging, path);
				throw new Error(`Refusing to modify unmanaged Git hook: ${path}`);
			}
			await rm(staging);
		} catch (error) {
			await rm(staging, { force: true });
			throw error;
		}
		return { enabled: false, path };
	}

	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.pi-deps-${process.pid}-${randomUUID()}`;
	try {
		await writeFile(temporary, source, { encoding: "utf8", mode: 0o755, flag: "wx" });
		await chmod(temporary, 0o755);
		await link(temporary, path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") {
			throw new Error(`Refusing to modify Git hook created concurrently: ${path}`, { cause: error });
		}
		throw error;
	} finally {
		await rm(temporary, { force: true });
	}
	return { enabled: true, path };
}

const statusKey = "pi-deps";
const pollMs = 500;
const waitTimeoutMs = 10 * 60_000;
const spinnerIntervalMs = 100;
const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function formatElapsed(startedAt: number): string {
	const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1_000));
	const minutes = Math.floor(seconds / 60);
	return minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

interface InstallStatus {
	state?: string;
	message?: string;
}

// Watches the status file written by the background installer spawned by the post-checkout hook.
// First consumer wins: the status file is removed once reported.
async function watchDependencyInstallation(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	signal: AbortSignal,
): Promise<void> {
	if (ctx.mode !== "tui") return;
	const git = await pi.exec("git", ["rev-parse", "--path-format=absolute", "--git-dir"], { cwd: ctx.cwd });
	if (git.code !== 0 || git.killed) return;
	const stateDir = join(git.stdout.trim(), "pi-deps");
	const statusPath = join(stateDir, "status.json");
	const readStatus = async (): Promise<InstallStatus | undefined> => {
		try {
			return JSON.parse(await readFile(statusPath, "utf8")) as InstallStatus;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			return { state: "running" }; // partial write from installer or test; retry next poll
		}
	};

	let status = await readStatus();
	if (!status) return;
	signal.throwIfAborted();
	const startedAt = Date.now();
	const update = () => {
		const frame = spinnerFrames[Math.floor(Date.now() / spinnerIntervalMs) % spinnerFrames.length]!;
		ctx.ui.setStatus(statusKey, ctx.ui.theme.fg("dim", `${frame} deps · installing ${formatElapsed(startedAt)}`));
	};
	let timer: ReturnType<typeof setInterval> | undefined;
	try {
		if (status.state === "running") {
			update();
			timer = setInterval(update, spinnerIntervalMs);
			timer.unref();
		}
		const deadline = startedAt + waitTimeoutMs;
		while (status.state === "running" && Date.now() < deadline) {
			await delay(pollMs, undefined, { signal });
			status = await readStatus();
			if (!status) return;
		}
		signal.throwIfAborted();
		await rm(statusPath, { force: true }); // consume so later sessions do not replay a stale outcome
		if (status.state === "error" || status.state === "running") {
			ctx.ui.setWidget(statusKey, [
				status.state === "error"
					? `pi-deps: install failed: ${status.message ?? "unknown error"}`
					: "pi-deps: stopped waiting for dependency installation after ten minutes; check the log.",
				`pi-deps: log: ${join(stateDir, "install.log")}`,
			]);
		}
	} finally {
		if (timer) clearInterval(timer);
		ctx.ui.setStatus(statusKey, undefined);
	}
}

export default function depsExtension(pi: ExtensionAPI): void {
	let watcher: AbortController | undefined;
	pi.on("session_shutdown", () => watcher?.abort());
	pi.on("session_start", (_event, ctx) => {
		watcher?.abort();
		const controller = watcher = new AbortController();
		void watchDependencyInstallation(pi, ctx, controller.signal).catch((error) => {
			if (!controller.signal.aborted) ctx.ui.notify(`pi-deps: ${errorMessage(error)}`, "error");
		});
	});
	pi.registerCommand("deps", {
		description: "Toggle dependency preparation for future Git worktrees",
		handler: async (args, ctx) => {
			if (args.trim()) throw new Error("Usage: /deps");
			const result = await pi.exec("git", ["rev-parse", "--git-common-dir", "--git-path", "hooks"], { cwd: ctx.cwd });
			if (result.code !== 0 || result.killed) {
				throw new Error(`Cannot locate shared Git directory: ${result.stderr.trim() || `exit code ${result.code}`}`);
			}
			const [commonGitDir, hooksDir] = result.stdout.trim().split(/\r?\n/);

			// core.hooksPath replaces <commonGitDir>/hooks; refuse instead of writing where Git ignores or shares the hook.
			const defaultHooksDir = resolve(ctx.cwd, commonGitDir, "hooks");
			if (resolve(ctx.cwd, hooksDir) !== defaultHooksDir) {
				throw new Error(`Refusing non-default hooks directory (core.hooksPath?): ${hooksDir}; expected ${defaultHooksDir}`);
			}

			try {
				const toggled = await toggleDependencyHook(resolve(ctx.cwd, commonGitDir));
				ctx.ui.notify(
					`Dependency preparation ${toggled.enabled ? "enabled" : "disabled"}: ${toggled.path}`,
					"info",
				);
			} catch (error) {
				throw new Error(`Cannot toggle dependency preparation: ${errorMessage(error)}`, { cause: error });
			}
		},
	});
}
