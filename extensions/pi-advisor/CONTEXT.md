# Pi Advisor

Pi Advisor lets a second model examine what the agent did in a run after the run settles. The second model returns graded Notes, and a Blocker sends one Blocker Follow-up that starts a new turn.

## Language

**Advisor**:
The second model that does the Review. It gets the latest user prompt and a record of the run, but no tools.
_Avoid_: reviewer agent, judge, critic

**Run**:
The agent work that one user prompt or one triggering custom message starts. Continuations that other extensions add at the settle boundary stay in the same Run.
_Avoid_: turn, session

**Review**:
One tool-free model request that the Advisor answers after a Run with tool calls settles. Pi Advisor makes a Review only when the Advisor is on for the conversation branch.
_Avoid_: audit, check

**Run record**:
The custom messages, assistant text, tool calls, and tool results of the current Run. Long items are truncated, and the Review keeps the newest items when the record is too long.
_Avoid_: transcript, log

**Note**:
One graded finding in a Review reply, with the evidence that shows it.
_Avoid_: comment, issue

**Grade**:
The importance of a Note: `nit`, `concern`, or `blocker`. Only a `blocker` can start a Blocker Follow-up.
_Avoid_: severity, priority

**Blocker Follow-up**:
A visible `pi-advisor-blocker` message that states the blockers, asks the agent to fix them, and starts a new Run. Pi Advisor sends at most one for each user prompt.
_Avoid_: retry, continuation

**Malformed reply**:
A Review reply that is not exactly `PASS`, is not only valid Note lines, or is longer than 8,000 characters. Pi Advisor ignores it.
_Avoid_: parse error
