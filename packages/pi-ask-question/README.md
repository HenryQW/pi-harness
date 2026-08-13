# `@henryqw/pi-ask-question`

Pi extension exposing `ask_question`, an interactive tool for asking user one question. Tool shows one to three supplied options, marks first as recommended, then adds `Something else.` for custom answer.

## Install

```bash
pi install npm:@henryqw/pi-ask-question
```

Tool accepts:

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

Supply one to three meaningful options in preference order; UI adds `(Recommended)` to first label. Number keys select options directly. Empty questions, blank or duplicate labels, empty lists, more than three options, and non-interactive sessions return error result. Aborting tool call closes pending question.

Remove with:

```bash
pi remove npm:@henryqw/pi-ask-question
```

## Development

```bash
npm test
npm run typecheck
npm run pack:check
```

Run manual model/TUI check outside CI:

```bash
npm run test:manual
```

Pass criteria:

1. Agent calls `ask_question` instead of asking in plain text.
2. UI shows one to three useful choices, first marked `(Recommended)`, plus `Something else.`.
3. Option descriptions explain tradeoffs without repeating labels.
4. Number key selects matching option; custom choice accepts typed answer; `Esc` cancels.
