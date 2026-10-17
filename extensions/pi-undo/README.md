# `@henryqw/pi-undo`

Return to the latest user prompt on the current branch, without later conversation context. Edit and resend the prompt in place instead of copying it into a new turn.

## Install

```bash
pi install npm:@henryqw/pi-undo
```

## Use

Run `/undo` with no arguments. It cancels active work, waits for it to stop, then returns to the undo target.

The command does not select prompts on other branches. If the current branch has no user message, Pi displays `Nothing to undo.`

## Limits and recovery

Conversation rewind does not revert filesystem changes. Review or restore files separately before you resend the prompt.
