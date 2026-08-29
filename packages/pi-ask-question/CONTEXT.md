# Pi Ask Question

## Language

**Ask Question tool**:
`ask_question` agent tool that pauses execution for one interactive user answer. Its named `askQuestion` helper is the reusable validated interaction for extensions that must wait for that answer.
_Avoid_: questionnaire, prompt tool

**Question option**:
One of up to three labeled predefined answers, optionally carrying description shown below label. First is recommended.
_Avoid_: choice value, enum member

**Custom answer**:
Free-text answer entered through final `Something else.` option.
_Avoid_: other option, fallback answer
