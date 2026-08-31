# Route `/pr` by current condition

## Decision

`/pr` is one argument-free PR workflow router. It is not a browser opener, workflow menu, or family of action commands. Each invocation reads fresh remote and local state, derives one `PR next step`, runs at most one route, and stops. The footer and widget use the same priority for presentation, but fresh command state is authoritative. Direct merging happens only after final confirmation and a fresh readiness check.

A branch without a current-branch pull request, including a missing upstream push target, selects pull-request creation. For an existing pull request, the first matching condition wins:

1. Merged, closed, or draft: no action.
2. Required base update or merge conflict: run the branch-update workflow against the exact pull request base.
3. Changes requested or unresolved review threads: run the package comment-sweep workflow.
4. CI failure: run the package CI-fix workflow.
5. Running CI, pending review, blocked merge policy, dirty worktree, local commits ahead or diverged, or another unavailable action: no action.
6. Merge-ready: ask for final confirmation, then merge directly.

Ordinary conversation comments neither select a route nor block merging. Only changes requested and unresolved review threads count as blocking PR feedback.

Current-branch discovery searches the exact push repository and ref, then validates the candidate's URL and exact head repository and ref. This finds a fork-head PR whose base is an upstream repository without selecting an unrelated PR. The selected push remote must have exactly one push URL matching the head repository and hostname.

When creation is selected, the bundled workflow pushes `HEAD` to `origin` and sets the upstream when absent before creating or updating the PR.

## Boundaries

Presentation polling never starts a workflow or auto-triages comments. The router does not open a browser, invoke `/done` or `/sweep`, enable auto-merge or a merge queue, rebase the local branch, force-push, delete branches, or clean up worktrees. A single invocation never chains into another route.

Before merging, the local safety check validates the PR head repository as the fetch remote, fetches the head, and rejects an OID mismatch. The comment-sweep workflow resolves its helper and references from the effective package skill path. It needs no external `jq` executable. Before a sweep push, it revalidates the full PR identity: number, URL, hostname, base repository/ref/OID, and head repository/ref/OID. Any mismatch stops the push. Each PR hostname selects its GitHub API host. Only authenticated GitHub.com and GitHub Enterprise repositories are supported.

## Consequences

The public interaction stays small: one command shows or runs the current highest-priority next step. The footer and widget can briefly lag between 30-second refreshes, while `/pr` avoids acting on that stale presentation. Exact-base, non-rewriting branch updates and confirmed direct merges keep mutations bounded and observable.
