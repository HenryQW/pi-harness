---
name: pi-pr-update-branch
description: Update the current pull-request branch with the exact revision of its base using a safe, non-rewriting merge.
---

# Pi PR Update Branch

Update only the attached branch for its current open pull request. This handles both a policy-required branch catch-up and a merge conflict.

## Guard and identify the pull request

Before changing anything:

1. Require an attached branch and a clean tree. Resolve the branch with `git symbolic-ref --quiet --short HEAD`; stop if it is empty. Then inspect `git status --porcelain=v1 --untracked-files=all` and stop for any staged, unstaged, untracked, unresolved, or in-progress operation. Never commit, clean, stash, or otherwise hide a dirty tree.
2. Resolve the local push repository from the branch's configured push remote. Do not assume a remote name. Stop if the branch has no unambiguous push remote or its repository cannot be identified.
3. Resolve exactly one open PR for this branch. Use `gh pr view --json number,state,baseRepository,baseRefName,headRepository,headRefName,headRefOid,mergeStateStatus,mergeable` in the checkout's GitHub context; for a fork checkout that cannot resolve it, search open PRs by the exact head repository owner and branch, then inspect each candidate. Require the candidate's `headRepository.nameWithOwner` and `headRefName` to match the local push repository and branch. Stop for none, more than one, a non-open PR, or any mismatch.
4. Record the PR number, `baseRepository.nameWithOwner`, `baseRefName`, `headRepository.nameWithOwner`, `headRefName`, and `headRefOid` from that PR. Set `EXPECTED_HEAD_SHA` to this initial `headRefOid` and never replace it with a later value. The pair `(base repository, base ref)` is the only target. Never infer it from a default branch, a local branch, or a remote-tracking ref. A forked head repository and a different base repository are normal.

## Fetch, pin, and merge

Resolve a clone URL for the recorded base repository, on the PR's GitHub host. Fetch that repository and ref first:

```bash
git fetch --no-tags "$BASE_REPOSITORY_URL" "refs/heads/$BASE_REF"
BASE_SHA="$(git rev-parse --verify 'FETCH_HEAD^{commit}')"
printf 'Fetched base %s %s at %s\n' "$BASE_REPOSITORY" "$BASE_REF" "$BASE_SHA"
```

If fetch or SHA resolution fails, stop. Preserve the printed `BASE_SHA`; it is authoritative for this run. Do not fall back to any local or remote-tracking ref.

Re-read the PR by its recorded number now, requesting the same JSON fields including `headRefOid`. Stop if its state, base repository/ref, head repository/ref, current-branch identity, or `headRefOid` differs from the recorded values. Immediately before merging, require the local `HEAD` to be exactly `EXPECTED_HEAD_SHA`:

```bash
LOCAL_HEAD="$(git rev-parse --verify HEAD)"
test "$LOCAL_HEAD" = "$EXPECTED_HEAD_SHA"
```

Stop if this check fails; never merge unpublished local commits. Merge the recorded SHA, never the branch name:

```bash
git merge --no-edit "$BASE_SHA"
```

A fresh `BEHIND` or branch-update-required PR status requires this merge even when GitHub reports no conflict. A conflict status follows the same merge path. Never rewrite history or hide changes: do not rebase, reset, force-push, auto-stash, or abort the merge.

## Conflict recovery

If the merge reports conflicts, keep the merge pending and list only unmerged paths:

```bash
git diff --name-only --diff-filter=U
```

Inspect one quoted path at a time. Find marker line numbers, then view a bounded window (for example, at most 40 lines on either side and 160 lines total); do not dump a repository-wide conflict diff:

```bash
grep -nE '^(<<<<<<<|=======|>>>>>>>)' -- "$PATH"
git diff --cc -- "$PATH" | sed -n '1,160p'
git show ":2:$PATH" | sed -n 'START,ENDp'
git show ":3:$PATH" | sed -n 'START,ENDp'
```

Resolve only clear intent: preserve unrelated base changes, combine compatible changes, and do not choose an entire side without understanding the hunk. Remove every marker, then `git add -- "$PATH"`. Resolve source files first. For lockfiles, indexes, build output, or other generated artifacts, run the repository's existing generator after its source inputs are resolved and stage the regenerated result; do not hand-merge generated output.

If the choice changes product behavior, an API, a data format, a migration, or another semantic contract and the intended winner is not clear, stop with the paths and alternatives. Leave the merge pending and ask the user; do not guess, continue, validate, or push.

When every conflict is resolved and staged, confirm no unmerged paths remain and continue the merge:

```bash
test -z "$(git diff --name-only --diff-filter=U)"
GIT_EDITOR=true git merge --continue
```

If a merge hook fails, fix the reported cause, stage any resulting changes, and run `git merge --continue` again. Do not bypass the hook.

## Validate and push once

After the merge completes:

1. Run the smallest existing validation relevant to the changed source and generated artifacts. Prefer a targeted test, typecheck, lint, or generator check; use the repository's dependency preflight when a check needs dependencies. Docs-only changes need only their narrow docs check. If validation fails, stop and report it; do not push.
2. Verify the exact fetched commit is present and the tree is clean:

   ```bash
   git merge-base --is-ancestor "$BASE_SHA" HEAD
   test -z "$(git status --porcelain=v1 --untracked-files=all)"
   ```

   Stop on either failure. Do not substitute a newer ref or another SHA.
3. Immediately before the single push, re-fetch the PR metadata by its recorded number with the same JSON fields, including `headRefOid`. Require the PR to remain open, its saved target and head repository/ref to remain unchanged, and its `headRefOid` to remain exactly `EXPECTED_HEAD_SHA`; stop if the PR head moved. Reconfirm the saved PR target and resolve the push remote's repository against the saved head repository. Stop if the push destination is not exact or any local-head check fails.
4. Push the current branch to the PR's exact head ref once, without force or retry:

   ```bash
   git push "$PUSH_REMOTE" "HEAD:$HEAD_REF"
   ```

A conflict, failed validation, failed ancestry check, changed PR target, or rejected push ends the workflow without a force push or a second push.
