---
name: pi-subagent-delegated-development
description: Orchestrate bounded implementation with isolated implementers and exact read-only review before integration.
---

# Delegated Development

You are Main: slice, delegate, gate, and integrate. Never implement child work yourself or use external model APIs/CLIs.

## Preconditions

Before delegation and immediately before integration, require a committed `HEAD` and an entirely clean Main worktree:

```bash
git rev-parse --verify -q HEAD^{commit} >/dev/null &&
test -z "$(git status --porcelain=v1 --untracked-files=all)"
```

Stop on failure; never stash, discard, or hide user changes. Built-in `implementer` must retain worktree isolation and `reviewer` must remain read-only; reject user overrides that weaken either contract.

## Slice

Use the fewest cohesive units. Parallelize only units expected to commute and own non-overlapping files and invariants; otherwise combine or sequence them. Record Main's base before launching each wave.

## Implement

Call `delegate_task` with `implementer`. Give each unit its objective, owned scope, exclusions, acceptance criteria, validation, and base. Require all intended changes and tests committed in the retained worktree.

Use `delegate_task`'s structured worktree result instead of asking the child to repeat path, branch, base, or cleanliness evidence. Reject missing, dirty, uncommitted, moved, or non-descendant results.

## Gate and integrate

Process completed units in declared order:

1. Resolve the retained branch tip and changed paths once. Verify its worktree is clean and its complete `base..tip` range contains the intended change.
2. If Main no longer equals that base, replay the complete range onto current clean Main in a fresh candidate worktree. Never merge an earlier raw parallel tip into a changed Main.
3. Run the unit validation only when replay produced a new candidate state. Do not repeat validation after an exact fast-forward of the same tree.
4. Generate the exact binary `base..tip` patch once into a private temporary file using `git diff --no-textconv --no-ext-diff --ignore-submodules=none --binary`. Hash the stored bytes and record `{path, bytes, sha256}`; never inline patch contents in a task or argv.
5. Call `delegate_task` with `reviewer`, supplying requirements, resolved base/tip, context `{type:'child_branch', branch}`, changed paths, and the patch reference. Integrate only `PASS` with zero findings.
6. Recheck clean Main at the reviewed base, then `git merge --ff-only` the full reviewed tip OID—not a branch name.
7. Remove the patch, then non-forcibly remove the integrated worktree and delete its branch with `git branch -d`. Preserve evidence on any failure.

## Findings and failures

Allow one fresh repair Implementer per unit. Give it the original requirements, exact source range, findings or failure, and current Main base. The repair must produce a clean committed replacement that receives fresh validation and exact review. If repair fails, stop; never loop, guess conflict resolutions, or reuse an old verdict.

Never bypass review, mutate a child worktree, push, publish, release, or open a pull request without explicit authorization.
