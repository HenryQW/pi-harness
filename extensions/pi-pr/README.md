# `@henryqw/pi-pr`

See, open, or create the current GitHub branch's pull request from Pi. Contributors get visible CI, review, merge, and lifecycle status without repeating `gh` commands.

## Install

```bash
pi install npm:@henryqw/pi-pr
```

Requires authenticated GitHub CLI access (`gh auth login`) in a GitHub repository checkout.

## Works with

**Improves.** [`@henryqw/pi-footer`](https://pi.henry.wang/extensions/pi-footer) shows current-branch pull-request status in the footer.

## Use

Run `/pr` in a GitHub checkout. Pi opens the current branch pull request when one exists.

If none exists, Pi starts the bundled creation workflow instead.

| Surface | Type | Purpose |
| --- | --- | --- |
| Footer | ui | Show the current branch pull request. |
| `/pr` | command | Open current branch PR, or start PR workflow when absent. |

## Flow

Each footer entry is one linked `PR #number` plus one plain-language state. Possible states are:

- `<count> unresolved`, `draft`, `open`, `approved`, and `CI running`
- `CI failed`, `changes requested`, `merge conflict`, `merged`, and `closed`

Colors support text. They do not carry meaning alone.

Known states have this priority:

1. `<count> unresolved` for known unresolved review threads
2. `merge conflict`
3. `changes requested`
4. `CI failed`
5. `CI running` for CI progress

The status loads at session start and polls every 30 seconds. It refreshes after an agent successfully runs `gh pr create`, `git push`, or `/pr`.

Unresolved review threads are checked every 30 seconds for 20 minutes after an open PR is first found. Each new push or remote PR update, including new comments, restarts that window.

The footer and warning notification show the unresolved count when first found or increased. The last known footer count remains after review checks stop. No pull request leaves the footer blank.

`/pr` finds an open PR for the current branch. When absent, it starts bundled `/skill:pi-pr-create` workflow.

The agent resolves the base and inspects and commits scoped changes. It runs relevant validation, pushes the branch, and creates or updates the PR with a live title and body.

This workflow handles dirty worktrees. It never silently commits unrelated changes.
