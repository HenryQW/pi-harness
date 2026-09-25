# `@henryqw/pi-herdr-done`

Finish a Herdr-managed linked-worktree task by removing its checkout, closing its workspace tabs, and fast-forwarding its primary checkout when possible. Normal removal refuses dirty worktrees and worktrees in use by another Herdr workspace; `--force` can delete uncommitted work and leave those tabs pointing at the removed checkout.

## Install

```bash
pi install npm:@henryqw/pi-herdr-done
```

Requires the Herdr CLI and Pi running inside a Herdr-managed linked worktree.

## Works with

| Package | Relationship | Purpose |
| --- | --- | --- |
| [`@henryqw/pi-herdr-clone`](https://pi.henry.wang/extensions/pi-herdr-clone) | Improves | Creates the worktree workspace that `/done` later removes. |

## Use

Commit or discard changes, then run `/done` and confirm. It removes the checkout and closes every tab in the same Herdr workspace.

| Surface | Type | Purpose |
| --- | --- | --- |
| `/done [--force]` | command | Remove the current worktree and close its Herdr workspace tabs; `--force` skips confirmation and permits forced removal without checking for tabs in other workspaces. |

## Flow

![Sequence of /done safety gates, cleanup order, and conditional parent update.](./docs/done-flow.svg)

Normal `/done` asks for confirmation before waiting for Pi to become idle; declining leaves the checkout untouched. `/done --force` skips confirmation. Both wait for Pi to become idle before cleanup.

Normal cleanup checks whether a tab in another Herdr workspace is using the checkout, removes it with `git worktree remove <checkout>`, closes every other tab in the current Herdr workspace, and runs `git pull --ff-only` from the primary checkout when this was a linked worktree and the primary is non-bare. It closes the current tab last. Tabs using the primary checkout do not block removal or the pull. Concurrent completions serialize on locks around the worktree and primary checkout.

## Limits and recovery

- `/done` refuses to remove a dirty worktree. Commit or discard changes first. `/done --force` passes `--force` to Git and can irreversibly delete uncommitted work.
- A tab in another Herdr workspace that uses this checkout blocks normal removal. `/done` lists the tab label, or its ID when no label is available. Close the tab and retry, or use `/done --force` only if you accept removing the checkout while that tab still refers to it. Tabs in other workspaces are not closed.
- The command requires Pi inside Herdr with `HERDR_ENV=1`, `HERDR_WORKSPACE_ID`, and `HERDR_TAB_ID` set.
- The primary checkout update runs only after worktree removal. If `git pull --ff-only` fails, for example because the primary has diverged or has local changes, the worktree is already gone and the current tab still closes. Resolve the primary checkout issue, then retry with `git -C <primary-checkout> pull --ff-only`.
