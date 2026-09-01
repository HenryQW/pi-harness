# `@henryqw/pi-multi-codex`

Use multiple ChatGPT Codex OAuth accounts in Pi.

![Pi showing Codex account quotas and the active footer slot](./example.png)

## Why

- **Created for**: Use multiple ChatGPT Codex OAuth accounts from one Pi installation.
- **Advantage**: Quota-aware routing starts with the eligible slot that has the most remaining seven-day quota. If that slot returns HTTP 429, Pi retries with another eligible slot.

## Install

```bash
pi install npm:@henryqw/pi-multi-codex
```

## With

| Package | Why |
| --- | --- |
| `@henryqw/pi-footer` | Improves. Shows the active slot's quota or five-hour block in the footer. |
| `@henryqw/pi-subagent` | Improves. Isolated children keep Main's active Codex slot. |
| `@henryqw/pi-task-models` | Improves. Numbered slots share one profile route. |

## Use

| Surface | Type | Purpose |
| --- | --- | --- |
| `/codex-add` | command | Create the next numbered slot, then authenticate that slot. |
| `/codex-status` | command | Show shared quota snapshots and five-hour blocks. Never waits on network. |
| `/codex-switch` | command | Pick an authenticated slot. |

A numbered slot is one Codex account position in Pi.

- The extension reads `auth.json`. It never writes or refreshes credentials.
- Before the first agent start, a fresh snapshot routes a managed Codex model to the eligible slot with the most seven-day quota.
- A slot whose reported five-hour window has reached 100% is excluded until that window resets.
- Routing preserves the model ID.
- During one agent run, each eligible slot is tried at most once after HTTP 429 responses.
- Automatic retry stops when no untried eligible slot remains.
- The footer shows the active slot's fresh quota or five-hour block.
- Scoped sessions can switch only to exact scoped aliases.
- Restart or update model scope after adding a slot.

## Config

Automatic HTTP 429 switching is on by default. To disable it, create `~/.pi/agent/config/pi-multi-codex/config.json`:

```json
{
  "autoSwitchOn429": false
}
```

The config must contain only `autoSwitchOn429` as a boolean. Invalid config is preserved and disables automatic switching.

Generated credential-free quota cache: `~/.pi/agent/config/pi-multi-codex/usage.json`. The extension maintains it.
