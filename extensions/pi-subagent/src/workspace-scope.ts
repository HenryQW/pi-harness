import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { runGit } from "./git-process.ts";

const Name = Type.String({ pattern: "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$", maxLength: 80 });
export const RepositorySelectionSchema = Type.Record(Name, Type.String({ minLength: 1, maxLength: 4096 }), { minProperties: 1, maxProperties: 8 });
export type RepositorySelection = Static<typeof RepositorySelectionSchema>;
export type SelectedRepository = { root: string; common: string };
export type WorkspaceScope = { root: string; repositories: Record<string, SelectedRepository> };

export function parseRepositorySelection(value: unknown): RepositorySelection {
	if (!Check(RepositorySelectionSchema, value)) throw new Error("repositories must map 1 to 8 unique names to absolute Git checkout paths.");
	for (const path of Object.values(value)) {
		if (!isAbsolute(path) || resolve(path) !== path || /[\x00-\x1f\x7f]/.test(path)) throw new Error("Selected repository paths must be absolute and normalized without control characters.");
	}
	return value;
}

/** Selection is explicit. Never discover repositories or infer a write scope from their names. */
export async function resolveWorkspaceScope(cwd: string, selection: RepositorySelection, signal?: AbortSignal): Promise<WorkspaceScope> {
	parseRepositorySelection(selection);
	signal?.throwIfAborted();
	if (process.env.GIT_DIR || process.env.GIT_WORK_TREE || process.env.GIT_INDEX_FILE) throw new Error("Workspace selection does not support Git environment overrides.");
	const root = await realpath(cwd);
	const enclosing = await runGit(["rev-parse", "--show-toplevel"], root, signal);
	if (enclosing.code === 0 || enclosing.code === -1 || !/not a git repository/i.test(enclosing.stderr)) throw new Error("Explicit repositories require a non-Git workspace directory.");
	const repositories: WorkspaceScope["repositories"] = {};
	const commons = new Set<string>();
	for (const [name, path] of Object.entries(selection)) {
		signal?.throwIfAborted();
		const canonical = await realpath(path);
		// One workspace owns selection. Nested layouts and symlink aliases are not inferred.
		if (canonical !== path || dirname(path) !== root || !(await lstat(path)).isDirectory()) throw new Error(`Repository ${name} must be a canonical direct child of the workspace.`);
		const top = await runGit(["rev-parse", "--show-toplevel"], path, signal);
		const commonResult = await runGit(["rev-parse", "--path-format=absolute", "--git-common-dir"], path, signal);
		if (top.code !== 0 || top.stdout.trimEnd() !== path || commonResult.code !== 0) throw new Error(`Repository ${name} does not identify an exact Git checkout.`);
		const common = await realpath(commonResult.stdout.trimEnd());
		if (common !== resolve(path, ".git") || !(await lstat(common)).isDirectory() || commons.has(common)) throw new Error(`Repository ${name} must be an independent primary checkout with its own .git directory.`);
		commons.add(common);
		repositories[name] = { root: path, common };
	}
	return { root, repositories };
}

/** Root inputs are files, not trees or Git members. No symlink traversal is accepted. */
export async function workspaceInputPath(scope: WorkspaceScope, path: string): Promise<string> {
	if (!isAbsolute(path) || await realpath(path) !== path || !(await lstat(path)).isFile()) throw new Error("Workspace inputs must be canonical regular files.");
	const within = relative(scope.root, path);
	if (!within || within.startsWith("..") || isAbsolute(within) || within.split(/[\\/]/).includes(".git")
		|| Object.values(scope.repositories).some(({ root }) => path.startsWith(`${root}/`))) throw new Error("Workspace inputs must be outside selected repositories and inside the workspace.");
	// An unselected repository is not a workspace-root input source either.
	const git = await runGit(["rev-parse", "--show-toplevel"], dirname(path));
	if (git.code === 0 || git.code === -1 || !/not a git repository/i.test(git.stderr)) throw new Error("Workspace input belongs to a Git repository or its scope is uncertain.");
	return path;
}
