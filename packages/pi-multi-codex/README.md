# `@henryqw/pi-multi-codex`

Use multiple ChatGPT Codex OAuth accounts in Pi. Native `/login` still owns credentials.

## Install

```bash
pi install npm:@henryqw/pi-multi-codex
```

## Use

| Surface | Purpose |
| --- | --- |
| `/login` | Authenticate slot 1 as OpenAI Codex. |
| `/codex-add` | Create the next numbered slot, then `/login` and pick that slot. |
| `/codex-status` | Show shared seven-day quota snapshots. Never waits on network. |
| `/codex-switch` | Pick an authenticated slot. |

Extension reads native `auth.json` and never writes or refreshes credentials. Before the first agent start, a fresh snapshot routes a managed Codex model to the slot with the most seven-day quota. Routing preserves model ID and never changes in-progress work. Footer shows the active slot and fresh seven-day quota. Scoped sessions can switch only to exact scoped aliases; restart or update model scope after adding a slot.

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
