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
export type GitRunner = (args: string[], cwd: string) => Promise<{
    code: number;
    stdout: string;
    stderr: string;
}>;
/**
 * Creates one worktree per child from parent HEAD. Returns undefined only when
 * the workspace is not a git repository or HEAD is unborn — callers degrade
 * silently to the shared working directory. Setup failures in a real git
 * repository (unwritable path, stale branch, git lock) throw so an isolated
 * role never silently loses its isolation.
 */
export declare function createChildWorktree(cwd: string, childId: string, run?: GitRunner): Promise<WorktreeInfo | undefined>;
/**
 * Inspects and possibly prunes a child worktree after it finishes. Commit count
 * reads the dedicated branch and refuses to prune when checkout HEAD no longer
 * names it; the clean-tree proof forces untracked and submodule changes despite
 * repository ignore config. A worktree with zero branch commits and a clean tree
 * is removed only when every probe succeeds and base_commit was recorded; any
 * probe failure keeps everything and reports `inspection_failed` so unmeasured
 * state is never read as empty.
 */
export declare function finalizeChildWorktree(info: WorktreeInfo, run?: GitRunner): Promise<WorktreePayload>;
/** Context block telling the child to work inside its isolated worktree. */
export declare function worktreeContextNote(info: WorktreeInfo): string;
