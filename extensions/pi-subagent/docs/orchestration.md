# Orchestration and package-author API

`pi-subagent` owns both delegation paths behind `delegate_task`:

```text
                         ┌─ direct ─── authorized shared-checkout Herdr tab
request + Role + route ──┤
                         └─ isolated ─ Herdr worktree, checked candidate, durable state
```

Both paths resolve Roles and model routes from Pi's effective registries. They share the package's global concurrency, turn/token, timeout, and correction policy. A request cannot supply or refill execution limits.

## Direct contract

Direct mode selects one single, parallel, or chain workflow:

```json
{
  "mode": "direct",
  "role": "scout",
  "name": "Inspect auth flow",
  "task": "Return the relevant files and risks.",
  "access": "read",
  "kind": "text",
  "modelClass": "fast"
}
```

```json
{
  "mode": "direct",
  "tasks": [
    { "role": "scout", "name": "Inspect service", "task": "Inspect the service boundary.", "access": "read" },
    { "role": "reviewer", "name": "Inspect tests", "task": "Inspect the test contract.", "access": "read" }
  ]
}
```

```json
{
  "mode": "direct",
  "chain": [
    { "role": "scout", "name": "Collect evidence", "task": "Collect exact evidence.", "access": "read" },
    { "role": "reviewer", "name": "Review evidence", "task": "Review this report:\n{previous}", "access": "read" }
  ]
}
```

Unknown properties and mixed shapes are rejected.

### Delegation fields

Each entry has:

| Field | Required | Contract |
| --- | --- | --- |
| `role` | yes | Effective configured Role name |
| `name` | yes | Short display name without terminal controls |
| `task` | yes | Non-empty task packet |
| `access` | yes | `read` or `write`; Main's honest classification, not enforced |
| `continueFrom` | no | Direct reference such as `D7.1`; continues that finished worker's Pi session. `role` must equal the recorded Role |
| `kind` | no | `text` only (default); direct `changeset` is rejected |
| `modelClass` | no | `fast`, `balanced`, `frontier`, or `fav` route |
| `model` | no | `provider/modelId`; replaces only the route model |

An explicit model must support the route's thinking level. A launched child is never retried automatically after provider or process failure.

Direct tasks use their Role's declared resources, including write tools, within explicit task authorization. Resource/trust validation and recursive-delegation exclusions still apply. A direct `changeset` is rejected; use isolated mode for checked integration. Roles do not classify writes: a request is a write request when any task declares `access: "write"`. Write requests run serially and reserve checkout admission until owned workers are proved stopped. Read requests skip admission and return plain text; their parallel `tasks` run concurrently up to `maxSubagents`, while a chain stays ordered; `read` is not enforced. Results stay in request order. A chain substitutes only the preceding successful output and stops at its first failure.

The internal `git_read` tool is read-only and loads only when declared in the Role's `tools`; the built-in reviewer includes it. Supply named refs and paths for bounded local Git evidence without Bash. User reviewer overrides must opt in explicitly. Exact isolated review keeps the supplied patch authoritative; named-ref inspection may supply only referenced context, never another branch or worktree's candidate diff. Reviewers still run no tests or mutations and approve with exactly `PASS`.

Writes and commits immediately change the shared checkout; there is no automatic validation, rollback, or isolated promotion. A final answer in a write request must be a JSON object with `outcome` (`succeeded`, `failed`, or `blocked`) and a non-empty `answer`; only explicit worker-reported success permits later dispatch or admission release, not merely a normally settled Pi turn. Preserve unrelated files and index entries, require explicit commit/external-action scope, and report checkout status. Uncertain launch after tab creation, failure, or cancellation retains admission and exact recovery identities. Inspect `/subagent`, stop remaining owned workers, inspect and preserve changes, then restart Pi before new writes. Admission covers this Main's Pi calls, not other sessions or external processes.

The tool returns a handle after the first exact Herdr tab is launched. The remaining tabs are launched asynchronously; their identities are recorded on the session branch. A session-owned observer awaits each exact agent's lifecycle and retrieves its final answer from its Pi session file, not its possibly truncated screen. Idle, blocked, unknown, malformed, or oversized answers fail with recoverable tab/session identity; no whole-run deadline is imposed. `/subagent` shows exact recorded tabs on this session branch, distinguishing locally observed work from unobserved records. A session switch stops observation and carries tab identity into the new branch.

