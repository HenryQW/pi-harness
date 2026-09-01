# `@henryqw/pi-add-dir`

Give the current Pi session context, skills, and searchable files from directories outside the current workspace.

![Pi using added external directories by name](./example.png)

## Why

- **Created for**: Pi users who keep reusable instructions or skills outside one repository.
- **Advantage**: Use those resources in place, without copying or linking their directories.

## Install

```bash
pi install npm:@henryqw/pi-add-dir
```

## Use

Run `/dir-add`, enter a directory, then run `/dir-ls`. Pi lists the directory and exposes its supported resources.

| Surface | Type | Purpose |
| --- | --- | --- |
| `/dir-add` | command | Add directory; no path opens input. Supports `~`. |
| `/dir-ls` | command | List directories; select one to remove. |
| `/dir-reload` | command | Reload external directory resources. |
| `add_directory` | tool | Add a directory. |
| `search_external_files` | tool | Glob-search added directories. |

Added directories give Pi these resources:

- Root `AGENTS.md`, `CLAUDE.md`, `.pi/AGENTS.md`, and `.pi/CLAUDE.md` files. Pi injects them into later prompts.
- Skills that Pi loads from `.pi/skills`, `.agents/skills`, and `.claude/skills`.
- Files in the editor's `@` autocomplete, with absolute paths.

`/dir-add` reloads when it finds skills. `add_directory` reports when a reload is needed.

Search supports basename and relative-path globs. It skips `.git` and `node_modules`. It uses Node filesystem traversal and returns at most 1,000 results per call.

## State

Pi session entry `add-dir:state` stores added directories. It is package-managed; do not edit it. Tree navigation restores the active branch's directories and reloads resources when that set changes.
