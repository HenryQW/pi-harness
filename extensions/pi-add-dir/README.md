# `@henryqw/pi-add-dir`

Give the current Pi session the context, skills, and searchable files of external directories. Pi uses these resources in place, so you do not copy or link the directories.

![Pi using added external directories by name](https://raw.githubusercontent.com/HenryQW/pi-harness/main/extensions/pi-add-dir/example.png)

## Install

```bash
pi install npm:@henryqw/pi-add-dir
```

Requires Pi 1.1.0 or later in the 1.x series.

## Use

Run `/dir-add` and enter a directory. Then run `/dir-ls` to make sure that Pi added it. Pi lists the directory and makes its supported resources available.

Humans use the slash commands from the Pi prompt. Pi agents use the tools.

| Surface | Type | Purpose |
| --- | --- | --- |
| `/dir-add [path]` | command | Add to this session by default. To persist for the linked worktrees of this Git repository or for every workspace, pass `--project` or `--global` before the path. Omit the path to enter it at the prompt. Supports `~`. |
| `/dir-ls` | command | List directories with their scope. Select one to remove it from that scope. |
| `/dir-reload` | command | Reload external directory resources. |
| `add_directory(path)` | tool | Add a directory to this session and return its context and instructions. Model-only: codemode scripts cannot call it. |
| `search_external_files(pattern, maxResults?)` | tool | Search added directories with a glob. Returns up to 50 results by default; `maxResults` accepts up to 1,000. Returns a structured result to codemode scripts. |
| `@` file autocomplete | ui | Find files in added directories and insert their absolute paths. |
| External directory widget | ui | Show added directories and refer to `/dir-ls` for management. |

Added directories give Pi these resources:

- Root `AGENTS.md`, `CLAUDE.md`, `.pi/AGENTS.md`, and `.pi/CLAUDE.md` files. Pi injects them into later prompts.
- Skills that Pi loads from `.pi/skills`, `.agents/skills`, and `.claude/skills`.
- Files in the editor's `@` autocomplete, with absolute paths.

`/dir-add` reloads only when the discovered external skill paths change. A directory that contains skills does not alone cause a reload. `add_directory` stays session-local. When its result asks for `/reload`, run `/reload` to update external skills.

### Programmatic use

`search_external_files` declares an output schema. Programmatic callers, such as Pi `codemode` scripts, receive `{ pattern, maxResults, searchedDirectories, totalFound, truncated, directories }`. `directories` lists each directory that has at least one match, with its label and absolute file paths. `searchedDirectories` counts only the directories that the tool searched, including directories with no matches. It does not count directories that the tool skipped after it reached the cap. `truncated` is true when the result cap stopped the search. In that case, later directories or files can contain more matches. The model receives the same matches as text. If there are no added directories, a call to the tool is a tool error, and scripts reject with the message.

`add_directory` is declared to the model only (Pi `model-only` exposure). Codemode scripts and other tools cannot call it. Thus, the `AGENTS.md`, `CLAUDE.md`, and skills of another directory enter the session only through a model-visible tool call or a user command. This package does not enable codemode.

## Config

Package-owned: `~/.pi/agent/config/pi-add-dir/config.json`

| Name | Description | Values | Default |
| --- | --- | --- | --- |
| `directories` | Directories loaded for every workspace. `/dir-add --global` updates this list. | Array of unique absolute paths without control characters. | `[]` |

If the file is missing, the extension uses the default. At launch, the extension shows a warning for each unknown key and each invalid or duplicate directory entry. It ignores that key or entry and loads the other directories. If the file is malformed or `directories` is not an array, it shows a warning and uses the default. It does not change the file. `/dir-add --global` and global removal with `/dir-ls` fail until you fix the reported issues. Reload Pi after you edit the file manually.

## State and storage

Session directories are stored in the current session branch. A new session addition rejects a directory that is inside the current working directory or that contains it. It also rejects a directory that overlaps another active added directory. When the working directory changes, the extension does not check restored session entries for overlap again. Project directories use the repeatable local Git config key `pi-add-dir.directory` of the repository. Linked worktrees share local Git config. A cloned repository cannot inject this config, and it stays on the local machine. Thus, `/dir-add --project` requires a Git repository.

Persistent scopes are explicit because added directories can inject `AGENTS.md`, `CLAUDE.md`, and skills.

## Limits and recovery

Search supports basename and relative-path globs. It skips `.git` and `node_modules` and does not follow symbolic links. It uses Node filesystem traversal and returns at most 1,000 results for each call.

Missing or overlapping **project and global** directories stay in the config, but the extension skips them with a warning. Restore a missing directory at its original path, or resolve the overlap. Then run `/dir-reload` to scan again. To change or discard a configured path, use `/dir-ls` to **remove** it from its scope. If necessary, run `/dir-add` with the corrected path. `/dir-ls` cannot repair paths in place.