`continueFrom` resolves to exactly one recorded tab on the current session branch; an unknown or ambiguous reference, a different Role, or a second continuation of the same worker in one request fails before launch. The request also fails before launch while a locally active task owns the worker's session, when the session file is missing or above 16 MiB, or when its last exact turn for the recorded prompt is not terminal. Records without a saved turn identity (written before 27.0.0) are not continuable. Each record saves its Herdr workspace and checkout; a record from another workspace or checkout is refused. A session continued again has a later user turn, so only its newest reference is continuable. A still-listed old agent must match the exact recorded identity and be idle or done; it is closed with the same proof as termination (pane absence and two empty lease scans), and an absent agent still needs the two empty scans. The worker then starts in a new non-focused tab with Pi `--session` on the same file and the same private lease, a new agent name, and a new reference and record. Its answer is matched by the new prompt's turn identity. Access, admission, write rules, and route precedence are the same as for a new task; the handle and result name the source reference.

In `/subagent`, a locally owned active workflow whose tasks are all `read` offers **Stop this worker** for each running worker. Each entry has its own abort controller linked to the workflow controller. Stop aborts only that entry, sends Ctrl-C, and proves termination with the exact pane close, pane absence, and two empty lease scans. The entry fails with `Stopped by user from /subagent` and keeps partial output; siblings continue, a chain stops later steps, and Main still receives one result. Write workflows offer only all-or-nothing Close. Stop uses the same session, branch, epoch, and ownership guards as Close. If a stop proof fails, the workflow keeps local ownership after its siblings settle, so Close can retry termination.

The result is delivered to Main with `triggerTurn: true, deliverAs: "followUp"`. Busy Main finishes its current turn before consuming the result; idle Main starts a turn. Herdr reports worker lifecycle but never prompts Main directly. Read-access workers can observe a concurrently changing checkout; consumers must account for drift rather than treating a tab as file isolation.

## Isolated contract

An isolated call is a checked directed graph:

```text
{
  mode: "isolated",
  id,
  goal,
  tasks: [1..8],
  finalChecks?,
  finalJudgment?
}
```

Every task declares `id`, `kind`, `role`, `modelClass`, `requirements`, `deliverable`, `dependsOn`, and `contextFrom`.

- A `text` task runs in a disposable child worktree and must leave it unchanged.
- A `changeset` task requires focused checks and owns one worktree, Herdr workspace, worker tab, and retained worker.
- `dependsOn` controls ready waves; dependent tasks can run from a selected staged snapshot only after Main explicitly advances it.
- `contextFrom` may reference completed text tasks only, implies scheduling dependencies, and preserves declaration order. It must not overlap `dependsOn`.
- A graph containing changesets requires final checks. The repository root must have a `package.json` test script; admission prepends canonical `pnpm test` if absent from final checks. Combined validation rejects a changed root test script.

Admission and worker-wave dispatch pin Main's exact committed branch, HEAD, and tree without inspecting or modifying its staged, unstaged, or untracked edits. Worker allocation verifies the same committed identity around worktree creation, including resumed waves; staged-dependent waves verify their clean integration snapshot. A dirty Main can therefore produce a checked retained candidate, but branch/HEAD drift stops new waves. The runner executes ready worker tasks concurrently, inspects clean committed candidates, runs preliminary task checks and optional preliminary judgment, then records ready candidates for Main. **It does not automatically integrate them.** Main selects exact candidates via `subagent_stage` into an owned integration checkout in explicit order. Each stage is a committed merge of the candidate, not a mutation of Main. Conflicts retain the checkout for Main to resolve; `resolve` verifies the exact two-parent merge instead of replaying an uncertain merge. Main can explicitly run dependent tasks from an exact staged tip with `subagent_integrate advance` and stage their results afterward. Independent candidates may be staged without re-running workers.

Once all selected work is staged, Main calls `subagent_integrate validate` on the exact clean combined tip. It acknowledges the durably saved validation intent and continues in the session-owned background, independent of later turn cancellation; session replacement/shutdown still cancels it. A follow-up reports completion; status remains authoritative if delivery is missed. This runs every final check, including `pnpm test`, and optional final judgment in the integration checkout before any Main mutation. A failed check/review can be followed by one Main-authored committed correction in that checkout, recorded with `correct`, then another `validate`. Staging, combined validation, and `promote` require clean Main at the recorded committed identity; they stay blocked by dirty edits even when the checked candidate is retained, and no dirty work is replayed or merged automatically. `promote` requires exact passing combined evidence and unchanged Main and uses a guarded update to Main. Only proven promotion leads to selected-worker termination and verified cleanup. A changed candidate, integration tip, or Main identity invalidates prior evidence or blocks promotion; review accepts only exact `PASS`.

