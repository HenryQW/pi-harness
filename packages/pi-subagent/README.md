# `@henryqw/pi-subagent`

Delegate one bounded task to one isolated Pi process. Main chooses the role and model class per call.

## Install

```bash
pi install npm:@henryqw/pi-task-models
pi install npm:@henryqw/pi-subagent
```

`pi-task-models` provides `/task-models` for Subagent routes.

## Use

| Surface | Purpose |
| --- | --- |
| `delegate_task` | Start one isolated child for `role`, `task`, and optional `modelClass`. |
| `/task-models` | Configure shared `fast`, `balanced`, and `frontier` profiles. |

`modelClass` is `fast`, `balanced`, or `frontier`. Omitted class uses `balanced`. Primary route is resolved against current scoped text models; fallback is tried only before launch. If no route is usable, delegation rejects with `Run /task-models`. A started child is never retried.

Each call starts one isolated child (`pi --mode json -p --no-session`). Ambient extensions and skills are off; only role resources load. Child uses the delegated working directory and Main's project approval. Abort kills the child process group. Streaming output is capped at 50 KiB. Unused JSON event types are discarded before payload buffering; consumed or unclassifiable events above 1 MiB fail delegation.

TUI shows one row per Subagent with role, route, task, tokens, and elapsed time. Terminal rows drop after one second.

## Config

Role files live in `~/.pi/agent/config/pi-subagent/*.md`. Model routes live in `~/.pi/agent/config/pi-task-models.json`.

```markdown
---
name: reviewer
description: Reviews changes for correctness and security
tools: [read, grep, find, ls, bash]
extensions:
  - ~/.pi/agent/extensions/review-tools.ts
skills:
  - code-review
  - security
---

Review only requested change. Return ranked findings with file and line evidence.
Do not edit files.
```

| Field | Required | Meaning |
| --- | --- | --- |
| `name` | yes | Role selected by Main |
| `description` | yes | Tells Main when to use the role |
| `tools` | no | Omit for Pi `defaultTools`; a non-empty list is an exact allowlist; `[]` means none |
| `extensions` | no | Absolute/`~/` paths or package sources. Repository-relative paths are rejected. |
| `skills` | no | Effective Pi skill names, resolved from Main's registry |
| Markdown body | yes | Role system instructions |

Missing skills warn and skip; they do not block delegation. No repo-controlled `.pi/agents` roles. No package-local model picker.

## Remove

```bash
pi remove npm:@henryqw/pi-subagent
```

## Development

```bash
npm test --workspace @henryqw/pi-subagent
npm run typecheck --workspace @henryqw/pi-subagent
npm run pack:check --workspace @henryqw/pi-subagent
```
