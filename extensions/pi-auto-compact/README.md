# `@henryqw/pi-auto-compact`

Trim repeated reads before compacting long Pi sessions. Completed tool turns continue naturally; compaction after a final answer does not start another turn. Your threshold leaves context headroom.

## Install

```bash
pi install npm:@henryqw/pi-task-models
pi install npm:@henryqw/pi-auto-compact
```

Install `@henryqw/pi-task-models` first. Run `/task-models` and configure the `fast` profile. Open `/task-models` again to verify that `fast` no longer says `not configured`.

Disable Pi's built-in auto-compaction in `~/.pi/agent/settings.json`:

```json
{
  "compaction": {
    "enabled": false
  }
}
```

Restart Pi after install or settings changes. Trusted `.pi/settings.json` files must not set `compaction.enabled` back to `true`.

## Works with

| Package | Relationship | Purpose |
| --- | --- | --- |
| [`@henryqw/pi-task-models`](https://pi.henry.wang/extensions/pi-task-models) | Required | Provides shared compaction routes. |

Task Models owns the shared `~/.pi/agent/config/pi-task-models/config.json` file. This extension's `pi-auto-compact/autoCompact` task uses the `fast` profile by default; a task entry is an explicit user override.

## Use

Run `/auto-compact` with no arguments and enter a threshold from 25% to below 100%. Pi confirms it as `Auto-compact threshold set to <value>%.` The default is 70%. Trimming has no separate switch; disable or remove this extension to opt out.

| Surface | Type | Purpose |
| --- | --- | --- |
| `/auto-compact` | command | For users: set the context-use threshold interactively. |
| `pi-auto-compact/autoCompact` | task | For Task Models users: configure compaction model routes. |

## Flow

![Auto-compact flowchart: completed boundaries trim duplicate reads before summarizing; oversized requests use a separate emergency guard](./docs/auto-compact-flow.svg)

- At completed `turn_end` and `agent_before_settle` boundaries, the extension replaces older successful, text-only `read` results only when an identical later full read is in the protected recent context. Tool name, arguments, and text must match. Failed, changed, image-bearing, or already edited results stay intact. If trimming brings context below the threshold, no summary request runs.
- If trimming is insufficient, the extension summarizes older effective context through the `fast` profile's primary route, then fallback, then the current session model. Pi commits context-edit and compaction entries without interrupting a normal tool turn or restarting a final answer. A failed summary does not become a checkpoint.
- Resumed/forked sessions and oversized fresh input may need emergency `ctx.compact()` before a completed boundary exists. This exceptional path interrupts and resumes the task.

## Config

Package-owned: `~/.pi/agent/config/pi-auto-compact/config.json`

| Name | Description | Values | Default |
| --- | --- | --- | --- |
| `autoCompactThreshold` | Sets the context-use percentage that triggers compaction. | Number from 25 inclusive to below 100. | `70` |

Unknown fields are ignored. Legacy model fields are obsolete. `/auto-compact` writes this file.

A missing file uses 70%. Reads do not create it. A malformed or invalid file fails visibly at session start, falls back to 70%, and stays unchanged.

Only `/auto-compact` writes this file. Its write is atomic.

## State and storage

Context edits and compaction entries affect the active session's projected context. They preserve raw session history, export, UI display, and historical usage, and reduce estimated future context only; earlier tokens are not refunded. Editing an older prefix may also reduce provider cache reuse. This is not secret erasure.

## Limits and recovery

- The extension refuses to activate unless effective `compaction.enabled` is `false`. Disable built-in compaction in Pi settings and check trusted project settings if activation fails.
- If a fresh request cannot be safely reduced, the extension reports the limit rather than discarding it. Shorten the new input or run `/compact`.
- Malformed shared Task Models config is reported and left unchanged; compaction then uses the current session model. If configured routes fail, compaction falls back to the current session model. If summary attempts fail, no checkpoint is saved; check model routes and authentication, then run `/compact` to retry manually.
