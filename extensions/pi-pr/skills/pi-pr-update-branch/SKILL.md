---
name: pi-pr-update-branch
description: Update the current pull-request branch with the exact revision of its base using a safe, non-rewriting merge.
---

# Pi PR Update Branch

Update only the attached branch for its current open pull request. This handles both a policy-required branch catch-up and a merge conflict.

## Guard and identify the pull request

Before changing anything:

1. Require an attached branch and a clean tree. Resolve the branch with `git symbolic-ref --quiet --short HEAD`; stop if it is empty. Then inspect `git status --porcelain=v1 --untracked-files=all` and stop for any staged, unstaged, untracked, unresolved, or in-progress operation. Never commit, clean, stash, or otherwise hide a dirty tree.
2. Resolve the local push repository from the branch's configured push remote. Do not assume a remote name. Require one push URL on that remote. Validate its GitHub host and owner/repository, and preserve that exact push URL. Stop if the branch has no unambiguous push target or its repository cannot be identified.
3. Set `PR_FIELDS=number,url,state,baseRefName,baseRefOid,headRepository,headRefName,headRefOid,mergeStateStatus,mergeable`. Resolve exactly one open PR for this branch with `gh pr view --json "$PR_FIELDS"`. For a fork checkout that cannot resolve it, search open PRs by the exact head repository owner and branch, then inspect each candidate by URL with the same fields. Require HTTPS and validate the URL as exactly `HOST/OWNER/REPOSITORY/pull/NUMBER`, with no credentials, port, query, or fragment. Require its number to match the URL. The URL gives the exact base host and repository. Require `headRepository.nameWithOwner` and `headRefName` to match the local push repository and branch. Stop for none, more than one, a non-open PR, or any mismatch.
4. Record the PR number and URL, URL-derived host and base repository, `baseRefName`, `baseRefOid`, `headRepository.nameWithOwner`, `headRefName`, and `headRefOid`. Validate both refs and both full OIDs. Set `EXPECTED_HEAD_SHA` to this initial `headRefOid` and `BASE_SHA` to this initial `baseRefOid`; never replace either with a later value. The base repository, ref, and OID are the only target. Never infer them from a default branch, local branch, remote-tracking ref, or unsupported `gh` field. A forked head repository and a different base repository are normal.

## Fetch, pin, and merge

Read only the documented `clone_url` field from the repository REST API on the validated PR host. Validate that URL against the recorded host and owner/repository. Fetch the recorded base OID without writing shared fetch state:

```bash
BASE_REPOSITORY_URL="$(gh api --hostname "$PR_HOST" \
  -H 'Accept: application/vnd.github+json' \
  -H 'X-GitHub-Api-Version: 2022-11-28' \
  "repos/$BASE_REPOSITORY" --jq .clone_url)"
git fetch --no-write-fetch-head --no-tags "$BASE_REPOSITORY_URL" "$BASE_SHA"
git cat-file -e "$BASE_SHA^{commit}"
printf 'Fetched base %s %s at %s\n' "$BASE_REPOSITORY" "$BASE_REF" "$BASE_SHA"
```

If API lookup, URL validation, fetch, or object verification fails, stop. The recorded `BASE_SHA` is authoritative for this run. Do not fall back to any local or remote-tracking ref.

Re-read the PR by its recorded URL now with exactly `PR_FIELDS`. Revalidate the URL-derived host/base repository and stop if its number, URL, state, base ref/OID, head repository/ref/OID, or current-branch identity differs from the recorded values. Immediately before merging, require the local `HEAD` to be exactly `EXPECTED_HEAD_SHA`:

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
3. Immediately before the single push, re-read the PR by its recorded URL with exactly `PR_FIELDS`. Revalidate its URL-derived host/base repository. Require the PR to remain open and its number, URL, base ref/OID, head repository/ref/OID, and current-branch identity to remain unchanged. Reconfirm the sole saved push URL against the saved head repository. Stop if the push destination is not exact or any local-head check fails.
4. Push the current branch to the PR's exact head ref once, without force or retry:

   ```bash
   git push "$PUSH_REMOTE" "HEAD:$HEAD_REF"
   ```

A conflict, failed validation, failed ancestry check, changed PR target, or rejected push ends the workflow without a force push or a second push.
