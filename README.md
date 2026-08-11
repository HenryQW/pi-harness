# HenryQW Pi packages

Public Pi packages under `@henryqw` scope.

## Packages

| Package | Install | Purpose |
| --- | --- | --- |
| [`@henryqw/pi-auto-compact`](./packages/pi-auto-compact) | `pi install npm:@henryqw/pi-auto-compact` | Compact context at the set threshold and resume current task. |
| [`@henryqw/pi-auto-dag`](./packages/pi-auto-dag) | `pi install npm:@henryqw/pi-auto-dag` | Execute an approved local Delivery Graph through Pi workers. |
| [`@henryqw/pi-herdr`](./packages/pi-herdr) | `npm install @henryqw/pi-herdr` | Run Herdr CLI commands through a shared thin client. |
| [`@henryqw/pi-herdr-subagents`](./packages/pi-herdr-subagents) | `pi install npm:@henryqw/pi-herdr-subagents` | Delegate bounded work to interactive Pi Subagents in Herdr tabs. |
| [`@henryqw/pi-model-thinking`](./packages/pi-model-thinking) | `pi install npm:@henryqw/pi-model-thinking` | Remember chosen thinking level per model. |
| [`@henryqw/pi-open-in`](./packages/pi-open-in) | `pi install npm:@henryqw/pi-open-in` | Open current working directory with configurable command. |

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
