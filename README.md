# HenryQW Pi packages

Public Pi packages under `@henryqw` scope.

## Packages

| Package | Purpose |
| --- | --- |
| [`@henryqw/pi-add-dir`](./packages/pi-add-dir) | Add external directories with context, skills, and file search. |
| [`@henryqw/pi-ask-question`](./packages/pi-ask-question) | Ask user one interactive multiple-choice or free-text question. |
| [`@henryqw/pi-auto-compact`](./packages/pi-auto-compact) | Compact context at the set threshold and resume current task. |
| [`@henryqw/pi-auto-dag`](./packages/pi-auto-dag) | Execute an approved local Delivery Graph through Pi workers. |
| [`@henryqw/pi-herdr`](./packages/pi-herdr) | Run Herdr CLI commands through a shared thin client. |
| [`@henryqw/pi-herdr-btw`](./packages/pi-herdr-btw) | Open and merge Pi side threads in Herdr panes. |
| [`@henryqw/pi-herdr-clone`](./packages/pi-herdr-clone) | Clone the current Pi conversation path into a new Herdr tab. |
| [`@henryqw/pi-herdr-done`](./packages/pi-herdr-done) | Close and remove current Herdr worktree. |
| [`@henryqw/pi-herdr-rename`](./packages/pi-herdr-rename) | Generate short chat titles and rename current Herdr location. |
| [`@henryqw/pi-model-thinking`](./packages/pi-model-thinking) | Remember chosen thinking level per model. |
| [`@henryqw/pi-multi-codex`](./packages/pi-multi-codex) | Use multiple ChatGPT Codex OAuth accounts in Pi. |
| [`@henryqw/pi-open-in`](./packages/pi-open-in) | Open current working directory with configurable command. |
| [`@henryqw/pi-footer`](./packages/pi-footer) | Henry's opinionated Pi footer style for concise checkout and usage details. |
| [`@henryqw/pi-pr`](./packages/pi-pr) | Show current-branch PR lifecycle, CI, mergeability, and review state in Pi footer. |
| [`@henryqw/pi-subagent`](./packages/pi-subagent) | Delegate one task to an isolated role with explicit extensions and skills. |
| [`@henryqw/pi-task-models`](./packages/pi-task-models) | Shared `fast`/`balanced`/`frontier` model profiles for HenryQW extensions. |

## Development

Requires Node.js `>=22.19.0`.

```bash
npm ci
npm test
npm run typecheck
npm run pack:check
```

Run live Pi integration tests only when authenticated model access is available:

```bash
npm run test:live
```

Live tests use real model requests and can incur provider cost. They set a temporary small context window so compaction completes quickly.

## Release

See [`docs/releasing.md`](./docs/releasing.md). Each package publishes independently; package names use `@henryqw` scope.
