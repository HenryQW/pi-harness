# `@henryqw/pi-footer`

Henry's opinionated Pi footer style shows checkout identity, usage, and extension status.

## Why

- **Created for**: Show concise checkout identity, usage, and extension status in the Pi footer.
- **Advantage**: Keep repository, PR, usage, model, and extension state visible without separate status commands.

## Install

```bash
pi install npm:@henryqw/pi-footer
```

## With

| Package | Why |
| --- | --- |
| `@henryqw/pi-multi-codex` | Improves. Adds active Codex subscription quota and reset status. |
| `@henryqw/pi-open-in` | Improves. Adds `/open` and `/set-open-in` commands for editor configuration. |
| `@henryqw/pi-pr` | Improves. Adds current-branch pull-request status. |

## Use

The footer shows checkout, usage, model, thinking, and extension statuses.

```text
pi-harness · clear-field-f8d2 · PR #123 · approved    Codex #1 · 50% · 7d 1d 1h 22m
↑ 12.4k · ↓ 2.1k · ↺ 84.3% · ⚡ 87.4 t/s · $ 0.127 · ◔ 36.8%    gpt-5.6-luna • high
●  🐴 ponytail: ⚡ FULL                                                    ◷ 12m 34s
```

- The first line shows the repository, branch, and `pi-pr` pull request status after the clickable checkout link. Linked-worktree branches drop the generated `worktree/` prefix.
- The second line shows cumulative input tokens, output tokens, latest cache-hit rate, and tokens per second for the most recent assistant response. It also shows estimated cost and context usage. Totals include reported tool usage and finished `pi-subagent` background workflows. The active model and thinking level are right-aligned.
- The third line shows other extension statuses on the left and cumulative agent-work time on the right, beneath the active model.

Unavailable values render as `—` without a misleading percent sign.

`off` uses the same dim grey as the model name. Active levels use an ANSI-256 gradient: green `minimal`, yellow-green `low`, lime `medium`, yellow `high`, orange `xhigh`, and red `max`.

`ultra` renders as a rainbow when the runtime supplies it. Pi 0.84.4 does not yet accept `ultra`, so that footer path remains unreachable until Pi adds it.

Non-empty statuses from `@henryqw` extensions, currently Codex quota, occupy the right side of the first line.

Agent-work time counts each run from `agent_start` through the final idle `agent_settled`. It includes automatic retries and auto-compaction inside that run. It excludes blocking user-prompt waits and idle waits between runs.

Standalone `/compact` is excluded because it runs outside the agent-run lifecycle and emits no `agent_start`. The cumulative total is persisted in the session through a `pi-footer:agent-work` custom entry after each finalized run. It is restored on session resume.

Statuses from all other extensions, including Ponytail and `pi-rewind`, share the left side. They are sorted by key with producer text, spacing, colors, links, and glyphs preserved.

## Clickable checkout

When `~/.pi/agent/config/pi-open-in/config.json` sets `command` to exactly `code` and Pi reports hyperlink support, the accent-colored checkout name is an OSC 8 `vscode://` link to the current path. A missing file silently uses `code` and gets the same link. Other configured commands and terminals with hyperlinks disabled render plain text.

Use Pi fullscreen TUI so Pi handles the custom URI:

```json
{
  "tuiMode": "fullscreen"
}
```

Set this through `/settings`, or launch with `--tui-mode fullscreen`. Then use normal primary click. Regular TUI delegates OSC 8 activation to the terminal.

Ghostty uses `Cmd+click` but may not open custom URI schemes.
