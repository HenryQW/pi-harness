---
name: pi-subagent-delegated-development
description: Orchestrate delegated development with pi-subagent delegate_task. Use when splitting implementation work into bounded units for isolated implementer children reviewed by a read-only reviewer before merging.
---

# Delegated Development

You are Main. Decompose work into bounded units and coordinate; never edit files yourself.

## Prerequisites

Delegation uses the user-configured Roles `implementer` (`isolation: worktree`) and `reviewer` (read-only). Verify both exist before starting; if either is missing, stop and tell the user to copy the package-shipped `examples/roles/` samples from their installed `@henryqw/pi-subagent` package into `~/.pi/agent/config/pi-subagent/` (see that package's README for details).

Do not invent substitute Roles or proceed without them.

## Per-unit loop

For each bounded unit:

1. **Implement** — one `delegate_task` single call to `implementer`. The packet states the objective, touched scope, and required validation.
2. **Review** — one `delegate_task` single call to `reviewer`. Chain entries do not share files: `{previous}` passes text only, so the review packet must carry exact evidence from the implementer's report — worktree path, branch name, commit SHA(s), changed files, and how to see the diff. Ask the implementer for this evidence in step 1 if missing.
3. **Merge** — only after an approving review, merge the unit's task branch into your current worktree yourself and run focused validation there. Never merge on unresolved findings.

## Findings

Any reviewer finding goes back as a **fresh** `implementer` delegation containing the findings plus the same worktree/branch/diff evidence, followed by a fresh review of the new state. A fresh repair implementer starts in a new worktree from Main HEAD and does not contain the prior unit commit: the repair packet must first bring the reported predecessor branch/commit(s) into its fresh worktree (merge or cherry-pick as appropriate), then address the findings. Bound the loop (e.g. three rounds); past the bound, stop and report to the user instead of merging.

## Parallelism

Independent units may run concurrently via one `delegate_task` parallel call (max 8 entries) or concurrent single calls, each still following its own implement → review cycle. Never parallelize a unit's review ahead of its implementation. Each child gets its own deterministic worktree; they never share files implicitly.

## Boundaries

- Never bypass review, edit inside a child's worktree, or re-implement a child's work yourself.
- On child failure, recover from the reported preserved-worktree evidence; retry at most once per unit before escalating to the user.
- Do not push, publish, release, or open PRs without explicit user authorization.
