# Pi Herdr Done

Pi Herdr Done ends completed worktree work through Herdr, with destructive cleanup requiring explicit force.

## Language

**Worktree completion**:
Explicit end of a Pi task that removes its linked Git worktree checkout and closes only its own Herdr tab, preserving sibling tabs in the same workspace. Dirty checkout removal requires explicit force.
_Avoid_: workspace removal, Pi exit, implicit forced cleanup
