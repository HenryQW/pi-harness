import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface WorktreeInfo {
	path: string;
	cwd: string;
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
	createHash("sha256").update(childId).digest("hex").slice(0, 24);

const isAbsoluteish = (path: string): boolean => path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);
const stripGitLineEnd = (value: string): string => value.replace(/\r?\n$/, "");

/** Keeps ".worktrees/" out of git status via the common repository's exclude file; never dirties any checkout. */
async function ensureLocalExclude(gitDir: string): Promise<void> {
	const entry = `${WORKTREES_DIRNAME}/`;
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
	if (root.code !== 0) {
		if (/not a git repository/i.test(root.stderr)) return undefined; // documented degradation
		throw new Error(`git rev-parse failed (${root.stderr.trim().slice(0, 200)})`); // dubious ownership, timeout, …
	}
	const repoRoot = stripGitLineEnd(root.stdout);
	if (!repoRoot) return undefined;
	const prefix = await run(["rev-parse", "--show-prefix"], cwd);
	if (prefix.code !== 0) throw new Error(`git rev-parse --show-prefix failed (${prefix.stderr.trim().slice(0, 200)})`);
	const relativeCwd = stripGitLineEnd(prefix.stdout);
	const base = await run(["rev-parse", "HEAD"], repoRoot);
	if (base.code !== 0) {
		if (/ambiguous argument|unknown revision|bad revision/i.test(base.stderr)) return undefined; // unborn HEAD
		throw new Error(`git rev-parse HEAD failed (${base.stderr.trim().slice(0, 200)})`);
	}
	const baseCommit = base.stdout.trim();
	const common = await run(["rev-parse", "--git-common-dir"], repoRoot);
	const rawGitDir = stripGitLineEnd(common.stdout);
	if (common.code !== 0 || !rawGitDir) {
		throw new Error(`git rev-parse --git-common-dir failed (${common.stderr.trim().slice(0, 200)})`);
	}
	const gitDir = isAbsoluteish(rawGitDir) ? rawGitDir : join(repoRoot, rawGitDir);
	const stableRepoRoot = dirname(gitDir);
	const worktreesRoot = join(stableRepoRoot, WORKTREES_DIRNAME);
	const name = `subagent-${sanitizeShortId(childId)}`;
	const branch = `${BRANCH_NAMESPACE}/${name}`;
	const path = join(worktreesRoot, name);
	try {
		await mkdir(worktreesRoot, { recursive: true });
	} catch (error) {
		throw new Error(`Could not create ${worktreesRoot}: ${error instanceof Error ? error.message : String(error)}`);
	}
	await ensureLocalExclude(gitDir);
	const added = await run(["worktree", "add", path, "-b", branch, baseCommit], repoRoot);
	if (added.code !== 0) {
		throw new Error(`git worktree add failed; preserved ${path} and ${branch}: ${added.stderr.trim().slice(0, 200)}`);
	}
	return { path, cwd: join(path, relativeCwd), branch, repoRoot: stableRepoRoot, baseCommit };
}

/** Flags a payload whose state could not be measured (#88113): unmeasured is not zero. */
function markUnproven(payload: WorktreePayload, reason: string, unmeasured = "commits/dirty"): WorktreePayload {
	payload.inspection_failed = true;
	payload.note =
		`git inspection failed (${reason}): ${unmeasured} UNKNOWN — not proven zero/clean. `
		+ `Any remaining worktree or branch was preserved — inspect ${payload.path} (branch ${payload.branch}) before assuming no work.`;
	return payload;
}

/**
 * Inspects and possibly prunes a child worktree after it finishes. Commit count
 * reads the dedicated branch and refuses to prune when checkout HEAD no longer
 * names it; the clean-tree proof includes untracked, ignored, and submodule
 * changes despite repository config. A worktree with zero branch commits and a
 * clean tree is removed only when every probe succeeds and base_commit was
 * recorded; any probe failure keeps everything and reports `inspection_failed` so unmeasured
 * state is never read as empty.
 */
export async function finalizeChildWorktree(info: WorktreeInfo, run: GitRunner = runGit): Promise<WorktreePayload> {
	const payload: WorktreePayload = { path: info.path, branch: info.branch, commits: 0, dirty: false, pruned: false };
	const gitCwd = info.repoRoot || info.path;
	if (!existsSync(info.path)) {
		// Checkout directory gone (external cleanup, child rm): the dedicated
		// branch may still hold all of the child's work — count it before
		// reporting anything as pruned/empty.
		if (!info.baseCommit) return markUnproven(payload, "no base_commit recorded — commit count unmeasurable", "commits");
		const counted = await run(["rev-list", "--count", `${info.baseCommit}..${info.branch}`], gitCwd);
		if (counted.code !== 0) return markUnproven(payload, `rev-list exit ${counted.code}: ${counted.stderr.trim().slice(0, 200)}`, "commits");
		const commits = Number.parseInt(counted.stdout.trim(), 10);
		if (Number.isNaN(commits)) return markUnproven(payload, "rev-list produced non-numeric output", "commits");
		payload.commits = commits;
		if (commits > 0) return payload; // keep the branch for parent review
		const pruned = await run(["worktree", "prune", "--expire", "now"], gitCwd);
		if (pruned.code !== 0) return markUnproven(payload, `worktree prune exit ${pruned.code}: ${pruned.stderr.trim().slice(0, 200)}`, "cleanup");
		const deleted = await run(["branch", "-D", info.branch], gitCwd);
		if (deleted.code !== 0) return markUnproven(payload, `branch delete exit ${deleted.code}: ${deleted.stderr.trim().slice(0, 200)}`, "cleanup");
		payload.pruned = true;
		return payload;
	}
	if (!info.baseCommit) return markUnproven(payload, "no base_commit recorded — commit count unmeasurable", "commits");

	const counted = await run(["rev-list", "--count", `${info.baseCommit}..${info.branch}`], info.path);
	const status = await run(["status", "--porcelain", "--untracked-files=all", "--ignored=matching", "--ignore-submodules=none"], info.path);
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
		const head = await run(["symbolic-ref", "--quiet", "HEAD"], info.path);
		if (head.code !== 0 || head.stdout.trim() !== `refs/heads/${info.branch}`) {
			return markUnproven(payload, "HEAD is detached, switched, or unreadable", "checked-out commits");
		}
		const cwd = info.repoRoot || info.path;
		const removed = await run(["worktree", "remove", "--force", info.path], cwd);
		if (removed.code !== 0) return markUnproven(payload, `worktree remove exit ${removed.code}: ${removed.stderr.trim().slice(0, 200)}`, "cleanup");
		const deleted = await run(["branch", "-D", info.branch], cwd);
		if (deleted.code !== 0) return markUnproven(payload, `branch delete exit ${deleted.code}: ${deleted.stderr.trim().slice(0, 200)}`, "cleanup");
		payload.pruned = true;
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
