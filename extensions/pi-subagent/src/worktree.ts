import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync } from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

export interface WorktreeInfo {
	path: string;
	cwd: string;
	branch: string;
	repoRoot: string;
	baseCommit: string;
}

export type WorktreePayload =
	| { outcome: "pruned"; path: string; branch: string }
	| { outcome: "retained"; path: string; branch: string; commits: number; dirty: boolean }
	| { outcome: "recovery"; path: string; branch: string; note: string; commits?: number; dirty?: boolean };

export type GitRunner = (args: string[], cwd: string, signal?: AbortSignal) => Promise<{ code: number; stdout: string; stderr: string }>;

const GIT_TIMEOUT_MS = 30_000;
const WORKTREES_DIRNAME = ".worktrees";
const BRANCH_NAMESPACE = "pi-subagent";

export class WorktreeSetupError extends Error {
	override name = "WorktreeSetupError";
	readonly worktree: WorktreeInfo;

	constructor(message: string, worktree: WorktreeInfo) {
		super(message);
		this.worktree = worktree;
	}
}

/** Runs git, capturing output; never throws on non-zero exit or spawn failure. */
const runGit: GitRunner = (args, cwd, signal) =>
	new Promise((resolve) => {
		execFile("git", args, { cwd, timeout: GIT_TIMEOUT_MS, signal }, (error, stdout, stderr) => {
			resolve({
				code: error ? (typeof error.code === "number" ? error.code : -1) : 0,
				stdout: String(stdout),
				stderr: String(stderr),
			});
		});
	});

const sanitizeShortId = (childId: string): string =>
	createHash("sha256").update(childId).digest("hex").slice(0, 24);

const stripGitLineEnd = (value: string): string => value.replace(/\r?\n$/, "");

function hasRepositoryMarker(cwd: string): boolean {
	for (let directory = resolve(cwd);; directory = dirname(directory)) {
		try {
			lstatSync(join(directory, ".git"));
			return true;
		} catch (error) {
			if (!error || typeof error !== "object" || !("code" in error) || !["ENOENT", "ENOTDIR"].includes(String(error.code))) return true;
		}
		if (dirname(directory) === directory) return false;
	}
}

