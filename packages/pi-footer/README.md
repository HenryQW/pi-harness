# `@henryqw/pi-footer`

Henry's opinionated Pi footer style: concise checkout identity plus essential usage and extension status details.

## Why

- **Created for**: Showing concise checkout identity plus usage and extension status in the Pi footer.
- **Advantage**: Keeps repository, PR, usage, model, and extension state visible without separate status commands.

## Install

```bash
pi install npm:@henryqw/pi-footer
```

## With

| Package | Why |
| --- | --- |
| `@henryqw/pi-multi-codex` | Adds active Codex subscription quota and reset status. |
| `@henryqw/pi-open-in` | Adds `/open` and `/set-open-in` commands for editor configuration. |

## Use

| Surface | Type | Purpose |
| --- | --- | --- |
| Footer | UI | Show checkout, usage, model, thinking, and extension statuses. |

```text
pi-packages · clear-field-f8d2 · PR #123 · approved    Codex #1 · 50% · 7d 1d 1h 22m
↑ 12.4k · ↓ 2.1k · ↺ 84.3% · ⚡ 87.4 t/s · $ 0.127 · ◔ 36.8%    gpt-5.6-luna • high
●  🐴 ponytail: ⚡ FULL                                                    ◷ 12m 34s
```

First line shows repository, branch, and pull request status (`pi-pr`) after clickable checkout link. Linked-worktree branches drop generated `worktree/` prefix.

Second line shows cumulative input tokens, output tokens, latest cache-hit rate, tokens per second of the most recent assistant response, estimated cost, and context usage. Unavailable values render as `—` without a misleading percent sign. Active model and thinking level are right-aligned.

`off` uses the same dim grey as the model name. Active levels use an ANSI-256 gradient: green `minimal`, yellow-green `low`, lime `medium`, yellow `high`, orange `xhigh`, and red `max`. `ultra` renders as a rainbow when the runtime supplies it. Pi 0.84.4 does not yet accept `ultra`, so that footer path remains unreachable until Pi adds it.

Non-empty statuses from `@henryqw` extensions, currently Codex quota, occupy the right side of the first line.

Third line shows cumulative agent-work time right-aligned beneath the model. It counts each run from `agent_start` through the final idle `agent_settled`, including automatic retries and auto-compaction inside that run, and excludes blocking user-prompt waits and idle waits between runs. Standalone `/compact` is excluded because it runs outside the agent-run lifecycle and emits no `agent_start`. The cumulative total is persisted in the session via a `pi-footer:agent-work` custom entry after each finalized run and restored on session resume. Statuses from all other extensions, including Ponytail and `pi-rewind`, share the left side, sorted by key with producer text, spacing, colors, links, and glyphs preserved.

## Clickable checkout

When `pi-open-in.json` command is exactly `code` and Pi reports hyperlink support, the accent-colored checkout name is an OSC 8 `vscode://` link to the current path. Other configured commands and terminals with hyperlinks disabled render plain text.

Use Pi fullscreen TUI so Pi handles the custom URI:

```json
{
  "tuiMode": "fullscreen"
}
```

Set this through `/settings`, or launch with `--tui-mode fullscreen`. Then use normal primary click. Regular TUI delegates OSC 8 activation to the terminal; Ghostty uses `Cmd+click` but may not open custom URI schemes.
