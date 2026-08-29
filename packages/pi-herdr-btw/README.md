# `@henryqw/pi-herdr-btw`

Open a focused Pi side thread in a Herdr pane, then merge its transcript and follow-up prompt into Main.

## Why

- **Created for**: Asking quick side questions in a dedicated Pi thread without derailing Main's conversation or context.
- **Advantage**: `/btw merge` returns the side transcript and follow-up to Main without manually copying context.
- **Inspired by**: [Claude Code](https://github.com/anthropics/claude-code) and its `/btw` side-question mode; this package adds transcript merge back into Main.

## Install

```bash
pi install npm:@henryqw/pi-herdr-btw
```

Requires Herdr 0.7.4+ and a Herdr-managed pane.

## With

| Package | Why |
| --- | --- |
| `@henryqw/pi-memory` | Improves. Marks side-thread children for pi-memory, suppressing parent-only memory injection and dream advice. |
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

`ask`, `config`, `merge`, and `help` route only when exact first words. Other input is a question. A provided question is an editable draft by default. `/btw` snapshots Main's compaction-aware context, inherits its working directory, and uses its consumer-owned `pi-herdr-btw/btw` task, which defaults to `fast`. It selects the first authenticated viable effective profile route before pane launch.

Shared: `~/.pi/agent/config/pi-task-models.json`, owned by `@henryqw/pi-task-models`. The local `pi-herdr-btw/btw` declaration defaults to `fast`; a task entry is an explicit user override. Side-thread routes resolve before pane launch.

In side pane, `/btw merge <prompt>` sends user/assistant text transcript to Main, refocuses Main, and closes side pane. Main appends transcript without starting a turn, then submits prompt. Bare `/btw merge` opens prompt editor. Pending delivery waits for Main to settle and current model authentication; it survives side-pane shutdown until consumed or 24-hour stale cleanup.

Side pane gets static parent context and shares Main's working directory, so enabled tools can change parent-visible files. Large parent contexts can exceed child context limits. Launch data stays in private temporary directory.

## Config

Package-owned: `~/.pi/agent/config/pi-herdr-btw.json`

```json
{
  "autoSubmit": false,
  "tools": "inherit",
  "split": "right"
}
```

| Field | Required | Possible values | Default |
| --- | --- | --- | --- |
| `autoSubmit` | No | `true`, `false` — submit the draft question automatically instead of leaving it editable in the side pane | `false` |
| `tools` | No | `inherit` (parent's active tools), `all`, `read-only` (built-in read-only tools), `none` | `inherit` |
| `split` | No | `right`, `down` — side-pane placement | `right` |

All fields are optional; unknown keys and non-object files are rejected. `/btw config show` prints effective values; `/btw config reset` removes the file. Missing config uses defaults; malformed config fails visibly and remains unchanged.
