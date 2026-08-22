# `@henryqw/pi-footer`

Henry's opinionated Pi footer style: concise checkout identity plus essential usage and subscription details.

```text
pi-packages · clear-field-f8d2
↑12.4k · ↓2.1k · ↺84.3% · $0.127 · ◔36.8%    gpt-5.6-luna • high
Codex #1 · 50% · 1d 1h 22m
```

First line shows repository and branch. Linked-worktree branches drop generated `worktree/` prefix.

## Clickable checkout

When `pi-open-in.json` command is exactly `code`, the accent-colored checkout name is an OSC 8 `vscode://` link to current path. Other configured commands remain plain because terminal links cannot run arbitrary shell commands.

Use Pi fullscreen TUI so Pi handles the custom URI:

```json
{
  "tuiMode": "fullscreen"
}
```

Set this through `/settings`, or launch with `--tui-mode fullscreen`. Then use normal primary click. Regular TUI delegates OSC 8 activation to terminal; Ghostty uses `Cmd+click` but may not open custom URI schemes.

Second line shows cumulative input tokens, output tokens, latest cache-hit rate, estimated cost, and context usage. Separators keep metrics readable; unavailable values render as `—` without a misleading percent sign. Active model and thinking level are right-aligned.

`off` uses same dim grey as model name. Active levels use a distinct ANSI-256 gradient: green `minimal`, yellow-green `low`, lime `medium`, yellow `high`, orange `xhigh`, and red `max`. `ultra` renders as rainbow when runtime supplies it. Pi 0.84.2 does not yet accept `ultra` as thinking level, so footer support is ready but unreachable until Pi adds it.

Final line renders every status emitted through `ctx.ui.setStatus()`, sorted by status key. Text, colors, links, and glyphs are preserved, including Ponytail mode, GitHub PR state, and Codex quota.

## Install

```bash
pi install npm:@henryqw/pi-footer
```

## With

| Package | Why |
| --- | --- |
| `@henryqw/pi-multi-codex` | Adds active Codex subscription quota and reset line. |
| `@henryqw/pi-open-in` | Supplies configured safe editor link; bundled as runtime dependency. |

## Development

```bash
npm test --workspace @henryqw/pi-footer
npm run typecheck --workspace @henryqw/pi-footer
npm run pack:check --workspace @henryqw/pi-footer
```
