# `@henryqw/pi-multi-codex`

Use multiple ChatGPT Codex OAuth accounts in Pi.

## Why

- **Created for**: Using multiple ChatGPT Codex OAuth accounts from one Pi installation.
- **Advantage**: Before work starts, quota-aware routing selects the eligible managed slot with the most remaining seven-day quota without changing in-progress sessions.

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

Extension reads `auth.json` and never writes or refreshes credentials. Before the first agent start, a fresh snapshot routes a managed Codex model to the eligible slot with the most seven-day quota. A slot whose reported five-hour window has reached 100% is excluded until that window resets. Routing preserves model ID and never changes in-progress work. Footer shows the active slot's fresh quota or five-hour block. Scoped sessions can switch only to exact scoped aliases; restart or update model scope after adding a slot.

## State

| Path | Purpose |
| --- | --- |
| `~/.pi/agent/config/pi-multi-codex/usage.json` | Generated credential-free quota cache, maintained by the extension. |
