# `@henryqw/pi-herdr-clone`

Continue the current Pi conversation in a new Herdr tab or a fresh Git worktree workspace.

## Why

- **Created for**: Pi users who want to explore or implement from the current conversation in another workspace.
- **Advantage**: Copy only the active conversation path while leaving siblings and the original session untouched.

## Install

```bash
pi install npm:@henryqw/pi-herdr-clone
```

Requires the Herdr CLI and a Pi session running inside a Herdr-managed pane.

## With

[`@henryqw/pi-herdr-done`](https://pi.henry.wang/extensions/pi-herdr-done) improves worktree clones by cleaning them up when work finishes.

## Use

Run `/clone-tab` first. A new Herdr tab opens with the saved active conversation, while the original session stays open.

| Surface | Type | Purpose |
| --- | --- | --- |
| `/clone-tab` | command | Clone the current conversation into a new tab of the current Herdr workspace. |
| `/clone-worktree` | command | Clone the current conversation into a new Herdr Git worktree workspace. |

The active conversation path is the saved messages from the session root to its current leaf. Both commands validate the current Herdr pane (`HERDR_ENV=1`, `HERDR_PANE_ID`), the session file, and the current session leaf immediately.

They copy only the active root-to-leaf path available when invoked into a new persisted session file. Sibling branches and still-streaming assistant output are excluded.

The original Pi session is not switched. Neither command has configuration.

### `/clone-tab` behavior

1. Create an unfocused Herdr tab in the current workspace with the current working directory.
2. Start Pi in the tab's root pane with `--session <absolute-clone-file>`.
3. Focus the new tab after Pi starts successfully.

### `/clone-worktree` behavior

1. Create a Git worktree-backed workspace with `herdr worktree create --workspace <current-workspace> --no-focus`.
   Herdr creates the branch from `HEAD` unless the name exists, checks out the worktree under its configured `worktrees.directory`, and opens it as a grouped workspace.
2. Wait briefly for a worktree-layout plugin, such as `herdr-plus`, to start its agent in the new workspace's root pane.
3. If the root pane is occupied, create an additional unfocused tab in the new workspace with the checkout as its working directory. The plugin's agent and the clone then coexist. Otherwise, use the root pane.
4. Copy the active path into a clone session stamped with the fresh checkout path as its working directory.
5. Start Pi in the chosen pane with `--session <absolute-clone-file>`.
6. Focus the clone's tab after Pi starts successfully.

### Failure semantics

- **Target creation failed:** No clone session is kept or created.
- **Killed or incomplete creation response:** The result is ambiguous because Herdr may have retained partial state. The error reports every identifier returned so far and suggests inspecting `herdr workspace list`.
- **Agent start attempted:** Retain the target tab, panes, and session file because the launch outcome can be unknown. The error reports any known IDs for recovery.
- **Later focus failure:** Show a warning. Do not report the already-started clone as failed.
