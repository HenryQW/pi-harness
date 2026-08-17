# `@henryqw/pi-herdr-btw`

Pi extension inspired by Claude Code `/btw`, based on [oscabriel/pi-herdr-btw](https://github.com/oscabriel/pi-herdr-btw). Opens a tool-enabled side conversation in a focused Herdr pane without changing parent transcript.

## Behavior

- snapshots parent's current, compaction-aware context
- inherits cwd, model, and thinking level by default
- prefills question for review by default
- leaves parent session unchanged
- supports `/btw merge` to return side-thread transcript and follow-up prompt
- routes Herdr commands through `@henryqw/pi-herdr`

## Requirements

- Pi v0.83.0+
- Herdr v0.7.4+
- Pi running in Herdr-managed pane

## Install

```bash
pi install npm:@henryqw/pi-herdr-btw
```

## Usage

```text
/btw                              open empty side pane
/btw <question...>                open side pane with draft question
/btw ask <question...>            escape hatch for reserved first words
/btw config [...]                 show or change defaults
/btw-model                        choose side-thread model
/btw merge <prompt...>            merge side thread into parent and continue
/btw help                         show grammar
```

`ask`, `config`, `merge`, and `help` route only when they are exact first words. Other input is a question.

`/btw-model` selects a model, then one of its supported thinking levels. It follows Pi's current scoped model list when `--models` or `enabledModels` is configured, including scoped thinking-level pins.

## Merge

In side pane, `/btw merge <prompt>` packages user/assistant turns, sends transcript to parent, refocuses parent pane, and closes side pane. Parent appends transcript without triggering a turn, then submits prompt. Bare `/btw merge` opens editor for prompt.

Pending delivery waits for parent to settle and for current model authentication to be ready. Requests survive child shutdown until parent consumes them or 24-hour stale cleanup expires them.

## Config

Run `/btw-model` to choose from Pi's available authenticated text models. Choose `Current session model` to clear override. Selection saves here:

`~/.pi/agent/config/pi-herdr-btw.json`

```json
{
  "model": "openai-codex/gpt-5.6-luna",
  "thinkingLevel": "max"
}
```

Saved `model` and `thinkingLevel` drive new side panes. Omit or set either to `null` to use current session values. `/btw config` can also persist `autoSubmit`, `tools`, and `split`.

Other settings:

```text
/btw config
/btw config auto-submit on|off
/btw config model inherit|provider/model
/btw config thinking inherit|off|minimal|low|medium|high|xhigh|max
/btw config tools inherit|all|read-only|none
/btw config split right|down
/btw config reset
```

## Caveats

Child gets static parent context. It shares working directory, so enabled tools can change parent-visible files. Large parent contexts can exceed child context limits.

Launch data uses a private temporary directory and stale entries expire after 24 hours.

## Development

```bash
npm test --workspace @henryqw/pi-herdr-btw
npm run typecheck --workspace @henryqw/pi-herdr-btw
npm run pack:check --workspace @henryqw/pi-herdr-btw
```

MIT
