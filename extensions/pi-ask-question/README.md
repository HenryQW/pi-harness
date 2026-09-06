# `@henryqw/pi-ask-question`

Pause Pi for one clear user choice, with up to three options or a custom answer. Its keyboard-selectable prompt gives agents and extensions an explicit answer without parsing free-form chat.

![Pi asking the user to choose a database](./example.png)

## Install

```bash
pi install npm:@henryqw/pi-ask-question
```

## Use

Call `ask_question` to pause for one interactive answer. Pi shows the choices and returns the selected or custom answer.

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

The tool returns an error for empty questions, blank or duplicate labels, empty lists, more than three options, and non-interactive sessions. Aborting the tool closes the pending question.
