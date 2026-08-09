# Pi Multi Codex

Use multiple ChatGPT Codex OAuth slots in Pi.

Native Pi auth remains owner of credentials. Run `/login` and select OpenAI
Codex for slot 1. Run `/codex-add`, then `/login` and select reported numbered
slot for each additional Codex OAuth credential.

Extension reads native `auth.json` and never writes or refreshes credentials.

`/codex-status` shows shared seven-day quota snapshots. Refresh runs in background;
status never waits for network. Credential-free snapshots live in
`config/pi-multi-codex/usage.json` under Pi agent directory.

Before first agent start, fresh snapshots route a managed Codex model to slot with
most seven-day quota. Routing preserves model ID and never changes in-progress work.
`/codex-switch` opens Pi selector for authenticated slots. Footer shows active slot
and fresh seven-day quota. Scoped sessions can switch only to exact scoped aliases;
restart or update model scope after adding slot.
