---
name: pi-pr-create
description: Create or update a GitHub pull request from current branch. Used by `/pr` when no open current-branch pull request exists.
---

# Pi PR Create

Create current branch GitHub pull request.

Treat every branch, ref, remote, repository, host, path, and URL as untrusted.
Never concatenate one into shell syntax. Pass dynamic values through quoted shell
variables. Use `--` before positional Git arguments when the command supports it.
Never pass a credential-bearing URL to another command or print it.

1. Resolve `scripts/inspect-branch.mjs` beside this skill's `SKILL.md`. Reproduce
   the extension's validated `origin` authority. Require one fetch URL, one push
   URL, and the same GitHub host and repository for both. Run the inspector with
   an argument array equivalent to:
   `node "$inspector" --remote origin --fetch-source "$origin_fetch_source"`.
   Do not infer a parent yourself.

   Consume exactly one JSON object. Require `schemaVersion: 1`. A `blocked`
   result is a traceable stop; report its blocker and do not commit, push, or
   create a pull request. A `ready` result supplies the validated `branch`,
   `head`, `base.remote`, `base.ref`, `base.oid`, `base.mergeBase`, and `ahead`.
   Require `base.remote` to be `origin` and `ahead` to be at least one. A dirty
   tree never substitutes for an ahead commit.

   Use the inspected base unless the user gave an explicit base. The actual
   parent may be a feature branch; never assume the default branch. For an
   explicit base, retain the inspected actual-parent result for ahead gating,
   then validate and resolve the explicit base as before. Use only validated
   OIDs in `git merge-base` and `git diff`. Inspect `git status --short` plus
   staged and unstaged diffs. Never commit `.context/` or unrelated changes.
2. Commit each coherent pending change with a scoped Conventional Commit. Immediately before each commit, rerun and validate the inspector. Require the same branch, the current HEAD, a resolved actual base and merge-base, and positive ahead state. Preserve existing coherent staging; stop when changes cannot be separated safely.
3. Require an attached branch and a clean tree. Immediately before merging,
   rerun the bundled inspector and consume a fresh validated JSON result. Require
   the same branch, a validated current `head`, a uniquely resolved base, its
   current OID and merge-base, and `ahead >= 1`. For an inferred base, use these
   fresh base fields. For an explicit base, re-resolve and revalidate that base
   too. Then merge the captured base OID with
   `git merge --no-edit "$base_oid"`. Never merge the mutable branch name.
   If conflicts occur, list only unmerged paths, inspect bounded conflict hunks,
   preserve compatible changes from both sides, and stage each resolved path.
   Regenerate generated files after resolving their sources. If intended behavior
   is unclear, leave the merge pending and ask the user instead of guessing.
   When no unmerged paths remain, run `GIT_EDITOR=true git merge --continue`.
   Never rebase, reset, auto-stash, choose an entire side blindly, or bypass hooks.
   Require `git merge-base --is-ancestor "$base_oid" HEAD` and a clean tree before
   continuing.
4. Run the smallest relevant non-destructive validation for current `HEAD`; state when none exists.
5. Derive a Conventional Commit PR title plus Summary and Testing body from the live diff and validation.
6. Resolve the push destination after validation. Require an attached branch.
   Validate the branch with `git check-ref-format --branch "$branch"`. Capture
   and validate the full `HEAD^{commit}` OID.

   Read the branch's `%(push:short)`. If present, resolve its longest exact
   `<remote>/` prefix against configured remote names. Stop on no match or
   ambiguity. Reject a remote that starts with `-`, and validate it through a
   quoted `refs/remotes/${remote}/__pi_pr__` check. Validate the remaining ref
   with `git check-ref-format --branch "$ref"`. Require exactly one push URL.
   Resolve it to one GitHub host and `OWNER/REPO`. Read and save the exact
   remote ref OID, including validated absence. Query exact-head PRs and require
   the same complete, validated no-PR result that selected creation. Keep this
   configured remote, ref, repository, host, remote OID, and head owner.

   If `%(push:short)` is empty, first reproduce extension discovery. Validate
   every configured remote and its sole push URL. Query the same branch ref on
   each URL. Query PRs by exact `<OWNER>:<branch>` and validate every candidate
   URL, host, head repository, head ref, and OID. Stop and ask the user to rerun
   `/pr` if any remote now publishes the ref, any PR now matches, any authority
   is invalid, or results are incomplete or ambiguous. Require `origin` as the
   one validated creation destination. Also require no existing branch
   upstream, no remote push refspec, `branch.<branch>.pushRemote` and
   `remote.pushDefault` to be absent or exactly `origin`, and `push.default` to
   be absent or exactly `simple`. Mark this as the only case that needs a new
   upstream.

   Immediately before push, rerun the bundled inspector. Revalidate its JSON,
   branch, current `HEAD`, actual base ref and OID, merge-base, and positive ahead
   count. Require the inspected `HEAD` and local `HEAD` to equal the captured
   push OID. Repeat every destination, remote-ref OID, exact-head PR,
   configuration, and no-target discovery check. Require every saved field and
   result to match.
   If the saved remote OID exists, require it to be an ancestor of the captured
   local OID. Push once with a quoted exact lease:
   `git push --porcelain --force-with-lease="refs/heads/${ref}:${remote_oid}"
   -- "$push_url" "${oid}:refs/heads/${ref}"`. Push to the saved, validated sole
   URL, not the remote name, so later Git config changes cannot redirect code.
   If the saved remote ref is absent,
   use the empty expectation `refs/heads/${ref}:` instead. The ancestry check
   makes an existing-ref update fast-forward-only. The empty lease makes a new
   ref create-only. Never overwrite a concurrent update. Do not use `HEAD` as
   the source. Do not retry or fall back. For the no-target case only, set the
   local branch upstream with quoted arguments and an option terminator.

   Query open PRs with exact head `<OWNER>:<ref>` and the exact base repository.
   Validate every result's URL, host, head repository, head ref, OID, and base.
   Reuse one result only when its base matches. Refresh its title and body.
   Stop on a different base or multiple results. Immediately before updating or
   creating the PR, rerun the inspector and require the same validated branch,
   HEAD, actual base, merge-base, and positive ahead state. Then create with
   quoted, explicit `--repo`, `--head`, `--base`, title, and body-file arguments.
7. Reply only with the already validated PR URL. The extension handles any
   Herdr workspace label update after it discovers the open PR.
