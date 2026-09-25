# `@henryqw/pi-herdr-btw`

Ask a focused side question in Herdr, then return its transcript and next instruction to Main. This avoids changing Main's conversation path or copying the result by hand.

Inspired by [Claude Code](https://github.com/anthropics/claude-code) and its `/btw` side-question mode. This package adds transcript merge back into Main.

## Install

```bash
pi install npm:@henryqw/pi-task-models
pi install npm:@henryqw/pi-herdr-btw
```

Requires Herdr 0.7.4+ and a Herdr-managed pane. Run `/task-models` and configure the `fast` profile before opening a side thread. Open `/task-models` again and verify that `fast` no longer says `not configured`.

## Works with

| Package | Relationship | Purpose |
| --- | --- | --- |
| [`@henryqw/pi-memory`](https://pi.henry.wang/extensions/pi-memory) | Improves | Marks side-thread children, suppressing parent-only memory injection and dream advice. |
| [`@henryqw/pi-task-models`](https://pi.henry.wang/extensions/pi-task-models) | Required | Provides shared model profiles for side-thread routes. |

## Use

From a Herdr-managed Pi pane with a conversation, run `/btw Why is this test failing?` to open a side pane with the question as an editable draft. Submit it there; after the answer, run `/btw merge Apply the smallest safe fix`. Main receives the side transcript, regains focus, and continues with the merge prompt.

| Surface | Type | Purpose |
| --- | --- | --- |
| `/btw [<question...>]` | command | For humans in Main: open an empty side pane or start with an editable question draft. |
| `/btw ask <question...>` | command | For humans in Main: ask a question whose first word is `ask`, `config`, `merge`, or `help`. |
| `/btw config [option value]` | command | For humans: show values, set `auto-submit` to `on` or `off`, set `tools` to `inherit`, `all`, `read-only`, or `none`, set `split` to `right` or `down`, or reset defaults. |
| `/btw merge [<prompt...>]` | command | For humans: in a side pane, queue its transcript and next prompt for Main (`/btw merge` opens the prompt editor); in Main, scan for pending side-thread deliveries. |
| `/btw help` | command | For humans: show the command grammar. |

## Flow

### Launch

- `ask`, `config`, `merge`, and `help` route only when they are exact first words. Other input is a question.
- A provided question is an editable draft by default.
- `/btw` gives the side pane a static snapshot of Main's compaction-aware context and shares Main's working directory.
- The consumer-owned `pi-herdr-btw/btw` task defaults to `fast`.
- Before pane launch, it selects the first authenticated viable effective profile route.

`~/.pi/agent/config/pi-task-models/config.json` is shared and owned by `@henryqw/pi-task-models`. A task entry is an explicit user override, and routes resolve before pane launch. BTW warns once per session if this file is missing.

### Merge delivery

![Sequence showing a fixed context snapshot with live shared files; the transcript and prompt queue until Main is idle and authenticated, then Main appends the transcript and submits the prompt.](./docs/btw-merge-sequence.svg)

- In the side pane, a merge stores the user/assistant transcript and next prompt as pending delivery.
- Herdr then refocuses Main and closes the side pane.
- Pending delivery survives side-pane shutdown. It waits for Main to settle and for current model authentication.
- Main appends the transcript without starting a turn, then submits the prompt.
- Pending delivery remains available until consumed or 24-hour stale cleanup.

## Config

Package-owned: `~/.pi/agent/config/pi-herdr-btw/config.json`

| Name | Description | Values | Default |
| --- | --- | --- | --- |
| `autoSubmit` | Submits the draft question instead of leaving it editable in the side pane. | Boolean. | `false` |
| `tools` | Selects the tools available in the side pane. | `inherit` (parent's active tools), `all`, `read-only` (built-in read-only tools), or `none`. | `inherit` |
| `split` | Sets the side-pane placement. | `right` or `down`. | `right` |

- All fields are optional.
- Unknown keys and non-object files are rejected.
- `/btw config show` prints effective values.
- `/btw config reset` saves the defaults.
- The config file is optional. Missing config uses defaults.
- Malformed config fails visibly and remains unchanged.

## Limits and recovery

The side pane shares Main's working directory, so enabled tools can change parent-visible files. Choose `read-only` or `none` when the side question should not make changes.

Large parent contexts can exceed child context limits; shorten Main's context and retry.
