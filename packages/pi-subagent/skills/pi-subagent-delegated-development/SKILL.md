---
name: pi-subagent-delegated-development
description: Orchestrate delegated development with pi-subagent delegate_task. Use when splitting implementation work into bounded units for isolated implementer children reviewed by a read-only reviewer before merging.
---

# Delegated Development

You are Main. Decompose work into bounded units and coordinate; never edit files yourself.

All model and agent work in this workflow goes through Pi's `delegate_task` and Pi-managed children. Do not invoke external LLM APIs, SDKs, agent harnesses, or model CLIs; ordinary deterministic developer tools such as `git`, npm, test runners, and compilers remain allowed.

## Required preflight

Before any delegation, require that Main's cwd is a Git working tree with a committed `HEAD`:

```bash
test "$(git rev-parse --is-inside-work-tree)" = true &&
git rev-parse --verify -q HEAD^{commit} >/dev/null
```

If this fails, stop before delegation and report that this Skill requires a Git repository with a committed `HEAD`; do not rely on the generic worktree fallback to Main's cwd.

Before recording each unit's `base=$(git rev-parse HEAD)`, and again immediately before integration and validation, require `git status --porcelain=v1 --untracked-files=all` to be empty. If Git cannot inspect status or any tracked or untracked change is present, stop and ask the user to preserve the changes; never stash, discard, hide, or work around them.

## Roles

The package-shipped built-in Roles `implementer` (`isolation: worktree`) and `reviewer` (read-only patch-and-file review) are always available; no installation step is required. A same-name user override replaces the built-in entirely. Before using this workflow, Main must verify that each override preserves implementer worktree isolation and reviewer read-only patch-and-file constraints; fail clearly if it does not. Do not invent substitute Roles.

## Per-unit loop

For each bounded unit:

1. **Implement** — one `delegate_task` single call to `implementer`. The packet states the objective, touched scope, required validation, and recorded base commit. Require its output to identify the retained worktree path, branch, base commit, tip commit, changed files from the base-to-tip committed diff, and clean `git status --porcelain=v1 --untracked-files=all` result.
2. **Verify and review** — refuse review or merge unless Main independently verifies that the worktree was retained and is clean (including untracked files), the reported base/branch/tip identities are complete and match Git, the tip is descended from the recorded base, and the reported changed files equal `git diff --name-only "$base" "$tip"`. All intended changes must be in that committed base-to-tip diff. If any evidence is missing or any check fails, send the work to a fresh implementer repair; never review dirty or uncommitted work.

   Create a private temporary exact-patch artifact outside the repository from `git diff --binary "$base" "$tip"`. Independently regenerate that diff and byte-compare it with the artifact, then record its path, byte count, and SHA-256. If creation, regeneration, comparison, byte count, or checksum fails, stop and report the artifact failure clearly; do not review or merge. Do not put any complete patch content in `delegate_task` text or argv.

   Make one `delegate_task` single call to `reviewer` with only a bounded metadata packet: base, tip, review context `{type:'child_branch', branch}`, the verified complete patch file reference (`path`, `bytes`, `sha256`), and the verified changed paths. If that complete metadata cannot fit the task transport bound, stop and report it rather than truncating or inlining patch content. Chain entries do not share files: `{previous}` passes text only.
3. **Merge** — only after an approving review, re-check Main's clean status, verify the branch tip still equals the reviewed tip commit, then merge that exact commit (not the branch name) into Main's current worktree and run focused validation there. Never merge on unresolved findings.
4. **Clean up after success** — only after the exact reviewed tip is integrated and focused validation passes, remove each reported retained worktree, then safely delete its task branch. Include a superseded repair-round worktree only when its exact tip is an ancestor of integrated `HEAD`. For each candidate, verify ancestry first, use non-forced worktree removal followed by `git branch -d`, and stop/report cleanup failure without deleting later evidence. On any integration or validation failure, preserve every temporary patch artifact, retained worktree, and task branch for recovery. After integration and validation succeed, remove the temporary reviewer patch artifacts.

## Findings

Any reviewer finding goes back as a **fresh** `implementer` delegation containing the findings plus the reviewed base/branch/tip identities and complete exact patch file reference, followed by a fresh review of the new state. A fresh repair implementer starts in a new worktree from Main HEAD and does not contain the prior unit commit: the repair packet must first bring the reported predecessor commit into its fresh worktree (merge or cherry-pick as appropriate), then address the findings. Dirty or uncommitted work also goes only to this fresh repair path. Bound the loop (e.g. three rounds); past the bound, stop and report to the user instead of merging.

## Parallelism

Independent units may run concurrently via one `delegate_task` parallel call (max 8 entries) or concurrent single calls, each still following its own implement → review cycle. Never parallelize a unit's review ahead of its implementation. Each child gets its own deterministic worktree; they never share files implicitly.

## Boundaries

- Never bypass review, edit inside a child's worktree, or re-implement a child's work yourself.
- On child failure, recover from the reported preserved-worktree evidence; retry at most once per unit before escalating to the user.
- Do not push, publish, release, or open PRs without explicit user authorization.
