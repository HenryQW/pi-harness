---
name: update-from-main
description: Safely sync attached non-`main` worktree branch with fetched `origin/main`. Use when asked to update, merge, or bring main into current branch.
---

# update-from-main

<!-- SPDX-License-Identifier: Apache-2.0. Derived from HenryQW/skills; modified for pi-pr exact backup identity, worktree ownership, and retained recovery. See ../../NOTICE.md for source identity and changes. -->

Run `python3 <skill>/scripts/update_from_main.py` once from the target worktree. Use this file's directory for `<skill>`. Requires Python 3.9 or newer and Git with `fetch --porcelain`. This is a standalone **merge**, not the `/pr` rebase route. The helper fetches before worktree mutation, backs up tracked/untracked state plus ignored paths when they collide, and merges the exact `main` OID captured from fetch output. It does not push or use GitHub. Before it stashes, the helper records ownership in this worktree's per-worktree ref. A retained backup blocks another run in its own worktree, also after a branch switch, but not in other worktrees. The instructions below are the single recovery guide.

## Fast path

For `status=merged` or `status=up_to_date`, report emitted line, run:

```bash
git status --short --branch
git diff --check <emitted-before-sha> HEAD
```

If `stash` is non-`none`, restoration used that exact OID and kept the backup. Report the OID even on success. A later run in this worktree stays blocked until the user verifies staged, unstaged, untracked, and applicable ignored bytes, then explicitly asks to [complete recovery](#complete-recovery). Never pop or drop a mutable stash stack entry automatically.

Stop. No tests, install, history scan, push, extra commit, or helper rerun.

## Recovery

Emitted `main` SHA is authoritative for run. Do not rerun because `origin/main` advances. Never rerun while emitted stash remains retained; finish current recovery first.

- `status=merge_conflict`: resolve and `git add <paths>`; run `GIT_EDITOR=true git merge --continue`, then apply non-`none` stash with `git stash apply --index <oid>`.
- `status=merge_pending`: fix failed merge hook, run `GIT_EDITOR=true git merge --continue`, then apply non-`none` stash.
- `status=submodule_update_required`: run `git submodule update --checkout --recursive`, then apply non-`none` stash.
- `status=stash_conflict`: resolve and stage every emitted conflict path; retain and report stash OID.
- `status=stash_restore_failed`: retain and report stash OID. Inspect once with `git stash show --name-status --include-untracked <oid>`, restore clear changes, and ask user only when one upstream-path collision version must win. Never drop backup first.

After manual recovery, keep the backup and report its OID. A later update in this worktree stays blocked until the user verifies restoration and explicitly asks to complete recovery. Do not drop it automatically. If execution stops without a complete result, inspect HEAD, Git operation state, the stash, and `git for-each-ref refs/worktree/update-from-main/` before further action; do not rerun an uncertain mutation.

### Complete recovery

Only after the user verifies the restored bytes and explicitly asks, run in the owning worktree:

```bash
git update-ref -d refs/worktree/update-from-main/backup <oid>
```

This unblocks the worktree and keeps the stash entry. Drop that entry only on a separate explicit request, with no concurrent stash changes in any linked worktree. Re-find its `stash@{n}` by OID with `git stash list --format='%gd %H'` immediately before `git stash drop`; a concurrent push can change the selector and cause removal of another backup.

### Interrupted run

The helper error names `refs/worktree/update-from-main/pending/<token>` when a run stopped before it recorded its stash OID. Find this run's entry:

```bash
git stash list --format='%H %gs' | grep -F 'update-from-main owned <token>'
```

- One entry: record it, remove the pending ref, then restore its exact OID. If `apply` fails, continue as `stash_restore_failed`.

  ```bash
  git update-ref refs/worktree/update-from-main/backup <oid> ""
  git update-ref -d refs/worktree/update-from-main/pending/<token>
  git stash apply --index <oid>
  ```

- No entry: stop and retain the pending ref. Absence does not prove that Git left the worktree unchanged; another session can remove a shared stash entry. Inspect the stash reflog and local state. Only after the user verifies all expected staged, unstaged, untracked, and applicable ignored bytes and explicitly asks to complete recovery, run `git update-ref -d refs/worktree/update-from-main/pending/<token>`. If the expected state cannot be verified, keep the ref and ask the user.
- More entries, or a `backup` ref is also present: stop and ask the user.

### Legacy backup

A stash entry with subject `update-from-main` or `update-from-main <uuid>` came from a helper without worktree ownership. It blocks every worktree until its owner adopts it or the user explicitly drops it. Ask the user to confirm the owner: the worktree that created it (the stash subject names its branch), or, if that worktree is gone, the worktree where they will verify recovery. In the owner worktree, run:

```bash
git update-ref refs/worktree/update-from-main/backup <oid> ""
git update-ref refs/update-from-main/adopted/<oid> <oid> ""
```

The first command blocks the owner; the second unblocks other worktrees. Both keep the stash entry. Then verify or restore it with `git stash apply --index <oid>` as for `stash_restore_failed`, and complete recovery. Keep the shared `adopted` ref while the stash entry exists; delete it with `git update-ref -d refs/update-from-main/adopted/<oid> <oid>` only together with an explicitly requested drop of that entry.

Start conflict triage with emitted JSON conflict path list, then inspect marker line numbers one separately quoted path at a time:

```bash
git show --no-patch --oneline <emitted-main-sha>
grep -nE '^(<<<<<<<|=======|>>>>>>>)' -- '<one-conflict-path>'
```

Inspect bounded source regions around markers. Never dump full `git diff --cc` across files. Use bounded `git show :2:path | sed -n '<start>,<end>p'` and `git show :3:path | sed -n '<start>,<end>p'` only when hunk lacks context. Prefer upstream for unrelated changes; combine compatible overlapping behavior. Ask user only when intent cannot determine one required semantic winner.

Resolve source first. Regenerate lockfiles and build artifacts instead of reading generated conflicts. For docs/index conflicts, keep entries whose paths exist, add upstream paths, remove deleted paths, and avoid full-repo scans.

After recovery, verify exact source merged:

```bash
git merge-base --is-ancestor <emitted-main-sha> HEAD
git status --short --branch
```

Run only smallest relevant check; docs-only recovery gets docs-specific checks, not broad tests. Run project dependency preflight before dependency-backed checks. Redirect check output to temp file. On success report the command and at most 20 summary lines. On failure report at most 80 lines or 8 KiB of relevant errors. Never rebase, reset, abort, push, or commit unrelated work.
