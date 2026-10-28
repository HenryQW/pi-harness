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
| `/task-models` | command | Configure profiles and assign them to active tasks. |
| `/task-models preset` | command | Apply a saved profile setup. |
| Option+S / Alt+S in `/task-models` | shortcut | Save configured profiles as a named preset in the interactive terminal. |
| Session start | ui | Warn about missing config and config or preset problems. Show an error when routing is disabled. |

Configure each profile your consumers require. `fav` has no fallback. Select an active task to override its declared profile; choosing its declared default removes the override.

### Presets

Run `/task-models preset` and choose a name. Included profiles replace complete routes, thinking levels, and fallbacks in one atomic update. Omitted profiles and task assignments stay unchanged. Applying can create missing active config. It does not check authentication, availability, or thinking support; task execution uses normal scope and resolution rules.

To save, open `/task-models`, press **Option+S** (macOS) or **Alt+S**, then enter a name. Configure at least one profile first. The preset contains all configured profiles, not task assignments. Replacing an existing name requires confirmation; other presets stay unchanged. Cancelling a preset prompt writes nothing.

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

You can edit `~/.pi/agent/config/pi-task-models/presets.json` manually. It maps preset names to any subset of the four profiles, each in the `profiles.<profile>` format above. Names must be non-empty, without surrounding whitespace or control characters. The picker sorts names alphabetically.

The file must be valid UTF-8 JSON, at most 64 KiB. Missing, empty, or invalid files do not change active config. Invalid names, presets, and profiles produce warnings and are ignored; valid entries remain available.

Saving refuses any preset-file problem and preserves that file. It reads the latest active profiles, including concurrent changes, before saving. It creates a missing preset file with a private atomic write. An open confirmation prompt does not block other sessions. Saves wait briefly for another save. If another session saves the same new name first, the save reports the conflict and writes nothing; try again.

## API

| Surface | Type | Purpose |
| --- | --- | --- |
| `PROFILE_NAMES`, `THINKING_LEVELS` | constant | List the profile names and thinking levels. |
| `ProfileName`, `ThinkingLevel`, `ModelTask`, `TaskModelRoute`, `TaskModelProfile`, `TaskModelsConfig`, `AvailableModel`, `ResolvedTaskRoute`, `TaskRouteErrorCode`, `TaskRouteError` | type | Name profiles, thinking levels, Model Tasks, Task Routes, Task Profiles, config, registry models, resolved routes, and route errors with `taskRouteCode` and optional `profileName`. |
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

Reads never change config. Problems appear at session start and when `/task-models` opens. Resolution throws `TaskRouteError` with a `taskRouteCode`:

| Problem | Code | Recovery |
| --- | --- | --- |
| Unknown key, misspelled `tasks`, unknown profile name, invalid task ID or task profile. Pi warns and ignores the entry. | None | None needed. Tasks without valid overrides use declared defaults. |
| Config is absent. | `config-missing` | Run `/task-models` to create it. |
| Malformed JSON, invalid UTF-8, over 64 KiB, unreadable file, non-object root or `profiles`, misspelled `profiles` such as `profile`. Routing is disabled for every task. | `config-disabled` | The error gives the path and problems. Repair the file or save through `/task-models`. |
| Profile is absent, or Pi warns and ignores an invalid profile, route, or `fallback` in `fav`. | `profile-missing` | The error identifies invalid settings. Configure the profile in `/task-models`. |
| No available route. | `no-route` | Choose an available model and thinking level in `/task-models`. |

Problematic config requires confirmation before a save or preset replaces it. Saves retain only valid settings, including valid `tasks` when `profiles` is invalid. If the file changed while `/task-models` was open, saving writes nothing; reopen `/task-models`.

Saving refuses oversized, unreadable, or non-regular files. Fix, shrink, or remove the file first.

Consumers may silence only `config-missing`, and only with a safe current-session fallback.
