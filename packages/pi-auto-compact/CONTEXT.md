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

**Compaction task profile**:
Shared task-model profile assigned to `pi-auto-compact/autoCompact` (default `balanced`) with primary and optional fallback Pi registry routes. If neither route works, native compaction uses the current session model.
_Avoid_: dedicated compaction model, package-owned model picker
