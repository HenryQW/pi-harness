# Pi CodeGraph

Pi CodeGraph prepares a separate CodeGraph index for each Git checkout and keeps it current while Pi runs. CodeGraph owns code indexing and exploration; this extension owns worktree setup and Pi access.

## Language

**Primary index**:
The CodeGraph index in the repository's primary checkout. Its presence establishes repository opt-in for automatic linked-worktree setup.

**Worktree index**:
A CodeGraph index owned by one checkout, never a shared live database between worktrees.

**Seed index**:
A complete compatible index from the same repository that can be copied to start a new Worktree index. Synchronization then accounts for differences in the target checkout.

**Indexing consent**:
The user's permission to create a missing Primary index. A recorded decline prevents repeated prompts for that repository.

**Index status**:
The displayed state of checkout indexing: ready, missing, in progress, or blocked by prerequisites or setup failure.
