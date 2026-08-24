# `@henryqw/pi-ask-question`

Ask the user one interactive question with up to three choices, or a custom answer.

## Why

- **Created for**: Asking the user one interactive question with up to three choices during a Pi session.
- **Advantage**: Offers a keyboard-selectable prompt and returns one explicit answer instead of relying on free-form chat parsing.
- **Inspired by**: Terminal choice prompts, implemented through Pi's TUI and tool APIs.

## Install

```bash
pi install npm:@henryqw/pi-ask-question
```

## Use

| Surface | Type | Purpose |
| --- | --- | --- |
| `ask_question` | tool | Pause for one interactive answer. |

```json
{
  "question": "Which database should we use?",
  "options": [
    { "label": "PostgreSQL", "description": "Shared server database" },
    { "label": "SQLite", "description": "Local, embedded storage" },
    { "label": "File", "description": "Plain file storage" }
  ]
}
```

Supply one to three options in preference order. UI marks the first `(Recommended)` and adds `Something else.` for a custom answer. Number keys select options. Empty questions, blank or duplicate labels, empty lists, more than three options, and non-interactive sessions return an error. Aborting the tool closes the pending question.

## Remove

```bash
pi remove npm:@henryqw/pi-ask-question
```

## Development

```bash
npm test --workspace @henryqw/pi-ask-question
npm run typecheck --workspace @henryqw/pi-ask-question
npm run pack:check --workspace @henryqw/pi-ask-question
```

Manual TUI check outside CI:

```bash
npm run test:manual --workspace @henryqw/pi-ask-question
```
