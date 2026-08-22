import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, rename, rm, writeFile, chmod } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type ExtensionAPI, type ExtensionUIContext, type Theme } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth, type TUI } from "@earendil-works/pi-tui";

const hookSourcePath = fileURLToPath(new URL("../hooks/post-checkout.mjs", import.meta.url));
const managedHookMarker = "pi-deps-managed-hook";

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function existingHook(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

export async function toggleDependencyHook(commonGitDir: string): Promise<{ enabled: boolean; path: string }> {
	const source = await readFile(hookSourcePath, "utf8");
	const path = join(commonGitDir, "hooks", "post-checkout");
	const existing = await existingHook(path);

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

const widgetKey = "pi-deps";
const pollMs = 500;
const successTtlMs = 5000;
const waitTimeoutMs = 10 * 60_000;
const spinnerIntervalMs = 100;
const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function formatElapsed(startedAt: number, now = Date.now()): string {
	const seconds = Math.max(0, Math.floor((now - startedAt) / 1_000));
	const minutes = Math.floor(seconds / 60);
	return minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

interface InstallStatus {
	state?: string;
	message?: string;
}

export interface InstallWatchContext {
	cwd: string;
	mode?: string;
	ui: Pick<ExtensionUIContext, "setWidget">;
}

// Watches the status file written by the background installer spawned by the post-checkout hook.
// First consumer wins: the status file is removed once reported.
export async function watchDependencyInstallation(
	exec: ExtensionAPI["exec"],
	ctx: InstallWatchContext,
	timing: { pollMs?: number; successTtlMs?: number } = {},
): Promise<void> {
	if (ctx.mode && ctx.mode !== "tui") return;
	const git = await exec("git", ["rev-parse", "--path-format=absolute", "--git-dir"], { cwd: ctx.cwd });
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
	if (status.state === "running") {
		const startedAt = Date.now();
		let timer: ReturnType<typeof setInterval> | undefined;
		ctx.ui.setWidget(widgetKey, (tui: TUI, theme: Theme): Component & { dispose?(): void } => {
			timer ??= setInterval(() => tui.requestRender(), spinnerIntervalMs);
			timer.unref();
			return {
				invalidate() {},
				dispose() {
					if (timer) clearInterval(timer);
					timer = undefined;
				},
				render: (width: number) => {
					const frame = spinnerFrames[Math.floor(Date.now() / spinnerIntervalMs) % spinnerFrames.length]!;
					return [
						truncateToWidth(
							`${theme.fg("accent", frame)} pi-deps: installing dependencies… ${theme.fg("dim", formatElapsed(startedAt))}`,
							width,
						),
					];
				},
			};
		});
	}
	const deadline = Date.now() + waitTimeoutMs;
	while (status.state === "running" && Date.now() < deadline) {
		await new Promise((resolveSleep) => setTimeout(resolveSleep, timing.pollMs ?? pollMs));
		status = await readStatus();
		if (!status) {
			ctx.ui.setWidget(widgetKey, undefined);
			return;
		}
	}
	await rm(statusPath, { force: true }); // consume so later sessions do not replay a stale outcome
	if (status.state === "ok") {
		ctx.ui.setWidget(widgetKey, ["pi-deps: dependencies installed"]);
		setTimeout(() => ctx.ui.setWidget(widgetKey, undefined), timing.successTtlMs ?? successTtlMs);
	} else if (status.state === "error") {
		ctx.ui.setWidget(widgetKey, [
			`pi-deps: install failed: ${status.message ?? "unknown error"}`,
			`pi-deps: log: ${join(stateDir, "install.log")}`,
		]);
	}
}

export default function depsExtension(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		await watchDependencyInstallation(pi.exec.bind(pi), ctx).catch(() => {});
	});
	pi.registerCommand("deps", {
		description: "Toggle dependency preparation for future Git worktrees",
		handler: async (args, ctx) => {
			if (args.trim()) throw new Error("Usage: /deps");
			const git = (args2: string[]) => pi.exec("git", args2, { cwd: ctx.cwd });
			const result = await git(["rev-parse", "--git-common-dir"]);
			if (result.code !== 0 || result.killed) {
				throw new Error(`Cannot locate shared Git directory: ${result.stderr.trim() || `exit code ${result.code}`}`);
			}
			const commonGitDir = result.stdout.trim();
			if (!commonGitDir) throw new Error("Cannot locate shared Git directory: git returned an empty path");

			// core.hooksPath replaces <commonGitDir>/hooks; refuse instead of writing where Git ignores or shares the hook.
			const hooksDir = await git(["rev-parse", "--git-path", "hooks"]);
			if (hooksDir.code !== 0 || hooksDir.killed) {
				throw new Error(`Cannot locate effective hooks directory: ${hooksDir.stderr.trim() || `exit code ${hooksDir.code}`}`);
			}
			const defaultHooksDir = resolve(ctx.cwd, commonGitDir, "hooks");
			if (resolve(ctx.cwd, hooksDir.stdout.trim()) !== defaultHooksDir) {
				throw new Error(`Refusing non-default hooks directory (core.hooksPath?): ${hooksDir.stdout.trim()}; expected ${defaultHooksDir}`);
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
