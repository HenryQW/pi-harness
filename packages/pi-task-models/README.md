# `@henryqw/pi-task-models`

Shared `fast`, `balanced`, and `frontier` model profiles for HenryQW Pi extensions.

## Install

```bash
pi install npm:@henryqw/pi-task-models
```

## With

| Package | Why |
| --- | --- |
| `@henryqw/pi-auto-compact` | Consumer. Compaction defaults to the `fast` profile. |
| `@henryqw/pi-herdr-rename` | Consumer. Rename uses the `fast` profile. |
| `@henryqw/pi-subagent` | Consumer. Delegation defaults to `balanced`; caller may override it. |
| `@henryqw/pi-multi-codex` | Improves. Numbered Codex slots dedupe to one route. |

## Use

| Surface | Type | Purpose |
| --- | --- | --- |
| `/task-models` | command | Edit a profile or assign a task to a profile. |

Selecting a profile sets primary model, primary thinking, optional fallback model, then fallback thinking. One completed flow writes the whole profile. Selecting a task changes its assignment.

Menus and resolution use the current session's `ctx.scopedModels`, including pinned thinking. Empty scope uses Pi's full available model registry. Numbered Codex account aliases are deduplicated. Fallback choices exclude the selected primary. Hidden task assignments stay stored when a package is disabled.

Package also exports config and route-resolution helpers for consumers.

## Config

`~/.pi/agent/config/pi-task-models.json`

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
    }
  },
  "tasks": {
    "pi-herdr-rename/rename": "fast",
    "pi-auto-compact/autoCompact": "fast",
    "pi-subagent/delegateTask": "balanced"
  }
}
```

Each configured profile needs one primary model and thinking level. Fallback is optional. Model references use canonical `provider/model`; numbered `openai-codex-N` routes store as `openai-codex/model`.

Reads are strict. Malformed or unknown values fail visibly and never rewrite the file. Only explicit `/task-models` actions write config.

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
