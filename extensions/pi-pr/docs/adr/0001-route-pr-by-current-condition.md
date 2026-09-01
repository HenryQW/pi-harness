# Route `/pr` by current condition

## Decision

`/pr` is one argument-free PR workflow router. It is not a browser opener, workflow menu, or family of action commands. Each invocation reads fresh remote and local state, derives one `PR next step`, runs at most one route, and stops. The footer and widget use the same priority for presentation, but fresh command state is authoritative. Direct merging happens only after final confirmation and a fresh readiness check.

A branch without a current-branch pull request, including a missing upstream push target, selects pull-request creation. For an existing pull request, the first matching condition wins:

1. Merged, closed, or draft: no action.
2. Required base update or merge conflict: run branch update only when the tree is clean and local HEAD equals the PR head. Otherwise, stop with no action.
3. Changes requested or unresolved review threads: run comment sweep under the same local prerequisite. Otherwise, stop with no action.
4. CI failure: run CI fix under the same local prerequisite. Otherwise, stop with no action.
5. Running CI, pending review, blocked merge policy, or unsafe local merge state: no action.
6. Merge-ready: allow a clean local HEAD equal to or behind the PR head. Ask for final confirmation, then merge directly.

Ordinary conversation comments neither select a route nor block merging. Only changes requested and unresolved review threads count as blocking PR feedback. Draft presentation outranks running CI.

Current-branch discovery searches the exact push repository and ref. It validates each candidate's URL, head repository, and head ref. It preserves the sole validated push URL as fetch authority, separate from repository identity. An open PR must match the exact remote push-ref OID. Without an open PR, one historical candidate must match that OID. Discovery never falls back to local HEAD when the remote ref is absent.

When creation is selected, the bundled workflow honors an existing configured push target. It pushes a captured OID to that exact remote and ref. Without a target, it uses `origin` and the local branch ref, then sets upstream. PR discovery and creation use the exact head owner and ref.

## Boundaries

Presentation polling never starts a workflow or auto-triages comments. The router does not open a browser, invoke `/done` or `/sweep`, enable auto-merge or a merge queue, rebase the local branch, force-push, delete branches, or clean up worktrees. A single invocation never chains into another route.

Presentation and merge safety fetch the exact advertised PR head OID from the validated push URL. Fetches use `--no-write-fetch-head` and never read `FETCH_HEAD`. Merge safety resolves Git operation-state paths through Git, so linked worktrees also block in-progress merge, rebase, cherry-pick, revert, and sequencer operations. Legacy branch protection and applicable repository rulesets both provide strict-status authority. A strict result from either requires a base update; malformed or unauthorized results fail visibly. The same fully paginated ruleset read provides merge-method authority. Every applicable restriction intersects repository-wide enabled methods.

Branch update derives the exact base host and repository from the validated public PR URL. It uses supported public base ref and OID fields. The comment sweep resolves its helper and references from the effective package skill path. It needs no external `jq` executable. Before pushing, it revalidates the configured destination, full PR identity, and local HEAD. It pushes the captured OID once without fallback. A PR head already equal to local HEAD needs no push. Snapshot head equality remains required when a push is still needed. Each PR hostname selects its GitHub API host. Only authenticated GitHub.com and GitHub Enterprise repositories are supported.

## Consequences

The public interaction stays small: one command shows or runs the current highest-priority next step. The footer and widget can briefly lag between 30-second refreshes, while `/pr` avoids acting on that stale presentation. Exact-base, non-rewriting branch updates and confirmed direct merges keep mutations bounded and observable.
