# `@henryqw/pi-auto-compact`

Compact context before it reaches the configured threshold. Then resume the current task.

## Why

- **Created for**: Compact session context automatically before it reaches the configured threshold.
- **Advantage**: Trigger early, use a dedicated model, and resume the interrupted task without manual work.

## Install

```bash
pi install npm:@henryqw/pi-task-models
pi install npm:@henryqw/pi-auto-compact
```

Disable Pi's built-in auto-compaction in `~/.pi/agent/settings.json`:

```json
{
  "compaction": {
    "enabled": false
  }
}
```

Restart Pi after install or settings changes. Trusted project settings in `.pi/settings.json` must not set `compaction.enabled` back to `true`.

## With

This package requires `@henryqw/pi-task-models` for shared compaction routes.

`~/.pi/agent/config/pi-task-models/config.json` is shared and owned by `@henryqw/pi-task-models`. The local `pi-auto-compact/autoCompact` declaration defaults to `fast`. A task entry is an explicit user override.

Malformed shared config is reported and left unchanged. Compaction then uses the current session model.

## Use

Use `/auto-compact` to set the compaction threshold.

- It refuses to activate unless effective `compaction.enabled` is `false`.
- It checks `turn_start`, tool-call `turn_end`, `agent_end`, `context`, and resumed or forked `session_start`.
- Its consumer-owned `pi-auto-compact/autoCompact` task defaults to `fast`.
- It tries the effective profile primary, then fallback. If neither route works, the current session model still compacts.
- After mid-task compaction, a follow-up message continues the current task.

## Config

Package-owned: `~/.pi/agent/config/pi-auto-compact/config.json`

```json
{
  "autoCompactThreshold": 50
}
```

`autoCompactThreshold` is optional. It must be a number that is at least 25 and below 100. The default is `50`.

Unknown fields are ignored. Legacy model fields are obsolete. `/auto-compact` writes this file.

A missing file uses 50%. Reads do not create it. A malformed or invalid file fails visibly at session start, falls back to 50%, and stays unchanged.

Only `/auto-compact` writes this file. Its write is atomic.
