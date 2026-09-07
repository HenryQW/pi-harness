# Pi Auto DAG context

## Purpose

Run a validated dependency graph serially in the current managed Git workspace. Bind task and final acceptance to direct checks on exact workspace identities.

## Glossary

- **Request**: One immutable goal, commit policy, elapsed budget, ordered task graph, and final verification policy.
- **Task**: One Role-owned requirement with a deliverable, dependencies, direct checks, and optional judgment.
- **Ready Task**: A pending task whose declared dependencies are completed. The runner picks the first ready task in supplied order.
- **Workspace Identity**: Current branch, `HEAD`, real index tree, and a Git tree built from all tracked and non-ignored untracked contents through a temporary index. Repositories with submodules are rejected.
- **Attempt**: One launched worker child. A task permits at most two.
- **Correction**: A fresh second worker with original requirements, direct dependency outputs, prior failure evidence, and current workspace identity.
- **Judgment**: Optional explicit criterion reviewed by an explicit Role. No criterion means no Reviewer.
- **Request Acceptance**: Every task completed, every final check passed on the identified combined workspace, and any final judgment approved.
- **Needs Attention**: Durable pause requiring Main to choose a resume action. Interrupted work always enters this state and never replays automatically.

## Invariants

- `@henryqw/pi-subagent` owns Role loading, task-model route resolution, child launch policy, and recursive delegation exclusion.
- Auto DAG uses `createEphemeralSubagentExecutor({ maxConcurrency: 1 })` and runs every child in the same workspace.
- Checks execute as direct `{command, args}` calls through `pi.exec`. There is no shell command string.
- Worker output is context, not acceptance evidence.
- The real index tree identifies staging changes. A temporary index identifies all file contents without changing the real index or worktree.
- Checks and Reviewers must not mutate the identified workspace.
- State uses only the v9 schema under Auto DAG's Pi config home, namespaced by canonical workspace-root hash and request ID. Older state is rejected.
- One lifecycle lock and atomic state replacement prevent concurrent mutation.
- The runner does not own worktrees, merge integration, transport receipts, push, pull requests, or post-PR work.
