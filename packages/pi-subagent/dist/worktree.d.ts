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
export type GitRunner = (args: string[], cwd: string) => Promise<{
    code: number;
    stdout: string;
    stderr: string;
}>;
/**
 * Creates one worktree per child from parent HEAD. Returns undefined when the
 * workspace is not a git repository, HEAD is unborn, or creation fails —
 * callers degrade silently to the shared working directory.
 */
export declare function createChildWorktree(cwd: string, childId: string, run?: GitRunner): Promise<WorktreeInfo | undefined>;
/**
 * Inspects and possibly prunes a child worktree after it finishes. A worktree
 * with zero commits and a clean tree is removed only when both probes exited
 * zero and base_commit was recorded; any probe failure keeps everything and
 * reports `inspection_failed` so unmeasured state is never read as empty.
 */
export declare function finalizeChildWorktree(info: WorktreeInfo, run?: GitRunner): Promise<WorktreePayload>;
/** Context block telling the child to work inside its isolated worktree. */
export declare function worktreeContextNote(info: WorktreeInfo): string;
