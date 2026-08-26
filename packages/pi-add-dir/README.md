# `@henryqw/pi-add-dir`

Add external directories to the current Pi session: inject context files, load skills, and search those trees.

## Why

- **Created for**: Extending Pi context and skill discovery beyond the current working directory.
- **Advantage**: Inject files and load skills from external trees without copying them into the repo.

## Install

```bash
pi install npm:@henryqw/pi-add-dir
```

## Use

| Surface | Type | Purpose |
| --- | --- | --- |
| `/dir-add` | command | Add directory; no path opens input. Supports `~`. |
| `/dir-ls` | command | List directories; select one to remove. |
| `add_directory` | tool | Add a directory. |
| `search_external_files` | tool | Glob-search added directories. |

Added directories return root `AGENTS.md`, `CLAUDE.md`, `.pi/AGENTS.md`, and `.pi/CLAUDE.md`, and inject them into later prompts. Skills load from `.pi/skills`, `.agents/skills`, and `.claude/skills`. `/dir-add` reloads when it finds skills; `add_directory` reports when a reload is needed.

Search uses Node filesystem traversal, skips `.git` and `node_modules`, supports basename and relative-path globs, and caps results at 1,000 per call.

## Config

| Package-owned editable config | Required | Fields | Possible values | Default |
| --- | --- | --- | --- | --- |
| None | No | No fields | No possible values | Built-in behavior |

Package-owned generated state: Pi session entry `add-dir:state` stores added directories; do not edit it.

## Remove

```bash
pi remove npm:@henryqw/pi-add-dir
```

## Development

```bash
npm test --workspace @henryqw/pi-add-dir
npm run typecheck --workspace @henryqw/pi-add-dir
npm run pack:check --workspace @henryqw/pi-add-dir
```
