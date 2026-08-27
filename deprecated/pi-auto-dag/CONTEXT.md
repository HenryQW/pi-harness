# Pi Auto DAG

Pi Auto DAG executes an exact Delivery Graph in the current main agent through one hash-bound confirmation, dependency-aware worker execution, and one integration pull request. Planning normalization and post-PR sweep/CI status are caller-owned (for example `/ship`).

## Language

**Execution Boundary**:
`auto_dag_execute({graph})` is the sole execution entry point. It accepts one exact immutable graph (no `status` or profile field), shows exactly one TUI confirmation bound to the graph SHA-256 that visibly renders every escaped exact command and both fixed Roles, then owns execution through PR creation. Durable status/resume/retry/resolve/abort controls remain for recovery; no draft state, planning review, approval/start tools, health tool, or explicit PR-health repair exists.
_Avoid_: Plan tool, approval gate chain, separate start tool

**Delivery Graph**:
Exact local JSON plan passed to `auto_dag_execute`, containing delivery intent (`id`, `goal`, `constraints`, `non_goals`), implementation Local Issues with dependencies, and structural Final Check. Immutable for the duration of a run.
_Avoid_: Issue graph, GitHub graph, plan graph

**Final Check**:
Structural integrated acceptance and exact test command that Auto DAG executes on clean integration HEAD after every implementation Local Issue.
_Avoid_: Final issue, release task

**Required Gate**:
Auto DAG execution of the exact `testing` text against a verified clean commit, producing persisted command, commit SHA, exit code, and bounded stdout/stderr evidence before reviewer dispatch. POSIX host is required for exact `sh -c` execution and process-group cleanup; a detached gate host owns deadline, output capture, completion journal, and isolated child process-group cleanup so lifecycle-process loss cannot orphan the gate or rerun a completed command. The completed journal remains until evidence is atomically saved and acknowledged, so recovery reuses completed execution instead of rerunning it. The final gate uses a clean disposable child worktree; output overflow records failed evidence with SHA-256-bound full streams. Infrastructure-invalid Final Check evidence surfaces as a blocked outbox event for user handling.
_Avoid_: Reviewer test, echoed command, suggested command

**Event Outbox**:
Durable at-least-once record of blocked and completed run outcomes in Run State, with stable event IDs persisted before dispatch acknowledgment. Consumers dedupe on event ID; redelivery never changes action, payload, or Git HEAD.
_Avoid_: Fire-and-forget message, retry queue

**Worker Action Ticket**:
Durable system-owned handoff containing event ID, attempt, review round, role, receipt path, and optional review ID. Worker tools accept intent only; adapter captures ticket at turn start and adds ticket metadata plus Git HEAD.
_Avoid_: Model correlation field, worker-supplied attempt

**Acceptance Receipt**:
Durable lifecycle-owned accepted or rejected result for one action ticket. Delivery alone never reports success; retries reuse ticket identity and poll receipt. Run State binds each accepted event ID to exact parsed-envelope SHA-256 before writing successful receipt.
_Avoid_: Sent message, transport success

**Review Dispatch ID**:
System-owned identity binding reviewer verdict to run, review kind, Local Issue, commit, attempt, and round. Written outside model prompts; nonmatching, stale, or duplicated verdicts are rejected.
_Avoid_: Reviewer correlation field, model token

**Review Packet**:
Canonical fresh reviewer handoff containing delivery context, Local Issue, worktree, base, Required Gate, and a read-only exact binary patch artifact. The artifact is atomically persisted privately under the run directory after base/commit verification and identifies its path, base, commit, byte count, SHA-256, and deterministic child-branch or explicit integration-head context; its patch body is never in the prompt. Existing reviewers receive only changed gate, findings, or resolution data.
_Avoid_: Reviewer prompt variant, inline diff, echoed orchestration state

**Local Issue**:
Immutable work definition identified by a stable string within a Delivery Graph.
_Avoid_: GitHub Issue, child issue, graph node

**Run Task**:
Mutable execution state for one Local Issue within one delivery run.
_Avoid_: Issue, Local Issue, worker

**Subagent Role**:
Package-fixed implementer and reviewer `@henryqw/pi-subagent` Roles. Every implementation issue runs the implementer Role; every review runs the reviewer Role. Subagent resolves Role Skills, tools, extensions, shared task-model route, Pi launch arguments, and managed Herdr lifecycle. Auto DAG contributes only the graph protocol extension, phase tools, prompt, and action identity.
_Avoid_: Config-selected profile, copied Role config, package-owned model route
