# `@henryqw/pi-auto-compact`

Compact long Pi sessions early through a shared model route, then continue the interrupted task automatically. Your chosen threshold keeps predictable context headroom without restarting the task.

## Install

Install the required Task Models extension first:

```bash
pi install npm:@henryqw/pi-task-models
pi install npm:@henryqw/pi-auto-compact
```

Run `/task-models` and configure the `fast` profile. Open `/task-models` again to verify that `fast` no longer says `not configured`.

Disable Pi's built-in auto-compaction in `~/.pi/agent/settings.json`:

```json
{
  "compaction": {
    "enabled": false
  }
}
```

Restart Pi after install or settings changes. Trusted `.pi/settings.json` files must not set `compaction.enabled` back to `true`.

Run `/auto-compact`, enter a threshold, and expect `Auto-compact threshold set to <value>%.`

## Works with

**Required.** [`@henryqw/pi-task-models`](https://pi.henry.wang/extensions/pi-task-models) provides shared compaction routes.

Its `~/.pi/agent/config/pi-task-models/config.json` file is shared and owned by Task Models. The local `pi-auto-compact/autoCompact` declaration defaults to `fast`. A task entry is an explicit user override.

## Use

Use `/auto-compact` to set the compaction threshold.

## Flow

- The extension refuses to activate unless effective `compaction.enabled` is `false`.
- It checks `turn_start`, tool-call `turn_end`, `agent_end`, `context`, and resumed or forked `session_start`.
- It tries the effective profile primary, then fallback. If neither route works, the current session model still compacts.
- After mid-task compaction, it resumes the current task automatically.

Malformed shared task-model config is reported and left unchanged. Compaction then uses the current session model.

## Config

Package-owned: `~/.pi/agent/config/pi-auto-compact/config.json`

```json
{
  "autoCompactThreshold": 70
}
```

`autoCompactThreshold` is optional. It must be a number that is at least 25 and below 100. The default is `70`.

Unknown fields are ignored. Legacy model fields are obsolete. `/auto-compact` writes this file.

A missing file uses 70%. Reads do not create it. A malformed or invalid file fails visibly at session start, falls back to 70%, and stays unchanged.

Only `/auto-compact` writes this file. Its write is atomic.
