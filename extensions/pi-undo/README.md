# `@henryqw/pi-undo`

Return to your latest user prompt so you can edit and retry it without later conversation context.

## Why

- **Created for**: Pi users who want to correct or retry their latest request.
- **Advantage**: Restore the prompt in place instead of copying it into a new turn.

## Install

```bash
pi install npm:@henryqw/pi-undo
```

## Use

Run `/undo` with no arguments. Pi stops active work and puts your latest prompt back in the editor.

Edit or submit it again. `/undo` does not revert filesystem changes.
