# @henryqw/pi-subagent

Delegate one bounded task to one isolated Pi process. Main chooses role and model class per task.

Based on Pi's authoritative [`examples/extensions/subagent`](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/examples/extensions/subagent): child processes use `pi --mode json -p --no-session`.

## Install

```bash
pi install npm:@henryqw/pi-subagent
```

## Configure roles

Use Pi's existing role Markdown format in package-owned `~/.pi/agent/config/pi-subagent/*.md`. Configure `fast`, `balanced`, and `frontier` model routes with `/subagent`.

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

Fields:

| Field | Required | Meaning |
| --- | --- | --- |
| `name` | yes | Role selected by Main |
| `description` | yes | Tells Main when to use role |
| `tools` | no | Omit for Pi effective `defaultTools`; a non-empty list is an exact built-in and extension tool allowlist; use `[]` for none |
| `extensions` | no | Absolute/user-home paths or package sources passed to Pi `--extension` |
| `skills` | no | Effective Pi Skill names loaded for role |
| Markdown body | yes | Role system instructions |

Omitted `tools` uses Pi's effective `defaultTools` for built-ins. Tools registered by Role extensions stay active without listing their names. A non-empty `tools` list strictly allowlists both built-in and extension tools; `tools: []` sends `--no-tools`.

String lists may also use comma-separated text, matching Pi's example role files. Repository-relative extension paths are rejected: child working directory is delegated project, so relative paths could load untrusted project code. Use absolute paths, `~/...`, or explicit package sources such as `npm:...`.

Skill entries use Pi Skill names, normally Skill directory names, not filesystem paths. At delegation time, package resolves names from Main's effective Pi Skill registry and passes matching files to child. Missing or unavailable Skills produce warning and are skipped; they do not block delegation. This preserves Main's trust and Skill collision decisions.

Pi's example `agents/` directory contains sample Role files, not another runtime mechanism. This package reuses that Markdown format but ships no presets: role capabilities and model routes stay explicit in user config. No nested `agents/` directory is needed because Roles remain Markdown files.

Reload Pi after adding or changing role files or manually editing model config. `/subagent` applies changes immediately.

## Execution

Main calls `delegate_task` with:

- `role`: configured role name
- `task`: one bounded task
- `modelClass`: optional `fast`, `balanced`, or `frontier`; defaults to configured `balanced`, then Main route

Run `/subagent` once per class. Select class, authenticated text model, and supported thinking level. Config lives in `~/.pi/agent/config/pi-subagent.json`:

```json
{
  "models": {
    "fast": { "model": "provider/fast-model", "thinkingLevel": "off" },
    "balanced": { "model": "provider/balanced-model", "thinkingLevel": "medium" },
    "frontier": { "model": "provider/frontier-model", "thinkingLevel": "max" }
  }
}
```

Explicit class routes must be configured and available. Omitted `modelClass` falls back to Main when `balanced` route is missing or stale.

Each call starts isolated child process. Ambient extensions and skills are disabled. Only role resources load. Child uses delegated working directory and normal Pi project context files, inheriting Main's project approval decision. Abort terminates child process group.

Configured model and thinking level must exist in Main model registry. Invalid role config or explicit model class fails before child starts.

Main-visible streaming updates, final output, and errors are capped at 50 KiB of UTF-8 text. Error collection stays bounded while child runs; malformed JSON events above 1 MiB fail delegation. Truncated output ends with exact omitted-byte count.

## Widget

TUI shows one aligned row per Subagent:

```text
⠼  scout[haiku:low]       find auth flow     18.4k   8s
✓  reviewer[sonnet:high]  inspect auth diff  22.1k  14s
✗  worker[sonnet:high]    fix token expiry   31.8k  27s
■  scout[haiku:low]       map routes          6.2k   5s
```

Spinner means working; terminal icons mean success, failure, or abort. Token column sums `usage.totalTokens` across Subagent turns. Terminal rows auto-remove after one second; empty widget renders nothing. Role/route and task columns truncate to preserve right-aligned token and elapsed columns on narrow terminals.

## Scouting roles

Treat scouting result as index, not file dump. Put conclusions first, followed by exact file/line references, short snippets only, risks, and unexamined scope. Main can read cited files when more detail is needed. Split work when useful index cannot fit within output cap.

## Deliberate limits

- User roles only; no repo-controlled `.pi/agents` trust flow.
- One task per call; Main handles orchestration.
- No custom profile schema; role Markdown already groups instructions, tools, extensions, and skills.
- No persistent child sessions or interactive panes.
- No full-result artifact or retrieval protocol; split oversized work instead.
