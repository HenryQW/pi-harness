# Orchestration and package-author API

`pi-subagent` owns both delegation paths behind `delegate_task`:

```text
                         ┌─ direct ─── read-only Herdr tab in Main's workspace
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
  "kind": "text",
  "modelClass": "fast"
}
```

```json
{
  "mode": "direct",
  "tasks": [
    { "role": "scout", "name": "Inspect service", "task": "Inspect the service boundary." },
    { "role": "reviewer", "name": "Inspect tests", "task": "Inspect the test contract." }
  ]
}
```

```json
{
  "mode": "direct",
  "chain": [
    { "role": "scout", "name": "Collect evidence", "task": "Collect exact evidence." },
    { "role": "reviewer", "name": "Review evidence", "task": "Review this report:\n{previous}" }
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
| `kind` | no | `text` only (default); direct `changeset` is rejected |
| `modelClass` | no | `fast`, `balanced`, `frontier`, or `fav` route |
| `model` | no | `provider/modelId`; replaces only the route model |

An explicit model must support the route's thinking level. A launched child is never retried automatically after provider or process failure.

Only Roles with known read-only tools and no extensions or MCP servers may run direct. A direct `changeset` or write-capable Role is rejected; use isolated mode for implementation. Parallel reads run concurrently and report in request order. A chain substitutes only the preceding successful output and stops at its first failure.

The tool returns a handle after the first exact Herdr tab is launched. The remaining tabs are launched asynchronously; their identities are recorded on the session branch. A session-owned observer awaits each exact agent's lifecycle and retrieves its final answer from its Pi session file, not its possibly truncated screen. Idle, blocked, unknown, malformed, or oversized answers fail with recoverable tab/session identity; no whole-run deadline is imposed. `/subagent-direct-recovery` shows exact launched tabs. A session switch stops observation and carries tab identity into the new branch.

The result is delivered to Main with `triggerTurn: true, deliverAs: "followUp"`. Busy Main finishes its current turn before consuming the result; idle Main starts a turn. Herdr reports worker lifecycle but never prompts Main directly. Read-only workers can observe a concurrently changing checkout; consumers must account for drift rather than treating a tab as file isolation.

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
- `contextFrom` may reference completed text tasks only and preserves declaration order.
- A graph containing changesets requires final checks. The repository root must have a `package.json` test script; admission prepends canonical `pnpm test` if absent from final checks. Combined validation rejects a changed root test script.

The runner executes ready worker tasks concurrently, inspects clean committed candidates, runs preliminary task checks and optional preliminary judgment, then records ready candidates for Main. **It does not automatically integrate them.** Main selects exact candidates via `subagent_stage` into an owned integration checkout in explicit order. Each stage is a committed merge of the candidate, not a mutation of Main. Conflicts retain the checkout for Main to resolve; `resolve` verifies the exact two-parent merge instead of replaying an uncertain merge. Main can explicitly run dependent tasks from an exact staged tip with `subagent_integrate advance` and stage their results afterward. Independent candidates may be staged without re-running workers.

Once all selected work is staged, Main calls `subagent_integrate validate` on the exact clean combined tip. This runs every final check, including `pnpm test`, and optional final judgment in the integration checkout before any Main mutation. A failed check/review can be followed by one Main-authored committed correction in that checkout, recorded with `correct`, then another `validate`. `promote` requires exact passing combined evidence and unchanged Main and uses a guarded update to Main. Only proven promotion leads to selected-worker termination and verified cleanup. A changed candidate, integration tip, or Main identity invalidates prior evidence or blocks promotion; review accepts only exact `PASS`.

### Readiness and Main actions

The user's request can authorize the declared local graph, checks, review, and Main's later explicit integration actions. After each successful preliminary check batch, the runner drains any follow-up already queued for the same live worker. Each revision must produce a new clean commit and rerun preliminary checks. When the queue is empty, the runner atomically seals the candidate and persists exact readiness evidence without waiting for input.

`/subagent-followup <request-id> <task-id> <message>` queues an optional same-worker revision only while the task is actively working. There is no guaranteed post-completion editing window; late follow-ups fail visibly. After readiness, use `subagent_stage revise` with an exact candidate, generation, current `expectedTip`, and instruction when a same-worker correction remains allowed. Material scope growth, missing authorization, user-owned conflicts, or consequential external actions still require a new decision. pi-subagent never pushes, publishes, deploys, or opens a pull request.

`subagent_status` reports ready candidates with `taskId`, `attempt`, and `tip`, plus each generation's number, stage lineage, combined tip, checks, promotion, and retained worktree. Use those exact identities (including branch, HEAD, index, and tree) rather than guessed commits:

- `subagent_stage`: `{ id, action: "stage" | "resolve" | "reject" | "revise", generation, taskId, attempt, candidate, expectedTip, instruction? }`. `candidate` is the ready candidate's `tip`; `expectedTip` is Main's recorded identity for the first stage or the previous stage's exact tip. `resolve` reconciles a pending/conflicted merge; `reject` and `revise` arbitrate a candidate without changing Main.
- `subagent_integrate`: `{ id, action: "advance" | "validate" | "correct" | "promote" | "reconcile" | "cleanup", generation, expectedTip }`. Use the generation's exact `combinedTip`. `advance` dispatches ready dependents on that snapshot, `correct` records the single clean committed correction after a definitive failed check/review, `reconcile` inspects an interrupted validation or promotion without replaying an uncertain promotion, and `cleanup` completes proved post-promotion cleanup.
- `subagent_integrate refresh`: `{ id, action: "refresh", generation, expectedTip, expectedMain, newMain }`. If Main advanced to a clean same-branch descendant, this freezes the old generation and allocates a new integration checkout from `newMain`. Restage selected immutable candidates in explicit order, resolve fresh conflicts, then rerun combined validation. Dirty, divergent, or uncertain Main cannot refresh.

A rejection or revision of a staged candidate supersedes that generation, leaves its checkout read-only, and requires explicit restaging of chosen candidates into a new generation. At most two owned integration checkouts/generations can be allocated per request. Superseded integration checkouts and rejected candidate resources are **retained, not automatically cleaned**; inspect exact status and clean them manually. Rejection invalidates dependent attempts; if the required fresh dependent work cannot run within the bounded attempt/lineage constraints, start a new request. `subagent_abort` cannot abort a request with retained candidates or integration generations.

### Recovery and state

State version 5 is stored privately under:

```text
<agent-dir>/config/pi-subagent/state/<repository-hash>/<request-id>.json
```

Strict parsing rejects unknown properties, malformed evidence, invalid lineage, and old v4 state without migration; preserve old files and recover their work manually. Writes are atomic and repository productive work uses a durable process lease. `delegate_task` and `subagent_resume` acknowledge only after durable state is saved, then continue productive work asynchronously. Completion or attention is sent as a Pi follow-up to the launching session. `subagent_status` is read-only and remains the recovery authority if a follow-up is missed. `subagent_resume` accepts only the continuation reported by state. `subagent_abort` performs exact worker termination and teardown.

Productive execution has no whole-run wall-clock deadline. Long productive work and later resumes remain valid. The request retains its original policy snapshot and correction count; a resume cannot refill them. Current configuration may tighten the correction allowance. Child idle/hard runtime, subprocess I/O, status inspection, termination, cleanup, and outer abort remain bounded independently.

Ambiguous prompt submission or merge/promotion is never replayed automatically. Unknown allocation, failed checks, review findings, Main drift, conflicts, interrupted promotion, unproved termination, or cleanup failure requires Main attention and preserves exact evidence. A definitive failed combined check retains its generation for one correction. Proven promotion is never rolled back; recovery finishes termination and cleanup. Only selected workers and the promoted integration checkout are automatically cleaned after proven promotion.

## Role and resource policy

A Role declares tools, trusted extension sources, Skill names, optional MCP names, instructions, and an optional model-class default. Roles do not declare isolation.

Every child launch:

1. disables ambient extension and Skill discovery;
2. loads only declared resources plus required internal adapters;
3. resolves Skill and model names from Pi's effective registries;
4. installs an exact tool policy;
5. excludes Main-only delegation/recovery tools and `ask_question`; and
6. prepends the delegated-subagent identity contract.

An empty `tools` list adds no base tools, though selected extension tools can still activate. Omitted or empty `mcps` denies MCP access. Loading `pi-mcp-adapter` directly is rejected because it bypasses the allowlist.

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
| `loadRoles` | Load built-in and user Role Markdown with strict validation |
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
