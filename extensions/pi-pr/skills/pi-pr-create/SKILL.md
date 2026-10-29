---
name: pi-pr-create
description: Prepare and publish the current branch pull request with deterministic package helpers.
---

# Pi PR Create

Use the supplied `projectPath` on every `pi_pr_create` call, and on any `pi_git_commit` or `git_conflict` call. It is the pinned canonical worktree root. Use that directory for file inspection, edits, and checks. Pi can start in a non-Git parent; do not use the session directory or select a sibling repository. A changed path does not grant new workflow authority.

Use only `pi_pr_create` for base selection, pending-work commits, Git and GitHub mutations. Do not reproduce its Git or GitHub checks with shell tools.

Use only the `runId` reserved in this session. If publication will be delegated, delegate before starting a workflow. Pass the authorized work scope, explicit base intent, and repository-local upstream consent, not the parent's `runId`. The child calls `pi_git_pr` and follows its own same-session skill handoff. An active parent workflow stays parent-owned; do not publish concurrently from parent and child. A foreign or stale run identifier (ID) is a blocker; do not start another workflow automatically. If this session's run ended at ordinary settlement, use a fresh `pi_git_pr` entry only when the same user authorization still applies. It must pass recovery checks. After failure or cancellation, inspect the result and recovery journal first; never replay an uncertain action.

Call `prepare`, then continue the route steps below in this run. Preparation is not completion; do not end the turn after it unless a blocker needs user input. It selects one `branch.<branch>.gh-merge-base` value or the validated `origin` default branch and pins its object identifier (OID). It rejects an in-progress Git operation, a head ref identical to the base, and a branch with neither an ahead commit nor ordinary pending work. Fork heads must share the base's GitHub source and host.

Call `inspect` to list pending paths. Review their changes and select the paths intended for this PR; exclude `.context/` and unrelated changes. If ownership is ambiguous, ask. Do not stash, discard, or hide unrelated changes. Call `commit` with reviewed paths and a scoped Conventional Commit message when pending work exists. The helper rejects an altered status or unrelated staged paths. If unrelated uncommitted work remains, stop and ask about ownership.

On a clean branch, call `verify`, then run relevant existing non-destructive validation before `push`. The base is **not** merged or rebased merely for being ahead of the branch. If validation fails, do not publish. `push` uses the captured exact lease and OID. Give `publish` a concise Conventional Commit title and a body with `Summary` and `Testing`. It validates the exact PR before no-target upstream setup. If setup fails after publication, retry `publish` with the same title and body; do not push or create the PR again. Report the validated PR URL. For a direct worker, keep the required JSON completion object and put the URL in its `answer`; do not reply with only a plain URL. After successful publication, the active `/pr` rediscovers the new PR and continues to its next safe route; do not ask for a new `/pr` unless continuation stops.
