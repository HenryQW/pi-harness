# `@henryqw/pi-notes`

Keep worktree reminders above the Pi editor across sessions.

![Pi showing two persistent notes above the editor](./example.png)

## Install

```bash
pi install npm:@henryqw/pi-notes
```

## Use

Run `/note Verify the migration rollback.` in a Git worktree. The reminder appears immediately and in later sessions.

| Surface | Type | Purpose |
| --- | --- | --- |
| `/note <text>` | command | Add a worktree note. |
| `/note-rm` | command | Select and remove a note. |
| `/note-clear` | command | Clear worktree notes. |
| Notes widget | ui | Show worktree notes. |

Each worktree has separate notes.

### Select a worktree

Use `--project`, which selects a project or worktree path for one command. Paths are absolute or relative to the session directory. Enter paths without shell quotes; spaces are allowed. For `/note`, `--` separates the path from the note text.

```text
/note --project first repo -- Verify the migration rollback.
/note-rm --project first repo
/note-clear --project first repo
```

Pi does not scan or select child repositories. Without a path, commands use the session directory and fail outside a Git worktree. An explicit selection does not change that default or select a project for other tools.

The widget stays with the session worktree. Explicit commands report the selected worktree's notes in a notification. Worktrees and symbolic links use the same canonical identity checks.

## State and storage

Commands save notes to `~/.pi/agent/config/pi-notes/<worktree-sha256>.json`.

Session start and note changes silently delete stale files for removed repositories and worktrees.

## Limits and recovery

Each worktree holds at most four notes. `/note` trims surrounding whitespace and replaces whitespace sequences with one space. It rejects remaining control characters with `Notes cannot contain terminal control characters.`

The extension validates files as untrusted data. Malformed files stay unchanged and block changes for their worktree. Fix the file or reset it with `/note-clear`.
