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

Requires Pi Coding Agent 0.84.2+.

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

`~/.pi/agent/config/pi-auto-compact.json`

```json
{
  "autoCompactThreshold": 50
}
```

Threshold must be at least 25 and below 100. Missing config defaults to 50. Model routes live in `~/.pi/agent/config/pi-task-models.json`. Malformed shared task-model config is reported and left unchanged.

## Remove

```bash
pi remove npm:@henryqw/pi-auto-compact
```

## Development

```bash
npm test --workspace @henryqw/pi-auto-compact
npm run typecheck --workspace @henryqw/pi-auto-compact
npm run pack:check --workspace @henryqw/pi-auto-compact
```

`test:live` needs real Pi plus authenticated model access. Set `PI_AUTO_COMPACT_AUTH_FILE` when auth is not at `~/.pi/agent/auth.json`.

```bash
npm run test:live --workspace @henryqw/pi-auto-compact
```
