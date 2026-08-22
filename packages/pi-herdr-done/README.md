# `@henryqw/pi-herdr-done`

Pi extension that closes and removes the current Herdr-managed linked worktree. Requires Pi Coding Agent 0.84.x (minimum 0.84.2) running inside Herdr.

## Install

```bash
pi install npm:@henryqw/pi-herdr-done
```

## Use

| Surface | Type | Purpose |
| --- | --- | --- |
| `/done` | command | Remove the current worktree checkout and close only this session's tab. |
| `/done --force` | command | Same, even when the worktree is dirty. |

Both forms wait for Pi to become idle. `/done` asks for confirmation first; `/done --force` skips it because the flag already states intent. Normal removal runs:

```bash
git worktree remove .
herdr tab close "$HERDR_TAB_ID"
```

Only the current session's tab closes, so sibling tabs in the same workspace survive. Command requires Pi running inside Herdr with `HERDR_ENV=1` and `HERDR_TAB_ID` set.

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
