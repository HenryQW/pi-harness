# Pi Config Store Migration

Agent record and runbook for the move of every user-edited extension config to the `@henryqw/pi-config-store` 4.x field contract. It applies the warn and disable rule in [ADR 004](../adr/004-extension-config-safety.md) and the ownership rules in [ADR 018](../adr/018-extension-config-homes.md).

This is the single migration source of truth. Do not add a second `MIGRATION.md` inside the package.

**Status:** complete. The store contract and every consumer below use the 4.x field contract. Every consumer depends on `@henryqw/pi-config-store` `^4.0.0`, and every `@henryqw/pi-task-models` consumer depends on `^9.0.0`. Use this page as the reference for a new config or a change to an existing one.

The earlier one-time move to Extension Config Homes is complete. Runtime code reads only `config/<extension-id>/`.

## Invariants

- Every user-edited config loads through `createConfigStore` with `fields` or `entries`. No direct `JSON.parse` of a config file, and no raw `readFileSync` of `config.json`.
- Generated state and recovery files stay strict and owner-local. Do not move them to fields.
- Do not change any file format. Existing valid files must load with the same effective values.
- `loadSync()` never throws for file content or I/O. Do not wrap it in `try`/`catch` for those cases.
- Register `registerConfigReporting(pi, [stores...])` once in the extension factory. Pass each lazy read result of a command or event to `reporter.report(ctx, store, result)`. Never report from a render; launch reporting covers a store that a render reads. All reporters in the process share one record per `session_start` event, so several extensions can report the same file and each issue still shows once.
- A consumer of another owner's config registers the owner's reporting hook and calls it before each lazy read: `registerTaskModelsConfigReporting` (`@henryqw/pi-task-models`) before route resolution, and `registerRoleDefaultsReporting` (`@henryqw/pi-subagent`) before `loadRoleCatalog`. The owner API must never drop a nonblocking issue silently.
- When `status` is `disabled`, disable features that need the config. Keep config repair commands working; they write with `store.save`.
- `store.update` refuses a file with any issue. A repair flow that builds its value from an earlier `loadSync()` snapshot replaces a broken file with `store.replaceIfUnchanged(snapshot, value)`, which compares the file bytes under the lock and refuses a changed file. `store.save` is only for a full replacement that does not depend on the current file. Before any replacement, including `save`, load and report the current file, and never drop a setting whose default is unsafe unless the command sets it.
- A write command never writes back a cached or session-start value. It loads and reports the file, then merges its change into the latest value with `update` when that load is clean, or uses `replaceIfUnchanged` with that load when it has issues, so a change made during a dialog is never overwritten.
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

**Near-miss keys.** An unknown key that misspells a declared key that is not in the file counts as an invalid value of that declared key. The match ignores letter case and allows at most one edit (insert, delete, replace, or swap of two adjacent characters) for each three characters of the declared key, and at most two edits. The issue is `<key>: unknown key "<typo>"; did you mean "<key>"?`, and the field rule applies: the default, or a disabled config for `required` and `onInvalid: "disable"`. Thus, a misspelled unsafe key, such as `maxToken` for `maxTokens`, never fails open. Other unknown keys only warn. The rule applies to each field table, also in `parsers.object`, but not to `parsers.record` keys or `entries`. When a consumer must treat an invalid value differently from a missing one (for example, an opt-out switch that must stay off), check `issues` for the field key or for `""` (a file-level issue).

## Consumer units

Each package owns its source, tests, and README.

