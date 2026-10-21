# Pi Advisor

Pi Advisor lets a second model examine what the agent did in a run before the run settles. The second model returns graded Notes, and a Blocker makes the agent continue one time.

## Language

**Advisor**:
The second model that does the Review. It gets the latest user prompt and a record of the run, but no tools.
_Avoid_: reviewer agent, judge, critic

**Review**:
One tool-free model request that the Advisor answers when a run with tool calls completes. Pi Advisor makes a Review only when the Advisor is on for the conversation branch.
_Avoid_: audit, check

**Run record**:
The assistant text, tool calls, and tool results after the latest user prompt. Long items are truncated, and the Review keeps the newest items when the record is too long.
_Avoid_: transcript, log

**Note**:
One graded finding in a Review reply, with the evidence that shows it.
_Avoid_: comment, issue

**Grade**:
The importance of a Note: `nit`, `concern`, or `blocker`. Only a `blocker` can continue the run.
_Avoid_: severity, priority

**Blocker Continuation**:
A visible `pi-advisor-blocker` message that states the blockers and asks the agent to fix them. Pi Advisor adds at most one for each user prompt.
_Avoid_: retry, follow-up

**Malformed reply**:
A Review reply that is not exactly `PASS` and is not only valid Note lines. Pi Advisor ignores it.
_Avoid_: parse error
