# `@henryqw/pi-undo`

Return to your latest user prompt so you can edit and retry it without later conversation context. The prompt returns in place instead of requiring a copied new turn.

## Install

```bash
pi install npm:@henryqw/pi-undo
```

## Use

Run `/undo` with no arguments. Pi stops active work and puts your latest prompt back in the editor.

Edit or submit it again.

## Limits and recovery

`/undo` does not revert filesystem changes.
