# Pi Memory

Pi Memory keeps bounded cross-session user facts and agent notes. Repository knowledge and current task progress belong outside these stores.

## Language

**Memory entry**:
One durable cross-project fact or instruction in a memory store, not a transcript or task log.

**Agent notes**:
The memory store for stable cross-project environment and workflow facts.

**User profile**:
The memory store for durable user identity, preferences, and corrections.

**Session snapshot**:
The fixed view of both stores captured when a session starts. Later writes change live memory, not the injected snapshot.

**Memory candidate**:
A proposed entry and target store that have not yet been accepted for saving.

**Candidate review**:
An independent model assessment of a proposed addition against live agent-global instructions and both memory stores.

**Memory conflict**:
An overlap or contradiction between a candidate and existing memory or agent-global instructions that needs user resolution.

**Queued conflict**:
A complete mutation held in the private review inbox until the user runs `/memory-review`. It is not a successful memory write.

**Remember request**:
A user instruction for an independent model to turn into one suitable memory candidate, or decline.

**Dream promotion**:
A user-approved transfer of a general invariant rule from memory into agent-global instructions. Only whole entries represented by the resulting instructions qualify for removal.

**Memory qualification**:
The current session agent's decision that a newly learned fact belongs in cross-session memory rather than repository docs or task progress.

**Review group**:
The canonical common Git directory for linked worktrees, or the canonical starting directory for a non-Git session. It selects which inbox candidates the session shows.
