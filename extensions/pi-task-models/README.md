# `@henryqw/pi-task-models`

Configure shared Task Profiles for `fast`, `balanced`, `frontier`, and `fav`. Each Task Route pairs a model with a thinking level; each consumer owns its Model Tasks and defaults.

![Pi showing task model profiles and task routes](./example.png)
![A Model Task selects a Task Profile and resolves Task Routes; config and profile errors occur before resolution, and no-route follows it.](./docs/task-routing-architecture.svg)

## Install

```bash
pi install npm:@henryqw/pi-task-models
```

## Works with

| Package | Relationship | Purpose |
| --- | --- | --- |
| [`@henryqw/pi-auto-compact`](https://pi.henry.wang/extensions/pi-auto-compact) | Consumer | Compaction defaults to `fast`. |
| [`@henryqw/pi-cron`](https://pi.henry.wang/extensions/pi-cron) | Consumer | Scheduled jobs default to `fast`. |
| [`@henryqw/pi-herdr-tools`](https://pi.henry.wang/extensions/pi-herdr-tools) | Consumer | Side-thread and rename tasks default to `fast`. |
| [`@henryqw/pi-memory`](https://pi.henry.wang/extensions/pi-memory) | Consumer | Candidate review, `/remember` preparation, and `/dream` promotion default to `balanced`. |
| [`@henryqw/pi-multi-codex`](https://pi.henry.wang/extensions/pi-multi-codex) | Improves | Numbered Codex slots become one route. |
| [`@henryqw/pi-prompt-creator`](https://pi.henry.wang/extensions/pi-prompt-creator) | Consumer | Prompt drafting defaults to `fast`. |
| [`@henryqw/pi-subagent`](https://pi.henry.wang/extensions/pi-subagent) | Consumer | Delegation defaults to `fast`. Callers can declare their own task. |

## Use

Run `/task-models`, select `fast`, then choose a primary model and thinking level. Choose a different fallback model and thinking level, or `None`. Reopen `/task-models`: `fast` shows the saved route instead of `not configured`.

| Surface | Type | Purpose |
| --- | --- | --- |
| `/task-models` | command | For people: configure profiles and assign them to active tasks. |
| `/task-models preset` | command | For people: apply a saved profile setup. |
| Option+S / Alt+S in `/task-models` | shortcut | For people: save configured profiles as a named preset in the interactive terminal. |
| Session start | ui | For people: warn about missing config and config or preset problems. Show an error when routing is disabled. |

Configure each profile your consumers require. `fav` has no fallback. Select an active task to override its declared profile; choosing its declared default removes the override.

### Presets

Run `/task-models preset` and choose a name. Included profiles replace complete routes, thinking levels, and fallbacks in one atomic update. Omitted profiles and task assignments stay unchanged. Cancellation writes nothing.

To save, open `/task-models`, press **Option+S** (macOS) or **Alt+S**, then enter a name. Configure at least one profile first. The preset contains all configured profiles, not task assignments. Replacing an existing name requires confirmation; other presets stay unchanged. Cancelling either prompt writes nothing.

The shortcut requires an interactive terminal that sends Option/Alt as Meta (Escape); RPC does not support it.

## Flow

The menu shows effective profiles for active tasks. Disabled consumers' assignments remain stored but hidden.

Menus and resolution use `ctx.scopedModels`, including pinned thinking levels. An empty scope uses available text models from Pi's registry. Duplicate numbered Codex aliases collapse into one choice; fallback choices exclude the primary.

## Config

Package-owned: `~/.pi/agent/config/pi-task-models/config.json`. Only explicit `/task-models` actions save it. Use exact model IDs from Pi's registry, not these placeholders:

```json
{
  "profiles": {
    "fast": {
      "primary": { "model": "<provider>/<model>", "thinkingLevel": "low" }
    }
  },
  "tasks": {}
}
```

| Name | Description | Values | Default |
| --- | --- | --- | --- |
| `profiles` | Stores shared routes. | Object keyed by `fast`, `balanced`, `frontier`, or `fav`. | `{}` |
| `profiles.<profile>.primary.model` | Required primary model. | Canonical `provider/model` without whitespace or NUL. | — |
| `profiles.<profile>.primary.thinkingLevel` | Required primary thinking level. | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`; model support required at resolution. | — |
| `profiles.<profile>.fallback` | Route to try when the primary is unavailable. | Object requiring `model` and `thinkingLevel`, with primary rules. Forbidden for `fav`. | No fallback. |
| `tasks` | Explicit profile overrides. | Object mapping `<package>/<task>` IDs to profiles. | `{}` |
| `tasks.<taskId>` | Overrides the declared profile. | `fast`, `balanced`, `frontier`, or `fav`. | Task declaration's `defaultProfile`. |

Task defaults belong to consumer declarations. Existing overrides equal to those defaults remain valid. Numbered `openai-codex-N` aliases resolve through Pi's registry and save as `openai-codex/<model>`.

### Preset file

You can edit `~/.pi/agent/config/pi-task-models/presets.json` manually. It maps names to any subset of the four profiles, using the same route format:

```json
{
  "my-setup": {
    "fast": {
      "primary": { "model": "<provider>/<model>", "thinkingLevel": "low" }
    }
  }
}
```

Replace placeholders with exact references from `/task-models`. Omit `fallback` to remove it; omit the whole profile to keep its routes. Names must be non-empty, without surrounding whitespace or control characters. The picker sorts names alphabetically.

Missing, empty, or invalid files do not change active config. Invalid names, presets, and profiles produce warnings and are ignored; valid entries remain available.

Saving refuses any preset-file problem and preserves that file. It reads the latest active profiles, including concurrent changes, before saving. It creates a missing preset file with a private atomic write. An open confirmation prompt does not block other sessions. Saves wait briefly for another save. If another session saves the same new name first, the save reports the conflict and writes nothing; try again.

Applying a preset can create missing active config. Config problems require confirmation before replacement. Applying does not check authentication, availability, or thinking support; task execution uses normal scope and resolution rules.

## API

| Surface | Type | Purpose |
| --- | --- | --- |
| `PROFILE_NAMES` | constant | Lists `fast`, `balanced`, `frontier`, and `fav`. |
| `THINKING_LEVELS` | constant | Lists thinking levels. |
| `ProfileName` | type | Shared profile name. |
| `ThinkingLevel` | type | Thinking level name. |
| `ModelTask` | type | Consumer-owned independent model operation. |
| `TaskModelRoute` | type | Model reference and thinking level. |
| `TaskModelProfile` | type | Primary route and optional fallback. |
| `TaskModelsConfig` | type | Profiles and explicit assignments. |
| `AvailableModel` | type | Pi registry model. |
| `ResolvedTaskRoute` | type | Session-resolved model and thinking level. |
| `TaskRouteErrorCode` | type | Route failure code. |
| `TaskRouteError` | type | Error with code and optional profile name. |
| `registerModelTask(pi, task)` | function | Registers a consumer declaration at extension load. |
| `loadTaskModelsConfig(agentDir?)` | function | Reads and validates config; throws when disabled. |
| `registerTaskModelsConfigReporting(pi, agentDir?)` | function | Reports problems at session start; returns `report(ctx)` for later problems. |
| `canonicalModelReference(model)` | function | Validates and canonicalizes `provider/model`, including numbered Codex aliases. |
| `modelReference(model)` | function | Formats `provider/model`. |
| `dedupeAvailableModels(models, preferredProvider?)` | function | Removes duplicate canonical references, with optional provider preference. |
| `resolveAvailableModel(models, reference, preferredProvider?)` | function | Finds a reference, including numbered Codex aliases. |
| `availableTaskModels(ctx)` | function | Lists scoped text models, or registry models when scope is empty. |
| `taskThinkingLevels(ctx, model)` | function | Lists supported levels, respecting session-pinned thinking. |
| `resolveTaskModelRoute(ctx, route, thinking?)` | function | Resolves one available route. |
| `resolveConfiguredTaskRoute(ctx, task, agentDir?, thinking?)` | function | Resolves the first usable task route. |
| `resolveConfiguredTaskRoutes(ctx, task, agentDir?, thinking?)` | function | Resolves configured task route candidates. |
| `executeTaskRoutes(routes, attempt, { shouldFallback, signal? })` | function | Tries resolved routes in order; returns first success. |
| `orderedProfileRoutes(profile)` | function | Returns primary, then optional fallback. |
| `createTaskModelsExtension(pi, options?)` (also default export) | function | Registers `/task-models`, missing-config warnings, and issue reporting. |

Model and route helpers use only `ctx.model`, `ctx.scopedModels`, and `ctx.modelRegistry.getAvailable()`. They do not require UI methods, so consumers can use supported Pi releases. Profile thinking is authoritative; resolution uses `config.tasks[task.id] ?? task.defaultProfile`.

Consumers must not read or write shared config directly. Register `registerTaskModelsConfigReporting(pi)` in the extension factory and call its `report(ctx)` before resolution, even without the Task Models extension. Each problem appears once per session across reporters.

`loadTaskModelsConfig()` returns `source: "file"` or `"missing"`. Missing config returns `{ source: "missing", value: { "profiles": {}, "tasks": {} } }` without creating files. Disabled-config errors give the path and problems.

`executeTaskRoutes()` only executes supplied routes. It does not resolve, authenticate, inspect providers, log, wait, or retry routes. It rejects empty lists and checks `signal` before each route. Cancellation or `shouldFallback(error) === false` stops execution. Allowed failures end with the final error unchanged. Each route call must be atomic and safe to repeat.

## Limits and recovery

Problems appear at session start and when `/task-models` opens. For the shared rules, see [Config files](https://pi.henry.wang/overview#config-files).

| Problem | Result |
| --- | --- |
| Unknown key, misspelled `tasks`, unknown profile name, invalid task ID or task profile | Warn and ignore the entry. Tasks without valid overrides use declared defaults. |
| Invalid profile or route; `fallback` in `fav` | Warn and ignore the profile. Tasks using it fail with `profile-missing`, including the problem. |
| File problem, non-object `profiles`, misspelled `profiles` such as `profile` | Disable routing. Every task fails with `config-disabled`. |

Repair the file manually, or save a profile with `/task-models`. Problematic config requires confirmation. Saves retain only valid settings, including valid `tasks` when `profiles` is invalid. If the file changed while `/task-models` was open, saving writes nothing; reopen `/task-models`.

Saving refuses oversized, unreadable, or non-regular files. Fix, shrink, or remove the file first.

Resolution throws `TaskRouteError`; check `taskRouteCode`:

| Code | Meaning and recovery |
| --- | --- |
| `config-missing` | Config is absent. Run `/task-models` to create it. |
| `config-disabled` | Config disables routing; the error gives its path and problems. Repair it or save through `/task-models`. |
| `profile-missing` | Profile is absent or invalid; errors identify invalid settings. Configure it in `/task-models`. |
| `no-route` | No available route. Choose an available model and thinking level in `/task-models`. |

Consumers may silence only `config-missing`, and only with a safe current-session fallback.
