# Pi Config Store Migration

Agent runbook for introducing `@henryqw/pi-config-store` and moving every current extension to the Extension Config Home layout from [ADR 018](../adr/018-extension-config-homes.md).

This is the single migration source of truth. Do not add a second `MIGRATION.md` inside the package.

## Invariants

- Use `getAgentDir()/config`, never a hardcoded home path.
- Every extension owns `config/<extension-id>/`.
- Default user JSON is `config/<extension-id>/config.json`.
- Only the owner writes its home.
- Consumers use an owner API or namespaced Pi events.
- Preserve malformed files and write only after explicit user action.
- Missing user config warns once per extension session before defaults are used.
- Missing generated state is normal and does not warn.
- Move existing files once outside runtime code. Add no legacy readers, aliases, adapters, dual schemas, or fallback paths.

## Delivery DAG

```text
Freeze public contract
        │
        ├──────────────┬──────────────────┐
        ▼              ▼                  ▼
Config-store core   Human README   This agent runbook
        └──────────────┴──────────────────┘
                       │
                       ▼
          Combined package validation
                       │
                       ▼
             Release config-store
                       │
          ┌────────────┴────────────┐
          ▼                         ▼
  Migrate task-models         Migrate open-in
  owner API and config        owner API and config
          │                         │
          ├──────────────┬──────────┼──────────────┐
          ▼              ▼          ▼              ▼
  auto-compact      herdr-btw    memory         subagent
          │              │          │              │
          └──────────┐   │          │              │
                     ▼   ▼          ▼              ▼
                herdr-rename     footer      remaining consumers

Independent custom-state helper migrations:
  multi-codex | notes | session-recall

All repository code integrated
        │
        ▼
Main moves local user files once; stop on conflicts
        │
        ▼
Update AGENTS.md, README template, stale paths, versions, lockfile
```

Owner packages must land before their consumers. Package runtime units may run in parallel only when they own disjoint files. Keep manifests, workspace versions, and `package-lock.json` in one central unit.

## Stage 1: Build `pi-config-store`

Freeze this public contract before parallel work:

```ts
extensionConfigDir(extensionId, agentDir?)
extensionConfigPath(extensionId, agentDir?)

createConfigStore({
  extensionId,
  agentDir?,
  defaults: () => T,
  parse: (value: unknown) => T,
})
```

The store exposes `path`, synchronous load with `{ source: "file" | "missing", value }`, and asynchronous `save`, locked `update`, and `remove`.

Run three disjoint units in parallel:

1. **Core package:** manifest, lockfile, source, tests, build config, and license.
2. **Human README:** package behavior and examples only.
3. **Agent runbook:** this file only.

Core requirements:

- validate extension IDs as one lowercase path component;
- keep path helpers free of filesystem side effects;
- bound JSON reads to 64 KiB and decode UTF-8 strictly;
- validate parsed `unknown` through the owner parser;
- preserve malformed and schema-invalid files;
- return missing defaults without creating a file;
- lock every mutation;
- write with a same-directory temporary file and atomic rename;
- use directory mode `0700` and file mode `0600`;
- remove only `config.json`.

Do not add UI, schemas, migration helpers, custom-format storage, or compatibility APIs.

Validate the integrated package:

```bash
npm test --workspace @henryqw/pi-config-store
npm run typecheck --workspace @henryqw/pi-config-store
npm run pack:check --workspace @henryqw/pi-config-store
git diff --check
```

Only new `@henryqw/pi-config-store@0.1.0` releases in this stage.

## Stage 2: Prepare extension migrations

After the config-store package is available, use one central metadata unit to:

1. add `@henryqw/pi-config-store` to every owner using its store or path helper;
2. remove direct `proper-lockfile` dependencies only where no other feature needs them;
3. bump every affected public package once with `npm version`;
4. regenerate `package-lock.json` once.

Runtime units must not edit package manifests, versions, or the lockfile.

## Stage 3: Migrate owners and consumers

Every package section below is one bounded runtime unit unless an owner API and its direct consumer must change together. Each unit owns only its package source, tests, and README.

### `pi-task-models`

- Move `config/pi-task-models.json` to `config/pi-task-models/config.json` during the one-time filesystem step.
- Replace local path and JSON I/O with the shared store.
- Keep task-model parsing, normalization, defaults, and route errors package-owned.
- Expose an owner API that returns validated effective config and whether the file was missing.
- Remove the old public path shape rather than aliasing it.
- Warn once when its own extension loads without config.
- Update direct consumers: `pi-auto-compact`, `pi-herdr-btw`, `pi-herdr-rename`, `pi-memory`, and `pi-subagent`.

