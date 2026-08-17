# HenryQW Pi packages

Public Pi packages under `@henryqw` scope.

## Packages

| Package | Install | Purpose |
| --- | --- | --- |
| [`@henryqw/pi-add-dir`](./packages/pi-add-dir) | `pi install npm:@henryqw/pi-add-dir` | Add external directories with context, skills, and file search. |
| [`@henryqw/pi-ask-question`](./packages/pi-ask-question) | `pi install npm:@henryqw/pi-ask-question` | Ask user one interactive multiple-choice or free-text question. |
| [`@henryqw/pi-auto-compact`](./packages/pi-auto-compact) | `pi install npm:@henryqw/pi-auto-compact` | Compact context at the set threshold and resume current task. |
| [`@henryqw/pi-auto-dag`](./packages/pi-auto-dag) | `pi install npm:@henryqw/pi-auto-dag` | Execute an approved local Delivery Graph through Pi workers. |
| [`@henryqw/pi-herdr`](./packages/pi-herdr) | `npm install @henryqw/pi-herdr` | Run Herdr CLI commands through a shared thin client. |
| [`@henryqw/pi-herdr-btw`](./packages/pi-herdr-btw) | `pi install npm:@henryqw/pi-herdr-btw` | Open and merge Pi side threads in Herdr panes. |
| [`@henryqw/pi-herdr-clone`](./packages/pi-herdr-clone) | `pi install npm:@henryqw/pi-herdr-clone` | Clone the current Pi conversation path into a new Herdr tab. |
| [`@henryqw/pi-herdr-rename`](./packages/pi-herdr-rename) | `pi install npm:@henryqw/pi-herdr-rename` | Generate short chat titles and rename current Herdr location. |
| [`@henryqw/pi-model-thinking`](./packages/pi-model-thinking) | `pi install npm:@henryqw/pi-model-thinking` | Remember chosen thinking level per model. |
| [`@henryqw/pi-multi-codex`](./packages/pi-multi-codex) | `pi install npm:@henryqw/pi-multi-codex` | Use multiple ChatGPT Codex OAuth accounts in Pi. |
| [`@henryqw/pi-open-in`](./packages/pi-open-in) | `pi install npm:@henryqw/pi-open-in` | Open current working directory with configurable command. |
| [`@henryqw/pi-subagent`](./packages/pi-subagent) | `pi install npm:@henryqw/pi-subagent` | Delegate one task to an isolated role with explicit extensions and skills. |
| [`@henryqw/pi-task-models`](./packages/pi-task-models) | `pi install npm:@henryqw/pi-task-models` | Shared `fast`/`balanced`/`frontier` model profiles for HenryQW extensions. |

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
