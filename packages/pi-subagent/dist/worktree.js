import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync } from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
const GIT_TIMEOUT_MS = 30_000;
const WORKTREES_DIRNAME = ".worktrees";
const BRANCH_NAMESPACE = "pi-subagent";
class WorktreeSetupError extends Error {
    name = "WorktreeSetupError";
}
/** Runs git, capturing output; never throws on non-zero exit or spawn failure. */
const runGit = (args, cwd, signal) => new Promise((resolve) => {
    execFile("git", args, { cwd, timeout: GIT_TIMEOUT_MS, signal }, (error, stdout, stderr) => {
        resolve({
            code: error ? (typeof error.code === "number" ? error.code : -1) : 0,
            stdout: String(stdout),
            stderr: String(stderr),
        });
    });
});
const sanitizeShortId = (childId) => createHash("sha256").update(childId).digest("hex").slice(0, 24);
const stripGitLineEnd = (value) => value.replace(/\r?\n$/, "");
function hasRepositoryMarker(cwd) {
    for (let directory = resolve(cwd);; directory = dirname(directory)) {
        try {
            lstatSync(join(directory, ".git"));
            return true;
        }
        catch (error) {
            if (!error || typeof error !== "object" || !("code" in error) || !["ENOENT", "ENOTDIR"].includes(String(error.code)))
                return true;
        }
        if (dirname(directory) === directory)
            return false;
    }
}
/** Keeps ".worktrees/" out of git status via the common repository's exclude file; never dirties any checkout. */
async function ensureLocalExclude(gitDir) {
    const entry = `/${WORKTREES_DIRNAME}/`;
    const exclude = join(gitDir, "info", "exclude");
    try {
        await mkdir(join(gitDir, "info"), { recursive: true });
        const existing = await readFile(exclude, "utf8").catch(() => "");
        if (existing.split("\n").some((line) => line.trim() === entry))
            return;
        await appendFile(exclude, `${existing && !existing.endsWith("\n") ? "\n" : ""}${entry}\n`);
    }
    catch {
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
export async function createChildWorktree(cwd, childId, run = runGit, signal) {
    const root = await run(["rev-parse", "--show-toplevel"], cwd, signal);
    if (root.code !== 0) {
        signal?.throwIfAborted();
        const repository = await run(["-c", "safe.directory=*", "rev-parse", "--show-toplevel"], cwd, signal);
        signal?.throwIfAborted();
        if (repository.code !== 0 && !hasRepositoryMarker(cwd) && !process.env.GIT_DIR && !process.env.GIT_WORK_TREE)
            return undefined;
        throw new Error(`git rev-parse failed (${root.stderr.trim().slice(0, 200)})`); // dubious ownership, timeout, …
    }
    const repoRoot = stripGitLineEnd(root.stdout);
    if (!repoRoot)
        return undefined;
    const prefix = await run(["rev-parse", "--show-prefix"], cwd, signal);
    if (prefix.code !== 0)
        throw new Error(`git rev-parse --show-prefix failed (${prefix.stderr.trim().slice(0, 200)})`);
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
            if (exists.code === 1)
                return undefined; // unborn HEAD
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
    }
    catch (error) {
        throw new Error(`Could not create ${worktreesRoot}: ${error instanceof Error ? error.message : String(error)}`);
    }
    await ensureLocalExclude(gitDir);
    signal?.throwIfAborted();
    const added = await run(["worktree", "add", path, "-b", branch, baseCommit], repoRoot, signal);
    if (added.code !== 0) {
        throw new WorktreeSetupError(`git worktree add failed; preserved ${path} and ${branch}: ${added.stderr.trim().slice(0, 200)}`);
    }
    return { path, cwd: join(path, relativeCwd), branch, repoRoot: stableRepoRoot, baseCommit };
}
/** Flags a payload whose state could not be measured (#88113): unmeasured is not zero. */
function markUnproven(payload, reason, unmeasured = "commits/dirty") {
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
 * recorded; any probe failure keeps everything and reports `inspection_failed`
 * so unmeasured state is never read as empty.
 */
export async function finalizeChildWorktree(info, run = runGit) {
    const payload = { path: info.path, branch: info.branch, commits: 0, dirty: false, pruned: false };
    const checkoutExists = existsSync(info.path);
    const gitCwd = checkoutExists ? info.path : info.repoRoot || info.path;
    if (!info.baseCommit)
        return markUnproven(payload, "no base_commit recorded — commit count unmeasurable", "commits");
    const counted = await run(["rev-list", "--count", `${info.baseCommit}..${info.branch}`], gitCwd);
    const commits = Number.parseInt(counted.stdout.trim(), 10);
    const countFailure = counted.code !== 0
        ? `rev-list exit ${counted.code}: ${counted.stderr.trim().slice(0, 200)}`
        : Number.isNaN(commits) ? "rev-list produced non-numeric output" : undefined;
    const status = checkoutExists
        ? await run(["status", "--porcelain", "--untracked-files=all", "--ignored=matching", "--ignore-submodules=none"], info.path)
        : undefined;
    const statusFailure = status && status.code !== 0 ? `status exit ${status.code}: ${status.stderr.trim().slice(0, 200)}` : undefined;
    if (!countFailure)
        payload.commits = commits;
    if (status?.code === 0)
        payload.dirty = Boolean(status.stdout.trim());
    if (countFailure || statusFailure) {
        return markUnproven(payload, [countFailure, statusFailure].filter(Boolean).join("; "), [countFailure && "commits", statusFailure && "dirty"].filter(Boolean).join("/"));
    }
    let forceRemove = false;
    if (checkoutExists) {
        if (payload.commits > 0 || payload.dirty)
            return payload;
        const head = await run(["symbolic-ref", "--quiet", "HEAD"], info.path);
        if (head.code !== 0 || head.stdout.trim() !== `refs/heads/${info.branch}`) {
            return markUnproven(payload, "HEAD is detached, switched, or unreadable", "checked-out commits");
        }
        const modules = await run(["submodule", "status", "--recursive"], info.path);
        if (modules.code !== 0)
            return markUnproven(payload, `submodule list exit ${modules.code}: ${modules.stderr.trim().slice(0, 200)}`, "dirty");
        forceRemove = modules.stdout.split("\n").some((line) => line && !line.startsWith("-"));
        if (forceRemove) {
            const nested = await run([
                "submodule", "foreach", "--recursive", "--quiet",
                "git status --porcelain --untracked-files=all --ignored=matching --ignore-submodules=none",
            ], info.path);
            if (nested.code !== 0)
                return markUnproven(payload, `submodule status exit ${nested.code}: ${nested.stderr.trim().slice(0, 200)}`, "dirty");
            if (nested.stdout.trim()) {
                payload.dirty = true;
                return payload;
            }
        }
        const rechecked = await run(["status", "--porcelain", "--untracked-files=all", "--ignored=matching", "--ignore-submodules=none"], info.path);
        if (rechecked.code !== 0)
            return markUnproven(payload, `final status exit ${rechecked.code}: ${rechecked.stderr.trim().slice(0, 200)}`, "dirty");
        if (rechecked.stdout.trim()) {
            payload.dirty = true;
            return payload;
        }
    }
    else if (payload.commits > 0)
        return payload;
    const cleanupCwd = info.repoRoot || info.path;
    const removed = await run(["worktree", "remove", ...(forceRemove ? ["--force"] : []), info.path], cleanupCwd);
    if (removed.code !== 0)
        return markUnproven(payload, `worktree remove exit ${removed.code}: ${removed.stderr.trim().slice(0, 200)}`, "cleanup");
    const deleted = await run(["update-ref", "-d", `refs/heads/${info.branch}`, info.baseCommit], cleanupCwd);
    if (deleted.code !== 0)
        return markUnproven(payload, `branch delete exit ${deleted.code}: ${deleted.stderr.trim().slice(0, 200)}`, "cleanup");
    payload.pruned = true;
    return payload;
}
/** Context block telling the child to work inside its isolated worktree. */
export function worktreeContextNote(info) {
    return `\n\n[WORKTREE ISOLATION] Work only in ${info.path} on ${info.branch}; do not use main checkout. Commit changes to this branch for parent review.`;
}
