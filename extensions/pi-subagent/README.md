# `@henryqw/pi-subagent`

Delegate bounded work to configured Pi Roles through [Herdr](https://herdr.dev/). Direct tasks share your checkout; isolated tasks produce checked candidates for explicit integration. Both return a handle so Main can continue working.

![Pi showing six delegated tasks running in parallel](./example.png)

## Install

Isolated work requires Herdr 0.9.3 or later for both the client and server. The server must run on API protocol 22 or later. Pi Subagent checks Herdr and server support before it starts.

```bash
pi install npm:@henryqw/pi-task-models
pi install npm:@henryqw/pi-subagent
```

Configure the profiles that your Roles use in `/task-models`. Direct writer termination proof requires native `lsof`.

## Works with

| Package | Relationship | Purpose |
| --- | --- | --- |
| [`@henryqw/pi-task-models`](https://pi.henry.wang/extensions/pi-task-models) | Required | Provides model routes for delegated Roles. |

## Use

Ask Main: “Have a scout trace sign-in without editing files.” Main calls `delegate_task` and stays available until progress and results arrive.

Commands and UI are for you. Tools and the packaged skill are for Main, except `git_read`, which is only for Role-declared children.

| Surface | Type | Purpose |
| --- | --- | --- |
| `/subagent` | command | Browse direct and isolated work. Stop or close owned direct workers, inspect isolated status, send follow-ups, or edit pending instructions. Requires interactive TUI or RPC. |
| `/subagent roles` | command | List Role sources, resources, resolved model and thinking level, route errors, and file errors. Read-only; requires no Herdr pane. |
| `/subagent prune` | command | Review remaining worker and integration branches and worktrees. Remove merged resources after confirmation. Requires a running Herdr server; without interactive UI, only reports. |
| `/subagent recover` | command | Classify orphaned isolated work in the canonical repository. Send Main request IDs, blockers, and next actions. Requires no UI or Herdr pane. |
| `delegate_task` | tool | Start authorized shared-checkout work or a durable isolated checked graph. |
| `subagent_status` | tool | Read saved isolated state, exact identities, failed review verdicts, and allowed continuation. Does not replay work. Supports structured output for `codemode`. |
| `subagent_resume` | tool | Perform the reported `retry`, `verify`, or `finalize` continuation, not staging or integration. Same-worker correction retries accept optional `instruction` text. |
| `subagent_stage` | tool | Stage, resolve, reject, or revise an exact candidate. Rejecting a staged candidate freezes its generation. |
| `subagent_integrate` | tool | Advance dependents, refresh, validate, correct, promote, reconcile, clean up promotion, or release rejected and superseded resources. |
| `subagent_abort` | tool | Terminate an isolated request without discarding retained work. Retained candidates and integration work require release or proof of absence. |
| `git_read` | tool | Let Role-declared children inspect bounded local Git evidence without Bash, tests, network access, or writes. Not available to Main. |
| `pi-subagent` | skill | Guide Main through authorization, delegation, checks, integration, and recovery. |
| Direct status widget (`D`) | ui | Show direct references, names, Role badges, status, routes, elapsed time, measured task tokens, and tool activity in the TUI. |
| Isolated status widget (`I`) | ui | Show recorded task state, Role/model-class badges, and retained workspaces in the TUI. Readiness does not mean promotion. |

`delegate_task`, `subagent_resume`, `subagent_stage`, `subagent_integrate`, and `subagent_abort` are model-only. Main must make these decisions visibly; `codemode` scripts can call only `subagent_status`.

### Direct workflow

A read-only task:

```json
{
  "mode": "direct",
  "role": "scout",
  "name": "Map sign-in flow",
  "task": "Trace sign-in through session creation. Report files and risks. Do not edit files.",
  "access": "read"
}
```

Choose exactly one shape:

```text
Single:   { mode: "direct", role, name, task, access, ... }
Parallel: { mode: "direct", tasks: [{ role, name, task, access, ... }] }
Chain:    { mode: "direct", chain: [{ role, name, task, access, ... }] }
```

Every task requires `access: "read"` or `access: "write"`. Declare `write` for file, Git, or external-resource changes. **Read access is not enforced and is not a sandbox.** The worker keeps its Role's tools.

Read requests run parallel tasks up to `maxSubagents`. Chains run in order, replace literal `{previous}` with the preceding successful answer, and stop on failure. Any `write` task makes the whole request serial and reserves checkout admission until all owned workers stop.

Direct writes change Main's checkout immediately, including dirty checkouts, and have no automatic checks or rollback. Preserve unrelated edits. See [Direct contract](./docs/orchestration.md#direct-contract) for write scope and checkout-admission rules.

Tasks in write requests must return one JSON completion object:

```json
{"outcome":"succeeded","answer":"Scoped commit completed."}
```

`outcome` accepts `succeeded`, `failed`, or `blocked`; `answer` must be non-empty. Plain text, malformed completion, blocked work, or failure stops later dispatch. Success is the worker's report, not independent validation. Checkout admission depends on proved termination, not the reported outcome.

The launch returns a task ID and first Herdr tab, not the answer. One follow-up delivers results when the workflow finishes. Busy Main receives it after its current turn; idle Main starts a turn. Failed partial output stays marked as partial, never success. Worker output carries no user authority.

To continue a finished worker, add `"continueFrom": "D7.1"` with the same `role`. This opens a new tab with the saved conversation and a new reference. Continue the newest reference from the original checkout and workspace. For eligibility and stop behavior, see [Continue or stop one direct worker](./docs/orchestration.md#continue-or-stop-one-direct-worker).

### Isolated workflow

![Isolated workers commit checked candidates; Main stages ready work while siblings run, advances dependents, validates the combined tip, and explicitly promotes](./docs/orchestration-architecture.svg)

Use isolated mode for checked implementation. An isolated request has one durable ID, one goal, and 1 to 8 text or changeset tasks:

```json
{
  "mode": "isolated",
  "id": "refresh-repair",
  "goal": "Repair token refresh.",
  "tasks": [{
    "id": "repair",
    "kind": "changeset",
    "role": "implementer",
    "modelClass": "balanced",
    "requirements": "Implement the smallest correct repair.",
    "deliverable": "A committed candidate in the owned worktree.",
    "dependsOn": [],
    "contextFrom": [],
    "checks": [{ "command": "pnpm", "args": ["test", "--", "refresh"] }]
  }],
  "finalChecks": [{ "command": "pnpm", "args": ["test", "--", "refresh"] }]
}
```

`dependsOn` controls scheduling. `contextFrom` also schedules dependencies and supplies completed text outputs in order. Do not repeat a task in both fields. Changesets require focused checks; graphs with changesets require final checks. The canonical root `package.json` must have a test script. The runner adds `pnpm test` to final checks if absent.

Workers use Main's pinned committed branch, HEAD, and tree, not staged, unstaged, or untracked edits. Branch or HEAD changes block new waves. Candidates must be committed with no tracked or untracked changes. Ignored generated files permit candidacy but prevent automatic cleanup.

Keep the durable ID; Main can work or end its turn without polling. Inspect ready candidates with `subagent_status`.

- `subagent_stage` stages exact candidates while siblings run; resolve conflicts in the integration checkout.
- `subagent_integrate advance` runs dependents on a staged snapshot.
- `subagent_integrate validate` checks the combined integration tip after the wave settles, with final checks and any final judgment.
- `subagent_integrate promote` explicitly promotes passing work.

Readiness requires preliminary checks and any task `judgment`; it does not permit promotion. Checks and judgments bind to exact Git identities. Staging, combined validation, and promotion require unchanged, clean Main at the pinned identity. Changed identities, conflicts, or uncertain outcomes block promotion and preserve evidence. A definitive combined check or review failure permits one committed integration correction, recorded with `subagent_integrate correct`, and another validation.

The extension sends follow-ups when a candidate becomes ready, a worker needs attention, and the wave finishes. A missed follow-up does not authorize replay. Read [Isolated contract](./docs/orchestration.md#isolated-contract) and [Exact integration actions](./docs/orchestration.md#exact-integration-actions) for graph, judgment, revision, refresh, and release details.

### Inspect work

Open `/subagent` to browse direct work on this session branch and isolated requests in the current canonical Git checkout, including other sessions. **Refresh** reloads saved status without recovery or mutation. Invalid state IDs stay preserved with a warning. Direct recovery remains available outside Git or without isolated inventory.

Inspection needs a Herdr pane, the configured `scout` Role, and the `fast` route. If it cannot start, the request stays unchanged; Main can use `subagent_status` to read state. See [Inspect and revise active work](./docs/orchestration.md#inspect-and-revise-active-work) for inspection and follow-up details.

See [Status widgets](./docs/orchestration.md#status-widgets) for reference numbering, token counts, and activity metrics, and [Choose a delegation mode](./docs/orchestration.md#choose-a-delegation-mode) for routing guidance.

![Main, its coordinator extension, and a Herdr subagent through checked work, worker failure, and coordinator interruption](./docs/worker-lifecycle.svg)

## Config

Package-owned: `~/.pi/agent/config/pi-subagent/config.json`. Missing files silently use defaults. No key is required; the extension preserves the file and never rewrites it automatically.

| Name | Description | Values | Default |
| --- | --- | --- | --- |
| `maxSubagents` | Concurrent direct workers and ephemeral children | Safe integer ≥ 1 | `5` |
| `maxTurns` | Provider turns per child | Safe integer ≥ 1 | `50` |
| `maxTokens` | Optional tokens per child | Safe integer ≥ 1 | Unlimited |
| `maxCorrections` | Same-worker automatic corrections per isolated request | Safe integer ≥ 0 | `1` |
| `timeout.idleMinutes` | Direct worker and ephemeral child idle timeout | Positive; within Node's timer range | `10` |
| `timeout.maxMinutes` | Ephemeral child hard runtime | Greater than idle; within Node's timer range | `30` |
| `roleDefaults` | Shared resources for built-in and user Roles | Object with `extensions`, `tools`, or `skills` arrays; same validation as Role fields | — |

`roleDefaults` entries precede Role entries; merging removes duplicates before resource resolution. Use it for a provider extension that every child needs. Limits come only from this file. Requests cannot override or replenish them. Durable requests keep recorded policy; a lower current correction limit can tighten recovery. There is no whole-run timeout.

The extension reports each new problem once per session. It reads config at launch, `delegate_task`, later direct workers, isolated Role launches, `/subagent roles`, and status inspection.

- Unknown keys warn and are ignored. A likely misspelling, such as `maxToken` for missing `maxTokens`, counts as invalid for that key.
- Invalid `maxSubagents`, `maxTurns`, `maxCorrections`, or `timeout` values warn and use finite defaults. If maximum timeout does not exceed idle timeout, the whole `timeout` uses defaults.
- Unknown or invalid `roleDefaults` keys warn; only those keys are ignored, so Roles receive fewer default resources.
- Invalid or misspelled `maxTokens` blocks delegation. Malformed JSON, invalid UTF-8, files above 64 KiB, and unreadable files also block delegation. The extension does not fall back to unlimited tokens.

`/subagent` remains available during a block. Correct the file to enable delegation. The next worker or isolated Role launch fails while the block remains; running workers retain their original limits. If the problem existed at session start, also run `/reload`, because that session took default execution limits.

### Roles

Role Markdown files in `~/.pi/agent/config/pi-subagent/` require frontmatter and a Markdown system prompt.

| Field | Requirement |
| --- | --- |
| `name`, `description` | Required non-empty text without terminal control characters |
| `modelClass` | Optional `fast`, `balanced`, `frontier`, or `fav` default |
| `tools` | Required base or internal tool-name array; `[]` selects none. Name `codemode` or `git_read` to activate it. |
| `extensions` | Required array of trusted absolute paths, supported package sources, or Pi built-ins such as `builtin:codemode` |
| `skills` | Required array of effective Pi Skill names |
| `mcps` | Optional exact global server names from `~/.pi/agent/mcp.json`, using native `mcpServers` format. Omitted or `[]` denies access to `mcp.json` servers. Servers that Role extensions register always connect. |
| body | Required system instructions |

The package ships `implementer`, `reviewer`, and `scout`; same-name user Roles override built-ins. Roles define capabilities, not access or isolation. Unknown frontmatter keys invalidate that file and report its path and key. Other valid Roles load; duplicate names become unavailable. Delegation to an invalid file's claimed Role fails with that file's error. Inspect `/subagent roles`.

The built-in reviewer includes `git_read`; existing user reviewers must add it to `tools`. No additional extension or Bash access is necessary. See [Reviewer Git inspection](./docs/orchestration.md#reviewer-git-inspection) for operations, parameters, limits, and Git requirements.

Children load only declared resources and required adapters. Roles must list their model provider extension. `codemode` requires both `builtin:codemode` in `extensions` and `codemode` in `tools`. Missing Skills, tools, MCP servers, Roles, or routes fail before productive work. Main-only delegation/recovery tools and `ask_question` stay unavailable to children.

Read [Role and resource policy](./docs/orchestration.md#role-and-resource-policy) for extension exposure, MCP validation, OAuth constraints, and child budgets. Project MCP overrides cannot change a Role's global allowlist or exposure.

## API

| Surface | Type | Purpose |
| --- | --- | --- |
| `loadRoleCatalog`, `findRole`, `parseRoleName`, `parseRoleDefaults` | functions | Load, validate, and select Roles with shared defaults and per-file errors. |
| `registerRoleDefaultsReporting(pi, agentDir?)` | function | Report problems at session start, once per session. Returns `report(ctx)`; call before a lazy `loadRoleCatalog`. |
| `resolveRoleSkills`, `resolveRoleLaunch`, `resolveConfiguredRoleLaunch` | functions | Resolve effective Pi resources and model routes. |
| `prepareRoleLaunch`, `finalizeRoleLaunch` | functions | Prepare Role prompts, arguments, and tool policy. |
| `createEphemeralSubagentExecutor` | function | Run bounded no-session Pi children through a FIFO pool. |
| `createChildWorktree`, `finalizeChildWorktree` | functions | Create and conservatively finalize child worktrees. |
| `prepareExactReviewEvidence` | function | Prepare private exact base-to-tip review evidence. |
| `ExecuteRequestSchema`, `StageRequestSchema`, `IntegrationActionSchema` | schemas | Validate checked request and integration inputs. |
| `IsolatedRunner`, `FileRunStore` | classes | Run checked work and persist request state. |
| `RoleLaunchRuntime`, `HerdrHostRuntime`, `CheckedGitRuntime` | classes | Supply launch, host, and Git behavior. |
| `ExecutionPolicySnapshot`, `RunState`, `CoordinatorRuntime` | types | Describe saved policy, state, and runner integration. |

Role helpers require model routing fields and `isProjectTrusted()`, plus `cwd` for configured package resources, not UI methods. See [Role launch API](./docs/orchestration.md#role-launch-api) for routing and worktree results.

The executor accepts concurrency, turn/token, idle/hard-runtime limits, and abort, output, token, and activity callbacks. Queue time uses no child timeout; resources resolve after admission. See [Ephemeral executor API](./docs/orchestration.md#ephemeral-executor-api) for bounded output, abort results, errors, and accounting.

## State and storage

Private durable state lives under `config/pi-subagent/state/`. Isolated worker sessions use mode `0600` under `config/pi-subagent/leases/`; worker umask stays unchanged. Reads stop at 16 MiB. Larger sessions require inspection and cannot prove completion.

Sessions are removed only after exact worker-tab cleanup. They can contain prompts and answers: do not share them. State v5 rejects v4 and older files without migration. Preserve old state and recover its work manually.

## Limits and recovery

Role extensions and MCP servers are trusted executable code, not a sandbox. Select the smallest resource set and authorize write scope explicitly. Admission coordinates this Main's Pi calls, not other sessions, trusted extension lifecycle code, or external processes. Concurrent edits can make direct reads stale.

For uncertain direct termination, open `/subagent`, select the exact workflow, and choose **Close/cancel-and-release ALL owned workers in this workflow**. This stops all owned workers, not only the selected one. Resolve reported blockers and repeat the action. Recorded-only tasks cannot release admission. Restarting Pi does not prove termination. Inspect partial changes before new writes; never blindly repeat commits or delete work.

Unverified tab allocations retain evidence but offer no Close action. Reconcile them manually against Herdr; do not recreate tabs, guess IDs, or restart to bypass admission. See [Direct contract](./docs/orchestration.md#direct-contract).

After coordinator interruption, restart Pi and run `/subagent recover` in the canonical repository. Use `subagent_status` for exact evidence; never take over a live productive lease or replay uncertain prompts, merges, or promotion. See [Recover after interruption](./docs/orchestration.md#recover-after-interruption) and [Recovery and state](./docs/orchestration.md#recovery-and-state).

Run `/subagent prune` for merged leftovers. Removing a checkout deletes its ignored files only after a separate confirmation naming those entries. Dirty, conflicted, changed, or uncertain resources require deliberate inspection. See [Prune leftover worktrees](./docs/orchestration.md#prune-leftover-worktrees) before removal.

For aborted requests with retained resources, inspect status, resolve blockers, and repeat `subagent_abort` to reconcile cleanup without replaying work. Release rejected candidates and superseded generations explicitly. The extension never pushes, opens pull requests, publishes, deploys, force-cleans recoverable work, or silently falls back to Main.
