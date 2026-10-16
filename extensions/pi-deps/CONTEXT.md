# Pi Deps

Pi Deps prepares dependencies when Git creates a worktree in a repository that opted in.

## Language

**Prepared worktree**:
A new Git worktree admitted to dependency preparation. Its installs can still be running; the term does not prove that dependencies are ready.
_Avoid_: ready repo, initialized checkout

**Dependency environment**:
An installable package set governed by a supported root lockfile. A repository can have both Node and uv dependency environments.
_Avoid_: dependency folder, package-manager cache

**Repository opt-in**:
An explicit local choice to prepare dependencies for future worktrees through the repository's shared Git checkout hook.
_Avoid_: global enablement, Pi startup install

**Preparation outcome**:
The running, successful, or failed state of background dependency installation for one worktree, separate from completion of worktree creation.
