---
name: pi-pr-update-branch
description: Update the current pull-request branch with the exact revision of its base using a safe, non-rewriting merge.
---

# Pi PR Update Branch

Update only the attached branch for its current open pull request. This handles both a policy-required branch catch-up and a merge conflict.

## Guard and identify the pull request

Before changing anything:

1. Require an attached branch and a clean tree. Save `git symbolic-ref --quiet --short HEAD` as `LOCAL_BRANCH`; it is checkout identity only. Inspect `git status --porcelain=v1 --untracked-files=all` and stop for any staged, unstaged, untracked, unresolved, or in-progress operation. Never commit, clean, stash, or hide a dirty tree.
2. Read `LOCAL_BRANCH`'s validated `%(push:short)` with `git for-each-ref` and enumerate configured remote names. Match an exact `<remote>/` prefix, choosing the unique longest match so remote names containing `/` work. Save that remote and the remaining ref as `PUSH_REMOTE` and `PUSH_REF`, then validate `PUSH_REF` with `git check-ref-format --branch`. Require one push URL and validate its GitHub host and owner/repository. Do not use `%(push:remoteref)` or fall back to `LOCAL_BRANCH`.
3. Set `PR_FIELDS=number,url,state,baseRefName,baseRefOid,headRepository,headRefName,headRefOid,mergeStateStatus,mergeable`. On the push target's host, search open pull requests by the exact push owner and `PUSH_REF`. Inspect every candidate by its URL with exactly `PR_FIELDS`; stop for incomplete, capped, duplicate, or ambiguous results. Never use branch-default `gh pr view` or retry with `LOCAL_BRANCH`.
4. Require exactly one open PR. Require its HTTPS URL to be exactly `HOST/OWNER/REPOSITORY/pull/NUMBER`, with no credentials, port, query, or fragment, and require its number to match. The URL gives the base host and repository. Require `headRepository.nameWithOwner` and `headRefName` to match the recorded push repository and `PUSH_REF`. Require local `HEAD` to equal `headRefOid`. Record the PR and its base/head repositories, refs, and full OIDs. Set `EXPECTED_HEAD_SHA` and `BASE_SHA` from the initial head and base OIDs; never replace them. A fork head and upstream base are normal.

## Fetch, pin, and merge

Read only the documented `clone_url` field from the repository REST API on the validated PR host. Validate that URL against the recorded host and owner/repository. Fetch the recorded base OID without writing shared fetch state:

```bash
BASE_REPOSITORY_URL="$(gh api --hostname "$PR_HOST" \
  -H 'Accept: application/vnd.github+json' \
  -H 'X-GitHub-Api-Version: 2022-11-28' \
  "repos/$BASE_REPOSITORY" --jq .clone_url)"
git fetch --no-write-fetch-head --no-tags --no-recurse-submodules "$BASE_REPOSITORY_URL" "$BASE_SHA"
git cat-file -e "$BASE_SHA^{commit}"
printf 'Fetched base %s %s at %s\n' "$BASE_REPOSITORY" "$BASE_REF" "$BASE_SHA"
```

If API lookup, URL validation, fetch, or object verification fails, stop. The recorded `BASE_SHA` is authoritative for this run. Do not fall back to any local or remote-tracking ref.

Before merging, require the attached branch to remain `LOCAL_BRANCH` and the tree to remain clean. Re-resolve its configured push target exactly as above and require the saved remote, `PUSH_REF`, sole push URL, host, and repository. Re-read the PR by its recorded URL with exactly `PR_FIELDS`; require its number, URL, open state, base repository/ref/OID, head repository, `PUSH_REF`, and head OID to remain unchanged. Immediately before merging, require local `HEAD` to equal `EXPECTED_HEAD_SHA`:

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

   Stop on either failure. Record the validated full local `HEAD` as `MERGED_HEAD`. Do not substitute a newer ref or another SHA.
3. Immediately before the single push, repeat the complete branch, configured push target, sole push URL, and recorded-URL PR guard used before merging. Require all saved identities and PR fields to remain exact, the tree to be clean, and local `HEAD` to equal `MERGED_HEAD`. Stop on any change.
4. Push once to the saved configured push ref, without force or retry:

   ```bash
   git push --recurse-submodules=no "$PUSH_REMOTE" "$MERGED_HEAD:$PUSH_REF"
   ```

A conflict, failed validation, failed ancestry check, changed PR target, or rejected push ends the workflow without a force push or a second push.
