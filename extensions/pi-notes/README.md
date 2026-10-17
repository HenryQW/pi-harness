# `@henryqw/pi-notes`

Keep worktree reminders above the Pi editor across sessions.

![Pi showing two persistent notes above the editor](./example.png)

## Install

```bash
pi install npm:@henryqw/pi-notes
```

Requires Node.js 22.19.0 or newer.

## Use

Run `/note Verify the migration rollback.` in a Git worktree. The reminder appears immediately and in later sessions.

These commands and the widget are for people.

| Surface | Type | Purpose |
| --- | --- | --- |
| `/note <text>` | command | Add a worktree note. |
| `/note-rm` | command | Select and remove a note. |
| `/note-clear` | command | Clear worktree notes. |
| Notes widget | ui | Show worktree notes. |

Each worktree has separate notes. The TUI numbers notes and limits each to two lines. Other modes show plain text without that limit. Empty widgets stay hidden.

## State and storage

Commands save notes to `~/.pi/agent/config/pi-notes/<worktree-sha256>.json`.

Session start and note changes silently delete stale files for removed repositories and worktrees.

## Limits and recovery

Each worktree holds at most four notes. `/note` trims surrounding whitespace and replaces whitespace sequences with one space. It rejects remaining control characters with `Notes cannot contain terminal control characters.`

The extension validates files as untrusted data. Malformed files stay unchanged and block changes for their worktree. Fix the file or reset it with `/note-clear`.
