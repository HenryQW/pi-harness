# Pi Herdr Done

Pi Herdr Done ends completed worktree work through Herdr, closing its workspace tabs while reserving explicit force for unsafe worktree removal.

## Language

**Worktree completion**:
Explicit end of a Pi task that removes its linked Git worktree checkout and closes every tab in its Herdr workspace. Dirty checkout removal or removal while another workspace uses the checkout requires explicit force.
_Avoid_: workspace removal, Pi exit, implicit forced cleanup
