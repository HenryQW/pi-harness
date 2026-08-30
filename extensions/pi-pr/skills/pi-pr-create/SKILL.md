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
5. Push `HEAD` to `origin`, setting upstream when absent. Query `gh pr list --head <branch> --state open --limit 100 --json number,url,baseRefName`; reuse exactly one only when its base matches, refreshing title and body when needed. Stop on a different base or multiple PRs. Otherwise create with `gh pr create --base <base> --title <title> --body-file <file>`.
6. Reply only with PR URL.