| Package | Store | Root shape | Field notes |
| --- | --- | --- | --- |
| `pi-bark` | `pi-bark` | fixed fields | `serverUrl` `required` custom (`parseServerUrl`): the default server would receive the Device Key; `deviceKey` `required(string({ trim: true }))`; `encryption` `required(nullable(...))` custom strict parser: a `null` default would send plaintext; `statusNotifications` `object` with `cwdOverrides` `record(boolean, { key: absolutePath() })`. Repair commands read a draft store over the same file (no disabling field, absent safety keys stay unset), report its issues, refuse a missing or invalid `serverUrl`, `deviceKey`, or `encryption` that the command does not set (`/bark` also refuses while the main store is disabled), then `update` a clean file or `replaceIfUnchanged` a file with issues. |
| `pi-footer` | `pi-footer` | fixed fields | `colors` `record(colorValue, { key: oneOf(FOOTER_COLOR_ROLES) })`. Read and report at session start. |
| `pi-footer` (open-in) | `pi-open-in` | fixed fields | `command` `field(string({ trim: true }), "code")`. `createOpenInConfigStore` (`extensions/open-in-config.ts`) builds the store. `footer.ts` and `open.ts` both pass it to `registerConfigReporting`, which reports at session start; the shared report record shows each issue one time, also with footer-only activation. `/open` reports its read. Renders call `configuredOpenUri`, which never throws or notifies. `loadOpenInConfig` returns `ConfigLoad` (pi-footer 5.0.0). |
| `pi-task-models` | `pi-task-models` `config.json` | fixed fields | `profiles` `record(profile, { key: oneOf(PROFILE_NAMES) })` with `onInvalid: "disable"`, because no default route is safe; `tasks` `record(oneOf(PROFILE_NAMES), { key: taskId })`. Profile parser keeps route normalization and the `fav` no-fallback rule. `/task-models` reads a repair store without the disable rule, so a confirmed save keeps the `tasks` that loaded; it saves with `replaceIfUnchanged`, which refuses a file changed after the snapshot. Consumers register `registerTaskModelsConfigReporting`. The owner API throws `config-disabled` with the path and the issues; consumers pass that message through. |
| `pi-task-models` | `pi-task-models` `presets.json` | `entries` | `fileName: "presets.json"`, `entries: record(record(profile, { key: oneOf(PROFILE_NAMES) }), { key: presetName })`. Replace the custom lock and write with `store.update`. |
| `pi-memory` | `pi-memory` | fixed fields | `directory` `absolutePath()` with `onInvalid: "disable"`, so an invalid or misspelled `directory` disables memory; char limits `integer({ min: 1, max: 100_000 })`. |
| `pi-prompt-creator` | `pi-prompt-creator` | fixed fields | `automatic` `boolean()`, `inputThreshold` `integer({ min: 1 })`. An `automatic` issue or a file-level issue keeps automatic analysis off; a missing file uses `true`. |
| `pi-auto-compact` | `pi-auto-compact` | fixed fields | `autoCompactThreshold` `number({ min: 25, lessThan: 100 })`. |
| `pi-multi-codex` | `pi-multi-codex` | fixed fields | `autoSwitchOn429` `field(boolean(), true)`. An `autoSwitchOn429` issue or a file-level issue keeps 429 switching off; a missing file uses `true`. Keep `usage.json` strict. |
| `pi-cron` | `pi-cron` | fixed fields | `jobs` `array(job, { unique: (job) => job.id })` with the custom job parser; `limits` custom object parser with the `maxMinutes > idleMinutes` rule. Keep run state strict. |
| `pi-herdr-tools` | `pi-herdr-btw` | fixed fields | `autoSubmit` `boolean()`, `tools` `oneOf(TOOL_MODES)`, `split` `oneOf(["right", "down"])`. `/btw config` keeps `update`; reset uses `save`. |
| `pi-add-dir` | `pi-add-dir` | fixed fields | `directories` `array(absolutePath(), { unique: (dir) => dir })`. |
| `pi-subagent` | `pi-subagent` | fixed fields | Bounded execution limits use `integer`/`number` and fall back to their finite defaults; `maxTokens` uses `onInvalid: "disable"` because its default is unlimited, so an invalid or misspelled `maxTokens` blocks delegation, and a session that started disabled needs `/reload`; `timeout` `object` plus the idle/max rule; `roleDefaults` custom parser from `parseRoleDefaults` that drops bad keys. `readRoleDefaults` (`src/index.ts`) reads only `roleDefaults` and throws only for a file-level issue, so a bad limit does not break `loadRoleCatalog` for other consumers; catalog consumers such as pi-cron report its issues with `registerRoleDefaultsReporting`. Every lazy policy, Role catalog, or route read in the extension reports first, and each deferred direct or isolated Role launch also revalidates with `currentPolicy()` so a now-disabled config blocks it (running workflows keep their admitted limits); the isolated runner's `currentPolicy` reports through the latest session context. |
| `pi-pr` | `pi-pr` | fixed fields | `mergeMethod` `oneOf(MERGE_METHODS)`, `codexReview` `boolean()`, numeric limits `integer` with the current bounds. `createPrPolicyStore()` (`extensions/pr-run.ts`) builds the store; `/pr` loads it with `loadSync()`, reports its issues, and no longer throws for bad optional values. |

`pi-notes` and `pi-session-recall` own only generated state; they need no runtime change.

## Validate a change

Run the package's own checks and update its README when user-visible behavior changes:

```bash
pnpm --filter <package> run test
pnpm --filter <package> run --if-present typecheck
git diff --check
```

Add the smallest regression tests for: an unknown key warns, an invalid optional value uses its default, a near-miss key of each `required` or `disable` field disables the features, and repair commands still work. Before a push, run `pnpm install --frozen-lockfile`, all package tests and typechecks, `pnpm run check:package-versions`, and `pnpm run docs:validate`.
