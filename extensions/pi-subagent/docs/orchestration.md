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
- A `changeset` task requires checks and owns one worktree, Herdr workspace, worker tab, and retained worker.
- `dependsOn` controls ready waves.
- `contextFrom` may reference completed text tasks only and preserves declaration order.
- A graph containing changesets requires final checks.

The runner executes ready tasks concurrently, then integrates same-wave changesets in request order. It records exact identities around every consequential boundary:

1. inspect clean committed Main;
2. allocate and durably record exact resources;
3. prompt the worker and inspect the clean committed candidate;
4. run preliminary checks and atomically seal the candidate when no follow-up is queued;
5. record durable readiness for that exact candidate;
6. retain the worker while rebasing if Main moved;
7. rerun authoritative checks and optional exact judgment;
8. integrate only the recorded candidate onto the recorded Main identity;
9. durably record integration;
10. terminate that exact worker; and
11. clean only proved owned resources.

A changed candidate invalidates prior checks, judgment, and readiness. A rebase produces a new exact identity and requires authoritative validation. Review accepts only exact `PASS`; all other output is a finding.

### Automatic readiness

The user's request authorizes the declared local graph, checks, review, and integration once. After each successful preliminary check batch, the runner drains any follow-up already queued for the same live worker. Each revision must produce a new clean commit and rerun preliminary checks. When the queue is empty, the runner atomically seals the candidate and persists exact readiness evidence without waiting for input.

`/subagent-followup <request-id> <task-id> <message>` queues an optional same-worker revision only while the task is actively working. There is no guaranteed post-completion editing window; late follow-ups fail visibly. Material scope growth, missing authorization, user-owned conflicts, or consequential external actions still require a new decision. pi-subagent never pushes, publishes, deploys, or opens a pull request.

### Recovery and state

State version 4 is stored privately under:

```text
<agent-dir>/config/pi-subagent/state/<repository-hash>/<request-id>.json
```

Strict parsing rejects unknown properties, malformed evidence, invalid lineage, and older versions. Writes are atomic and repository productive work uses a durable process lease. `delegate_task` and `subagent_resume` acknowledge only after durable state is saved, then continue productive work asynchronously. Completion or attention is sent as a Pi follow-up to the launching session. `subagent_status` is read-only and remains the recovery authority if a follow-up is missed. `subagent_resume` accepts only the continuation reported by state. `subagent_abort` performs exact worker termination and teardown.

Productive execution has no whole-run wall-clock deadline. Long productive work and later resumes remain valid. The request retains its original policy snapshot and correction count; a resume cannot refill them. Current configuration may tighten the correction allowance. Child idle/hard runtime, subprocess I/O, status inspection, termination, cleanup, and outer abort remain bounded independently.

Ambiguous prompt submission is never replayed automatically. Unknown allocation, failed checks, review findings, Main drift, conflicts, interrupted integration, unproved termination, or cleanup failure enters `needs_attention` and preserves exact evidence. Integration is never rolled back after it is durably recorded; recovery finishes termination and cleanup.

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
