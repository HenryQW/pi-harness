# Sweep Recovery

Read only for resume or PR-head mismatch.

## Checkpoint

Only ignored `.context/progress.md` may change under `.context/`. Keep one JSON
line under `## PR comment sweep`; never stage it:

```json
{"workflow":"pi-pr-comment-sweep","pr":"URL","snapshot":"/tmp/file","final_snapshot":null,"head":"SHA","phase":"triage","owned":[],"ledger":{},"checks":[],"commit":null,"pushed":false,"resolved":[]}
```

Use phases `triage`, `editing`, `validated`, `committed`, `pushed`, or `resolved`.
Update after each phase; keep repository-relative owned paths, thread verdicts in
`ledger`, exact validation results, commit SHA, push state, and resolved IDs.

Resume only when workflow and PR match, snapshot exists and names that PR, local
`HEAD` equals `head`, and tracked dirty paths equal `owned`. Skip completed
phases and continue with next one. Stop on missing, malformed, or conflicting
state; never absorb unknown changes. Commands requiring a clean tree remain
blocked until tracked work is committed or otherwise restored by user.

## Adopt PR head

Only exact user words **“Adopt PR head”** authorize this path. Inspect
`gh pr view "$PR" --json url,headRepository,headRefName,headRefOid`. Validate the
PR URL, full head OID, and ref. Choose exactly one push URL whose normalized
GitHub host/owner/repository matches `headRepository`. Run:

```bash
git fetch --no-write-fetch-head --no-tags "$PUSH_URL" "$PR_HEAD_SHA"
git cat-file -e "$PR_HEAD_SHA^{commit}"
git log --oneline HEAD.."$PR_HEAD_SHA"
git diff --stat HEAD.."$PR_HEAD_SHA"
git merge-base --is-ancestor HEAD "$PR_HEAD_SHA"
STATUS=$(git status --porcelain=v1 --untracked-files=all) || exit 1
test -z "$STATUS" || exit 1
for STATE in MERGE_HEAD rebase-merge rebase-apply CHERRY_PICK_HEAD REVERT_HEAD sequencer; do
  STATE_PATH=$(git rev-parse --git-path "$STATE") || exit 1
  test -n "$STATE_PATH" && test ! -e "$STATE_PATH" || exit 1
done
git merge --ff-only "$PR_HEAD_SHA"
```

Run the clean-tree and Git-operation checks immediately before the fast-forward.
Stop on an absent object, divergence, dirty tracked or untracked state, an active
Git operation, or an ambiguous push URL. Never stash, reset, or clean. Re-run
target verification and initial fetch after fast-forward.
