# `@henryqw/pi-add-dir`

Pi extension for adding external directories to current session, based on [shelken's pi-add-dir](https://github.com/shelken/pi-extensions/tree/main/extensions/pi-add-dir). It injects `AGENTS.md` / `CLAUDE.md`, discovers skills, persists directory state in session history, and searches external files.

## Install

```bash
pi install npm:@henryqw/pi-add-dir
```

## Use

| Surface | Purpose |
| --- | --- |
| `/dir-add [path]` | Add directory; no path opens input. Supports `~`. |
| `/dir-ls` | List directories; select one to remove. |
| `add_directory` | Agent tool for adding directory. |
| `search_external_files` | Agent tool for glob-searching external files. |

Added directories return root `AGENTS.md`, `CLAUDE.md`, `.pi/AGENTS.md`, and `.pi/CLAUDE.md` in `add_directory` results and inject them into future prompts. Skills load from `.pi/skills`, `.agents/skills`, and `.claude/skills`, then register as `/skill:<name>` after reload. `/dir-add` reloads automatically when it finds skills; `add_directory` reports when `/reload` is needed.

Search uses native Node filesystem traversal, skips `.git` and `node_modules`, supports basename and relative-path globs, and caps results at 1,000 per call. No config file or runtime dependency.

## Remove

```bash
pi remove npm:@henryqw/pi-add-dir
```

## Development

```bash
npm test
npm run typecheck
npm run pack:check
```
