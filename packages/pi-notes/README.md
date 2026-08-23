# `@henryqw/pi-notes`

Persistent notes shown in a Pi widget, managed with slash commands.

## Install

```bash
pi install npm:@henryqw/pi-notes
```

## Use

| Surface | Type | Purpose |
| --- | --- | --- |
| `/note <text>` | command | Add a note for current Git worktree (max 4). |
| `/note-rm` | command | Pick a note from current worktree to remove. |
| `/note-clear` | command | Clear current worktree's notes. |
| `/note-prune` | command | Delete notes for repositories and worktrees that no longer exist. |

Notes are isolated per Git worktree, render as a numbered widget above editor, and persist across sessions under `~/.pi/agent/config/pi-notes/`. Startup only reads config. `/note-prune` is explicit stale-data cleanup.

Each worktree file is validated as untrusted data. Malformed files are preserved and block mutation for affected worktree until fixed or reset with `/note-clear`; `/note-prune` reports but never deletes malformed files.

## Remove

```bash
pi remove npm:@henryqw/pi-notes
```

## Development

```bash
npm test --workspace @henryqw/pi-notes
npm run typecheck --workspace @henryqw/pi-notes
npm run pack:check --workspace @henryqw/pi-notes
```
