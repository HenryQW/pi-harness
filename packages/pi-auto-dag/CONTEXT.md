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
Structural integrated acceptance and frozen test command that Auto DAG executes after every implementation Local Issue. It is not user-authored as fake Local Issue.
_Avoid_: Final issue, release task

**Required Gate**:
Auto DAG execution of exact frozen `issue.testing` text against verified clean commit, producing persisted command, commit SHA, exit code, stdout, and stderr evidence before reviewer dispatch. Execution has configured deadline, terminates process group on timeout, then restores commit and removes gate-created Git dirt. Review Packet bounds model-facing output to marked head/tail excerpts and gives truncated streams SHA-256-bound paths to full output. Reviewer may run extra checks but submits only verdict and findings; extra checks cannot replace gate.
_Avoid_: Reviewer test, echoed command, suggested command

**Review Dispatch ID**:
System-owned identity binding reviewer verdict to run, review kind, Local Issue, commit, attempt, and round. Orchestration writes it outside model prompt; worker extension attaches it outside reviewer-owned payload. Nonmatching stale or duplicated verdict is ignored.
_Avoid_: Reviewer correlation field, model token, review result

**Review Packet**:
Canonical fresh reviewer handoff containing delivery context, Local Issue, worktree, base, and Required Gate. Auto DAG owns deterministic Git verification. Existing reviewer receives only changed gate, findings, or resolution data; no-change resume receives only resend event.
_Avoid_: Reviewer prompt variant, echoed orchestration state, reviewer verification request

**Local Issue**:
Immutable work definition identified by a stable string within a Delivery Graph.
_Avoid_: GitHub Issue, child issue, graph node

**Run Task**:
Mutable execution state for one Local Issue within one delivery run.
_Avoid_: Issue, Local Issue, worker

**Run Resolution**:
User-approved clarification that unblocks one Run Task without changing its Local Issue.
_Avoid_: Graph edit, issue update, new requirement

**Pi Profile Resolver**:
External command that maps reusable profile ID to versioned Pi launch data: agent directory, description, skills, and baseline tools. Auto DAG owns only role bindings and worker lifecycle injection; Herdr only hosts resulting process.
_Avoid_: Auto DAG profile, Herdr profile
