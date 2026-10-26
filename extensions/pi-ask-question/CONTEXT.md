# Pi Ask Question

Pi Ask Question collects explicit user answers while agent work waits.

## Language

**Interactive question**:
A question that pauses agent work until the user selects a predefined answer, enters a custom answer, or cancels.

**Question option**:
One of up to three labeled predefined answers, with an optional description. The first option is the recommended answer.
_Avoid_: choice value, enum member

**Custom answer**:
Free-text input supplied through the final `Something else.` option. Cancellation or empty input is not an answer.
_Avoid_: other option, fallback answer
