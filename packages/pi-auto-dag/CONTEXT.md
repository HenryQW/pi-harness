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
Auto DAG execution of exact frozen `issue.testing` text against verified clean commit, producing persisted command, commit SHA, exit code, and bounded stdout/stderr evidence before reviewer dispatch. POSIX host is required for exact `sh -c` execution and process-group cleanup. Durable launch intent and bounded host plus command-group handshakes bind both process identities before command execution; startup failure blocks without gate evidence. Launch-specific cancellation stops hosts transitioning during interrupted cleanup. Execution deadline starts when ready host is released and cannot exceed Node timer maximum; detached host owns deadline, output capture, completion journal, and isolated child process-group cleanup so lifecycle-process loss cannot orphan gate or rerun completed command. Persisted process identities prevent interrupted recovery from signaling reused PIDs. Completed journal records owner, command result, output spools, and cleanup status; it remains until bounded evidence is atomically saved in Run State and acknowledged, so recovery reuses completed execution instead of rerunning it. Cleanup restores original branch and commit, removes gate-created tracked, untracked, and ignored dirt, and restores pre-existing ignored resources from a private snapshot with deterministic recoverable staging. Ignored snapshots preserve only relative symlinks resolving to non-protected source-worktree paths. Final gate uses a clean disposable child worktree whose frozen command prepares its own dependencies; mutable ignored resources are never copied from main worktree. Output overflow records failed evidence; Run State stores marked head/tail excerpts and SHA-256-bound paths to exact full captured streams. Reviewer starts only after exit code 0. Resolution clears failed evidence and reruns same commit. Reviewer may run extra checks but submits only verdict and findings; extra checks cannot replace gate.
_Avoid_: Reviewer test, echoed command, suggested command

**Worker Action Ticket**:
Durable system-owned handoff containing event ID, attempt, review round, role, receipt path, and optional review ID. Worker tools accept intent only; adapter captures ticket at turn start and adds ticket metadata plus Git HEAD.
_Avoid_: Model correlation field, worker-supplied attempt, review token

**Acceptance Receipt**:
Durable lifecycle-owned accepted or rejected result for one action ticket. Delivery alone never reports success; retries reuse ticket identity and poll receipt. Run State binds each accepted event ID to exact parsed-envelope SHA-256 before writing successful receipt, so missing receipts can be recovered without letting retries change action, payload, or Git HEAD. Correctable rejection rotates active action ticket; stale tickets are rejected explicitly.
_Avoid_: Sent message, transport success

**Review Dispatch ID**:
System-owned identity binding reviewer verdict to run, review kind, Local Issue, commit, attempt, and round. Orchestration writes it outside model prompt; worker extension attaches it outside reviewer-owned payload. Nonmatching stale or duplicated verdict is rejected.
_Avoid_: Reviewer correlation field, model token, review result

**Review Packet**:
Canonical fresh reviewer handoff containing delivery context, Local Issue, worktree, base, and Required Gate. Auto DAG owns deterministic Git verification and captures scope-specific dispatch identity at reviewer-turn start. Existing reviewer receives only changed gate, findings, or resolution data; no-change resume receives only resend event.
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

**Pi Profile**:
Config-defined Worker launch policy containing agent directory, description, effective Pi skill names, and baseline tools. At runtime Auto DAG selects matching entries from Pi's ordered effective skill registry, disables ambient skill loading, and injects exact selected `SKILL.md` paths. Run State retains selected entries only for recovery; Herdr only hosts resulting process.
_Avoid_: Profile resolver, Herdr profile, skill path configuration
