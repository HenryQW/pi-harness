---
name: pi-pr-create
description: Create or update a GitHub pull request from current branch. Used by `/pr` when no open current-branch pull request exists.
---

# Pi PR Create

Create current branch GitHub pull request.

1. Resolve `<base>` from explicit input, current PR base, or repository default branch. Stop if ambiguous. Inspect `git status --short`, staged and unstaged diffs, and `git diff "$(git merge-base HEAD <base>)"`. Never commit `.context/` or unrelated changes.
2. Commit each coherent pending change with a scoped Conventional Commit. Preserve existing coherent staging; stop when changes cannot be separated safely.
3. Run smallest relevant non-destructive validation for current `HEAD`; state when none exists.
4. Derive Conventional Commit PR title plus Summary and Testing body from live diff and validation.
5. Resolve the push destination after validation. Require an attached, valid
   local branch. Capture and validate the full `HEAD^{commit}` OID.

   Read the branch's `%(push:short)`. If present, resolve its longest exact
   `<remote>/` prefix against configured remote names. Stop on no match or
   ambiguity. Validate the remaining branch ref with `git check-ref-format
   --branch`. Require exactly one push URL on that remote. Resolve the URL to
   one GitHub host and `OWNER/REPO`. Never print a credential-bearing URL.
   Keep this configured remote, ref, repository, host, and head owner.

   If `%(push:short)` is empty, use `origin` and the local branch ref. Apply the
   same ref, sole push URL, repository, and host checks. Mark this as the only
   case that needs a new upstream.

   Immediately before push, require local `HEAD` to equal the captured OID.
   Re-resolve the destination and require every saved field to match. Push
   `<OID>:refs/heads/<ref>` to that exact remote. Do not use `HEAD` as the
   source. Do not retry or fall back to `origin`. For the no-target case only,
   set the local branch upstream to the pushed `origin/<ref>`.

   Query open PRs with exact head `<OWNER>:<ref>` and the exact base repository.
   Validate every result's URL, host, head repository, head ref, and base.
   Reuse one result only when its base matches. Refresh its title and body.
   Stop on a different base or multiple results. Otherwise create with explicit
   `--head <OWNER>:<ref>`, `--base <base>`, title, and body file.
6. Reply only with PR URL.
