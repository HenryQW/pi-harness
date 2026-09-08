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

1. Fetch current branch refs from `origin` without tags or submodules. Resolve
   `<base>` from explicit input or the branch's actual parent. The parent may be
   a feature branch; never assume the repository default branch. To infer it,
   inspect branch-creation reflogs and the fetched commit graph, excluding the
   current branch and symbolic refs. Accept history inference only when one
   validated remote branch is uniquely nearest to `HEAD`. Stop and ask for the
   base when evidence is absent or ambiguous. Validate `<base>` with
   `git check-ref-format --branch "$base"`, resolve
   `refs/remotes/origin/${base}` to a full `<base-oid>`, and use only that OID in
   `git merge-base HEAD "$base_oid"` and `git diff "$merge_base" --`. Also
   inspect `git status --short` and staged and unstaged diffs. Never commit
   `.context/` or unrelated changes.
2. Commit each coherent pending change with a scoped Conventional Commit. Preserve existing coherent staging; stop when changes cannot be separated safely.
3. Require an attached branch and a clean tree, then merge the captured base OID
   with `git merge --no-edit "$base_oid"`. Never merge the mutable branch name.
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

   Immediately before push, require local `HEAD` to equal the captured OID.
   Repeat every destination, remote-ref OID, exact-head PR, configuration, and
   no-target discovery check. Require every saved field and result to match.
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
   Stop on a different base or multiple results. Otherwise create with quoted,
   explicit `--repo`, `--head`, `--base`, title, and body-file arguments.
7. Reply only with the already validated PR URL. The extension handles any
   Herdr workspace label update after it discovers the open PR.
