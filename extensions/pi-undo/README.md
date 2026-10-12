# `@henryqw/pi-undo`

Return to your latest user prompt. Then edit it and send it again without the later conversation context. The prompt returns in place, so you do not copy it into a new turn.

## Install

```bash
pi install npm:@henryqw/pi-undo
```

Requires Pi 1.1.0 or later in the 1.x series.

## Use

Run `/undo` with no arguments. It stops active work and waits until the work stops. Then it returns to the latest user prompt on the current branch. You can edit the prompt or submit it again. It does not select prompts on other branches. If the current branch has no user message, Pi displays `Nothing to undo.`

## Limits and recovery

`/undo` rewinds only the conversation context. It does not revert filesystem changes. Review or restore files separately if necessary.
