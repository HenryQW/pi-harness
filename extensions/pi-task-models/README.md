# `@henryqw/pi-task-models`

Choose shared model and thinking routes for extension tasks named `fast`, `balanced`, `frontier`, and `fav`. Users configure routes once while each extension keeps ownership of its task and default.

![Pi showing task model profiles and task routes](./example.png)
![Task routing from consumer declaration to route or error](./docs/task-routing-architecture.svg)

## Install

Requires Pi 1.x (1.0.0 or newer). Upgrade Pi before installing version 8 of this package.

```bash
pi install npm:@henryqw/pi-task-models
```

Run `/task-models` after installation. Configure each profile that your installed consumers require.

## Works with

| Package | Relationship | Purpose |
| --- | --- | --- |
| [`@henryqw/pi-auto-compact`](https://pi.henry.wang/extensions/pi-auto-compact) | Consumer | Its local compaction task defaults to `fast`. |
| [`@henryqw/pi-herdr-tools`](https://pi.henry.wang/extensions/pi-herdr-tools) | Consumer | Its side-thread and rename tasks default to `fast`. |
| [`@henryqw/pi-memory`](https://pi.henry.wang/extensions/pi-memory) | Consumer | Its local candidate-review task defaults to `balanced`. |
| [`@henryqw/pi-multi-codex`](https://pi.henry.wang/extensions/pi-multi-codex) | Improves | Numbered Codex slots dedupe to one route. |
| [`@henryqw/pi-prompt-creator`](https://pi.henry.wang/extensions/pi-prompt-creator) | Consumer | Its local prompt-drafting task defaults to `fast`. |
| [`@henryqw/pi-subagent`](https://pi.henry.wang/extensions/pi-subagent) | Consumer | Its local delegation task defaults to `fast`; callers can declare their own task. |

## Use

Run `/task-models` to complete the first setup:

1. Select `fast`.
2. Choose a primary model from Pi's effective registry, then choose its thinking level.
3. Choose a different fallback model and thinking level, or choose `None`.
4. Reopen `/task-models`. The `fast` row now shows the saved route instead of `not configured`.

| Surface | Type | Purpose |
| --- | --- | --- |
| `/task-models` | command | For people: configure shared profile routes and assign profiles to active consumer tasks. |
| `/task-models preset` | command | For people: choose a saved setup for any of `fast`, `balanced`, `frontier`, and `fav`. |
| Option+S / Alt+S in `/task-models` | shortcut | For people: save the current profile setup as a named preset in the interactive terminal. |
| Session start | ui | For people: when the shared config is missing, show a warning that points to `/task-models`. |

Repeat these steps for `balanced`, `frontier`, or `fav` when a consumer needs them. The `fav` profile has no fallback.

Select an active task to override its declared profile. Choosing that task's declared default removes the override.

## Flow

Consumers register declarations at extension load. When `/task-models` opens, the shared control plane asks active extensions for declarations. Extension load order does not matter.

The control plane lists each active task's effective profile. Hidden explicit assignments stay stored when a consumer is disabled.

Menus and resolution use the current session's `ctx.scopedModels`, including pinned thinking. An empty scope uses available text models from Pi's registry. Numbered Codex account aliases are deduplicated.

Fallback choices exclude the selected primary. BTW selects the first authenticated viable route before pane launch.

## Config

The shared JSON file is at `~/.pi/agent/config/pi-task-models/config.json`. Only explicit `/task-models` actions save it.

The following JSON shows structure only. Every model ID is a placeholder and must not be copied.

```json
{
  "profiles": {
    "fast": {
      "primary": { "model": "<provider>/<fast-model-from-Pi>", "thinkingLevel": "low" },
      "fallback": { "model": "<provider>/<fallback-model-from-Pi>", "thinkingLevel": "low" }
    },
    "balanced": {
      "primary": { "model": "<provider>/<balanced-model-from-Pi>", "thinkingLevel": "high" }
    },
    "frontier": {
      "primary": { "model": "<provider>/<frontier-model-from-Pi>", "thinkingLevel": "max" }
    },
    "fav": {
      "primary": { "model": "<provider>/<favorite-model-from-Pi>", "thinkingLevel": "high" }
    }
  },
  "tasks": {
    "pi-herdr-btw/btw": "balanced"
  }
}
```

Use exact model IDs offered by `/task-models`. Pi's registry, not this example, defines available models.

| Name | Description | Values | Default |
| --- | --- | --- | --- |
| `profiles` | Stores configured shared routes by profile name. | Object keyed by `fast`, `balanced`, `frontier`, or `fav`; unknown profile names are rejected. | `{}` (no profiles configured) |
| `profiles.<profile>.primary.model` | Selects the primary model. Required within a configured `primary` route. | Canonical `provider/model` reference without whitespace or NUL; available models come from Pi's model registry or session-scoped models. | — |
| `profiles.<profile>.primary.thinkingLevel` | Sets the primary model's thinking level. Required within a configured `primary` route. | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`; the model must support the level when the route resolves. | — |
| `profiles.<profile>.fallback` | Sets the route to try when the primary route is unavailable. | Object requiring `model` and `thinkingLevel` under the same rules as `primary`; not allowed for `fav`. | No fallback route. |
| `tasks` | Stores explicit profile overrides by task ID. | Object mapping task IDs (`<package>/<task>`) to profiles. | `{}` |
| `tasks.<taskId>` | Overrides that task's declared profile. | `fast`, `balanced`, `frontier`, or `fav`. | That task declaration's `defaultProfile` |

Pi's model registry, including session-scoped models, is the source of available models. This file does not contain a model catalog.

Task defaults live only in consumer declarations. Existing explicit assignments, including one equal to a declaration's default, remain valid.

Model references use canonical `provider/model`. Numbered Codex account aliases (`openai-codex-N`) resolve through Pi's registry and store canonically as `openai-codex/<model>`.

### Presets

Run `/task-models preset` and choose a name from the list to apply a saved setup. All four profiles (`fast`, `balanced`, `frontier`, and `fav`) are optional: omitted profiles keep their current values. Each included profile replaces its complete routes, including thinking levels and optional fallbacks, in one atomic config update. Task assignments stay unchanged. Cancelling the picker writes nothing.

To create a preset, open `/task-models` and press **Option+S** (macOS) or **Alt+S** in the main menu, then enter a name. This saves all currently configured profiles, including their thinking levels and fallbacks, but not task assignments. At least one profile must be configured. Reusing a name asks for confirmation before replacing that preset; other presets stay unchanged. Cancelling either prompt writes nothing.

The shortcut requires interactive terminal mode and a terminal configured to send Option/Alt as Meta (Escape). RPC does not support this shortcut. You can also edit `~/.pi/agent/config/pi-task-models/presets.json` yourself. The file maps preset names to any subset of the four profiles, using the same route format as the active config:

```json
{
  "my-setup": {
    "fast": {
      "primary": { "model": "<provider>/<fast-model>", "thinkingLevel": "low" }
    },
    "balanced": {
      "primary": { "model": "<provider>/<balanced-model>", "thinkingLevel": "high" },
      "fallback": { "model": "<provider>/<fallback-model>", "thinkingLevel": "medium" }
    }
  },
  "favorite-only": {
    "fav": {
      "primary": { "model": "<provider>/<favorite-model>", "thinkingLevel": "high" }
    }
  }
}
```

Replace every placeholder with an exact reference from `/task-models`; add more named objects for more setups. For an included profile, omit `fallback` for no fallback; `fav` never accepts a fallback. Omit the whole profile to leave its existing routes unchanged. Preset names must be non-empty, have no surrounding whitespace, and contain no control characters. Names appear alphabetically in the picker.

A missing, empty, or invalid preset file leaves the active config unchanged. The file must be valid UTF-8 JSON and no larger than 64 KiB; any invalid preset prevents the picker from opening. Read and save failures are reported without overwriting malformed files. Saving creates a missing preset file and uses a private atomic write under a lock; if another session is saving, retry after it finishes. Applying a preset can create a missing active config, but cannot overwrite an invalid one. Switching stores routes without checking current authentication, model availability, or thinking support; the usual scope and route-resolution rules still apply when a task runs.

## API

| Surface | Type | Purpose |
| --- | --- | --- |
| `PROFILE_NAMES` | constant | Lists the shared profiles: `fast`, `balanced`, `frontier`, and `fav`. |
| `THINKING_LEVELS` | constant | Lists supported thinking level names. |
| `ProfileName` | type | Names one shared profile. |
| `ThinkingLevel` | type | Names one thinking level. |
| `ModelTask` | type | Describes a consumer-owned independently executed model operation. |
| `TaskModelRoute` | type | Stores a model reference and thinking level. |
| `TaskModelProfile` | type | Stores a primary route and optional fallback. |
| `TaskModelsConfig` | type | Stores profile routes and explicit task assignments. |
| `AvailableModel` | type | Represents a model from Pi's registry. |
| `ResolvedTaskRoute` | type | Represents a model and thinking level resolved for the current session. |
| `TaskRouteErrorCode` | type | Identifies a route-resolution failure. |
| `TaskRouteError` | type | Carries a route error code and optional profile name. |
| `registerModelTask(pi, task)` | function | Registers a consumer's task declaration at extension load. |
| `loadTaskModelsConfig(agentDir?)` | function | Reads and validates the owner config file when present. |
| `canonicalModelReference(model)` | function | Validates and canonicalizes `provider/model`, including numbered Codex aliases. |
| `modelReference(model)` | function | Formats a model as `provider/model`. |
| `dedupeAvailableModels(models, preferredProvider?)` | function | Deduplicates canonical model references, preferring a provider when requested. |
| `resolveAvailableModel(models, reference, preferredProvider?)` | function | Finds a model by reference, including numbered Codex aliases. |
| `availableTaskModels(ctx)` | function | Lists usable text models from the current session scope or, when empty, Pi's registry. |
| `taskThinkingLevels(ctx, model)` | function | Lists supported thinking levels, honoring any session-pinned level. |
| `resolveTaskModelRoute(ctx, route, thinking?)` | function | Resolves one route against the current session, if available. |
| `resolveConfiguredTaskRoute(ctx, task, agentDir?, thinking?)` | function | Resolves the first usable route for a task. |
| `resolveConfiguredTaskRoutes(ctx, task, agentDir?, thinking?)` | function | Resolves the task's configured route candidates. |
| `executeTaskRoutes(routes, attempt, { shouldFallback, signal? })` | function | Tries supplied resolved routes in order and returns the first success. |
| `orderedProfileRoutes(profile)` | function | Returns the primary route followed by the optional fallback. |
| `createTaskModelsExtension(pi, options?)` (also the default export) | function | Registers the `/task-models` command and missing-config warning. |

Consumers do not access the config file directly. `loadTaskModelsConfig()` returns `source` as `"file"` or `"missing"`, so consumers can warn when defaults are in use.

Profile thinking is authoritative. Resolution uses `config.tasks[task.id] ?? task.defaultProfile`.

Consumers never read or write the shared file directly.

## Limits and recovery

`loadTaskModelsConfig()` returns `{ source: "missing", value: { "profiles": {}, "tasks": {} } }` for a missing file. It does not create a file.

At session start, Task Models warns when the shared config is missing. Run `/task-models` to configure task routes.

Malformed JSON, unknown keys, invalid task IDs, unknown profiles, or invalid profile or route values cause config loading to fail; the file is preserved. Repair or restore the file before reopening `/task-models`, which cannot load or overwrite an invalid config.

Resolution errors are `TaskRouteError` values. Check `taskRouteCode`:

| Code | Meaning |
| --- | --- |
| `config-missing` | The optional shared config file is absent. |
| `config-read` | A present shared config file cannot be read or validated; repair its contents or permissions before using `/task-models`. |
| `profile-missing` | The selected profile is not configured; set it in `/task-models`. |
| `no-route` | The selected profile has no available route; choose an available model and thinking level in `/task-models`. |

For `config-missing`, run `/task-models` to create the file. A consumer may silence only `config-missing` when it has a safe current-session fallback.

`executeTaskRoutes()` uses only caller-supplied resolved routes. It does not resolve routes, authenticate, inspect providers, log, wait, or retry a route.

It rejects empty route lists and checks its optional abort signal before every attempt. It stops on cancellation or when `shouldFallback(error)` returns false.

After allowed failures, it rethrows the final route error unchanged. Each attempt must be atomic and safe to repeat.
