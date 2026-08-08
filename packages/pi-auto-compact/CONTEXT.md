# Pi Auto Compact

Pi Auto Compact protects ongoing Pi work from context-window pressure. It compacts session context early, then continues the same task without user intervention.

## Language

**Auto-compaction**:
Proactive compaction of a Pi session before context pressure interrupts active work.
_Avoid_: Automatic summarization, context reset

**Task resumption**:
Continuation of the current task after auto-compaction, without asking the user to repeat the request.
_Avoid_: Retry, restart, new task

**Current task**:
The user-directed work in progress when auto-compaction begins and which continues after it completes.
_Avoid_: Prompt, new task
