# `@henryqw/pi-herdr-clone`

Pi extension that clones the current conversation path into a new Pi process in a new tab of the current Herdr workspace, or into a new Herdr Git worktree workspace. Requires Pi Coding Agent 0.84.x (minimum 0.84.2) and a Pi session running inside Herdr.

## Install

```bash
pi install npm:@henryqw/pi-herdr-clone
```

## Use

| Surface | Type | Purpose |
| --- | --- | --- |
| `/clone-tab` | command | Clone the current conversation into a new tab of the current Herdr workspace. |
| `/clone-worktree` | command | Clone the current conversation into a new Herdr Git worktree workspace. |

Both commands wait until Pi is idle, then validate the current Herdr pane (`HERDR_ENV=1`, `HERDR_PANE_ID`), the persisted session file, and the current session leaf. They copy only the active root-to-leaf path into a new persisted session file: sibling branches are excluded and the original Pi session is not switched. Neither command has configuration.

### `/clone-tab` behavior

1. Creates an unfocused Herdr tab in the current workspace with the current working directory.
2. Starts Pi in the tab's root pane with `--session <absolute-clone-file>`.
3. Focuses the new tab after Pi starts successfully.

### `/clone-worktree` behavior

1. Creates a Git worktree-backed workspace with `herdr worktree create --workspace <current-workspace> --no-focus`; Herdr creates the branch from `HEAD` unless the name exists, checks out the worktree under its configured `worktrees.directory`, and opens it as a grouped workspace.
2. Waits briefly for any worktree-layout plugin (for example `herdr-plus`) to start its own agent in the new workspace's root pane.
3. If the root pane is occupied, creates an additional unfocused tab in the new workspace with the checkout as its working directory, so the plugin's agent and the clone coexist. Otherwise the clone uses the root pane.
4. Copies the active path into a clone session stamped with the fresh checkout path as its working directory.
5. Starts Pi in the chosen pane with `--session <absolute-clone-file>`.
6. Focuses the clone's tab after Pi starts successfully.

### Failure semantics

If target creation fails outright, no clone session is kept or created. A killed or incomplete creation response is ambiguous because Herdr may have retained partial state; the error reports every identifier returned so far and suggests inspecting `herdr workspace list`. Once agent start is attempted, the target tab, panes, and session file are retained because the launch outcome can be unknown; the error reports any known IDs for recovery. A later focus failure is shown as a warning and does not report the already-started clone as failed.

## Remove

```bash
pi remove npm:@henryqw/pi-herdr-clone
```

## Development

```bash
npm test --workspace @henryqw/pi-herdr-clone
npm run typecheck --workspace @henryqw/pi-herdr-clone
npm run pack:check --workspace @henryqw/pi-herdr-clone
```
