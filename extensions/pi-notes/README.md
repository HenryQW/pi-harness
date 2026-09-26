# `@henryqw/pi-notes`

Keep up to four persistent reminders for each worktree visible above the Pi editor. Small fixed slots stay useful without becoming an unbounded history store.

![Pi showing two persistent notes above the editor](./example.png)

## Install

```bash
pi install npm:@henryqw/pi-notes
```

Requires Node.js 22.19.0 or newer.

## Use

Run `/note Verify the migration rollback.` from inside a Git worktree. The reminder appears above the editor immediately and returns in later sessions for that worktree.

| Surface | Type | Purpose |
| --- | --- | --- |
| `/note <text>` | command | Add a note to the current Git worktree (max 4). |
| `/note-rm` | command | Pick a note from the current worktree to remove. |
| `/note-clear` | command | Clear all notes for the current worktree. |
| Notes widget | ui | Show the current worktree's notes. |

Each Git worktree has separate notes. In the TUI, the widget numbers notes above the editor and shows at most two lines per note. In non-TUI modes, notes are plain text without the two-line cap. When there are no notes, no widget is shown.

## State and storage

The extension generates `~/.pi/agent/config/pi-notes/<worktree-sha256>.json` for command-managed notes in one Git worktree.

Stale files for removed repositories and worktrees are deleted silently when a session starts or notes change.

## Limits and recovery

Each worktree can hold at most four notes. Each worktree file is validated as untrusted data. Malformed files are preserved and block mutation for the affected worktree until fixed or reset with `/note-clear`.
