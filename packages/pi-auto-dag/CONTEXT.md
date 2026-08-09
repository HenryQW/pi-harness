# Pi Auto DAG

Pi Auto DAG coordinates approved local delivery work through dependency-aware worker execution and one integration pull request.

## Language

**Delivery Graph**:
Approved immutable DAG containing Local Issues and their dependency relations.
_Avoid_: Issue graph, GitHub graph, plan graph

**Local Issue**:
Immutable work definition identified by a stable string within a Delivery Graph.
_Avoid_: GitHub Issue, child issue, graph node

**Run Task**:
Mutable execution state for one Local Issue within one delivery run.
_Avoid_: Issue, Local Issue, worker

**Run Resolution**:
User-approved clarification that unblocks one Run Task without changing its Local Issue.
_Avoid_: Graph edit, issue update, new requirement
