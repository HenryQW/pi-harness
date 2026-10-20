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
The exclusive permission held by a direct write request that prevents Main and other direct writers from writing to the shared checkout. It remains held until worker termination is proven; read classification is not a sandbox.

**Isolated request**:
A durable goal and dependency graph of text and changeset tasks, with checked results and recovery state.

**Text task**:
An isolated-graph task whose result is bounded text rather than a changeset. Completed text can supply context to later tasks.

**Changeset task**:
An isolated-graph task that produces a committed change in its own worker worktree.

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

**Discard**:
The user-confirmed deletion of owned isolated resources from `/subagent`, including committed, uncommitted, and ignored content. Unlike Release, only the user can trigger it.

**Orphaned request**:
An isolated request whose parent checkout was removed. Other checkouts of the same repository can still list and discard it.

**Productive lease**:
Repository-scoped ownership that excludes concurrent execution or resumption while permitting status inspection and abort.

**Safety budget**:
A finite limit for child execution or a safety operation, not a deadline for the whole isolated request.
