# Pi Subagent Context

## Purpose

Own Role-configured Pi delegation through one `delegate_task` surface:

- **direct mode** runs compact work in Main's checkout and can bind checks and judgment to exact working-change evidence;
- **isolated mode** runs durable checked graphs with Herdr workers, exact Git identities, guarded integration, and recovery; and
- the package root exposes the Role, executor, worktree, evidence, schema, state, and runtime mechanisms used by the extension.

## Domain glossary

- **Main**: the Pi session and checkout coordinating delegated work.
- **Role**: package or user Markdown defining responsibility, tools, trusted extension sources, Skills, optional MCP names, instructions, and an optional model-class default. Roles do not select isolation.
- **Model Class**: `fast`, `balanced`, `frontier`, or `fav`, resolved through `pi-task-models`.
- **Direct task**: one text or changeset assignment in Main's checkout.
- **Isolated request**: one durable ID, goal, and checked task graph.
- **Candidate**: exact clean committed task-worktree identity produced by an isolated changeset worker.
- **Readiness**: durable proof that one exact live-worker candidate passed its preliminary checks and is sealed for automatic integration; it is not a separate user approval.
- **Productive lease**: repository-scoped process lease that excludes concurrent execute/resume while permitting status and abort.
- **Safety budget**: finite timeout for child work, process I/O, status, termination, or cleanup. It is not a whole-run deadline.

## Invariants

### Unified surface and modes

- Every `delegate_task` request declares `mode: "direct"` or `mode: "isolated"`. No path silently falls back between modes.
- Direct mode selects exactly one single, parallel, or chain shape. Unknown properties and mixed shapes fail before launch.
- Isolated mode accepts 1–8 typed tasks. `dependsOn` controls waves. `contextFrom` may name completed text tasks only and preserves declared order.
- Roles describe capability, not checkout placement. Role-level worktree isolation is rejected.

### Global limits

- `config/pi-subagent/config.json` is the only user execution-policy source. It owns `maxSubagents`, `maxTurns`, optional `maxTokens`, `maxCorrections`, and child idle/hard timeout.
- Request fields cannot override or replenish policy. Durable requests store the policy snapshot and cumulative correction count; current config may tighten the correction allowance.
- Productive execution has no whole-run wall-clock deadline. Long productive work and later resume remain valid.
- Child idle/hard runtime, turn/token handling, outer abort, process I/O, status inspection, termination, and cleanup remain independently bounded.
- Ephemeral children share one FIFO executor pool. Queued time consumes no child timeout. Isolated Herdr Role launches receive the same non-refilling turn/token/runtime budget metadata.

### Direct evidence

- Direct text work assigned to a potentially writing Role records checkout state and rejects any mutation.
- Direct changesets run serially in Main, leave changes uncommitted, and require exact command/argv checks.
- Checks and optional judgment bind to one exact working snapshot. Any mutation by checks or review invalidates evidence.
- Existing ambiguous Git state, hidden index content, unsupported layout, evidence overflow, or candidate drift fails closed and preserves files.
- Background direct mode admits only Roles proven read-only from declared tools, extensions, and MCP resources. It belongs to the launching session.

### Isolated lifecycle

- Changeset tasks durably record allocation intent before each external side effect. Unknown outcomes are retained and never guessed.
- One worker remains live across prompts, preliminary checks, follow-up/correction, readiness, rebase, authoritative validation, guarded integration, durable integration recording, exact termination, and cleanup.
- Optional same-worker follow-ups are admitted only while a changeset is actively working. After the final checked-evidence save, one synchronous queue-or-seal transition prevents admitted revisions from being lost; the runner never waits for routine input.
- Preliminary checks gate readiness. Any changed candidate invalidates previous readiness and validation.
- Authoritative task checks and optional exact-`PASS` judgment run after any required rebase. Final checks and optional final judgment bind to resulting Main.
- Integration requires exact expected Main and exact ready candidate identities. Same-wave integration follows request order.
- Integration is durably recorded before worker termination and cleanup. Recovery never rolls back recorded integration.
- Failures, ambiguity, interruption, review findings, conflicts, drift, unproved termination, or cleanup failure enter `needs_attention` and preserve evidence.
- `subagent_status` is read-only. `subagent_resume` accepts only strict `retry`, `verify`, or `finalize` continuations. `subagent_abort` terminates only exact owned workers.
- The extension never pushes, opens a pull request, publishes, deploys, stashes, resets, force-cleans, or deletes unproved recoverable work.

### Resource and launch policy

- Ambient child extensions and Skills stay disabled. Only Role/caller resources plus required internal adapters load.
- Every Role requires `tools`, `extensions`, and `skills` arrays. Omitted or empty `mcps` denies MCP access. Direct `pi-mcp-adapter` loading is rejected because it bypasses the allowlist.
- Selected extensions are trusted executable bundles, not a sandbox. All tools and lifecycle behavior they register load together.
- Role Skill names resolve through Main's effective Pi registry. Missing Roles, Skills, tools, MCP servers, routes, models, or thinking levels fail before the first productive turn.
- Route precedence is call model class, then Role default, then registered Model Task assignment/default. A direct model replaces only the route model and must support its thinking level.
- Main-only delegation/recovery tools and `ask_question` are excluded from children. Recursive delegation is unavailable.
- Package built-ins are `implementer`, `reviewer`, and `scout`; a same-named user Role overrides a built-in.

### Executor boundaries

- A terminal response at the turn boundary succeeds; attempted continuation fails with typed `turn_limit` and bounded retained output.
- Token accounting sums completed assistant responses once. A terminal crossing succeeds. A continuing crossing completes tools and receives one response-only handoff; further continuation fails.
- Recognized Pi JSON events renew idle timeout; raw bytes do not. Child maximum runtime always terminates ephemeral children.
- Output, stderr, protocol events, callback draining, and inherited descendant streams are bounded.
- Low-level worktree finalization returns explicit `pruned`, `retained`, or `recovery` evidence and never force-deletes uncertain work.
- Exact review and working-change helpers produce bounded private evidence; callers must preserve identity guards and verdict validation.

## Owned storage

- User config and Role Markdown: `<agent-dir>/config/pi-subagent/`
- Durable state: `<agent-dir>/config/pi-subagent/state/<repository-hash>/`
- Shared model routes: `<agent-dir>/config/pi-task-models/config.json`

State version 4 is strict. Older or malformed files are rejected rather than rewritten or migrated silently.
