# HenryQW Pi packages

Public Pi packages under `@henryqw` scope.

## Packages

| Package | Install | Purpose |
| --- | --- | --- |
| [`@henryqw/pi-auto-compact`](./packages/pi-auto-compact) | `pi install npm:@henryqw/pi-auto-compact` | Compact context at 50% and resume current task. |
| [`@henryqw/pi-model-thinking`](./packages/pi-model-thinking) | `pi install npm:@henryqw/pi-model-thinking` | Remember chosen thinking level per model. |

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

## Install a package

```bash
pi install npm:@henryqw/pi-auto-compact
pi install npm:@henryqw/pi-model-thinking
```
