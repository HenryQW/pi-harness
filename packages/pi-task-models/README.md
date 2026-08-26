# `@henryqw/pi-task-models`

Shared `fast`, `balanced`, `frontier`, and `fav` model profiles for HenryQW Pi extensions.

## Why

- **Created for**: Deduplicating model pickers and catalogs that each extension previously owned separately.
- **Advantage**: One shared source of `fast`/`balanced`/`frontier`/`fav` profiles keeps routing consistent across consumers.

## Install

```bash
pi install npm:@henryqw/pi-task-models
```

## With

| Package | Why |
| --- | --- |
| `@henryqw/pi-auto-compact` | Consumer. Compaction defaults to the `fast` profile. |
| `@henryqw/pi-auto-dag` | Consumer. Implement uses `balanced`; review uses `frontier`. |
| `@henryqw/pi-herdr-btw` | Consumer. Side-thread launch uses the `fast` profile. |
| `@henryqw/pi-herdr-rename` | Consumer. Rename uses the `fast` profile. |
| `@henryqw/pi-subagent` | Consumer. Delegation defaults to `balanced`; caller may override it. |
| `@henryqw/pi-multi-codex` | Improves. Numbered Codex slots dedupe to one route. |

## Use

| Surface | Type | Purpose |
| --- | --- | --- |
| `/task-models` | command | Edit a profile or assign a task to a profile. |

Selecting a profile sets primary model, primary thinking, optional fallback model, then fallback thinking. One completed flow writes the whole profile. Selecting a task changes its assignment.

Menus and resolution use the current session's `ctx.scopedModels`, including pinned thinking. Empty scope uses Pi's full available model registry. Numbered Codex account aliases are deduplicated. Fallback choices exclude the selected primary. Hidden task assignments stay stored when a package is disabled. BTW selects the first authenticated viable route before pane launch.

Package also exports config and route-resolution helpers for consumers.

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
    "pi-herdr-btw/btw": "fast",
    "pi-herdr-rename/rename": "fast",
    "pi-auto-compact/autoCompact": "fast",
    "pi-subagent/delegateTask": "balanced",
    "pi-auto-dag/implement": "balanced",
    "pi-auto-dag/review": "frontier"
  }
}
```

| Field | Required | Possible values | Default |
| --- | --- | --- | --- |
| `profiles` | No | Object keyed by `fast`, `balanced`, `frontier`, `fav`; unknown profile names are rejected | `{}` (no profiles configured) |
| `profiles.<profile>.primary.model` | Yes within a configured profile's `primary` | Canonical `provider/model` reference without whitespace or NUL; available models come from Pi's model registry (or session-scoped models) at resolution time, not from this file | — |
| `profiles.<profile>.primary.thinkingLevel` | Yes within a configured profile's `primary` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`; the model must support the level when the route resolves | — |
| `profiles.<profile>.fallback.model` / `.thinkingLevel` | No | Same as the corresponding `primary.*` fields; not allowed for `fav` | Omitted |
| `tasks` | No | Object mapping task IDs (`<package>/<task>`) to a profile name | Built-in defaults listed in the example above |
| `tasks.<taskId>` | Value required if the key is present | `fast`, `balanced`, `frontier`, `fav` | The built-in default for that task, if any |

Model references use canonical `provider/model`; numbered Codex account aliases (`openai-codex-N`) resolve through Pi's registry and store canonically as `openai-codex/<model>`.

Reads are strict. A missing file yields no profiles and the built-in default task assignments; malformed JSON, unknown keys, invalid task IDs, unknown profiles, or out-of-range values fail visibly with `/task-models` guidance and never rewrite the file.

Profile thinking is authoritative for task routes.

Consumers can call `resolveConfiguredTaskRoute(ctx, taskId)` for the first usable route or `resolveConfiguredTaskRoutes(ctx, taskId)` for primary and fallback routes. Both read strict shared config and fail with `/task-models` guidance when assignment, profile, or route is unavailable.

## Remove

```bash
pi remove npm:@henryqw/pi-task-models
```

## Development

```bash
npm test --workspace @henryqw/pi-task-models
npm run typecheck --workspace @henryqw/pi-task-models
npm run pack:check --workspace @henryqw/pi-task-models
```
