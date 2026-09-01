# Henry Pi Harness

A collection of 21 opinionated Pi extensions. Browse them at <https://pi.henry.wang>.

![Pi extensions in use](./example.png)

## Extensions

| Extension | Purpose |
| --- | --- |
| [`@henryqw/pi-add-dir`](./extensions/pi-add-dir) | Add external directories with context, skills, and file search. |
| [`@henryqw/pi-ask-question`](./extensions/pi-ask-question) | Ask user one interactive multiple-choice or free-text question. |
| [`@henryqw/pi-auto-compact`](./extensions/pi-auto-compact) | Compact context at the set threshold and resume current task. |
| [`@henryqw/pi-config-store`](./extensions/pi-config-store) | Create validated extension JSON stores with shared config homes. |
| [`@henryqw/pi-deps`](./extensions/pi-deps) | Prepare locked Node and uv dependencies for opted-in Git worktrees. |
| [`@henryqw/pi-footer`](./extensions/pi-footer) | Henry's opinionated Pi footer style for concise checkout and usage details. |
| [`@henryqw/pi-herdr`](./extensions/pi-herdr) | Run Herdr CLI commands through a shared thin client. |
| [`@henryqw/pi-herdr-btw`](./extensions/pi-herdr-btw) | Open and merge Pi side threads in Herdr panes. |
| [`@henryqw/pi-herdr-clone`](./extensions/pi-herdr-clone) | Clone the current Pi conversation path into a new Herdr tab. |
| [`@henryqw/pi-herdr-done`](./extensions/pi-herdr-done) | Close and remove current Herdr worktree. |
| [`@henryqw/pi-herdr-rename`](./extensions/pi-herdr-rename) | Generate short chat titles and rename current Herdr location. |
| [`@henryqw/pi-memory`](./extensions/pi-memory) | Maintain size-capped agent memory and user-profile stores across sessions. |
| [`@henryqw/pi-multi-codex`](./extensions/pi-multi-codex) | Use multiple ChatGPT Codex OAuth accounts in Pi. |
| [`@henryqw/pi-notes`](./extensions/pi-notes) | Keep persistent per-worktree notes visible in a Pi widget. |
| [`@henryqw/pi-open-in`](./extensions/pi-open-in) | Open current working directory with configurable command. |
| [`@henryqw/pi-pr`](./extensions/pi-pr) | Show current-branch PR lifecycle, CI, mergeability, and review state in Pi footer. |
| [`@henryqw/pi-prompt-creator`](./extensions/pi-prompt-creator) | Turn current-conversation patterns into reviewed global prompt templates. |
| [`@henryqw/pi-session-recall`](./extensions/pi-session-recall) | Search past Pi sessions with local FTS5 and zero LLM calls. |
| [`@henryqw/pi-subagent`](./extensions/pi-subagent) | Delegate bounded single, parallel, chained, and extension-owned Git Flow work to isolated roles. |
| [`@henryqw/pi-task-models`](./extensions/pi-task-models) | Shared `fast`/`balanced`/`frontier` model profiles for HenryQW extensions. |
| [`@henryqw/pi-undo`](./extensions/pi-undo) | Rewind conversation context to the latest prompt. |

## Extension dependency graph

The diagram covers 20 extensions. It predates `pi-prompt-creator`, which is listed in the catalog above.

Solid arrows (`-->`) show internal `@henryqw` npm runtime dependencies. Dashed arrows (`-.->`) show direct runtime protocols or couplings. Arrows point from the consumer to the provider.

![Extension dependency graph](./docs/extension-dependency-graph.svg)

## Deprecated

Retired extensions and their replacements are recorded under [`deprecated/`](./deprecated).

## Remove

```bash
pi remove npm:@henryqw/<extension>
```

Replace `<extension>` with the extension's unscoped name, for example `pi-subagent`.

Before removing `@henryqw/pi-deps`, disable each opted-in repository with `/deps`. Its copied hook is self-contained.

After removing `@henryqw/pi-session-recall`, delete its derived index to reclaim storage:

```bash
rm -rf ~/.pi/agent/config/pi-session-recall/
```

## Development

Requires Node.js `>=22.19.0` and pnpm `11.24.0`.

```bash
pnpm install --frozen-lockfile
pnpm test
pnpm run typecheck
pnpm run pack:check
```

Run live Pi integration tests only when authenticated model access is available:

```bash
pnpm run test:live
```

Live tests use real model requests. They can incur provider cost. They set a temporary small context window so compaction completes quickly.

Manual Pi TUI check for `@henryqw/pi-ask-question`:

```bash
pnpm --filter @henryqw/pi-ask-question run test:manual
```

`@henryqw/pi-auto-compact` live test needs real Pi and authenticated model access:

```bash
pnpm --filter @henryqw/pi-auto-compact run test:live
PI_AUTO_COMPACT_AUTH_FILE=/path/to/auth.json pnpm --filter @henryqw/pi-auto-compact run test:live
```

Set `PI_AUTO_COMPACT_AUTH_FILE` only when auth is not at `~/.pi/agent/auth.json`.

## Documentation site

The landing page uses workspace manifests. The overview and extension pages use their READMEs directly. The site publishes at <https://pi.henry.wang>.

```bash
pnpm run docs:dev
pnpm run docs:build
pnpm run docs:validate
```

`docs:dev` starts local development. `docs:build` writes static files to `website/dist/`.

## Release

See [`docs/releasing.md`](./docs/releasing.md). Each extension publishes independently as an npm package under the `@henryqw` scope.
