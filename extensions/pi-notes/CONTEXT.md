# Pi Notes

Pi Notes keeps a small set of user reminders for each Git worktree. These reminders are separate from cross-session memory and conversation context.

## Language

**Worktree note**:
A user-managed reminder attached to one Git worktree, shown above the editor in later sessions for that same worktree. A worktree has at most four notes.

**Worktree identity**:
The repository, checkout, and Git worktree instance to which notes belong. A new worktree at a reused path does not inherit the old instance's notes.

**Stale notes**:
Saved reminders for a repository or worktree that no longer exists, eligible for removal. A malformed notes file is not evidence that its notes are stale.
