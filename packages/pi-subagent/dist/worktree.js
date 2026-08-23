import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
const GIT_TIMEOUT_MS = 30_000;
const WORKTREES_DIRNAME = ".worktrees";
const BRANCH_NAMESPACE = "pi-subagent";
/** Runs git, capturing output; never throws on non-zero exit or spawn failure. */
const runGit = (args, cwd) => new Promise((resolve) => {
    execFile("git", args, { cwd, timeout: GIT_TIMEOUT_MS }, (error, stdout, stderr) => {
        resolve({
            code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
            stdout: String(stdout),
            stderr: String(stderr),
        });
    });
});
const sanitizeShortId = (childId) => childId.replace(/[^A-Za-z0-9._-]/g, "_") || randomBytes(4).toString("hex");
async function ensureGitignoreEntry(repoRoot) {
    const entry = `${WORKTREES_DIRNAME}/`;
    const gitignore = join(repoRoot, ".gitignore");
    try {
        const existing = await readFile(gitignore, "utf8").catch(() => "");
        if (existing.split("\n").some((line) => line.trim() === entry))
            return;
        await appendFile(gitignore, `${existing && !existing.endsWith("\n") ? "\n" : ""}${entry}\n`);
    }
    catch {
        // Best-effort: never fail launch over .gitignore.
    }
}
/**
 * Creates one worktree per child from parent HEAD. Returns undefined when the
 * workspace is not a git repository, HEAD is unborn, or creation fails —
 * callers degrade silently to the shared working directory.
 */
export async function createChildWorktree(cwd, childId, run = runGit) {
    const root = await run(["rev-parse", "--show-toplevel"], cwd);
    if (root.code !== 0 || !root.stdout.trim())
        return undefined;
    const repoRoot = root.stdout.trim();
    const name = `subagent-${sanitizeShortId(childId)}`;
    const branch = `${BRANCH_NAMESPACE}/${name}`;
    const path = join(repoRoot, WORKTREES_DIRNAME, name);
    try {
        await mkdir(join(repoRoot, WORKTREES_DIRNAME), { recursive: true });
        await ensureGitignoreEntry(repoRoot);
    }
    catch {
        return undefined;
    }
    const base = await run(["rev-parse", "HEAD"], repoRoot);
    const baseCommit = base.code === 0 ? base.stdout.trim() : "";
    const added = await run(["worktree", "add", path, "-b", branch, "HEAD"], repoRoot);
    if (added.code !== 0)
        return undefined;
    return { path, branch, repoRoot, baseCommit };
}
/** Flags a payload whose state could not be measured (#88113): unmeasured is not zero. */
function markUnproven(payload, reason, unmeasured = "commits/dirty") {
    payload.inspection_failed = true;
    payload.note =
        `git inspection failed (${reason}): ${unmeasured} UNKNOWN — not proven zero/clean. `
            + `The worktree and branch were preserved — inspect ${payload.path} (branch ${payload.branch}) before assuming no work.`;
    return payload;
}
/**
 * Inspects and possibly prunes a child worktree after it finishes. A worktree
 * with zero commits and a clean tree is removed only when both probes exited
 * zero and base_commit was recorded; any probe failure keeps everything and
 * reports `inspection_failed` so unmeasured state is never read as empty.
 */
export async function finalizeChildWorktree(info, run = runGit) {
    const payload = { path: info.path, branch: info.branch, commits: 0, dirty: false, pruned: false };
    if (!existsSync(info.path)) {
        payload.pruned = true; // nothing on disk to review
        return payload;
    }
    if (!info.baseCommit)
        return markUnproven(payload, "no base_commit recorded — commit count unmeasurable", "commits");
    const counted = await run(["rev-list", "--count", `${info.baseCommit}..HEAD`], info.path);
    const status = await run(["status", "--porcelain"], info.path);
    const failed = [];
    const unmeasured = [];
    if (counted.code === 0) {
        const commits = Number.parseInt(counted.stdout.trim(), 10);
        if (Number.isNaN(commits)) {
            failed.push("rev-list produced non-numeric output");
            unmeasured.push("commits");
        }
        else
            payload.commits = commits;
    }
    else {
        failed.push(`rev-list exit ${counted.code}: ${counted.stderr.trim().slice(0, 200)}`);
        unmeasured.push("commits");
    }
    if (status.code === 0)
        payload.dirty = Boolean(status.stdout.trim());
    else {
        failed.push(`status exit ${status.code}: ${status.stderr.trim().slice(0, 200)}`);
        unmeasured.push("dirty");
    }
    if (failed.length)
        return markUnproven(payload, failed.join("; "), unmeasured.join("/"));
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
export function worktreeContextNote(info) {
    return "\n\n[WORKTREE ISOLATION] You are working in an isolated git worktree "
        + `at: ${info.path}\n`
        + `Your dedicated branch is: ${info.branch}\n`
        + "All file edits and shell commands must happen inside this worktree directory "
        + "(your terminal already starts there). Do NOT cd to the main repository checkout. "
        + "Commit your changes to your branch when done; the parent agent will review and merge your branch. "
        + "If you make no commits and leave the tree clean, the worktree is discarded automatically.";
}
