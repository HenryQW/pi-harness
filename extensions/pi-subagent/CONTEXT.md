# Pi Subagent Context

## Purpose

Own Role-configured Pi delegation through one `delegate_task` surface:

- **direct mode** runs authorized compact shared-checkout work in Herdr tabs in Main's workspace and returns a handle before completion;
- **isolated mode** runs durable checked graphs with Herdr worktrees, exact Git identities, guarded integration, and recovery; and
- the package root exposes the Role, executor, worktree, evidence, schema, state, and runtime mechanisms used by the extension.

## Domain glossary

- **Main**: the Pi session and checkout coordinating delegated work.
- **Role**: package or user Markdown defining responsibility, tools, trusted extension sources, Skills, optional MCP names, instructions, and an optional model-class default. Roles do not select isolation.
- **Model Class**: `fast`, `balanced`, `frontier`, or `fav`, resolved through `pi-task-models`.
- **Direct task**: one bounded task using its Role's declared resources in Main's shared checkout; authorized writes take effect immediately without checked integration.
- **Isolated request**: one durable ID, goal, and checked task graph.
- **Candidate**: exact clean committed task-worktree identity produced by an isolated changeset worker.
- **Readiness**: durable proof that one exact live-worker candidate passed its preliminary checks and is sealed for Main's explicit selection; it is not a separate user approval.
- **Integration generation**: Main's owned, ordered assembly of selected candidates in a separate checkout; each replaced assembly remains an inspectable superseded generation.
- **Release**: Main's explicit, exact-identity cleanup of a rejected worker or superseded generation after proving it is no longer selected; it never discards dirty or conflicted work.
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
- Productive execution has no whole-run wall-clock deadline. Long productive work and later resume remain valid. Direct Herdr observation also has no whole-task elapsed deadline; worker idleness is bounded.
- Child idle/hard runtime, turn/token handling, outer abort, process I/O, status inspection, termination, and cleanup remain independently bounded. Direct Herdr workers use idle limits, not ephemeral child hard runtime.
- Ephemeral children share one FIFO executor pool. Queued time consumes no child timeout. Isolated Herdr Role launches receive the same non-refilling turn/token/runtime budget metadata.

### Direct evidence

- Direct mode admits declared write-capable resources for explicitly authorized scope while preserving read-only Role restrictions. Potential-writer requests serialize tasks and retain Pi checkout admission until exact owned worker termination is proved by pane absence and two empty private process-lease scans; uncertain termination retains admission and live recovery ownership. Potential-writer answers require an explicit structured `succeeded` outcome; failed, blocked, or malformed completion stops dispatch but does not prevent release after proved termination. `/subagent` Close/cancel-and-release retries termination under session, branch, epoch and exact ownership guards without replaying work or removing checkout/session evidence. This is a worker report, not proof of validation, cleanliness, rollback, or checked integration. Direct changesets require isolated mode.
- Only direct requests with potential writers reserve checkout admission. They cannot start while another direct writer holds it or a Main potentially-writing call is in flight. Main calls, including Bash and nested `codemode` writes, do not block each other. A direct writer blocks Main's writes until verified worker termination; use isolated mode when Main must continue writing. Reads never wait.
- Each direct worker has a recorded Herdr tab and Pi session identity. The first handle returns before completion; subsequent tab identities remain recoverable on the session branch.
- An exact settled worker with a bounded final Pi answer produces a follow-up to Main. Blocked, unknown, idle-stalled, truncated, or ambiguous outcomes retain actionable recovery identity. Session replacement never delivers to the wrong Main session.

### Isolated lifecycle

