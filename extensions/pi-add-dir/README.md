# `@henryqw/pi-add-dir`

Give the current Pi session context, skills, and searchable files from directories outside the workspace. Reuse those resources in place without copying or linking their directories.

![Pi using added external directories by name](./example.png)

## Install

```bash
pi install npm:@henryqw/pi-add-dir
```

## Use

Run `/dir-add`, enter a directory, then run `/dir-ls`. Pi lists the directory and exposes its supported resources.

| Surface | Type | Purpose |
| --- | --- | --- |
| `/dir-add [path]` | command | Add to the current session; no path opens input. Supports `~`. |
| `/dir-add --project [path]` | command | Persist for the current Git repository and all its linked worktrees. |
| `/dir-add --global [path]` | command | Persist for every Pi workspace for this user. |
| `/dir-ls` | command | List directories with their scope; select one to remove from that scope. |
| `/dir-reload` | command | Reload external directory resources. |
| `add_directory` | tool | Add a directory. |
| `search_external_files` | tool | Glob-search added directories. |

Added directories give Pi these resources:

- Root `AGENTS.md`, `CLAUDE.md`, `.pi/AGENTS.md`, and `.pi/CLAUDE.md` files. Pi injects them into later prompts.
- Skills that Pi loads from `.pi/skills`, `.agents/skills`, and `.claude/skills`.
- Files in the editor's `@` autocomplete, with absolute paths.

`/dir-add` reloads when it finds skills. `add_directory` reports when a reload is needed and always remains session-local.

## Persistence and trust

Global directories live in Pi's private `config/pi-add-dir/config.json`. Project directories use the repository's local Git config under the repeatable key `pi-add-dir.directory`. Git local config is shared by linked worktrees, cannot be injected by cloning a repository, and remains machine-local. `/dir-add --project` therefore requires a Git repository.

Both persistent scopes are explicit because added directories can inject `AGENTS.md`, `CLAUDE.md`, and skills. Missing directories and directories that overlap the current workspace remain configured but are skipped with a warning. Fix or remove them through `/dir-ls`. Invalid global configuration stops loading and is not overwritten.

## Limits and recovery

Search supports basename and relative-path globs. It skips `.git` and `node_modules`. It uses Node filesystem traversal and returns at most 1,000 results per call.
