# Pi Deps

Pi Deps makes dependency preparation an explicit repository capability for future Git worktrees.

## Language

**Prepared worktree**:
New Git worktree whose supported root dependency environments start installing at creation and finish in the background; completion is signaled to consumers instead of blocking the creator.
_Avoid_: ready repo, initialized checkout

**Dependency environment**:
Installable package set governed by one supported root lockfile. One repository may contain both Node and uv dependency environments.
_Avoid_: dependency folder, package-manager cache

**Repository opt-in**:
Explicit repository state requesting dependency preparation for future worktrees, independent of which tool creates them.
_Avoid_: global enablement, Pi startup install
