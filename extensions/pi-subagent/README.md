# `@henryqw/pi-subagent`

Delegate work to configured Pi Roles with [Herdr](https://herdr.dev/). Authorized direct tasks run in Herdr tabs in your current workspace; checked implementation runs in isolated Herdr worktrees. Both return a handle so Main can continue while they work.

![Pi showing six delegated tasks running in parallel](./example.png)

## Install

Requires Pi 1.0.0 or later. Development and automated checks use Pi 1.0.2. Older Pi releases are no longer supported.

```bash
pi install npm:@henryqw/pi-task-models
pi install npm:@henryqw/pi-subagent
```

Run `/task-models` and configure the `fast`, `balanced`, `frontier`, and `fav` routes you use.

## Works with

| Package | Relationship | Purpose |
| --- | --- | --- |
| [`@henryqw/pi-task-models`](https://pi.henry.wang/extensions/pi-task-models) | Required | Provides the configured model routes for delegated Roles. |

## Use

Ask Main to delegate a bounded task, such as “Have a scout trace sign-in without editing files.” Main uses `delegate_task`; you receive progress and a result or an actionable failure while Main remains available.

Commands are for you; tools and the packaged skill are for Main. You do not need to call agent tools or manage candidate identities yourself. Delegation and continuation tools use plain-object parameter schemas so providers that omit root-union tools can expose them; each mode and action still requires its exact arguments.

| Surface | Type | Purpose |
| --- | --- | --- |
| `/subagent` | command | Browse work, Close/cancel-and-release locally owned direct workers, launch isolated status inspection in a separate Herdr tab with the `fast` model, or send/edit pending instructions. Requires interactive TUI or RPC; inspection also requires a Herdr-managed pane and a read-only `scout` Role. |
| `/subagent recover` | command | Classify orphaned isolated work in the current canonical repository and send Main one follow-up with request IDs, blockers, and reported next actions. No UI or Herdr pane required. |
| `delegate_task` | tool | Start authorized shared-checkout work or a durable isolated checked graph. |
| `subagent_status` | tool | Read durable isolated state and the exact allowed continuation without replaying work. Declares an output schema, so `codemode` scripts receive the same bounded public projection as structured content. |
| `subagent_resume` | tool | Perform the reported `retry`, `verify`, or `finalize` continuation; does not replace staging or integration. |
| `subagent_stage` | tool | Stage or resolve an exact candidate, or reject/revise it; rejection of a staged candidate freezes that generation. |
| `subagent_integrate` | tool | Advance staged dependents, refresh after clean Main drift or evidence-less validation failure, validate in the background, record one correction, promote, reconcile interrupted promotion, clean up proven promotion, or explicitly release rejected/superseded resources. |
| `subagent_abort` | tool | Abort an isolated request only when no retained candidates or integration worktrees remain; cannot discard them. |
| `pi-subagent` | skill | Guide Main through delegation, authorization, checks, integration, and recovery. |

![Main, its coordinator extension, and a Herdr subagent through checked work, worker failure, and coordinator interruption](./docs/worker-lifecycle.svg)

`delegate_task`, `subagent_resume`, `subagent_stage`, `subagent_integrate`, and `subagent_abort` are model-only: Pi's `codemode` scripts cannot call them, because delegation and guarded state transitions need Main's visible reasoning. `subagent_status` stays callable from scripts. In Main, one model-issued call at a time may write to a checkout through Pi tools; a `codemode` script owns the checkout from its first nested write until the script ends, so its own nested calls pass while an independent writer is blocked with a reason and retries after it settles. Reads never wait.

The coordinator is extension code running in Main's Pi process, not another agent. It persists the request, launches the Herdr subagent, checks its committed work, and reports saved results; Main chooses what to stage and promote. If a worker fails, the coordinator reports attention after the wave settles, not necessarily immediately while siblings work. If Main's Pi process stops, no follow-up is guaranteed: restart and run `/subagent recover` in the canonical repository to classify orphaned interruptions and send Main one recovery report. Main then uses `subagent_status` for exact evidence and deliberate next actions. A stale `running` state does not prove a worker is still active; interrupted or ambiguous actions are never replayed automatically.

In the TUI, the compact widget uses one row per visible agent/task: `D` or `I` marks direct or isolated work, and `[S]` or `[I3]` identifies the Role initial (plus the isolated model class: `1` fast, `2` balanced, `3` frontier, `*` fav). Direct rows show the launched model, thinking level, elapsed time, and measured session tokens (`— tok` until usage is available). Isolated rows show the recorded task state and any retained workspace; an aborted request with visible tasks has its own `request aborted` row and does not change their recorded statuses. A committed worker without a checked candidate can still show attention rather than readiness. Status glyphs use the active TUI theme, while the text still names the status without color. Herdr does not currently provide reliable live model, thinking, or token readings for those rows. Attention appears before ordinary work, with a `… N more` summary when direct rows overflow. A ready isolated candidate is **not promoted** to Main. Choose **Refresh** in `/subagent` to reload both the menu and isolated widget from saved state; it does not recover or change a request. Use `/subagent` or `subagent_status` for exact identities, failures, and recovery.

### How Main routes delegation

Main chooses the mode from your request; you do not need to select one. Words like “direct” and “isolated” can signal your intent, but the work determines the route. Main declares the chosen mode in every `delegate_task` call, and the extension never falls back between modes.

| Mode | Request that triggers it | Checkout behavior |
| --- | --- | --- |
| `direct` | Bounded research, review, or explicitly authorized shared-checkout writes and commits | Opens non-focused Herdr tabs in Main's current workspace. No worktree is created. |
| `isolated` | Implementation or a checked task graph | Runs changesets in owned Herdr worktrees; Main selects, validates, and promotes exact candidates. |

Keep trivial mechanically verifiable work in Main. Keep tightly coupled changes under one owner rather than splitting by file count.

### Direct delegation

A read-only task:

```json
{
  "mode": "direct",
  "role": "scout",
  "name": "Map sign-in flow",
  "task": "Trace sign-in through session creation. Report files and risks. Do not edit files."
}
```

Direct mode selects exactly one shape:

```text
Single:   { mode: "direct", role, name, task, ... }
Parallel: { mode: "direct", tasks: [{ role, name, task, ... }] }
Chain:    { mode: "direct", chain: [{ role, name, task, ... }] }
```

Direct tasks use the selected Role's declared tools, extensions, Skills, and MCP servers, including write-capable resources. Authorization comes from your request and Main's bounded task packet, not the Role's capabilities: name allowed paths/actions and exclusions, preserve unrelated edits and staged changes, and authorize commits or external actions explicitly. For example, a configured Git operator with `bash` can stage named pending files and commit them on the `fast` route. Read-only Roles retain their tool restrictions. Use isolated mode for a checked changeset.

Direct writes affect Main's checkout immediately. No clean-checkout prerequisite, automatic checks, rollback, or isolated integration guarantee applies. Requests containing potential writers (including any extensions or MCP servers) run their tasks serially and hold checkout admission after the initial handle returns; competing Pi writes fail until all owned workers are proved stopped. Pure read-only parallel requests still run concurrently. A failure in a potential-writer request stops further dispatch; an uncertain worker may still be running. Chains replace each literal `{previous}` with the preceding successful answer and stop on failure. Task outcome and worker termination are separate: after settlement the coordinator closes exact owned writer panes and releases admission only after pane absence and two empty private process-lease scans. Native `lsof` is required for this proof; no Git files, commits, or saved sessions are removed. Failure remains failure even when admission is released. If closing fails, identity changes, a leased child survives, or inspection is uncertain, admission stays held. Open `/subagent`, select the exact direct task, and choose **Close/cancel-and-release owned workers** to cancel dispatch and retry termination. The action checks session/branch/epoch and live ownership; recorded-only tasks cannot unlock anything. Resolve the reported blocker (including any surviving owned process), then repeat the same action. Restarting Pi is not termination proof. Inspect partial changes before new writes; never blindly retry a commit or delete work to recover.

If tab creation times out or returns incomplete or mismatched identity, `/subagent` retains the allocation intent: workspace, checkout, label, private lease/session paths, and any returned tab/pane IDs. No worker is started until creation identity is verified. These records are evidence, not ownership: Close is unavailable for unverified allocation, and admission remains held pending manual reconciliation against Herdr. Do not recreate a tab, guess missing IDs, or restart to bypass this blocker. A Close begun while a worker is active keeps its branch/session/epoch guards through cancellation settlement; stale dialogs cannot close panes or release admission.

Potential-writer tasks must return one JSON completion object, such as `{"outcome":"succeeded","answer":"Scoped commit completed."}`. `outcome` must be `succeeded`, `failed`, or `blocked`, and `answer` must be non-empty. A normal final Pi turn is not enough: failure, blocked work, plain text, or malformed completion stops later dispatch, but admission depends on proved termination, not the reported outcome. Success is the worker's explicit report, not independent validation of its changes.

The tool returns a task ID and first Herdr tab after launch, not the answer. The extension observes each worker and sends one result to Main when the workflow finishes. If Main is busy, Pi queues it after the current turn; if idle, it starts a turn. A blocked, stalled, unknown, or truncated result is not reported as success. Session switch or shutdown stops observation and preserves tab identities for recovery. Open `/subagent` on the session branch to inspect exact tabs, agents, and Pi session files, including tabs launched after the first. A recorded tab may no longer be running; locally observed work is labelled separately.

### Isolated checked graphs

An isolated request has one durable ID, one goal, and 1–8 typed tasks:

```json
{
  "mode": "isolated",
  "id": "refresh-repair",
  "goal": "Repair token refresh with exact checked evidence.",
  "tasks": [
    {
      "id": "inspect",
      "kind": "text",
      "role": "scout",
      "modelClass": "fast",
      "requirements": "Identify the refresh failure and relevant tests.",
      "deliverable": "A concise evidence report.",
      "dependsOn": [],
      "contextFrom": []
    },
    {
      "id": "repair",
      "kind": "changeset",
      "role": "implementer",
      "modelClass": "balanced",
      "requirements": "Implement the smallest correct repair.",
      "deliverable": "A committed candidate in the owned worktree.",
      "dependsOn": [],
      "contextFrom": ["inspect"],
      "checks": [
        { "command": "pnpm", "args": ["test", "--", "refresh"] }
      ],
      "judgment": {
        "role": "reviewer",
        "modelClass": "balanced",
        "criterion": "The exact candidate fixes refresh and preserves unrelated behavior."
      }
    }
  ],
  "finalChecks": [
    { "command": "pnpm", "args": ["test", "--", "refresh"] }
  ]
}
```

`dependsOn` controls scheduling. `contextFrom` also schedules dependencies and carries completed text outputs in the declared order. Do not repeat the same task in both fields. Changesets require focused task checks; a graph with changesets requires final checks. A canonical root `package.json` test script is required: the runner adds `pnpm test` to final checks if missing, and Main runs it on the combined integration checkout before promotion. Checks and judgments bind to exact Git identities; candidate drift, Main drift, mutation during validation, ambiguity, or conflicts stop promotion and retain evidence.

`delegate_task`, `subagent_resume`, and `subagent_integrate advance` return a durable request ID after the wave is saved; productive work continues while Main is free. Main can do other work or end its turn instead of sleeping or polling. Pi sends a follow-up in the launching session whenever a checked worker becomes ready or a worker needs attention, and again when the wave finishes. A worker whose exact turn ends without a changed clean commit—including a failed or aborted turn—needs attention, not an inferred candidate; use `subagent_status` for its saved evidence. Session replacement or shutdown suppresses stale delivery and logs the request ID and reason, without prompts or credentials. Synchronous delivery failures are reported without automatic replay; Pi reports asynchronous `send_message` failures through its native runtime. If delivery is missed, inspect `subagent_status`.

Completed text answers are saved independently of cleanup. Status and terminal follow-ups include a bounded accepted-answer preview and cleanup evidence. Ignored automatic artifacts can retain a checkout without violating the read-only contract; no ignored files are deleted to make cleanup pass. Tracked or untracked changes, changed checkout identity, or unproved inspection still require attention: the completed answer remains saved but is not accepted as dependency context or retried automatically. Retained text checkouts require deliberate manual inspection and cleanup; a retained checkout alone is not evidence that the Role edited source.

Isolated workers can start while Main has staged, unstaged, or untracked changes: they use only Main's pinned committed branch, HEAD, and tree. Those local edits are neither copied into worker worktrees nor stashed, staged, reset, or merged automatically. Main must remain at that committed identity while workers run; branch or HEAD drift blocks new waves. The worker produces a committed candidate without tracked or untracked changes, then runs focused preliminary checks and optional judgment. Ignored generated files do not block candidacy, but prevent automatic worktree cleanup; inspect them before deleting retained work. The runner records each ready candidate immediately but **does not integrate it automatically**. Main can inspect `subagent_status` and use `subagent_stage` to select the exact candidate in an owned integration worktree while siblings are still working; conflicts are resolved there. Stage and resolve are available during an active wave, but rejection and revision wait for the wave to settle. `subagent_integrate` can advance dependent tasks from a staged snapshot, validate the combined tip with full root checks and optional final judgment after the wave settles, and promote it to Main only after exact validation. A definitive failed combined check/review allows one committed correction in the integration checkout followed by another validation. Main must explicitly promote; promotion and cleanup never silently discard retained work.

Open `/subagent` without arguments to pick work by label. The menu shows direct records on this session branch and isolated requests in the current canonical Git checkout (including requests launched in other sessions). Pick an isolated request and **Inspect status and recovery** to launch a non-focused Herdr tab with a read-only `scout` Role on the configured `fast` route. Unlike ordinary direct delegation, status inspection rejects Roles with extensions or MCP servers because their tools are not verified read-only. Its prompt contains bounded saved status (including retained paths, but not raw launch environment or session transcripts); the analysis stays in that tab and does not queue a Main turn. The tab and session file are recorded for recovery even if launch becomes uncertain. The read-only `subagent_status` tool remains Main's authority for exact identities before any stage or recovery action. If Herdr or the read-only fast route is unavailable, inspection fails without changing the request; Main can use `subagent_status`. Refresh or choose completed/history for older work. Invalid state IDs are warned about and preserved. Outside Git or when isolated inventory is unavailable, direct recovery still works. Browsing does not resume work or change resources; direct **Close/cancel-and-release** is an explicit termination action.

For a locally active unsealed isolated changeset, choose **Send follow-up instructions** to open a native multiline editor; submission queues the instruction, not a completed revision. Choose **Edit queued instructions** to withdraw *all still-pending* instructions for that selected task before the editor opens. Their full text appears in FIFO order separated by blank lines. Explicit submission queues **one replacement** at the tail. Cancel leaves the withdrawn instructions removed; already-claimed instructions, initial prompts, and automatic corrections cannot be recalled. A worker may seal during editing: failed submission reopens the full submitted text for deliberate editing or copying, never automatically requeues it. Combined text above the single-instruction limit is preserved in the editor but rejected until shortened. Cancelling before withdrawal makes no change. Neither action touches Main's editor or Pi's global Option+Up queue shortcut. No-UI sessions can run `/subagent recover` or use agent tools for individual inspection and recovery.

A queued follow-up runs after the current turn settles and must produce a new clean commit that passes preliminary checks again. When no queued revision remains, the checked candidate seals immediately; there is no guaranteed post-completion editing window. Late follow-ups fail visibly.

### Isolated recovery

`subagent_integrate validate` acknowledges only after saving the exact generation's validation intent, then runs checks and any final judgment in the background. A later turn cancellation does not cancel acknowledged validation; session replacement or shutdown still stops it. Completion sends a follow-up to the launching session. Use `subagent_status` if delivery is missed; acknowledgement is not passing evidence.

If validation was interrupted, first prove the old coordinator/check processes have stopped; never take over a live productive lease. Use guarded `reconcile` on the saved generation and `combinedTip`. Missing checks/review never authorize `correct` or `promote`. For a `validation_failed` generation with **no recorded checks, review, or prior combined correction**, `refresh` also accepts identical `expectedMain` and `newMain`. Supply the exact old combined `expectedTip` and the next generation number. Both Main and the retained integration tip must remain exact and clean. This explicitly allocates a new checkout; it does not resume old checks. Restage selected immutable candidates and run fresh full-suite checks and required final judgment before promotion. The old generation stays retained, the two-checkout limit still applies, and correction allowances are not reset. Other failures retain their existing recovery requirements.

After a coordinator interruption, run `/subagent recover` once. It acquires the repository productive lease before changing any orphaned `pending` or `running` state, preserves unreadable state files and retained candidates, and reports blockers and existing continuations to Main without replaying prompts, merges, promotion, or cleanup. If another productive run holds the lease, it only reads status and reports the live owner; wait rather than taking over. Repeating the command is safe. Main uses `subagent_status` for exact identities and the recovery tools in the interface table above for deliberate decisions; the command never stages or promotes. Direct Herdr tab recovery remains in `/subagent`.

If an isolated worker produced no candidate, `subagent_abort` terminates it and removes only proven unchanged, clean owned resources. Cleanup includes ignored-file checks and never discards unique commits. If productive work is still settling, termination is uncertain, or cleanup fails, the request stays aborted with retained-resource evidence. Inspect `subagent_status`, resolve the reported blocker, then repeat `subagent_abort` to reconcile cleanup; it does not replay worker prompts. Dirty work, unique commits, and uncertain allocations remain for deliberate manual recovery.

The following details describe exact identity and retained-work requirements.

A checked candidate stays retained if Main is dirty. Staging, combined validation, and promotion require Main to be clean at the pinned committed identity; clean your local edits deliberately before using those actions. No dirty work is replayed or merged automatically. Pass the exact `generation`, candidate (`taskId`, `attempt`, `candidate`) and `expectedTip` identities reported by status to stage; pass the generation and combined `expectedTip` to integrate. If Main advances cleanly before promotion, call `subagent_integrate refresh` with the recorded `expectedMain`, old `expectedTip`, and new clean `newMain`. Main must restage selected immutable candidates into the new generation and rerun combined checks. Dirty or divergent Main blocks refresh. Stale identities fail. If integration allocation was uncertain, `subagent_stage resolve` first proves the owned checkout is still at its base before starting the selected merge; otherwise it retains the intent. At most two integration worktrees may remain unreleased per request; a superseded generation is read-only. To release a superseded *clean* integration checkout, call `subagent_integrate` with `{ id, action: "release", generation, expectedTip }`, using that generation's last staged tip (or integration base when no stage completed). To release a rejected candidate after its worker has terminated and all generations using it are released, pass `{ id, action: "release", generation: <latest generation number, or 1>, taskId, attempt, expectedTip: <candidate tip> }`. Release persists each host/checkout/branch step, verifies ownership and cleanliness (including ignored files), and deletes the branch only if its ref still names the exact tip. Dirty, conflicted, changed, or uncertain resources remain for manual inspection; retry the same release after resolving the obstacle. Released checkouts free a retained slot; abort is available after every retained resource is released. Rejection can invalidate dependent work; if fresh dependent execution is impossible, start a new request instead of forcing promotion. Productive requests have no whole-run wall-clock deadline. Resume does not reset the recorded policy or correction count. Text tasks have two dispatch attempts; inspection failures before dispatch do not consume one. Verification requires passing preliminary checks and any required judgment; it cannot override failed review. Child limits, abort signals, process I/O, status inspection, exact termination, and cleanup retain finite safety bounds.

The extension never pushes, opens a pull request, publishes, deploys, force-cleans recoverable work, or silently falls back to Main.

## Config

pi-subagent owns `~/.pi/agent/config/pi-subagent/config.json`. A missing file silently uses defaults.

| Name | Description | Values | Default |
| --- | --- | --- | --- |
| `maxSubagents` | Concurrent direct Herdr workers and ephemeral child-process limit | Safe integer ≥ 1 | `5` |
| `maxTurns` | Provider-turn limit per child | Safe integer ≥ 1 | `50` |
| `maxTokens` | Optional token limit per child | Safe integer ≥ 1 | Unlimited |
| `maxCorrections` | Same-worker automatic corrections per isolated request | Safe integer ≥ 0 | `1` |
| `timeout.idleMinutes` | Direct worker and ephemeral child idle timeout | Positive and within Node's timer range | `10` |
| `timeout.maxMinutes` | Ephemeral child hard runtime | Greater than idle and within Node's timer range | `30` |

Limits come only from this global file. Request fields cannot override or replenish them. Existing durable requests keep their recorded policy, while a lower current correction limit can tighten recovery. There is intentionally no whole-run timeout setting.

Malformed or unreadable JSON, unknown keys, and invalid values block delegation with one actionable warning. The file is preserved and never rewritten automatically.

### Roles

Role Markdown lives in `~/.pi/agent/config/pi-subagent/` and requires frontmatter plus a Markdown system prompt.

| Field | Requirement |
| --- | --- |
| `name`, `description` | Required non-empty text without terminal control characters |
| `modelClass` | Optional `fast`, `balanced`, `frontier`, or `fav` default |
| `tools` | Required array of base or internal tool names; `[]` selects none. Name `codemode` or `git_read` here to activate it (see below) |
| `extensions` | Required array of trusted absolute paths, supported package sources, or Pi built-in extensions such as `builtin:codemode` |
| `skills` | Required array of effective Pi Skill names |
| `mcps` | Optional exact server names from `~/.pi/agent/mcp.json` in Pi's native `mcpServers` format; omitted or `[]` denies MCP access |
| body | Required system instructions |

Roles describe responsibility and capabilities. They do not choose isolation; each request does. A same-named user Role overrides a built-in Role. The package ships `implementer`, `reviewer`, and `scout`. The built-in reviewer includes `git_read`; add it to an existing user reviewer's `tools` array to opt in. No additional extension or Bash access is needed.

### Reviewer Git inspection

`git_read` is an internal child tool, loaded and registered only for Roles that declare it. Direct delegation treats it as read-only. It accepts structured parameters, not shell commands or arbitrary Git options:

| `operation` | Parameters and evidence |
| --- | --- |
| `status` | Optional `path`; staged, unstaged, and untracked status |
| `diff` | `mode: "working"` (default, unstaged), `"staged"`, or `"committed"`; committed requires `base` and `tip`. Optional `path` |
| `show` | Optional `revision` (default `HEAD`) and `path`; commit patch or file content at that commit |
| `log` | Optional `revision`, `path`, and `maxCount` (default 20, maximum 100) |
| `blame` | Required `path`, optional `revision` and paired `startLine`/`endLine` |
| `rev-parse` | Optional `revision`; resolves one commit ID |

Revisions accept commit IDs or named refs with optional `~N`/`^N` ancestry, not ranges or reflog expressions. Paths are literal and relative to the assigned cwd; absolute paths, traversal, `.git` components, and option-like paths are rejected. Use named candidate refs rather than assuming Main's checkout contains an isolated candidate. In isolated judgment, the supplied exact patch remains authoritative; Git inspection supplies only referenced context, not a replacement diff. Reviewers still cannot run tests, write, commit, or push, and approve only with exact `PASS`.

Each call is cancellable and limited to 30 seconds. Results retain at most the last 32 KiB of UTF-8 output with an explicit `truncated` flag and notice; narrow the path, log count, or blame lines rather than treating truncated evidence as complete. Missing refs/files, non-repositories, invalid UTF-8, timeouts, and Git failures fail visibly. No full-output artifact is written. Git must support `--no-lazy-fetch`; older versions fail rather than allowing network access. Lazy fetch, pager, optional locks, hooks, fsmonitor, external diffs, textconv, and clean/process filters are disabled. Working-tree comparisons therefore use unfiltered bytes and can differ from filter-aware Git output (for example Git LFS). Submodule contents are not inspected. Concurrent edits can still make direct inspection stale.

### Child resources

Children run with `--no-extensions`, so a Role must list the extension that registers its route model's provider, and only declared resources plus required internal policy adapters load. `builtin:<name>` entries load Pi built-in extensions (`builtin:codemode`, `builtin:tool-search`, `builtin:llama.cpp`) explicitly; `builtin:mcp` is rejected because it would connect every configured server and bypass `mcps`. Extension tools registered with `codemode` or `deferred` exposure stay callable from scripts but are declared to the model only when `tools` names them.

Checkout admission keeps a script's writer ownership until the script and all its admitted nested writes finish, including writes still settling after cancellation. Independent writers stay blocked during that time; nested writes that have not passed admission before the script ends are rejected.

To let a Role run `codemode` scripts, list `builtin:codemode` in `extensions` and `codemode` in `tools`; both are required, because the built-in registers the tool inactive and the Role tool policy activates it. `codemode` alone in `tools` fails the launch as an unavailable tool. Pi's `codemode.mode` and `codemode.inlineBudget` settings apply in the child unchanged, so the Role never forces codemode-only operation, and MCP configuration never activates `codemode` in a child. Scripts can call only the Role's active tools plus `codemode`/`deferred` extension and MCP tools; inactive base tools such as `bash` stay unreachable.

The servers named in `mcps` come from the global `~/.pi/agent/mcp.json` only. In a Role that activates `codemode`, each selected server keeps its configured `exposure` and `toolExposure` (Pi's default `codemode` exposure makes tools callable from scripts without declaring them, `direct` declares them, `deferred` tools stay reachable from scripts, `hidden` tools stay unreachable), and an invalid exposure value fails the launch. In every other Role, selected servers are forced to `direct` exposure and `toolExposure` is ignored, because that child cannot reach undeclared tools. Declared tools appear to the model as `mcp__<server>__<tool>` once the server connects. Pi replaces `-` in server and tool names with `_` and appends a hash suffix when two tool names collide or a name exceeds 64 characters. Each selected entry is checked against Pi's documented `mcpServers` rules before launch, in Main and again in the child: a disabled, malformed, or unknown-transport entry, an invalid server name, two selected names that differ only in `-` and `_`, `auth.provider` over plain HTTP outside `localhost`, `127.0.0.1`, or `[::1]`, or a non-HTTPS `oauth.authServerMetadataUrl` outside those hosts fails the launch with the file path and field. The file is never modified; fix the entry or choose another server. Valid `auth`, `oauth`, and `description` fields are passed through so Pi's native provider auth and OAuth apply. `oauth.clientRegistration` must be `dcr` or `cimd`; `cimd` requires Pi 1.0.1 or later; Pi 1.0.0 rejects it before child launch. It cannot use `clientId` or `clientName`, and any `callbackUrl` must use localhost or 127.0.0.1 with path `/callback`. Project MCP overrides remain ignored: a project cannot change the Role's global server allowlist or exposure. Missing Skills, tools, MCP servers, Roles, or routes fail before productive work starts. Main-only delegation and recovery tools plus `ask_question` are excluded from children.

## API

| Surface | Type | Purpose |
| --- | --- | --- |
| `loadRoles`, `parseRoleName` | functions | Load and validate built-in and user Roles. |
| `resolveRoleSkills`, `resolveRoleLaunch`, `resolveConfiguredRoleLaunch` | functions | Resolve effective Pi resources and model routes. |
| `prepareRoleLaunch`, `finalizeRoleLaunch` | functions | Prepare Role prompts, arguments, and tool policy. |
| `createEphemeralSubagentExecutor` | function | Run bounded no-session Pi children through a FIFO pool. |
| `createChildWorktree`, `finalizeChildWorktree` | functions | Create and conservatively finalize child worktrees. |
| `prepareExactReviewEvidence` | function | Prepare private exact base-to-tip review evidence. |
| `ExecuteRequestSchema`, `StageRequestSchema`, `IntegrationActionSchema` | schemas | Validate checked request and integration inputs. |
| `IsolatedRunner`, `FileRunStore` | classes | Run checked work and persist durable request state. |
| `RoleLaunchRuntime`, `HerdrHostRuntime`, `CheckedGitRuntime` | classes | Supply launch, host, and Git behavior to the runner. |
| `ExecutionPolicySnapshot`, `RunState`, `CoordinatorRuntime` | types | Describe persisted policy, state, and runner integration. |

`createEphemeralSubagentExecutor` accepts global concurrency, turn/token, idle, and hard-runtime policy. Queued time consumes no child timeout. A run resolves resources only after receiving its permit and accepts abort, output, token, and activity callbacks. Output and diagnostics are bounded.

See [Orchestration and package-author API](./docs/orchestration.md) for the detailed contracts and recovery model.

## State and storage

Durable state is private under `config/pi-subagent/state/`. Isolated worker Pi sessions are precreated with mode `0600` under `config/pi-subagent/leases/` without changing the worker's umask. Reads stop at the 16 MiB limit even if the session grows; an oversized session requires inspection rather than being accepted as completion evidence. Sessions are removed only after exact worker-tab cleanup; retained sessions may contain prompts and answers, so do not share them. State v5 rejects v4 and older files rather than migrating them; retain the old state and recover its work manually.

## Limits and recovery

Role extensions and MCP servers are trusted executable code, not a sandbox. Select the smallest resource set. Direct tasks may use declared write-capable resources in Main's checkout only within the authorized scope. Checkout admission coordinates this Main's Pi calls, not other Pi sessions, trusted extension lifecycle code, or external processes. Concurrent changes can make a direct worker's read stale. Retained-work reports identify exact resources for deliberate recovery.
