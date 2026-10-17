# `@henryqw/pi-undo`

Return to your latest user prompt without the later conversation context. You can edit the prompt and send it again. The prompt returns in place, so you do not need to copy it into a new turn.

## Install

```bash
pi install npm:@henryqw/pi-undo
```

Requires Pi 1.3.0 or later in the 1.x series.

## Use

Run `/undo` with no arguments. It cancels active work. It waits until the work stops. Then it returns to the latest user prompt on the current branch. You can edit the prompt or submit it again.

The command does not select prompts on other branches. If the current branch has no user message, Pi displays `Nothing to undo.`

## Limits and recovery

`/undo` returns only the conversation context to its earlier state. It does not revert filesystem changes. Review or restore files separately if necessary.
