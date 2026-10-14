# Pi Config Store Migration

Agent runbook for moving every user-edited extension config to the `@henryqw/pi-config-store` 4.x field contract. It applies the warn and disable rule in [ADR 004](../adr/004-extension-config-safety.md) and the ownership rules in [ADR 018](../adr/018-extension-config-homes.md).

This is the single migration source of truth. Do not add a second `MIGRATION.md` inside the package.

**Status:** the store contract, versions, and lockfile are complete. Each consumer migration below is pending until its own task lands. Until then, unmigrated consumers do not typecheck against `^4.0.0`, and the root `postinstall` build fails in `pi-task-models`.

The earlier one-time move to Extension Config Homes is complete. Runtime code reads only `config/<extension-id>/`.

## Invariants

- Every user-edited config loads through `createConfigStore` with `fields` or `entries`. No direct `JSON.parse` of a config file, and no raw `readFileSync` of `config.json`.
- Generated state and recovery files stay strict and owner-local. Do not move them to fields.
- Do not change any file format. Existing valid files must load with the same effective values.
- `loadSync()` never throws for file content or I/O. Do not wrap it in `try`/`catch` for those cases.
- Register `registerConfigReporting(pi, [stores...])` once in the extension factory. Pass every lazy read result (per command, per render, per event) to `reporter.report(ctx, store, result)`.
- When `status` is `disabled`, disable features that need the config. Keep config repair commands working; they write with `store.save`.
- `store.update` refuses a file with any issue. Repair flows that must replace a broken file use `store.save`.
- Parsers of a store that writes must accept their own output.
- Only the owner reads its files. Consumers use the owner API.

## Contract

```ts
createConfigStore({ extensionId, agentDir?, fileName?, fields, check? })
createConfigStore({ extensionId, agentDir?, fileName?, entries, check? })
field(parse, fallback, { onInvalid?: "default" | "disable" })
required(parse)
parsers.boolean() | number(range) | integer(range) | string({ trim? }) | absolutePath()
       | oneOf(values) | nullable(p) | object(fields) | record(value, { key? }) | array(item, { unique? })
store.loadSync(): ConfigLoad<T>  // { status: "ok", source, value, issues } | { status: "disabled", source, issues }
registerConfigReporting(pi, stores): { report(ctx, store, result) }
```

Rules for choosing a field:

| Setting | Declaration |
| --- | --- |
| Optional with a safe default | `field(parser, default)` |
| Default would read or write the wrong place, or weaken a safety limit | `field(parser, default, { onInvalid: "disable" })` |
| No usable default | `required(parser)` |
| Map of user names | `parsers.record(value, { key })`; a bad entry is dropped |
| List | `parsers.array(item, { unique })`; a bad item is dropped |
| Rule across fields | `check`, or a custom parser for a nested object |

A custom `FieldParser` throws to reject the whole value. Use `report(path, message)` only for an entry that it drops.

## Consumer units

Each package is one bounded runtime unit. It owns its source, tests, and README. It does not edit `package.json`, versions, or `pnpm-lock.yaml`; this contract commit already set every `@henryqw/pi-config-store` range to `^4.0.0` and bumped each consumer.

| Package | Store | Root shape | Field notes |
| --- | --- | --- | --- |
| `pi-bark` | `pi-bark` | fixed fields | `serverUrl` custom (`parseServerUrl`); `deviceKey` `nullable(string({ trim: true }))`; `encryption` custom strict parser with `onInvalid: "disable"` (a `null` fallback would send unencrypted); `statusNotifications` `object` with `cwdOverrides` `record(boolean, { key: absolutePath() })`. |
| `pi-footer` | `pi-footer` | fixed fields | `colors` `record(colorValue, { key: oneOf(FOOTER_COLOR_ROLES) })`. Report per-render reads. |
| `pi-footer` (open-in) | `pi-open-in` | fixed fields | `command` `field(string({ trim: true }), "code")`. Report per-call and per-render reads; `configuredOpenUri` must not throw. |
| `pi-task-models` | `pi-task-models` `config.json` | fixed fields | `profiles` `record(profile, { key: oneOf(PROFILE_NAMES) })`; `tasks` `record(oneOf(PROFILE_NAMES), { key: taskId })`. Profile parser keeps route normalization and the `fav` no-fallback rule. Keep the owner API result shape explicit for consumers. |
| `pi-task-models` | `pi-task-models` `presets.json` | `entries` | `fileName: "presets.json"`, `entries: record(record(profile, { key: oneOf(PROFILE_NAMES) }), { key: presetName })`. Replace the custom lock and write with `store.update`. |
| `pi-memory` | `pi-memory` | fixed fields | `directory` `absolutePath()` with `onInvalid: "disable"`; char limits `integer({ min: 1, max: 100_000 })`. |
| `pi-prompt-creator` | `pi-prompt-creator` | fixed fields | `automatic` `boolean()`, `inputThreshold` `integer({ min: 1 })`. |
| `pi-auto-compact` | `pi-auto-compact` | fixed fields | `autoCompactThreshold` `number({ min: 25, lessThan: 100 })`. |
| `pi-multi-codex` | `pi-multi-codex` | fixed fields | `autoSwitchOn429` `field(boolean(), true)`. Keep `usage.json` strict. |
| `pi-cron` | `pi-cron` | fixed fields | `jobs` `array(job, { unique: (job) => job.id })` with the custom job parser; `limits` custom object parser with the `maxMinutes > idleMinutes` rule. Keep run state strict. |
| `pi-herdr-tools` | `pi-herdr-btw` | fixed fields | `autoSubmit` `boolean()`, `tools` `oneOf(TOOL_MODES)`, `split` `oneOf(["right", "down"])`. `/btw config` keeps `update`; reset uses `save`. |
| `pi-add-dir` | `pi-add-dir` | fixed fields | `directories` `array(absolutePath(), { unique: (dir) => dir })`. |
| `pi-subagent` | `pi-subagent` | fixed fields | Bounded execution limits use `integer`/`number` and fall back to their finite defaults; `maxTokens` uses `onInvalid: "disable"` because its default is unlimited, so delegation stays blocked; `timeout` `object` plus the idle/max rule; `roleDefaults` custom parser from `parseRoleDefaults` that drops bad keys. Replace the raw `readFileSync` in `readRoleDefaults` (`src/index.ts`) with the same store. |
| `pi-pr` | `pi-pr` | fixed fields | `mergeMethod` `oneOf(MERGE_METHODS)`, `codexReview` `boolean()`, numeric limits `integer` with the current bounds. `loadPrPolicy` stops throwing for bad optional values. |

`pi-notes` and `pi-session-recall` own only generated state; they need no runtime change.

## Validate each unit

Run the package's own checks and update its README when user-visible behavior changes:

```bash
pnpm --filter <package> run test
pnpm --filter <package> run --if-present typecheck
git diff --check
```

Add the smallest regression tests for: an unknown key warns, an invalid optional value uses its default, and each required or `disable` field disables the features while repair commands still work.

## Finish

After every unit lands, Main runs `pnpm install --frozen-lockfile`, all package tests and typechecks, `pnpm run check:package-versions`, and `pnpm run docs:validate`. Do not publish, push, or edit user files from an isolated subagent worktree.
