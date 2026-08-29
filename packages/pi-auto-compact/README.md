# `@henryqw/pi-auto-compact`

Compact context before it hits the configured threshold, then resume the current task.

## Why

- **Created for**: Compacting session context automatically before it reaches the configured threshold.
- **Advantage**: Triggers early, uses a dedicated model, and resumes the interrupted task without manual intervention.

## Install

```bash
pi install npm:@henryqw/pi-task-models
pi install npm:@henryqw/pi-auto-compact
```

Requires Pi Coding Agent 0.84.4+.

## With

| Package | Why |
| --- | --- |
| `@henryqw/pi-task-models` | Required. Shared model profiles for compaction routes. |

Disable Pi's built-in auto-compaction in `~/.pi/agent/settings.json`:

```json
{
  "compaction": {
    "enabled": false
  }
}
```

Restart Pi after install or settings changes. Trusted project settings in `.pi/settings.json` must not set `compaction.enabled` back to `true`.

## Use

| Surface | Type | Purpose |
| --- | --- | --- |
| `/auto-compact` | command | Set the compaction threshold. |

Refuses to activate unless effective `compaction.enabled` is `false`. Checks `turn_start`, tool-call `turn_end`, `agent_end`, `context`, and resumed or forked `session_start`. `pi-auto-compact/autoCompact` defaults to the `fast` profile. Tries the assigned profile primary, then fallback; if neither route works, the current session model still compacts. After mid-task compaction, a follow-up message continues the current task.

## Config

Package-owned: `~/.pi/agent/config/pi-auto-compact.json`

```json
{
  "autoCompactThreshold": 50
}
```

| Field | Required | Possible values | Default |
| --- | --- | --- | --- |
| `autoCompactThreshold` | No | Number, at least 25, below 100 | `50` |

Unknown fields are ignored (legacy model fields are obsolete). `/auto-compact` writes this file. A missing file uses the default; a malformed or invalid file fails visibly at session start, falls back to 50%, and stays unchanged.

Shared: `~/.pi/agent/config/pi-task-models.json`, owned by `@henryqw/pi-task-models`. Task `pi-auto-compact/autoCompact` defaults to profile `fast`. Malformed shared task-model config is reported and left unchanged; compaction then uses the current session model.
