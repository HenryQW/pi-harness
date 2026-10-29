import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { canonicalWorktree } from "../extensions/pi-pr/extensions/pr-execution.ts";

/** Accept production project paths, but keep all fixture actions in this worktree. */
export async function assertFixtureWorktree(cwd: string, projectPath?: string, signal?: AbortSignal): Promise<void> {
	if (projectPath !== undefined && (!projectPath.trim() || projectPath.includes("\0"))) throw new Error("projectPath must name a project directory");
	const worktree = await canonicalWorktree(resolve(cwd, projectPath ?? cwd), signal);
	if (worktree !== realpathSync(cwd)) throw new Error("projectPath must match the fixture worktree");
}
