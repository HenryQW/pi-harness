# `@henryqw/pi-ask-question`

Pause Pi for one clear user choice, with up to three options or a custom answer. Its keyboard-selectable prompt gives agents and extensions an explicit answer without parsing free-form chat.

![Pi asking the user to choose a database](./example.png)

## Install

```bash
pi install npm:@henryqw/pi-ask-question
```

Requires Pi 1.1.0 or later in the 1.x series.

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

Import these exports from the package root, `@henryqw/pi-ask-question`.

| Surface | Type | Purpose |
| --- | --- | --- |
| `askQuestion(params, ctx, signal)` | function | Runs the validated question flow for another extension. |
| `AskQuestionOption` | type | Describes a question option. |
| `AskQuestionRequest` | type | Describes a question request. |
| `AskQuestionResult` | type | Describes the flow result. |

The result has a `null` answer if the user cancels, submits an empty custom answer, the request is invalid, or the context is not in TUI mode. It has an optional `error` for invalid requests and non-TUI contexts.

## Limits and recovery

Questions must not be blank. Supply one to three options with nonblank, case-insensitively unique labels; `Something else.` is reserved for the custom-answer option. Invalid questions return an error.

The tool requires an interactive TUI. Non-interactive sessions return `UI not available (running in non-interactive mode)`; ask in plain assistant text instead. Aborting the tool closes the pending question. If the user cancels the prompt or submits an empty custom answer, the result has no answer.
