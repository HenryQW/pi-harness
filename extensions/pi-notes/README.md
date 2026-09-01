# `@henryqw/pi-notes`

Keep a few persistent worktree reminders visible above the Pi editor.

![Pi showing two persistent notes above the editor](./example.png)

## Why

- **Created for**: Pi users who need small reminders tied to one worktree.
- **Advantage**: Four visible note slots stay useful without becoming another unbounded history store.

## Install

```bash
pi install npm:@henryqw/pi-notes
```

## Use

Run `/note Verify the migration rollback.` The reminder appears above the editor and returns in later sessions for this worktree.

| Surface | Type | Purpose |
| --- | --- | --- |
| `/note <text>` | command | Add a note for current Git worktree (max 4). |
| `/note-rm` | command | Pick a note from current worktree to remove. |
| `/note-clear` | command | Clear current worktree's notes. |

- Each Git worktree has separate notes.
- The widget numbers notes above the editor and shows at most two lines per note.
- Each worktree has at most four notes.
- Empty worktrees show no widget.
- Stale files for removed repositories and worktrees are deleted silently when a session starts or notes change.

Each worktree file is validated as untrusted data. Malformed files are preserved. They block mutation for the affected worktree until fixed or reset with `/note-clear`.

## State

The extension generates `~/.pi/agent/config/pi-notes/<worktree-sha256>.json` for command-managed notes in one Git worktree.
