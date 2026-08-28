# `@henryqw/pi-task-models`

Shared `fast`, `balanced`, `frontier`, and `fav` model profiles plus routing for consumer-owned Model Tasks.

## Why

- **Created for**: Deduplicating model pickers and catalogs that each extension previously owned separately.
- **Advantage**: One shared profile control plane keeps routes consistent while each consumer owns its task identity, intent, and default profile.

## Install

```bash
pi install npm:@henryqw/pi-task-models
```

## With

| Package | Why |
| --- | --- |
| `@henryqw/pi-auto-compact` | Consumer. Its local compaction task defaults to `fast`. |
| `@henryqw/pi-herdr-btw` | Consumer. Its local side-thread task defaults to `fast`. |
| `@henryqw/pi-herdr-rename` | Consumer. Its local rename task defaults to `fast`. |
| `@henryqw/pi-subagent` | Consumer. Its local delegation task defaults to `fast`; callers can declare their own task. |
| `@henryqw/pi-multi-codex` | Improves. Numbered Codex slots dedupe to one route. |

## Use

| Surface | Type | Purpose |
| --- | --- | --- |
| `/task-models` | command | Edit a profile or override an active task's default profile. |

Selecting a profile sets primary model, primary thinking, optional fallback model, then fallback thinking. One completed flow writes the whole profile. Selecting an active task sets its explicit override; choosing its consumer-declared default removes that override.

Consumers register their declarations at extension load. The one shared control plane asks active extensions for declarations when `/task-models` opens, so extension load order does not matter. It lists each active task's effective profile. Hidden explicit assignments stay stored when a consumer is disabled.

Menus and resolution use the current session's `ctx.scopedModels`, including pinned thinking. Empty scope uses Pi's full available model registry. Numbered Codex account aliases are deduplicated. Fallback choices exclude the selected primary. BTW selects the first authenticated viable route before pane launch.

## Config

Single shared JSON file at the exact package-owned path `~/.pi/agent/config/pi-task-models.json`. Consumers read it but never write it; only explicit `/task-models` actions save it.

```json
{
  "profiles": {
    "fast": {
      "primary": { "model": "openai-codex/gpt-fast", "thinkingLevel": "low" },
      "fallback": { "model": "other-provider/fast-model", "thinkingLevel": "low" }
    },
    "balanced": {
      "primary": { "model": "openai-codex/gpt-balanced", "thinkingLevel": "high" }
    },
    "frontier": {
      "primary": { "model": "openai-codex/gpt-frontier", "thinkingLevel": "max" }
    },
    "fav": {
      "primary": { "model": "openai-codex/gpt-favorite", "thinkingLevel": "high" }
    }
  },
  "tasks": {
    "pi-herdr-btw/btw": "balanced"
  }
}
```

| Field | Required | Possible values | Default |
| --- | --- | --- | --- |
| `profiles` | No | Object keyed by `fast`, `balanced`, `frontier`, `fav`; unknown profile names are rejected | `{}` (no profiles configured) |
| `profiles.<profile>.primary.model` | Yes within a configured profile's `primary` | Canonical `provider/model` reference without whitespace or NUL; available models come from Pi's model registry (or session-scoped models) at resolution time, not from this file | — |
| `profiles.<profile>.primary.thinkingLevel` | Yes within a configured profile's `primary` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`; the model must support the level when the route resolves | — |
| `profiles.<profile>.fallback` | No | When present, requires both `model` and `thinkingLevel` with the corresponding `primary.*` values; not allowed for `fav` | Omitted |
| `tasks` | No | Object mapping task IDs (`<package>/<task>`) to explicit user profile overrides | `{}` |
| `tasks.<taskId>` | Value required if the key is present | `fast`, `balanced`, `frontier`, `fav` | That task declaration's `defaultProfile` |

Task defaults live only in consumer declarations. Existing explicit assignments, including one equal to a declaration's default, remain valid. Model references use canonical `provider/model`; numbered Codex account aliases (`openai-codex-N`) resolve through Pi's registry and store canonically as `openai-codex/<model>`.

Reads are strict. A missing file yields `{ "profiles": {}, "tasks": {} }`; malformed JSON, unknown keys, invalid task IDs, unknown profiles, or invalid profile or route values fail visibly with `/task-models` guidance and never rewrite the file.

Profile thinking is authoritative for task routes. Consumers define a `ModelTask`, call `registerModelTask(pi, task)` at extension load, then call `resolveConfiguredTaskRoute(ctx, task)` or `resolveConfiguredTaskRoutes(ctx, task)`. Resolution uses `config.tasks[task.id] ?? task.defaultProfile`.
