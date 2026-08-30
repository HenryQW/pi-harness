# `@henryqw/pi-herdr-btw`

Open a focused Pi side thread in a Herdr pane. Then merge its transcript and follow-up prompt into Main.

## Why

- **Created for**: Ask quick side questions in a dedicated Pi thread without derailing Main's conversation or context.
- **Advantage**: `/btw merge` returns the side transcript and follow-up to Main without manually copying context.
- **Inspired by**: [Claude Code](https://github.com/anthropics/claude-code) and its `/btw` side-question mode. This package adds transcript merge back into Main.

## Install

```bash
pi install npm:@henryqw/pi-task-models
pi install npm:@henryqw/pi-herdr-btw
```

Requires Herdr 0.7.4+ and a Herdr-managed pane.

## With

| Package | Why |
| --- | --- |
| `@henryqw/pi-memory` | Improves. Marks side-thread children for pi-memory, suppressing parent-only memory injection and dream advice. |
| `@henryqw/pi-task-models` | Required. Shared model profiles for side-thread routes. |

## Use

Use `/btw` to open a side thread, set its defaults, or recover a pending merge.

```text
/btw                              open an empty side pane
/btw <question...>                open side pane with draft question
/btw ask <question...>            escape reserved first words
/btw config [...]                 show or change launch defaults
/btw merge <prompt...>            merge side thread into Main and continue
/btw help                         show grammar
```

### Launch

- `ask`, `config`, `merge`, and `help` route only when they are exact first words. Other input is a question.
- A provided question is an editable draft by default.
- `/btw` snapshots Main's compaction-aware context and inherits its working directory.
- The consumer-owned `pi-herdr-btw/btw` task defaults to `fast`.
- Before pane launch, it selects the first authenticated viable effective profile route.

`~/.pi/agent/config/pi-task-models/config.json` is shared and owned by `@henryqw/pi-task-models`. A task entry is an explicit user override, and routes resolve before pane launch. BTW warns once per session if this file is missing.

### Merge delivery

- In the side pane, `/btw merge <prompt>` sends the user/assistant text transcript to Main, refocuses Main, and closes the side pane.
- Main appends the transcript without starting a turn, then submits the prompt.
- Bare `/btw merge` opens the prompt editor.
- Pending delivery waits for Main to settle and for current model authentication. It survives side-pane shutdown until consumed or 24-hour stale cleanup.

### Limits and privacy

- The side pane gets static parent context and shares Main's working directory. Enabled tools can change parent-visible files.
- Large parent contexts can exceed child context limits.
- Launch data stays in a private temporary directory.

## Config

Package-owned: `~/.pi/agent/config/pi-herdr-btw/config.json`

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

- All fields are optional.
- Unknown keys and non-object files are rejected.
- `/btw config show` prints effective values.
- `/btw config reset` saves the defaults.
- The config file is optional. Missing config uses defaults.
- Malformed config fails visibly and remains unchanged.
