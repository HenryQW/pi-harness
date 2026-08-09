# Pi Auto DAG

Pi Auto DAG plans local delivery work in current main agent, obtains independent semantic review and hash-bound approval, then coordinates approved work through dependency-aware worker execution and one integration pull request.

## Language

**Delivery Graph**:
Exact local JSON plan containing delivery intent, implementation Local Issues, dependencies, and structural Final Check. Mutable only while `draft`; immutable during approved execution.
_Avoid_: Issue graph, GitHub graph, plan graph

**Planning Review**:
Read-only semantic review of draft Delivery Graph in one same-tab Herdr pane. Reviewer records `PASS` evidence bound to approved-form graph SHA-256 or returns material blockers; deterministic validation remains separate. Approval rejects missing or stale evidence and removes matching evidence before persisting approved graph.
_Avoid_: Task review, implementation review, approval

**Final Check**:
Structural integrated acceptance and frozen test command that executes after every implementation Local Issue. It is not user-authored as fake Local Issue.
_Avoid_: Final issue, release task

**Local Issue**:
Immutable work definition identified by a stable string within a Delivery Graph.
_Avoid_: GitHub Issue, child issue, graph node

**Run Task**:
Mutable execution state for one Local Issue within one delivery run.
_Avoid_: Issue, Local Issue, worker

**Run Resolution**:
User-approved clarification that unblocks one Run Task without changing its Local Issue.
_Avoid_: Graph edit, issue update, new requirement
