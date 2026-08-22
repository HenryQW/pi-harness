# `@henryqw/pi-herdr-clone`

Pi extension that clones the current conversation path into a new Pi process in a new tab of the current Herdr workspace, or into a new Herdr Git worktree workspace. Requires Pi Coding Agent 0.84.x (minimum 0.84.2) and a Pi session running inside Herdr.

## Install

```bash
pi install npm:@henryqw/pi-herdr-clone
```

Remove with:

```bash
pi remove npm:@henryqw/pi-herdr-clone
```

## `/clone-tab`

The command waits until Pi is idle, then:

1. Validates the current Herdr pane and resolves its live workspace.
2. Copies only the current Pi session path into a new persisted session file. Sibling branches are excluded and the original Pi session is not switched.
3. Creates an unfocused Herdr tab in that workspace with the current working directory.
4. Starts Pi in the tab's root pane with `--session <absolute-clone-file>`.
5. Focuses the new tab after Pi starts successfully.

The command requires `HERDR_ENV=1`, `HERDR_PANE_ID`, an existing persisted session file, and a current session leaf. It has no configuration.

## `/clone-worktree`

The command performs the same validation and active-path clone as `/clone-tab`, then:

1. Creates a Git worktree-backed workspace with `herdr worktree create --workspace <current-workspace> --no-focus`; Herdr creates the branch from `HEAD` unless the name exists, checks out the worktree under its configured `worktrees.directory`, and opens it as a grouped workspace.
2. Starts Pi in the new workspace's root pane (whose shell runs inside the checkout) with `--session <absolute-clone-file>`.
3. Focuses the new tab after Pi starts successfully.

Cleanup and ambiguity semantics match `/clone-tab`: a failed `worktree create` removes the clone session; once creation succeeds but the response is incomplete or agent start is attempted, the worktree workspace, tab, pane, and session file are retained and reported for recovery.

If tab creation itself fails, the cloned session file is removed. If Herdr creates the tab but the response is incomplete, or once agent start is attempted, the tab and session file are retained because the launch outcome can be unknown; the error reports any known IDs for recovery. A later focus failure is shown as a warning and does not report the already-started clone as failed.

## Development

```bash
npm test --workspace @henryqw/pi-herdr-clone
npm run typecheck --workspace @henryqw/pi-herdr-clone
npm run pack:check --workspace @henryqw/pi-herdr-clone
```
