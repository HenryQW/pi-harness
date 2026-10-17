# `@henryqw/pi-auto-compact`

Keep free context space with read trim before summary compaction. Normal compaction preserves completed tool turns and does not restart a final answer.

## Install

```bash
pi install npm:@henryqw/pi-task-models
pi install npm:@henryqw/pi-auto-compact
```

Install Task Models first. Run `/task-models` and configure `fast`. Open `/task-models` again; verify that `fast` no longer says `not configured`.

Disable Pi's built-in compaction in `~/.pi/agent/settings.json`:

```json
{
  "compaction": {
    "enabled": false
  }
}
```

Restart Pi after installation or settings changes. Activation requires effective `compaction.enabled: false`; check that trusted `.pi/settings.json` files do not override it with `true`.

## Works with

| Package | Relationship | Purpose |
| --- | --- | --- |
| [`@henryqw/pi-task-models`](https://pi.henry.wang/extensions/pi-task-models) | Required | Provides shared compaction routes. |

Task Models owns `~/.pi/agent/config/pi-task-models/config.json`. The compaction task profile defaults to `fast`; a task entry overrides it. The extension reports each shared-config problem once per session, at startup or before compaction, without changing that file.

## Use

Run `/auto-compact` without arguments and enter a threshold. Pi confirms `Auto-compact threshold set to <value>%.`

| Surface | Type | Purpose |
| --- | --- | --- |
| `/auto-compact` | command | For users: set the context-use threshold interactively. |
| `pi-auto-compact/autoCompact` | task | For Task Models users: configure compaction model routes. |

Read trim has no separate switch. Disable or remove this extension to opt out.

## Flow

![Auto-compact flowchart: completed boundaries trim duplicate reads before summarizing; oversized requests use a separate emergency guard](./docs/auto-compact-flow.svg)

- Context measurement matches Pi's status bar: latest provider usage plus estimates for later messages. Without usage data, including after compaction, estimates use about four characters per token. Replayed reasoning can make estimates too high until the next response.
- Between completed turns, read trim replaces older successful, text-only `read` results only if identical full reads remain in protected recent context. Tool names, arguments, and text must match. Failed, changed, already edited, and image results stay intact. Sufficient read trim avoids a summary request.
- Otherwise, the extension sends older effective context for summary compaction. It tries the configured primary route, fallback route, then the current session model. Malformed shared config also selects the current session model.
- Resumed or forked sessions and oversized fresh input can require emergency compaction. This interrupts the current task, then resumes it.

## Config

Package-owned: `~/.pi/agent/config/pi-auto-compact/config.json`

| Name | Description | Values | Default |
| --- | --- | --- | --- |
| `autoCompactThreshold` | Context-use percentage above which compaction starts. | Number from 25 inclusive to below 100. | `70` |

Missing files and invalid thresholds use the default. Reading never creates or changes the file. Unknown keys, including misspelled or obsolete model keys, are ignored.

At startup, one warning gives the path and reasons for malformed JSON, invalid thresholds, and unknown keys. Without a UI, warnings go to stderr.

Only `/auto-compact` writes config. It rereads and reports problems when opened. Writes are atomic. Valid-file updates preserve concurrent changes. Replacing a problem file removes unknown keys and invalid values, but fails without writing if another session changed it during input.

## State and storage

Compaction changes only future context for the active session. Raw history, exports, UI display, and historical usage stay unchanged. Providers do not refund earlier tokens. Older-prefix edits can decrease provider cache reuse.

This does not erase secrets.

## Limits and recovery

If fresh input cannot fit safely, Pi reports the limit without discarding the request. Shorten the input or run `/compact`.

If all summary requests fail, no checkpoint is saved. Check model routes and authentication, then run `/compact` to try again.
