# Pi Herdr Clone (retired)

This archive records conversation cloning and the worktree completion previously absorbed from [Pi Herdr Done](../pi-herdr-done/CONTEXT.md). The active replacement is [Pi Herdr Tools](../../extensions/pi-herdr-tools/CONTEXT.md).

## Language

**Active-path clone**:
A saved Pi session containing the original session's root-to-current-leaf path, without sibling branches. The original session remained active.
_Avoid_: session fork, full session copy

**Clone tab**:
A new Herdr tab that hosted an Active-path clone in the same working directory.
_Avoid_: worker tab, worktree tab

**Worktree clone**:
An Active-path clone in a fresh Herdr Git worktree workspace, with the new checkout as its working directory.
_Avoid_: branch clone, repo copy

**Ambiguous launch**:
A launch whose response could not prove whether Herdr created or started the target. Known tabs and session files remained for recovery.
_Avoid_: failed clone, cleanup failure

**Worktree completion**:
The explicit end of a Pi task that removed its linked checkout and closed its Herdr workspace tabs. Removal of a dirty checkout or one used by another workspace required explicit force.
_Avoid_: workspace removal, Pi exit, implicit forced cleanup
