# `@henryqw/pi-ask-question`

Pause Pi for one clear user choice, with up to three options or a custom answer. Its keyboard-selectable prompt gives agents and extensions an explicit answer without parsing free-form chat.

![Pi asking the user to choose a database](./example.png)

## Install

```bash
pi install npm:@henryqw/pi-ask-question
```

## Use

In an interactive TUI session, call `ask_question` with a question and one to three options. Pi pauses for the user's choice and returns the selected or custom answer.

| Surface | Type | Purpose |
| --- | --- | --- |
| `ask_question` | tool | For agents: pauses execution so the user can select an option or enter a custom answer. |

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

- Supply one to three options in preference order.
- The UI marks the first option `(Recommended)`.
- The UI adds `Something else.`, which opens a text input for a custom answer.

While an interactive TUI question is open, the tool publishes `herdr:blocked` with the `Input required` label. It clears the status after completion, cancellation, or failure.

## API

Extensions can reuse the validated interaction with `askQuestion(params, ctx, signal)`. This package export returns the tool's answer details without registering another UI flow.

## Limits and recovery

Questions must not be blank. Supply one to three options with nonblank, case-insensitively unique labels; `Something else.` is reserved for the custom-answer option. Invalid questions return an error.

The tool requires an interactive TUI. Non-interactive sessions return `UI not available (running in non-interactive mode)`; ask in plain assistant text instead. Aborting the tool closes the pending question. If the user cancels the prompt or submits an empty custom answer, the result has no answer.
