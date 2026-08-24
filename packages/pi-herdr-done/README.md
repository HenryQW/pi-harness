# `@henryqw/pi-herdr-done`

Pi extension that closes and removes the current Herdr-managed linked worktree. Requires Pi Coding Agent 0.84.x (minimum 0.84.2) running inside Herdr.

## Why

- **Created for**: Automating safe cleanup after finishing worktree-based tasks instead of manually removing checkouts, closing tabs, and pulling parents.
- **Advantage**: `/done` removes the checkout, closes workspace tabs, fast-forwards the parent with `--ff-only`, and refuses unsafe cases unless forced.

## Install

```bash
pi install npm:@henryqw/pi-herdr-done
```

## Use

| Surface | Type | Purpose |
| --- | --- | --- |
| `/done` | command | Remove the current worktree checkout, close its Herdr workspace's tabs, and fast-forward the parent workspace. |
| `/done --force` | command | Same, even when the worktree is dirty or used by tabs in another workspace. |

Both forms wait for Pi to become idle. `/done` asks for confirmation first; `/done --force` skips it because the flag already states intent. Normal removal runs:

```bash
git worktree remove .
herdr tab close <other-tabs-in-$HERDR_WORKSPACE_ID>
git -C <parent> pull --ff-only
herdr tab close "$HERDR_TAB_ID"
```

The parent pull runs only when this session ran in a linked worktree with a non-bare primary. It fails safely when the parent has diverged. Parent tabs do not block worktree removal or the parent pull. Once removal succeeds, every tab in the current Herdr workspace closes even when the parent pull fails. Concurrent completions serialize on a lock around the parent checkout.

Tabs in the current Herdr workspace close automatically. When a tab from another workspace still uses the current checkout, `/done` refuses and lists it by name; use `/done --force` to remove the checkout regardless. Command requires Pi running inside Herdr with `HERDR_ENV=1`, `HERDR_WORKSPACE_ID`, and `HERDR_TAB_ID` set.

Dirty worktrees make `/done` fail. Commit or discard changes, or use `/done --force` to explicitly delete them.

## Remove

```bash
pi remove npm:@henryqw/pi-herdr-done
```

## Development

```bash
npm test --workspace @henryqw/pi-herdr-done
npm run typecheck --workspace @henryqw/pi-herdr-done
npm run pack:check --workspace @henryqw/pi-herdr-done
```