### Readiness and Main actions

The user's request can authorize the declared local graph, checks, review, and Main's later explicit integration actions. After each successful preliminary check batch, the runner drains any follow-up already queued for the same live worker. Each revision must produce a new clean commit and rerun preliminary checks. When the queue is empty, the runner atomically seals the candidate and persists exact readiness evidence without waiting for input.

`/subagent` opens a native picker for direct recovery and isolated inspection; locally owned active changesets may queue an optional same-worker revision or drain all still-pending instructions into the native editor and submit one replacement. Cancel after draining leaves them withdrawn; claimed instructions are unaffected. Pi's global Option+Up is unchanged. There is no guaranteed post-completion editing window; late follow-ups fail visibly. After readiness, use `subagent_stage revise` with an exact candidate, generation, current `expectedTip`, and instruction when a same-worker correction remains allowed. Material scope growth, missing authorization, user-owned conflicts, or consequential external actions still require a new decision. pi-subagent never pushes, publishes, deploys, or opens a pull request.

`subagent_status` puts failed review verdicts from every task's latest attempt (also while siblings run), the final gate, and each generation into its model-visible text within one shared 32 KiB budget and counts omitted verdicts; its structured projection carries each verdict up to 32 KiB and sets `verdictTruncated` when it is cut; asynchronous follow-ups keep a short preview and point Main to `subagent_status`. It reports ready candidates with `taskId`, `attempt`, and `tip`, plus each generation's number, stage lineage, combined tip, checks, promotion, and retained worktree. Use those exact identities (including branch, HEAD, index, and tree) rather than guessed commits:

- `subagent_stage`: `{ id, action: "stage" | "resolve" | "reject" | "revise", generation, taskId, attempt, candidate, expectedTip, instruction? }`. `candidate` is the ready candidate's `tip`; `expectedTip` is Main's recorded identity for the first stage or the previous stage's exact tip. `resolve` reconciles a pending/conflicted merge; `reject` and `revise` arbitrate a candidate without changing Main.
- `subagent_integrate`: `{ id, action: "advance" | "validate" | "correct" | "promote" | "reconcile" | "cleanup", generation, expectedTip }`. Use the generation's exact `combinedTip`. `advance` dispatches ready dependents on that snapshot, `correct` records the single clean committed correction after a definitive failed check/review, `reconcile` inspects an interrupted validation or promotion without replaying an uncertain promotion, and `cleanup` completes proved post-promotion cleanup.
- `subagent_integrate refresh`: `{ id, action: "refresh", generation, expectedTip, expectedMain, newMain }`. If Main advanced to a clean same-branch descendant, this freezes the old generation and allocates a new integration checkout from `newMain`. Restage selected immutable candidates in explicit order, resolve fresh conflicts, then rerun combined validation. Dirty, divergent, or uncertain Main cannot refresh. For a reconciled `validation_failed` generation without checks, review, or a prior combined correction, identical `expectedMain` and `newMain` instead rebuild on the unchanged base. This requires the exact clean retained integration tip, leaves the old checkout retained, and never resumes its uncertain checks. Prove old coordinator/check processes stopped before recovery; a live productive lease blocks it. Restage explicitly and rerun all final gates; no correction allowance is replenished.
- `subagent_integrate release`: `{ id, action: "release", generation, expectedTip, taskId?, attempt? }`. With no task, release an explicitly superseded checkout using that generation's last staged tip (or integration base if empty). With both `taskId` and `attempt`, release a rejected, terminated worker using its exact candidate tip and the latest generation number (or 1 when none exists); release every generation that staged it first. Cleanup steps are persisted separately, and a retry reconciles already-removed resources by proving absence. Release refuses dirty/conflicted work, changed refs, unproved termination, and still-needed checkouts.

A rejection or revision of a staged candidate supersedes that generation, leaves its checkout read-only, and requires explicit restaging of chosen candidates into a new generation. At most two unreleased owned integration checkouts can coexist per request. Superseded integration checkouts and rejected candidate resources are **retained until Main explicitly releases them**. Inspect exact status first; dirty or unresolved conflicts require manual recovery without force deletion. Rejection invalidates dependent attempts; if the required fresh dependent work cannot run within the bounded attempt/lineage constraints, start a new request. `subagent_abort` cannot discard retained resources, but can finish after all candidates are rejected and all owned checkouts are released.

