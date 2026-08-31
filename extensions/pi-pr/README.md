# `@henryqw/pi-pr`

Show the current branch pull request in the Pi footer and use `/pr` to run its next safe step.

## Why

- **Created for**: Check pull-request progress without repeated `gh` commands.
- **Advantage**: See the current pull request and its next step in one place.

## Install

```bash
pi install npm:@henryqw/pi-pr
```

Requires an authenticated GitHub CLI session (`gh auth login`) and a GitHub repository checkout. It works in generic Pi sessions outside Herdr.

## With

`@henryqw/pi-footer` improves this package by showing its pull-request status in the footer.

## Use

| Surface | Type | Purpose |
| --- | --- | --- |
| Footer | ui | Show a linked `PR #number` and one plain-language status. |
| Widget hint | ui | Show at most one hint for the next `/pr` step. |

Footer statuses include `N unresolved`, `draft`, `open`, `approved`, `CI running`, `CI failed`, `changes requested`, `base update required`, `merge conflict`, `merge-ready`, `merged`, and `closed`. Colors support the text; they do not carry meaning alone.

Use `/pr` without arguments. It reads the current branch pull request and local state, then runs one route.

## Routes

| Current condition | `/pr` route |
| --- | --- |
| No current-branch pull request | Start pull-request creation. |
| Base update required or merge conflict | Update from the pull request's exact base. A conflict uses this same route. |
| Changes requested or unresolved review threads | Run the package comment sweep. |
| CI failed | Run the CI fix workflow. |
| No-action state | Report the state without taking action. |
| Merge-ready pull request | Ask for final confirmation, recheck fresh state, and merge directly if confirmed. |

A no-action state includes a draft, merged or closed pull request, running CI, pending review, blocked merge policy, a dirty worktree, local commits ahead or diverged, or no available action.

## Route priority

A missing pull request uses creation. For an existing pull request, the first matching condition wins:

1. Merged, closed, or draft: no action.
2. Base update required or merge conflict.
3. Changes requested or unresolved review threads.
4. CI failure.
5. Waiting or local safety block: no action.
6. Merge-ready: final confirmation, then direct merge.

Ordinary conversation comments do not trigger a route or block a merge. Changes requested and unresolved review threads can select the package comment sweep.

## Refresh

The footer and widget load at session start and poll every 30 seconds. Polling updates presentation only and may be stale. `/pr` reads fresh remote and local state before it chooses a route or merges. The command is authoritative for actions.

## Safety limits

- `/pr` takes no arguments and does not open a browser.
- It does not run `/done` or `/sweep`.
- Polling does not auto-triage comments or start a workflow. The package comment sweep runs only when an explicit `/pr` selects it.
- It does not enable auto-merge or add a merge queue.
- It does not rebase the local branch, force-push, delete branches, or clean up worktrees.
- Direct merge requires final confirmation and a fresh readiness check.
