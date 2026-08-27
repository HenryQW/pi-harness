# `@henryqw/pi-notes`

Persistent post-it reminders shown in a Pi widget, managed with slash commands.

## Why

- **Created for**: Keeping a few brief, post-it-style reminders visible per worktree without leaving the Pi session.
- **Advantage**: Notes stay intentionally bounded and visible instead of becoming clipboard storage or history.

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

Notes are isolated per Git worktree, render as a numbered widget above editor with at most two lines per note, and persist across sessions under `~/.pi/agent/config/pi-notes/`. Empty worktrees show no widget. Stale files for removed repositories and worktrees are deleted silently when a session starts or notes change.

Each worktree file is validated as untrusted data. Malformed files are preserved and block mutation for affected worktree until fixed or reset with `/note-clear`.

## State

| Path | Purpose |
| --- | --- |
| `~/.pi/agent/config/pi-notes/<worktree-sha256>.json` | Command-managed notes for one Git worktree. |