### Recovery and state

State version 5 is stored privately under:

```text
<agent-dir>/config/pi-subagent/state/<repository-hash>/<request-id>.json
```

Strict parsing rejects unknown properties, malformed evidence, invalid lineage, and old v4 state without migration; preserve old files and recover their work manually. Writes are atomic and repository productive work uses a durable process lease. `delegate_task` and `subagent_resume` acknowledge only after durable state is saved, then continue productive work asynchronously. A durably recorded worker attention state sends an immediate once-per-transition Pi follow-up to the launching session, even while siblings run; the wave also reports its final outcome. Isolated workers persist a private exact Pi session under the owned process lease so a proved final answer without a changed clean commit becomes attention rather than an indefinitely pending prompt. Missing or mismatched session proof cannot establish completion and never authorizes prompt replay. When a proved finished turn leaves tracked or untracked changes in a valid owned worktree, the runner sends the same worker one commit reminder per attempt, saved as a follow-up prompt record before delivery like any other prompt. It does not use a correction or a dispatch attempt. The runner never commits, stages, stashes, or discards; a commit from the reminder goes through the normal candidate path, and a worktree still dirty after it needs attention. `subagent_status` is read-only and remains the recovery authority if a follow-up is missed. `subagent_resume` accepts only the continuation reported by state. A `retry` that sends a same-worker correction may add an `instruction` (at most 32000 exact characters, no NUL), appended to the correction prompt as Main's instruction after the saved failure and saved in its prompt record before delivery; other actions reject it. `subagent_abort` performs exact worker termination and conservative teardown. Without a retained candidate, it removes only owned checkouts still clean and unchanged from their pinned base, including ignored-file checks. Active productive execution defers cleanup until it settles. Repeating abort on an aborted request reconciles pending cleanup without replaying uncertain termination. Dirty or committed work and uncertain allocations stay retained with visible blockers; `/subagent recover` includes aborted requests with retained resources.

`/subagent prune` reviews every `pi-subagent/subagent-<24 hex>` branch in the repository and its `.worktrees/` checkout. An item is removable only when its tip is an ancestor of Main's HEAD or the local `origin` default-branch ref (no fetch), the checkout is still on its own branch (a detached or switched owned checkout is found by path and blocks), has no tracked or untracked changes, no initialized submodules, and no in-progress Git operation, no non-terminal or unreadable state in any of the repository's checkouts records its name (a non-regular state entry counts as unreadable and may own any name), no productive lease is live, and no Herdr pane works inside the checkout (unavailable Herdr refuses). Removal needs interactive confirmation; checkouts with ignored files need a second confirmation that names each ignored entry in full, and a checkout whose list does not fit is left out; that approval covers each entry with all its contents, and a new or changed top-level ignored entry skips the checkout. Prunable items are listed first, and only items shown in full in both dialogs can be removed; an over-long list ends with an explicit `+N more not shown` line instead of a silent cut. The confirming session's ownership is rechecked immediately before each `git worktree remove` and branch deletion. Each item is re-verified immediately before `git worktree remove`, and its branch is deleted with a compare-and-swap on the reviewed tip. Aborted requests that recorded a removed resource are then reconciled by the guarded abort path, which proves absence; requests it cannot reconcile are reported. State files are never edited directly.

Text attempt history records dispatches, not pre-dispatch inspection failures. Such failures retain task-level attention without adding an attempt or rewriting earlier execution diagnostics. A recorded interrupted dispatch still consumes an attempt. Verification requires the same passing preliminary checks, judgment, and ownership as candidate retention; readiness and the verified candidate are saved together.

Productive execution has no whole-run wall-clock deadline. Long productive work and later resumes remain valid. The request retains its original policy snapshot and correction count; a resume cannot refill them. Current configuration may tighten the correction allowance. Child idle/hard runtime, subprocess I/O, status inspection, termination, cleanup, and outer abort remain bounded independently.

Ambiguous prompt submission or merge/promotion is never replayed automatically. Unknown allocation, failed checks, review findings, Main drift, conflicts, interrupted promotion, unproved termination, or cleanup failure requires Main attention and preserves exact evidence. A definitive failed combined check retains its generation for one correction. Proven promotion is never rolled back; recovery finishes termination and cleanup. Only selected workers and the promoted integration checkout are automatically cleaned after proven promotion; rejected workers and superseded generations require the explicit `release` action.

