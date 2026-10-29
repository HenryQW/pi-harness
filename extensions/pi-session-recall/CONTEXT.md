# Pi Session Recall

Pi Session Recall retrieves evidence from saved Pi conversations on request. It does not inject historical transcripts on every turn or curate cross-session memory.

## Language

**Session corpus**:
The saved Pi sessions eligible for local search and retrieval.

**Discovery**:
Keyword search over indexed user and assistant text that returns session metadata and short matching passages. Tool results and thinking are not searchable.

**Transcript retrieval**:
Reading saved messages from a selected session branch, including tool-result text when present. Unlike discovery, it can expose historical tool output.

**Scroll anchor**:
The message that centers a retrieved window on a selected session branch.

**Branch tip**:
The saved entry that identifies the conversation path used for retrieval. Keeping the same tip preserves that path across scrolls.

**Session lineage**:
The grouping of a session with its directly recorded fork or clone parent, used to avoid counting copied history as independent evidence.

**Prepared mining corpus**:
A bounded sample of recent lineage-distinct sessions for pattern analysis. It includes user and assistant text, not thinking or tool-result content.

**Repository scope**:
The selection of sessions whose recorded working directories are the selected Git root or its descendants. The default root comes from the session directory; an explicit project path selects one root for a preparation call.

**Repository inventory**:
Discovery hints about indexed package scripts, executables, instructions, and effective repository Skills. It is not proof of current worktree contents or workflow ownership.

**Independent example**:
Evidence of repeated work from a distinct session lineage. Copied history in a fork or clone is not a second example.

**Sync backlog**:
Eligible session files not yet processed into the search index. An incomplete sync means that search and preparation may omit recent evidence.
