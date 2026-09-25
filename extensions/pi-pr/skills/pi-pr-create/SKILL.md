---
name: pi-pr-create
description: Prepare and publish the current branch pull request with deterministic package helpers.
---

# Pi PR Create

Use only `pi_pr_create` for base selection, pending-work commits, Git and GitHub mutations. Do not reproduce its Git or GitHub checks with shell tools.

Call `prepare`. It selects one `branch.<branch>.gh-merge-base` value or the validated `origin` default branch and pins its OID. It rejects an in-progress Git operation, a head ref identical to the base, and a branch with neither an ahead commit nor ordinary pending work. Fork heads must share the base's GitHub source and host.

Call `inspect` to list pending paths. Review their changes and select the paths intended for this PR; exclude `.context/` and unrelated changes. If ownership is ambiguous, ask. Do not stash, discard, or hide unrelated changes. Call `commit` with reviewed paths and a scoped Conventional Commit message when pending work exists. The helper rejects an altered status or unrelated staged paths. If unrelated uncommitted work remains, stop and ask about ownership.

On a clean branch, call `verify`, then run relevant existing non-destructive validation before `push`. The base is **not** merged or rebased merely for being ahead of the branch. If validation fails, do not publish. `push` uses the captured exact lease and OID. Give `publish` a concise Conventional Commit title and a body with `Summary` and `Testing`. It validates the exact PR before no-target upstream setup. If setup fails after publication, retry `publish` with the same title and body; do not push or create the PR again. Reply with the validated PR URL. After successful publication, the active `/pr` rediscovers the new PR and continues to its next safe route; do not ask for a new `/pr` unless continuation stops.