/** Keeps ".worktrees/" out of git status via the common repository's exclude file; never dirties any checkout. */
async function ensureLocalExclude(gitDir: string): Promise<void> {
	const entry = `/${WORKTREES_DIRNAME}/`;
	const exclude = join(gitDir, "info", "exclude");
	try {
		await mkdir(join(gitDir, "info"), { recursive: true });
		let existing = "";
		try {
			existing = await readFile(exclude, "utf8");
		} catch (error) {
			if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error;
		}
		if (existing.split("\n").some((line) => line.trim() === entry)) return;
		await appendFile(exclude, `${existing && !existing.endsWith("\n") ? "\n" : ""}${entry}\n`);
	} catch (error) {
		throw new Error(`Could not update ${exclude}: ${error instanceof Error ? error.message : String(error)}`);
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
	signal?: AbortSignal,
): Promise<WorktreeInfo | undefined> {
	const root = await run(["rev-parse", "--show-toplevel"], cwd, signal);
	if (root.code !== 0) {
		signal?.throwIfAborted();
		const repository = await run(["-c", "safe.directory=*", "rev-parse", "--show-toplevel"], cwd, signal);
		signal?.throwIfAborted();
		if (repository.code !== 0 && !hasRepositoryMarker(cwd) && !process.env.GIT_DIR && !process.env.GIT_WORK_TREE) return undefined;
		throw new Error(`git rev-parse failed (${root.stderr.trim().slice(0, 200)})`); // dubious ownership, timeout, …
	}
	const repoRoot = stripGitLineEnd(root.stdout);
	if (!repoRoot) return undefined;
	const prefix = await run(["rev-parse", "--show-prefix"], cwd, signal);
	if (prefix.code !== 0) throw new Error(`git rev-parse --show-prefix failed (${prefix.stderr.trim().slice(0, 200)})`);
	const relativeCwd = stripGitLineEnd(prefix.stdout);
	const base = await run(["rev-parse", "HEAD"], repoRoot, signal);
	if (base.code !== 0) {
		signal?.throwIfAborted();
		const head = await run(["symbolic-ref", "--quiet", "HEAD"], repoRoot, signal);
		signal?.throwIfAborted();
		const reference = stripGitLineEnd(head.stdout);
		if (head.code === 0 && reference) {
			const exists = await run(["show-ref", "--verify", "--quiet", reference], repoRoot, signal);
			signal?.throwIfAborted();
			if (exists.code === 1) return undefined; // unborn HEAD
		}
		throw new Error(`git rev-parse HEAD failed (${base.stderr.trim().slice(0, 200)})`);
	}
	const baseCommit = base.stdout.trim();
	const superproject = await run(["rev-parse", "--show-superproject-working-tree"], repoRoot, signal);
	if (superproject.code !== 0) {
		throw new Error(`git rev-parse --show-superproject-working-tree failed (${superproject.stderr.trim().slice(0, 200)})`);
	}
	if (stripGitLineEnd(superproject.stdout)) {
		throw new Error("Worktree isolation is unavailable inside Git submodules because parent cleanup can remove their Git metadata.");
	}
	const common = await run(["rev-parse", "--git-common-dir"], repoRoot, signal);
	const rawCommonGitDir = stripGitLineEnd(common.stdout);
	if (common.code !== 0 || !rawCommonGitDir) {
		throw new Error(`git rev-parse --git-common-dir failed (${common.stderr.trim().slice(0, 200)})`);
	}
	const current = await run(["rev-parse", "--git-dir"], repoRoot, signal);
	const rawCurrentGitDir = stripGitLineEnd(current.stdout);
	if (current.code !== 0 || !rawCurrentGitDir) {
		throw new Error(`git rev-parse --git-dir failed (${current.stderr.trim().slice(0, 200)})`);
	}
	const gitDir = isAbsolute(rawCommonGitDir) ? rawCommonGitDir : join(repoRoot, rawCommonGitDir);
	const currentGitDir = isAbsolute(rawCurrentGitDir) ? rawCurrentGitDir : join(repoRoot, rawCurrentGitDir);
	let stableRepoRoot = repoRoot;
	if (currentGitDir !== gitDir) {
		const worktrees = await run(["worktree", "list", "--porcelain", "-z"], repoRoot, signal);
		const primary = worktrees.stdout.split("\0", 1)[0];
		if (worktrees.code !== 0 || !primary?.startsWith("worktree ") || primary.length === "worktree ".length) {
			throw new Error(`git worktree list failed (${worktrees.stderr.trim().slice(0, 200)})`);
		}
		stableRepoRoot = primary.slice("worktree ".length);
	}
	signal?.throwIfAborted();
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
	signal?.throwIfAborted();
	const worktree = { path, cwd: join(path, relativeCwd), branch, repoRoot: stableRepoRoot, baseCommit };
	const added = await run(["worktree", "add", path, "-b", branch, baseCommit], repoRoot, signal);
	if (added.code !== 0) {
		throw new WorktreeSetupError(
			`git worktree add failed after attempting path=${JSON.stringify(path)} branch=${JSON.stringify(branch)} base=${baseCommit}: ${added.stderr.trim().slice(0, 200)}`,
			worktree,
		);
	}
	return worktree;
}

/** Records only measurements that completed before recovery became necessary. */
function recoveryPayload(
	info: WorktreeInfo,
	reason: string,
	measurements: { commits?: number; dirty?: boolean } = {},
	action = `Inspect ${info.path} (branch ${info.branch}) before assuming no work.`,
): Extract<WorktreePayload, { outcome: "recovery" }> {
	const unknown = [
		...(measurements.commits === undefined ? ["commits"] : []),
		...(measurements.dirty === undefined ? ["dirty"] : []),
	].join("/");
	return {
		outcome: "recovery",
		path: info.path,
		branch: info.branch,
		...(measurements.commits === undefined ? {} : { commits: measurements.commits }),
		...(measurements.dirty === undefined ? {} : { dirty: measurements.dirty }),
		note: `Worktree recovery required (${reason})${unknown ? `: ${unknown} UNKNOWN` : ""}. ${action}`,
	};
}

export interface WorktreeDirtyInspection {
	dirty: boolean;
	failure?: string;
	initializedSubmodules?: boolean;
}

export async function inspectIndexFlags(cwd: string, run: GitRunner = runGit, signal?: AbortSignal): Promise<{ hidden: boolean; failure?: string }> {
	const flags = await run(["ls-files", "-v", "-z"], cwd, signal);
	if (flags.code !== 0) return { hidden: false, failure: `ls-files exit ${flags.code}: ${flags.stderr.trim().slice(0, 200)}` };
	return { hidden: flags.stdout.split("\0").some((entry) => /^(?:[a-z]|S) /.test(entry)) };
}

async function inspectDirty(run: GitRunner, cwd: string): Promise<WorktreeDirtyInspection> {
	const refreshed = await run(["update-index", "--really-refresh"], cwd);
	if (refreshed.code !== 0 && refreshed.code !== 1) {
		return { dirty: false, failure: `update-index exit ${refreshed.code}: ${refreshed.stderr.trim().slice(0, 200)}` };
	}
	const status = await run(["status", "--porcelain", "--untracked-files=all", "--ignored=matching", "--ignore-submodules=none"], cwd);
	if (status.code !== 0) return { dirty: false, failure: `status exit ${status.code}: ${status.stderr.trim().slice(0, 200)}` };
	if (refreshed.code === 1 || status.stdout.trim()) return { dirty: true };
	const flags = await inspectIndexFlags(cwd, run);
	if (flags.failure) return { dirty: false, failure: flags.failure };
	if (flags.hidden) return { dirty: false, failure: "assume-unchanged or skip-worktree index entries remain" };
	return { dirty: false };
}

/** Proves a worktree has no tracked, untracked, ignored, index-hidden, or nested submodule work. */
export async function inspectWorktreeDirty(cwd: string, run: GitRunner = runGit): Promise<WorktreeDirtyInspection> {
	const root = await inspectDirty(run, cwd);
	if (root.dirty || root.failure) return root;
	const modules = await run(["submodule", "status", "--recursive"], cwd);
	if (modules.code !== 0) return { dirty: false, failure: `submodule list exit ${modules.code}: ${modules.stderr.trim().slice(0, 200)}` };
	const initializedSubmodules = modules.stdout.split("\n").some((line) => line && !line.startsWith("-"));
	if (initializedSubmodules) {
		const listed = await run(["submodule", "foreach", "--recursive", "--quiet", "printf '%s\\0' \"$PWD\""], cwd);
		if (listed.code !== 0) return { dirty: false, failure: `submodule list exit ${listed.code}: ${listed.stderr.trim().slice(0, 200)}` };
		const paths = listed.stdout.split("\0").filter(Boolean);
		if (!paths.length) return { dirty: false, failure: "initialized submodule paths unavailable" };
		for (const path of paths) {
			const nested = await inspectDirty(run, path);
			if (nested.failure) return { dirty: false, failure: `submodule ${path}: ${nested.failure}` };
			if (nested.dirty) return { dirty: true };
		}
	}
	const rechecked = await inspectDirty(run, cwd);
	return initializedSubmodules ? { ...rechecked, initializedSubmodules } : rechecked;
}

/**
 * Inspects and possibly prunes a child worktree after it finishes. Commit count
 * reads the dedicated branch and refuses to prune when checkout HEAD no longer
 * names it; the clean-tree proof includes untracked, ignored, and submodule
 * changes despite repository config. A worktree with zero branch commits and a
 * clean tree is removed only when every probe succeeds and base_commit was
 * recorded; any uncertainty preserves work and omits unknown measurements.
 */
export async function finalizeChildWorktree(info: WorktreeInfo, run: GitRunner = runGit): Promise<WorktreePayload> {
	const checkoutExists = existsSync(info.path);
	const gitCwd = checkoutExists ? info.path : info.repoRoot || info.path;
	if (!info.baseCommit) return recoveryPayload(info, "no base_commit recorded — commit count unmeasurable");

	const counted = await run(["rev-list", "--count", `${info.baseCommit}..${info.branch}`], gitCwd);
	const commits = Number.parseInt(counted.stdout.trim(), 10);
	const countFailure = counted.code !== 0
		? `rev-list exit ${counted.code}: ${counted.stderr.trim().slice(0, 200)}`
		: Number.isNaN(commits) ? "rev-list produced non-numeric output" : undefined;
	const inspection = checkoutExists ? await inspectDirty(run, info.path) : undefined;
	const measurements = {
		...(countFailure === undefined ? { commits } : {}),
		...(inspection?.failure === undefined && inspection !== undefined ? { dirty: inspection.dirty } : {}),
	};
	if (countFailure || inspection?.failure) {
		return recoveryPayload(info, [countFailure, inspection?.failure].filter(Boolean).join("; "), measurements);
	}

	let forceRemove = false;
	if (checkoutExists) {
		const dirty = inspection!.dirty;
		if (commits > 0 || dirty) return { outcome: "retained", path: info.path, branch: info.branch, commits, dirty };

		const head = await run(["symbolic-ref", "--quiet", "HEAD"], info.path);
		if (head.code !== 0 || head.stdout.trim() !== `refs/heads/${info.branch}`) {
			return recoveryPayload(info, "HEAD is detached, switched, or unreadable", measurements);
		}
		const rechecked = await inspectWorktreeDirty(info.path, run);
		if (rechecked.failure) return recoveryPayload(info, `final ${rechecked.failure}`, { commits });
		if (rechecked.dirty) return { outcome: "retained", path: info.path, branch: info.branch, commits, dirty: true };
		forceRemove = Boolean(rechecked.initializedSubmodules);
	} else if (commits > 0) {
		return recoveryPayload(info, "worktree checkout is missing", { commits });
	}

	const cleanupCwd = info.repoRoot || info.path;
	const removed = await run(["worktree", "remove", ...(forceRemove ? ["--force"] : []), info.path], cleanupCwd);
	if (removed.code !== 0) return recoveryPayload(info, `worktree remove exit ${removed.code}: ${removed.stderr.trim().slice(0, 200)}`, measurements);
	const deleted = await run(["update-ref", "-d", `refs/heads/${info.branch}`, info.baseCommit], cleanupCwd);
	if (deleted.code !== 0) {
		return recoveryPayload(
			info,
			`branch delete exit ${deleted.code}: ${deleted.stderr.trim().slice(0, 200)}`,
			measurements,
			`Inspect branch ${info.branch}; recreate ${info.path} from it before assuming no work.`,
		);
	}
	return { outcome: "pruned", path: info.path, branch: info.branch };
}

/** Context block telling the child to work inside its isolated worktree. */
export function worktreeContextNote(info: WorktreeInfo): string {
	return `\n\n[WORKTREE ISOLATION] Work only in ${info.path} on ${info.branch}; do not use main checkout. Commit changes to this branch for parent review.`;
}
