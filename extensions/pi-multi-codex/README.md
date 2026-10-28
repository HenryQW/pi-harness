# `@henryqw/pi-multi-codex`

Use multiple ChatGPT Codex OAuth accounts with quota-based selection and HTTP 429 failover.

![Pi showing Codex account quotas and the active footer slot](./example.png)
![Flowchart separating fresh-quota startup ranking from broader HTTP 429 failover](./docs/codex-routing-flow.svg)

## Install

```bash
pi install npm:@henryqw/pi-multi-codex
```

## Works with

| Package | Relationship | Purpose |
| --- | --- | --- |
| [`@henryqw/pi-footer`](https://pi.henry.wang/extensions/pi-footer) | Improves | Shows the active slot's quota status. |
| [`@henryqw/pi-subagent`](https://pi.henry.wang/extensions/pi-subagent) | Improves | Delegated children keep Main's active Codex slot. |
| [`@henryqw/pi-task-models`](https://pi.henry.wang/extensions/pi-task-models) | Improves | Numbered slots share one profile route. |

## Use

Run `/login` and authenticate `OpenAI Codex (legacy)` for slot 1. Run `/codex-add`, then `/login` and select `OpenAI Codex #<n>`. Restart Pi or update model scope. Run `/codex-status` to verify the new account slot.

| Surface | Type | Purpose |
| --- | --- | --- |
| `/codex-add` | command | Create the next numbered slot for authentication. |
| `/codex-status` | command | Show shared usage snapshots and five-hour quota blocks without network waits. |
| `/codex-switch` | command | Select an authenticated, scope-allowed slot for the current Codex model. |
| Pi model selector (`OpenAI Codex (legacy)`, `OpenAI Codex #<n>`) | ui | Choose an authenticated account slot. |
| Pi status `pi-multi-codex` | ui | Show active fresh quota, five-hour limit countdown, or stale/unavailable state. `@henryqw/pi-footer` displays it. |

Status stays `unavailable` until a successful usage snapshot.

## Flow

Eligible slots must be authenticated, registered, and scope-allowed, without known active five-hour quota blocks.

Before first agent work, the extension selects the eligible slot with the most fresh remaining quota. It repeats this selection before later starts only for a known active five-hour quota block. Explicit model selection wins for the next agent start.

After HTTP 429, it tries each eligible slot at most once per run.

Routing preserves physical model IDs. Virtual `openai-codex` models, such as `openai-codex/auto`, receive neither account-slot routing nor quota status.

## Config

Package-owned: `~/.pi/agent/config/pi-multi-codex/config.json`

| Name | Description | Values | Default |
| --- | --- | --- | --- |
| `autoSwitchOn429` | Switch slots after HTTP 429. Set `false` to disable this switching. | Boolean. | `true` |

Edit config manually; changes apply at the next session start. The extension never writes it.

An invalid or misspelled `autoSwitchOn429`, or a file problem, disables HTTP 429 switching for the session. Fix the file and start a new session. For the shared rules, see [Config files](https://pi.henry.wang/overview#config-files).

## State and storage

Generated, credential-free quota cache: `~/.pi/agent/config/pi-multi-codex/usage.json`.

## Limits and recovery

The extension identifies slots from `auth.json` without directly editing credentials.

Scoped sessions can switch only to exact scoped aliases.
