# `@henryqw/pi-notes`

Persistent notes shown in a Pi widget, managed with slash commands.

## Install

```bash
pi install npm:@henryqw/pi-notes
```

## Use

| Surface | Type | Purpose |
| --- | --- | --- |
| `/note <text>` | command | Add a note to the widget (max 4). |
| `/note-rm` | command | Pick a note from a menu to remove. |
| `/note-clear` | command | Remove all notes. |

Notes render as a numbered widget above the editor and persist across sessions in `~/.pi/agent/config/pi-notes.json`. The file is validated on read; malformed files are treated as empty and only rewritten by an explicit command.

## Remove

```bash
pi remove npm:@henryqw/pi-notes
```

## Development

```bash
npm test --workspace @henryqw/pi-notes
npm run typecheck --workspace @henryqw/pi-notes
npm run pack:check --workspace @henryqw/pi-notes
```
