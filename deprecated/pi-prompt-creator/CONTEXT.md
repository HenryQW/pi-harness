# Pi Prompt Creator

Pi Prompt Creator finds reusable prompt ideas in the current conversation. Main and the user review each idea before the user approves a new global prompt.

## Language

**Current Conversation**:
The model-visible conversation on the active branch, including its retained summary and effective user and completed assistant text. Inactive branches, removed context, tool traffic, and thinking are not prompt-analysis evidence.

**Signal**:
Evidence that a reusable prompt could help: explicit recurrence language, requests with the same intent, or repeated corrections of Main's behavior.

**Prompt Candidate**:
One unsaved prompt template proposed from a Signal. A pending candidate is untrusted review material, not an approved prompt.

**Prompt Review**:
Conversational refinement of a displayed Prompt Candidate by the user and Main.

**Final Prompt Draft**:
The complete prompt-template Markdown in Main's latest valid retained review reply after the candidate was displayed. A Prompt Candidate is not a Final Prompt Draft.

**Approved Prompt**:
A Final Prompt Draft that the user explicitly accepts for creation as a new global Pi prompt. Approval does not permit replacement of an existing prompt.