### `pi-open-in`

- Move `config/pi-open-in.json` to `config/pi-open-in/config.json`.
- Keep command validation and the `code` default package-owned.
- Expose validated effective config plus missing source to consumers.
- Warn once when its extension loads without config.
- Update `pi-footer` to consume the owner API; it must not know the path.

### `pi-auto-compact`

- Move `config/pi-auto-compact.json` to `config/pi-auto-compact/config.json`.
- Replace `readConfig` and `writeConfig` filesystem mechanics with the store.
- Keep threshold parsing and defaults local.
- Warn once for missing local config.
- Consume task-model data through the owner API and warn once if that shared config is missing.
- Update local and shared-config fixtures.

### `pi-herdr-btw`

- Move `config/pi-herdr-btw.json` to `config/pi-herdr-btw/config.json`.
- Delete the package-local generic `ConfigStore` mechanics after adopting the shared store.
- Retain `parseConfig`, command application, formatting, and defaults.
- Preserve concurrent no-lost-update behavior through the shared locked update.
- Warn once for missing local config and once for missing required shared task-model config.

### `pi-herdr-rename`

- It owns no local config.
- Replace shared task-model access with the owner API.
- Warn once when the shared config is missing.
- Update task-model path fixtures and README references.

### `pi-memory`

- `config/pi-memory/config.json` already has the target path; do not move it.
- Use the shared store while retaining strict memory-specific validation.
- Use the directory helper for `memory/`, `backups/`, and `dream.json`.
- Do not move those files.
- Warn once for missing local config and once for missing shared task-model config.
- Keep memory mutation locking; remove no dependency still used by memory storage.

### `pi-subagent`

- Move `config/pi-subagent/pi-subagent.json` to `config/pi-subagent/config.json`.
- Keep role Markdown files in `config/pi-subagent/` unchanged.
- Use the shared store for JSON and the directory helper for role files.
- Preserve optional-config diagnostics and defaults without rewriting malformed files.
- Warn once for missing local config and once for missing shared task-model config.

### `pi-footer`

- It owns no local config.
- Consume validated open-in values through the owner API.
- Warn once when open-in config is missing.
- Update footer fixtures from the flat path to the owner home.

### `pi-multi-codex`

- Keep `config/pi-multi-codex/usage.json` in place.
- Replace repeated directory joins with the shared directory helper.
- Keep cache parsing, abort handling, locking, and atomic writes package-owned.
- Do not warn when the generated cache is absent.

### `pi-notes`

- Keep `config/pi-notes/<worktree-hash>.json` in place.
- Replace the local directory helper with the shared helper.
- Keep note identity, validation, pruning, and persistence package-owned.
- Do not warn when generated note state is absent.

### `pi-session-recall`

- Keep `config/pi-session-recall/index.db` in place.
- Replace the local directory join with the shared helper.
- Keep SQLite lifecycle and rebuild behavior package-owned.
- Do not warn when the disposable index is absent.

## Stage 4: Move local files once

Main performs this step outside delegated worktrees after all code is integrated and before restarting Pi.

For each changed path:

1. stop active Pi processes;
2. resolve the effective agent directory;
3. if only the old path exists, create the target home and move the file without parsing or rewriting it;
4. if only the new path exists, do nothing;
5. if neither exists, do nothing and expect the extension warning;
6. if both exist, overwrite neither and ask the user which file is authoritative;
7. verify bytes and permissions after each move.

Move these files:

| Old | New |
| --- | --- |
| `config/pi-auto-compact.json` | `config/pi-auto-compact/config.json` |
| `config/pi-herdr-btw.json` | `config/pi-herdr-btw/config.json` |
| `config/pi-open-in.json` | `config/pi-open-in/config.json` |
| `config/pi-subagent/pi-subagent.json` | `config/pi-subagent/config.json` |
| `config/pi-task-models.json` | `config/pi-task-models/config.json` |

Do not move `pi-memory`, `pi-multi-codex`, `pi-notes`, or `pi-session-recall` state already inside its owner home.

## Stage 5: Finish repository policy

After every runtime migration and local file move:

1. replace the transitional path rules in `AGENTS.md` with ADR 018's Extension Config Home rule;
2. change `packages/README-template.md` to `~/.pi/agent/config/<package>/config.json`;
3. search current source, tests, READMEs, context files, root docs, and deprecated docs for old paths;
4. remove obsolete local JSON I/O and lock helpers;
5. validate each changed package once;
6. run repository tests, typechecks, pack checks, version checks, and `git diff --check`.

Do not publish, push, or move user files from an isolated subagent worktree.
