# `@henryqw/pi-ask-question`

Pause Pi until the user selects a question option with the keyboard or enters a custom answer. Agents and extensions get an explicit answer without parsing free-form chat.

![Pi asking the user to choose a database](./example.png)

## Install

```bash
pi install npm:@henryqw/pi-ask-question
```

## Use

Call `ask_question` in an interactive TUI with a question and one to three options in preference order. Pi waits for the selected option or custom answer.

| Surface | Type | Purpose |
| --- | --- | --- |
| `ask_question` | tool | For agents: pause execution to get one user answer. |

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

The UI marks the first option `(Recommended)` and adds `Something else.` for custom text input. Descriptions are optional.

While a question is open, the tool publishes `herdr:blocked` with `Input required`. Completion, cancellation, or failure clears the status.

## API

Import from the package root, `@henryqw/pi-ask-question`.

| Surface | Type | Purpose |
| --- | --- | --- |
| `askQuestion(params, ctx, signal)` | function | Runs the validated question flow for another extension. |
| `AskQuestionOption` | type | Describes a question option. |
| `AskQuestionRequest` | type | Describes a question request. |
| `AskQuestionResult` | type | Describes the flow result. |

The answer is `null` for cancellation, empty custom input, invalid requests, or non-TUI calls. Invalid requests and non-TUI calls also include `error`.

## Limits and recovery

Questions and option labels must not be blank. Labels must be unique, without regard to case. `Something else.` is reserved for the custom answer option.

Non-interactive calls return `UI not available (running in non-interactive mode)`. Ask in plain assistant text instead. Aborting the tool closes the pending question.
