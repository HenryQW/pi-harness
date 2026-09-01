# pi-prompt-creator — Context

## Domain

Turn repetition and correction in the current Pi conversation into one editable prompt template candidate. The user decides whether the candidate becomes a global Pi prompt.

## Glossary

- **Current Conversation**: The active conversation branch, including summaries that replace compacted history. Inactive branches are outside the scope.
- **Signal**: Evidence in the Current Conversation that a reusable prompt may help. Signals are explicit recurrence language, repetition of the same underlying request, or repeated correction of the agent's behavior.
- **Prompt Candidate**: One unsaved, editable prompt template proposed from the strongest Signal. A session has at most one pending Prompt Candidate; the user may explicitly request another after the pending candidate is shown or dismissed.
- **Prompt Review**: Conversational refinement of a Prompt Candidate by the user and Main.
- **Final Prompt Draft**: Complete prompt-template Markdown authored by Main after Prompt Review. A Prompt Candidate is not a Final Prompt Draft.
- **Approved Prompt**: A Final Prompt Draft the user explicitly accepts for creation as a global Pi prompt. Approval never authorizes replacing an existing prompt.

## Boundary

| Concern | Home |
| --- | --- |
| Cross-session evidence and historical search | `@henryqw/pi-session-recall` |
| Scripts, Skills, and other automation | Their owning package or repository |
| This extension | Current-conversation Signal detection, Prompt Candidate generation, and Prompt Review |

The extension stays silent when it finds no Prompt Candidate. Background analysis remains visible while it is running. Every completed candidate waits for explicit user display, so background work never steals editor focus.
