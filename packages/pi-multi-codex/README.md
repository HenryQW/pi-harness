# `@henryqw/pi-multi-codex`

Use multiple ChatGPT Codex OAuth accounts in Pi.

## Why

- **Created for**: Using multiple ChatGPT Codex OAuth accounts from one Pi installation.
- **Advantage**: Before work starts, quota-aware routing selects the managed slot with the most remaining seven-day quota without changing in-progress sessions.

## Install

```bash
pi install npm:@henryqw/pi-multi-codex
```

## With

| Package | Why |
| --- | --- |
| `@henryqw/pi-task-models` | Improves. Numbered slots share one profile route. |
| `@henryqw/pi-subagent` | Improves. Isolated children keep Main's active Codex slot. |

## Use

| Surface | Type | Purpose |
| --- | --- | --- |
| `/codex-add` | command | Create the next numbered slot, then authenticate that slot. |
| `/codex-status` | command | Show shared seven-day quota snapshots. Never waits on network. |
| `/codex-switch` | command | Pick an authenticated slot. |

Extension reads `auth.json` and never writes or refreshes credentials. Before the first agent start, a fresh snapshot routes a managed Codex model to the slot with the most seven-day quota. Routing preserves model ID and never changes in-progress work. Footer shows the active slot and fresh seven-day quota. Scoped sessions can switch only to exact scoped aliases; restart or update model scope after adding a slot.

Quota snapshots live in `~/.pi/agent/config/pi-multi-codex/usage.json`. They are credential-free cache, not user-edited config.

## Remove

```bash
pi remove npm:@henryqw/pi-multi-codex
```

## Development

```bash
npm test --workspace @henryqw/pi-multi-codex
npm run typecheck --workspace @henryqw/pi-multi-codex
npm run pack:check --workspace @henryqw/pi-multi-codex
```