## Role and resource policy

A Role declares tools, trusted extension sources, Skill names, optional MCP names, instructions, and an optional model-class default. Roles do not declare isolation.

Every child launch:

1. disables ambient extension and Skill discovery;
2. loads only declared resources plus required internal adapters;
3. resolves Skill and model names from Pi's effective registries;
4. installs an exact tool policy;
5. excludes Main-only delegation/recovery tools and `ask_question`; and
6. prepends the delegated-subagent identity contract.

An empty `tools` list adds no base tools, though selected extension tools can still activate; extension tools with `codemode` or `deferred` exposure stay callable from scripts and are declared only when `tools` names them. Children run with `--no-extensions`, so a Role must list the extension that registers its route model's provider; `builtin:<name>` entries load Pi built-in extensions. A Role activates `codemode` by listing `builtin:codemode` in `extensions` and `codemode` in `tools`. `mcps` names servers from the global `~/.pi/agent/mcp.json` in Pi's native format; their tools keep their configured exposure in a codemode Role and load with direct exposure otherwise. Omitted or empty `mcps` denies MCP access. Loading `pi-mcp-adapter` directly is rejected because it bypasses the allowlist.

Isolated Herdr Role launches receive the same turn, token, and child-runtime budget metadata as ephemeral launches. Retained workers therefore keep one non-refilling session budget across follow-ups rather than receiving a new request budget.

## Ephemeral executor API

```js
const executor = createEphemeralSubagentExecutor({
  maxConcurrency: 4,
  maxTurns: 50,
  maxTokens: 100_000, // optional
  timeout: {
    idleMs: 10 * 60_000,
    maxMs: 30 * 60_000,
  },
});

const result = await executor.run({
  signal,
  onUpdate(text) {},
  onTokens(total) {},
  onActivity(event) {},
  prepare: async () => ({ launch, task, cwd }),
});
```

The FIFO permit is acquired before `prepare`, so queued work can resolve fresh Role and route state without consuming timeout. Each child gets independent turn/token and idle/hard-runtime limits. Output, stderr, protocol events, callback draining, and descendant stream draining are bounded.

A result contains `outcome`, `exitCode`, bounded `output` and `stderr`, truncation state, optional stop reason/error, and aggregate usage. Abort, timeout, turn/token limit, spawn, protocol, preparation, and callback failures reject with typed `EphemeralSubagentError` codes.

Token accounting adds each completed assistant response once. A terminal response that crosses the configured token value succeeds. A continuing crossing turn completes tools and receives one response-only handoff; further continuation fails. Role tools provide a convergence warning near configured turn/token/runtime limits.

## Role launch API

The package exports:

| API | Responsibility |
| --- | --- |
| `loadRoleCatalog` / `findRole` | Load built-in and user Roles with `roleDefaults` and per-file errors; select one by name |
| `parseRoleName` | Normalize arbitrary Role names and reject display controls |
| `resolveRoleSkills` | Resolve named Skills from Pi's effective registry |
| `resolveRoleLaunch` | Resolve Role, caller-owned Model Task, resources, and route |
| `resolveConfiguredRoleLaunch` | Resolve a named Role with an explicit model class |
| `prepareRoleLaunch` / `finalizeRoleLaunch` | Separate stable prompt data from final argv and tool policy |
| `createEphemeralSubagentExecutor` | Run bounded no-session Pi children through one FIFO pool |
| `createChildWorktree` / `finalizeChildWorktree` | Create and conservatively finalize optional child worktrees |
| `prepareExactReviewEvidence` | Produce bounded private base-to-tip evidence |
| checked runner exports | Compose strict schemas, state, Git, Herdr, and launch runtimes |

Package callers must register their Model Task once with `@henryqw/pi-task-models`. `resolveRoleLaunch` applies call-level model class, then Role default, then the registered task route. `resolveConfiguredRoleLaunch` requires the class explicitly. Missing Skills reject before launch.

Worktree finalization returns one of:

- `pruned`: no commits and clean files were proved, then branch/worktree removal completed;
- `retained`: exact commit and dirty measurements are known and work remains; or
- `recovery`: cleanup or measurement needs deliberate action and reports only proved fields.

No cleanup path uses `git clean`, force deletion, hidden fallback to Main, or deletion of unproved work.
