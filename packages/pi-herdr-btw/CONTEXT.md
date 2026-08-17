# Pi Herdr BTW

Pi Herdr BTW opens an isolated side thread in a Herdr pane and can merge its text transcript plus a follow-up prompt back into Main.

## Language

**Main**:
Parent Pi session that owns side-thread launch and merge delivery.
_Avoid_: Parent agent

**Side Thread**:
Separate Pi process and Herdr pane opened for a bounded question.
_Avoid_: Child agent

**Side-Thread Transcript**:
User/assistant text turns returned to Main; tool payloads are excluded.
_Avoid_: Full child context

**Merge Request**:
One-way handoff of Side-Thread Transcript plus follow-up prompt to Main. Main owns consumption; Side Thread does not wait for confirmation.
_Avoid_: Merge acknowledgement

**Model Override**:
Saved `provider/model` used by side threads instead of Main's current model.
_Avoid_: Hardcoded model
