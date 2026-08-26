# `@henryqw/pi-pr`

Show the current branch pull request's lifecycle, CI, mergeability, and review state in the Pi footer.

## Why

- **Created for**: Avoiding repeated `gh` commands just to check pull-request status during work.
- **Advantage**: Branch lifecycle, CI, mergeability, and review state appear at a glance in the footer.

## Install

```bash
pi install npm:@henryqw/pi-pr
```

Requires authenticated GitHub CLI access (`gh auth login`) in a GitHub repository checkout.

## Use

| Surface | Type | Purpose |
| --- | --- | --- |
| Footer | UI | Show the current branch pull request. |
| `/pr` | command | Open current branch PR, or start PR workflow when absent. |

Each entry is one linked `PR #number` plus one plain-language state: `<count> unresolved`, `draft`, `open`, `approved`, `CI running`, `CI failed`, `changes requested`, `merge conflict`, `merged`, or `closed`. Known unresolved review threads take priority, followed by merge conflict, changes requested, CI failure, then CI progress. Colors support text; they do not carry meaning alone.

The status loads at session start, polls every 30 seconds, and refreshes after an agent successfully runs `gh pr create`, `git push`, or `/pr`. Unresolved review threads are checked every 30 seconds for 20 minutes after an open PR is first found. Each new push or remote PR update, including new comments, restarts that window. Footer and warning notification show the unresolved count when first found or increased. Last known footer count remains after review checks stop. No pull request leaves the footer blank.

`/pr` finds an open PR for current branch. When absent, it starts bundled `/skill:pi-pr-create` workflow. Agent resolves base, inspects and commits scoped changes, runs relevant validation, pushes branch, and creates or updates PR with live title and body. This workflow handles dirty worktrees; it never silently commits unrelated changes.

## Config

This package has no package-owned user-editable config. Its in-memory poll and review state is not configuration.

| File | Required | Fields | Possible values | Default |
| --- | --- | --- | --- | --- |
| — | No | — | — | Built-in behavior |

## Remove

```bash
pi remove npm:@henryqw/pi-pr
```

## Development

```bash
npm test --workspace @henryqw/pi-pr
npm run typecheck --workspace @henryqw/pi-pr
npm run pack:check --workspace @henryqw/pi-pr
```
