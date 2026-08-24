# `@henryqw/pi-herdr-btw`

Open a focused Pi side thread in a Herdr pane, then merge its transcript and follow-up prompt into Main.

## Why

- **Created for**: Asking quick side questions in a dedicated Pi thread without derailing Main's conversation or context.
- **Advantage**: `/btw merge` returns the side transcript and follow-up to Main without manually copying context.
- **Inspired by**: [Claude Code](https://github.com/anthropics/claude-code) and its `/btw` side-question mode; this package adds transcript merge back into Main.

## Install

```bash
pi install npm:@henryqw/pi-task-models
pi install npm:@henryqw/pi-herdr-btw
```

Requires Pi Coding Agent 0.84.2+, Herdr 0.7.4+, and a Herdr-managed pane.

## With

| Package | Why |
| --- | --- |
| `@henryqw/pi-task-models` | Required. Shared model profiles for side-thread routes. |

## Use

| Surface | Type | Purpose |
| --- | --- | --- |
| `/btw` | command | Open a side thread, configure its defaults, or recover a pending merge. |

```text
/btw                              open an empty side pane
/btw <question...>                open side pane with draft question
/btw ask <question...>            escape reserved first words
/btw config [...]                 show or change launch defaults
/btw merge <prompt...>            merge side thread into Main and continue
/btw help                         show grammar
```

`ask`, `config`, `merge`, and `help` route only when exact first words. Other input is a question. A provided question is an editable draft by default. `/btw` snapshots Main's compaction-aware context, inherits its working directory, and uses shared task `pi-herdr-btw/btw`, which defaults to `fast`. It selects first authenticated viable profile route before pane launch.

In side pane, `/btw merge <prompt>` sends user/assistant text transcript to Main, refocuses Main, and closes side pane. Main appends transcript without starting a turn, then submits prompt. Bare `/btw merge` opens prompt editor. Pending delivery waits for Main to settle and current model authentication; it survives side-pane shutdown until consumed or 24-hour stale cleanup.

Side pane gets static parent context and shares Main's working directory, so enabled tools can change parent-visible files. Large parent contexts can exceed child context limits. Launch data stays in private temporary directory.

## Config

`~/.pi/agent/config/pi-herdr-btw.json`

```json
{
  "autoSubmit": false,
  "tools": "inherit",
  "split": "right"
}
```

`/btw config` shows defaults. Set `auto-submit on|off`, `tools inherit|all|read-only|none`, or `split right|down`; `reset` removes config. Missing config uses defaults. Malformed config fails visibly and remains unchanged. Model routes live in `~/.pi/agent/config/pi-task-models.json`.

## Remove

```bash
pi remove npm:@henryqw/pi-herdr-btw
```

## Development

```bash
npm test --workspace @henryqw/pi-herdr-btw
npm run typecheck --workspace @henryqw/pi-herdr-btw
npm run pack:check --workspace @henryqw/pi-herdr-btw
```
