# `@henryqw/pi-add-dir`

Add external directories to the current Pi session: inject context files, load skills, and search those trees.

## Install

```bash
pi install npm:@henryqw/pi-add-dir
```

## Use

| Surface | Purpose |
| --- | --- |
| `/dir-add [path]` | Add directory; no path opens input. Supports `~`. |
| `/dir-ls` | List directories; select one to remove. |
| `add_directory` | Agent tool for adding a directory. |
| `search_external_files` | Agent tool for glob-searching added directories. |

Added directories return root `AGENTS.md`, `CLAUDE.md`, `.pi/AGENTS.md`, and `.pi/CLAUDE.md`, and inject them into later prompts. Skills load from `.pi/skills`, `.agents/skills`, and `.claude/skills` as `/skill:<name>`. `/dir-add` reloads when it finds skills; `add_directory` reports when `/reload` is needed.

Search uses Node filesystem traversal, skips `.git` and `node_modules`, supports basename and relative-path globs, and caps results at 1,000 per call.

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
