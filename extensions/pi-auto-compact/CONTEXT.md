# Pi Auto Compact

Pi Auto Compact reduces context pressure while preserving the current task. Normal context maintenance occurs between completed turns; emergency compaction can interrupt and resume work.

## Language

**Auto-compaction**:
Extension-owned reduction of Pi session context when context use exceeds the selected threshold. It preserves raw session history.
_Avoid_: Automatic summarization, context reset

**Read trim**:
Replacement of an older successful text-only read result when an identical later full read remains in protected recent context. A sufficient read trim avoids summary compaction.
_Avoid_: Pruning, summarization

**Summary compaction**:
A summary of older effective conversation context that replaces that context in future model requests when read trim is insufficient.

**Current task**:
The user-directed work in progress when context maintenance begins.
_Avoid_: Prompt, new task

**Task resumption**:
Continuation of the current task after emergency compaction interrupts it. Normal boundary compaction does not restart a completed answer.
_Avoid_: Retry, restart, new task

**Auto-compaction threshold**:
The selected percentage of the context window above which automatic context reduction is needed.

**Compaction task profile**:
The shared Task Profile assigned to the independent compaction Model Task. Its default is `fast`; the current session model is the final fallback when shared routes cannot complete compaction.
_Avoid_: dedicated compaction model, package-owned model picker
