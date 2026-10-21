# Pi Goal

Pi Goal keeps one objective active on a conversation branch and continues the agent until the agent proves completion with evidence or a stop limit applies.

## Language

**Goal**:
One user objective that the agent records with the `goal` tool. A Goal is active, complete, or dropped, and belongs to the conversation branch that records it.
_Avoid_: Task, plan

**Deliverable**:
One concrete outcome that a Goal declares at creation. Completion needs Evidence for each Deliverable.
_Avoid_: Subtask, step

**Evidence**:
The agent's report of what it inspected in current state (files, command output, or tests) to prove one Deliverable. Pi Goal checks that Evidence is present, not that it is true.
_Avoid_: Proof, verification

**Continuation**:
A hidden message that Pi Goal adds when the agent stops while a Goal is active, so that the agent does one more turn.
_Avoid_: Retry, follow-up

**Budget**:
An optional token limit for a Goal. Tokens used are the total tokens, including cache reads and writes, of assistant responses after the Goal starts. An exhausted Budget stops Continuation; it does not complete the Goal.
_Avoid_: Quota, limit
