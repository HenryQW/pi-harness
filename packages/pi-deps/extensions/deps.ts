import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, rm, unlink, writeFile, chmod } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const hookSourcePath = fileURLToPath(new URL("../hooks/post-checkout.mjs", import.meta.url));

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
		if (existing !== source) {
			throw new Error(`Refusing to modify existing Git hook: ${path}`);
		}
		await unlink(path);
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

export default function depsExtension(pi: ExtensionAPI): void {
	pi.registerCommand("deps", {
		description: "Toggle dependency preparation for future Git worktrees",
		handler: async (args, ctx) => {
			if (args.trim()) throw new Error("Usage: /deps");
			const result = await pi.exec("git", ["rev-parse", "--git-common-dir"], { cwd: ctx.cwd });
			if (result.code !== 0 || result.killed) {
				throw new Error(`Cannot locate shared Git directory: ${result.stderr.trim() || `exit code ${result.code}`}`);
			}
			const commonGitDir = result.stdout.trim();
			if (!commonGitDir) throw new Error("Cannot locate shared Git directory: git returned an empty path");

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
