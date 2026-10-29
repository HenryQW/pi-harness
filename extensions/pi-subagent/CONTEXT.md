# Pi Subagent

Pi Subagent delegates bounded work to Role-configured Pi workers. Direct tasks share Main's checkout; isolated requests produce checked candidates for explicit integration.

## Language

### Delegation

**Main**:
The Pi session and checkout that coordinate delegated work.

**Role**:
A named capability definition with instructions, tools, trusted extension sources, Skills, optional MCP servers, and an optional Model Class default. A Role does not select isolation.

**Model Class**:
A `fast`, `balanced`, `frontier`, or `fav` choice resolved through Pi Task Models.

**Direct task**:
A bounded task in Main's shared checkout with declared `read` or `write` access. Authorized writes take effect immediately, without rollback or checked integration.

**Direct reference**:
A display and continuation reference for one recorded direct worker, such as `D7.1`. It does not grant ownership of that worker.

**Continued worker**:
A new direct worker that resumes a finished worker's saved Pi conversation in a new tab with a new Direct reference.

**Checkout admission**:
The exclusive permission held by a direct write request or managed background writer that prevents Main and other direct writers from writing to the shared checkout. Pi Herdr supplies the shared process-local coordinator. Each owner keeps admission until termination is proven; read classification is not a sandbox.

**Isolated request**:
A durable goal and dependency graph of text and changeset tasks, with checked results and recovery state.

**Text task**:
An isolated-graph task whose result is bounded text rather than a changeset. Completed text can supply context to later tasks.

**Changeset task**:
An isolated-graph task that produces a committed change in its own worker worktree.

**Repository set**:
The explicitly selected independent Git repositories that one workspace task reads, checks, and changes. An unchanged member remains part of the exact input set.

**Workspace input**:
An explicitly selected non-Git file copied for read-only task use. It is never a Git candidate or a promotion target.

**Promotion receipt**:
The durable record of one repository's proved movement to its checked integration tip. A receipt does not imply that other repositories moved.

### Checked integration

**Candidate**:
The exact clean committed identity of a changeset worker's proposed change.

**Readiness**:
Saved proof that an exact candidate passed preliminary checks and is sealed for Main's explicit selection. It is not a separate user approval.

**Integration generation**:
Main's ordered assembly of selected candidates in a separate checkout. A replaced assembly remains available as a superseded generation.

**Judgment**:
A review decision bound to an exact candidate or combined integration generation, separate from automated validation.

**Promotion**:
The guarded transfer of a validated integration generation into unchanged, clean Main. Readiness alone does not permit promotion.

**Release**:
Main's explicit cleanup of an exact rejected worker or superseded generation after proving that it is no longer selected. Release does not discard dirty, conflicted, or uncertain work.

**Subagent Collection**:
Tab-only cleanup of verified completed workers. It preserves sessions, leases, worktrees, candidates, and recovery records. A workspace with more than 10 tabs triggers an automatic attempt; `/subagent prune` attempts it at any count. Live isolated revision workers are not completed resources.

**Discard**:
The user-confirmed deletion of owned isolated resources from `/subagent`, including committed, uncommitted, and ignored content. Unlike Release, only the user can trigger it.

**Orphaned request**:
An isolated request whose parent checkout was removed. Other checkouts of the same repository can still list and discard it.

**Productive lease**:
Repository-scoped ownership that excludes concurrent execution or resumption while permitting status inspection and abort.

**Safety budget**:
A finite limit for child execution or a safety operation, not a deadline for the whole isolated request.

## Pending-result event contract

`pi-subagent:pending-result` is an optional synchronous query through `pi.events`.
The caller emits a mutable `{ sessionId: string, pending: false }` object, then reads
`pending` when `emit` returns. Pi Subagent changes only `pending`, and only to `true`.
No listener means no pending result. Listeners must not wait for asynchronous work.

A positive answer means that this process owns live direct or isolated work for
that exact current Pi session, with a future result message that triggers a turn.
Direct ownership starts after a verified launch. Isolated ownership starts after
durable acknowledgement. Ownership ends on completion or failure, before result
delivery. Cancellation, shutdown, and session replacement cannot grant ownership.
Retained tabs, checkout admission, saved requests, interrupted or unknown work,
and results whose delivery failed do not grant ownership.

Pi Goal checks this query after its budget and continuation limits, before its
no-progress check. A positive answer lets Pi settle without another continuation
or a no-progress warning. The result message starts ordinary goal handling again.
No package dependency is required. Background-command notices do not trigger a
turn and do not participate in this contract.
