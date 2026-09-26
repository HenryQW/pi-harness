# `@henryqw/pi-undo`

Return to your latest user prompt so you can edit and retry it without later conversation context. The prompt returns in place instead of requiring a copied new turn.

## Install

```bash
pi install npm:@henryqw/pi-undo
```

## Use

Run `/undo` with no arguments. It stops active work, waits for it to finish stopping, and returns to the latest user prompt on the current branch so you can edit or submit it again. It does not select prompts on other branches. If the current branch has no user message, Pi displays `Nothing to undo.`

## Limits and recovery

`/undo` rewinds conversation context only; it does not revert filesystem changes. Review or restore any files you need to change separately.