- Changeset tasks durably record allocation intent before each external side effect. Unknown outcomes are retained and never guessed.
- One worker remains live across prompts, preliminary checks, follow-up/correction, readiness, Main's staging decisions, combined validation, and guarded promotion. Selected workers terminate after promotion; rejected workers terminate on explicit rejection.
- Optional same-worker follow-ups are admitted only while a changeset is actively working. After the final checked-evidence save, one synchronous queue-or-seal transition prevents admitted revisions from being lost; the runner never waits for routine input.
- Worker waves pin Main's committed branch/HEAD/tree, excluding staged, unstaged, and untracked changes; dirty Main permits checked candidate readiness, but branch/HEAD drift blocks dispatch and clean Main is required before staging, combined validation, or promotion.
- Preliminary checks gate readiness. Any changed candidate invalidates previous readiness and validation.
- Optional task judgment binds to the exact preliminary candidate. Main selects and orders candidates in a separate owned integration checkout, where final full-suite checks and optional final judgment bind to the clean combined tip before promotion.
- Promotion requires exact unchanged clean Main and a passing combined generation. Durable promotion evidence precedes selected-worker termination and cleanup; recovery never rolls back a proven promotion.
- Rejected workers and superseded generations stay retained until Main explicitly releases their exact clean, proved-owned resources. At most two unreleased integration checkouts coexist.
- Failures, ambiguity, interruption, review findings, conflicts, drift, unproved termination, or cleanup failure enter `needs_attention` and preserve evidence.
- `subagent_status` is read-only, callable from `codemode` scripts, and returns the bounded public projection as structured content, never raw run state. `delegate_task`, `subagent_resume`, `subagent_stage`, `subagent_integrate`, and `subagent_abort` are model-only. `subagent_resume` accepts only strict `retry`, `verify`, or `finalize` continuations. `subagent_abort` terminates only exact owned workers.
- The extension never pushes, opens a pull request, publishes, deploys, stashes, resets, force-cleans, or deletes unproved recoverable work.

### Resource and launch policy

- Ambient child extensions and Skills stay disabled. Only Role/caller resources plus required internal adapters load.
- Every Role requires `tools`, `extensions`, and `skills` arrays. `extensions` may name Pi built-in extensions as `builtin:<name>`. A Role activates `codemode` only by naming it in `tools` with `builtin:codemode` loaded; MCP configuration never activates it, and Pi's codemode settings apply unchanged. `mcps` names servers from the global `~/.pi/agent/mcp.json`; their tools keep their configured exposure in a codemode Role and are forced to direct exposure otherwise. Omitted or empty `mcps` denies MCP access. Direct `pi-mcp-adapter` loading is rejected because it bypasses the allowlist.
- The Role tool policy declares the Role's `tools` and the extension tools Pi would declare on registration; extension tools with `codemode` or `deferred` exposure stay callable from scripts without being declared.
- Selected extensions are trusted executable bundles, not a sandbox. All tools and lifecycle behavior they register load together.
- Role Skill names resolve through Main's effective Pi registry. Missing Roles, Skills, tools, MCP servers, routes, models, or thinking levels fail before the first productive turn.
- Route precedence is call model class, then Role default, then registered Model Task assignment/default. A direct model replaces only the route model and must support its thinking level.
- Main-only delegation/recovery tools and `ask_question` are excluded from children. Recursive delegation is unavailable.
- Package built-ins are `implementer`, `reviewer`, and `scout`; a same-named user Role overrides a built-in.
- `git_read` is an internal read-only child tool loaded only for Roles declaring it; the built-in reviewer opts in. Fixed structured Git operations provide bounded local evidence without Bash, network, external filters, or mutations. Named-ref context supplements but never replaces the authoritative exact isolated review patch.

### Executor boundaries

- A terminal response at the turn boundary succeeds; attempted continuation fails with typed `turn_limit` and bounded retained output.
- Token accounting sums completed assistant responses once. A terminal crossing succeeds. A continuing crossing completes tools and receives one response-only handoff; further continuation fails.
- Recognized Pi JSON events renew idle timeout; raw bytes do not. Child maximum runtime always terminates ephemeral children.
- Output, stderr, protocol events, callback draining, and inherited descendant streams are bounded.
- Low-level worktree finalization returns explicit `pruned`, `retained`, or `recovery` evidence and never force-deletes uncertain work.
- Exact review helpers produce bounded private evidence; callers must preserve identity guards and verdict validation.

## Owned storage

- User config and Role Markdown: `<agent-dir>/config/pi-subagent/`
- Durable state: `<agent-dir>/config/pi-subagent/state/<repository-hash>/`
- Shared model routes: `<agent-dir>/config/pi-task-models/config.json`

State version 4 is strict. Older or malformed files are rejected rather than rewritten or migrated silently.
