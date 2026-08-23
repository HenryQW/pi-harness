import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export interface WorktreeInfo {
	path: string;
	branch: string;
	repoRoot: string;
	baseCommit: string;
}

export interface WorktreePayload {
	path: string;
	branch: string;
	commits: number;
	dirty: boolean;
	pruned: boolean;
	inspection_failed?: boolean;
	note?: string;
}

export type GitRunner = (args: string[], cwd: string) => Promise<{ code: number; stdout: string; stderr: string }>;

const GIT_TIMEOUT_MS = 30_000;
const WORKTREES_DIRNAME = ".worktrees";
const BRANCH_NAMESPACE = "pi-subagent";

/** Runs git, capturing output; never throws on non-zero exit or spawn failure. */
const runGit: GitRunner = (args, cwd) =>
	new Promise((resolve) => {
		execFile("git", args, { cwd, timeout: GIT_TIMEOUT_MS }, (error, stdout, stderr) => {
			resolve({
				code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
				stdout: String(stdout),
				stderr: String(stderr),
			});
		});
	});

const sanitizeShortId = (childId: string): string =>
	childId.replace(/[^A-Za-z0-9._-]/g, "_") || randomBytes(4).toString("hex");

const isAbsoluteish = (path: string): boolean => path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);

/** Keeps ".worktrees/" out of git status via the repository-local exclude file; never dirties the checkout. */
async function ensureLocalExclude(repoRoot: string, run: GitRunner): Promise<void> {
	const entry = `${WORKTREES_DIRNAME}/`;
	const dir = await run(["rev-parse", "--git-dir"], repoRoot);
	if (dir.code !== 0 || !dir.stdout.trim()) return;
	const raw = dir.stdout.trim();
	const gitDir = isAbsoluteish(raw) ? raw : join(repoRoot, raw);
	const exclude = join(gitDir, "info", "exclude");
	try {
		await mkdir(join(gitDir, "info"), { recursive: true });
		const existing = await readFile(exclude, "utf8").catch(() => "");
		if (existing.split("\n").some((line) => line.trim() === entry)) return;
		await appendFile(exclude, `${existing && !existing.endsWith("\n") ? "\n" : ""}${entry}\n`);
	} catch {
		// Best-effort: never fail launch over the exclude file.
	}
}

/**
 * Creates one worktree per child from parent HEAD. Returns undefined only when
 * the workspace is not a git repository or HEAD is unborn — callers degrade
 * silently to the shared working directory. Setup failures in a real git
 * repository (unwritable path, stale branch, git lock) throw so an isolated
 * role never silently loses its isolation.
 */
export async function createChildWorktree(
	cwd: string,
	childId: string,
	run: GitRunner = runGit,
): Promise<WorktreeInfo | undefined> {
	const root = await run(["rev-parse", "--show-toplevel"], cwd);
	if (root.code !== 0 || !root.stdout.trim()) return undefined;
	const repoRoot = root.stdout.trim();
	const base = await run(["rev-parse", "HEAD"], repoRoot);
	if (base.code !== 0) return undefined; // unborn HEAD: nothing to branch from
	const baseCommit = base.stdout.trim();
	const name = `subagent-${sanitizeShortId(childId)}`;
	const branch = `${BRANCH_NAMESPACE}/${name}`;
	const path = join(repoRoot, WORKTREES_DIRNAME, name);
	try {
		await mkdir(join(repoRoot, WORKTREES_DIRNAME), { recursive: true });
	} catch (error) {
		throw new Error(`Could not create ${join(repoRoot, WORKTREES_DIRNAME)}: ${error instanceof Error ? error.message : String(error)}`);
	}
	await ensureLocalExclude(repoRoot, run);
	const added = await run(["worktree", "add", path, "-b", branch, "HEAD"], repoRoot);
	if (added.code !== 0) throw new Error(`git worktree add failed: ${added.stderr.trim().slice(0, 200)}`);
	return { path, branch, repoRoot, baseCommit };
}

/** Flags a payload whose state could not be measured (#88113): unmeasured is not zero. */
function markUnproven(payload: WorktreePayload, reason: string, unmeasured = "commits/dirty"): WorktreePayload {
	payload.inspection_failed = true;
	payload.note =
		`git inspection failed (${reason}): ${unmeasured} UNKNOWN — not proven zero/clean. `
		+ `The worktree and branch were preserved — inspect ${payload.path} (branch ${payload.branch}) before assuming no work.`;
	return payload;
}

/**
 * Inspects and possibly prunes a child worktree after it finishes. Commit count
 * reads the dedicated branch (not the checkout's HEAD, which a child may have
 * detached); the clean-tree proof forces untracked files so repository config
 * cannot hide them. A worktree with zero branch commits and a clean tree is
 * removed only when both probes exited zero and base_commit was recorded; any
 * probe failure keeps everything and reports `inspection_failed` so unmeasured
 * state is never read as empty.
 */
export async function finalizeChildWorktree(info: WorktreeInfo, run: GitRunner = runGit): Promise<WorktreePayload> {
	const payload: WorktreePayload = { path: info.path, branch: info.branch, commits: 0, dirty: false, pruned: false };
	if (!existsSync(info.path)) {
		payload.pruned = true; // nothing on disk to review
		return payload;
	}
	if (!info.baseCommit) return markUnproven(payload, "no base_commit recorded — commit count unmeasurable", "commits");

	const counted = await run(["rev-list", "--count", `${info.baseCommit}..${info.branch}`], info.path);
	const status = await run(["status", "--porcelain", "--untracked-files=all"], info.path);
	const failed: string[] = [];
	const unmeasured: string[] = [];
	if (counted.code === 0) {
		const commits = Number.parseInt(counted.stdout.trim(), 10);
		if (Number.isNaN(commits)) {
			failed.push("rev-list produced non-numeric output");
			unmeasured.push("commits");
		} else payload.commits = commits;
	} else {
		failed.push(`rev-list exit ${counted.code}: ${counted.stderr.trim().slice(0, 200)}`);
		unmeasured.push("commits");
	}
	if (status.code === 0) payload.dirty = Boolean(status.stdout.trim());
	else {
		failed.push(`status exit ${status.code}: ${status.stderr.trim().slice(0, 200)}`);
		unmeasured.push("dirty");
	}
	if (failed.length) return markUnproven(payload, failed.join("; "), unmeasured.join("/"));

	if (payload.commits === 0 && !payload.dirty) {
		const cwd = info.repoRoot || info.path;
		const removed = await run(["worktree", "remove", "--force", info.path], cwd);
		if (removed.code === 0) {
			await run(["branch", "-D", info.branch], cwd);
			payload.pruned = true;
		}
	}
	return payload;
}

/** Context block telling the child to work inside its isolated worktree. */
export function worktreeContextNote(info: WorktreeInfo): string {
	return "\n\n[WORKTREE ISOLATION] You are working in an isolated git worktree "
		+ `at: ${info.path}\n`
		+ `Your dedicated branch is: ${info.branch}\n`
		+ "All file edits and shell commands must happen inside this worktree directory "
		+ "(your terminal already starts there). Do NOT cd to the main repository checkout. "
		+ "Commit your changes to your branch when done; the parent agent will review and merge your branch. "
		+ "If you make no commits and leave the tree clean, the worktree is discarded automatically.";
}
