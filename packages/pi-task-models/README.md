# `@henryqw/pi-task-models`

Shared `fast`, `balanced`, and `frontier` model profiles for HenryQW Pi extensions.

## Install

```bash
pi install npm:@henryqw/pi-task-models
```

Run `/task-models`. Top menu shows all profiles plus assignments for active supported packages. Selecting a profile chooses primary model, primary thinking, fallback model or `None`, then fallback thinking when needed; one completed flow writes whole profile once. Selecting a task changes its profile assignment.

Menus and runtime resolution use current session's `ctx.scopedModels`, including pinned thinking levels. Empty scope falls back to Pi's full available model registry. Numbered Codex account aliases are deduplicated, and fallback choices exclude selected primary model. Hidden task assignments remain stored when package is disabled or removed.

## Config

Config lives at `getAgentDir()/config/pi-task-models.json`, normally `~/.pi/agent/config/pi-task-models.json`:

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
    "pi-auto-compact/autoCompact": "balanced"
  }
}
```

Each configured profile requires one primary model and thinking level. Fallback is optional. Model references use canonical `provider/model`; numbered `openai-codex-N` account routes are stored as `openai-codex/model` and resolve onto active matching account when available.

Config reads are strict. Malformed or unknown values fail visibly and never rewrite file. Only explicit `/task-models` actions write config.

## Consumers

- `pi-herdr-rename`: task assignment defaults to `fast`; retries configured fallback after primary route failure.
- `pi-auto-compact`: task assignment defaults to `balanced`; retries fallback, then uses current session model so compaction still runs.
- `pi-subagent`: caller chooses `fast`, `balanced`, or `frontier`; fallback is selected only before child starts. Started child is never retried because tools may already have side effects.
- `pi-herdr-subagents`: intentionally independent.

Primary and fallback routes outside current model scope, with unavailable models, or with unsupported or scope-pinned-different thinking levels are skipped. Consumers define final failure behavior above.

## Library API

Package exports config, canonical model reference, model deduplication, supported-thinking, route resolution, and active-task discovery helpers. Pi model registry and extension `sourceInfo` remain runtime authority.

## Development

```bash
npm test --workspace @henryqw/pi-task-models
npm run typecheck --workspace @henryqw/pi-task-models
npm run pack:check --workspace @henryqw/pi-task-models
```
