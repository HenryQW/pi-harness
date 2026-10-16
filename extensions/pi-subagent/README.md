# `@henryqw/pi-subagent`

Delegate work to configured Pi Roles with [Herdr](https://herdr.dev/). Authorized direct tasks use Herdr tabs in your current workspace. Checked implementation uses isolated Herdr worktrees. Both modes return a handle, so Main can continue while the work runs.

![Pi showing six delegated tasks running in parallel](./example.png)

## Install

Pi Subagent requires Pi 1.1.0 or later in the 1.x series. Development and automated checks use Pi 1.1.0. Pi Subagent no longer supports older Pi releases.

Isolated work requires Herdr 0.9.3 or later. It also requires a running Herdr server on API protocol 22 or later. Pi Subagent checks both before it starts.

```bash
pi install npm:@henryqw/pi-task-models
pi install npm:@henryqw/pi-subagent
```

Run `/task-models`. Configure the `fast`, `balanced`, `frontier`, and `fav` routes you use.

### Upgrade from 26.x

Version 27.0.0 has breaking changes. Each direct task must declare `access`. The extension rejects Role files with unknown frontmatter keys. The library replaces `loadRoles` with `loadRoleCatalog` and `findRole`. Read [Migrate from 26.x to 27.0.0](./docs/migration.md) before you upgrade.

## Works with

| Package | Relationship | Purpose |
| --- | --- | --- |
| [`@henryqw/pi-task-models`](https://pi.henry.wang/extensions/pi-task-models) | Required | Provides the configured model routes for delegated Roles. |

## Use

Ask Main to delegate a bounded task, such as “Have a scout trace sign-in without editing files.” Main uses `delegate_task`. Main stays available while you receive progress and a result or a failure with recovery steps.

Commands are for you. Delegation and state tools and the packaged skill are for Main. `git_read` is only for children whose Role declares it. Main cannot use it. You do not need to call agent tools or manage candidate identities.

Delegation and continuation tools use plain-object parameter schemas. So providers that omit root-union tools can expose them. Each mode and action still requires its exact arguments.

| Surface | Type | Purpose |
| --- | --- | --- |
| `/subagent` | command | Browse work. Close/cancel-and-release locally owned direct workers. Stop one running worker of a read workflow. Inspect isolated status in a separate Herdr tab with the `fast` model. Send or edit pending instructions. These actions require interactive TUI or RPC. Inspection also requires a pane that Herdr manages and a configured `scout` Role. |
| `/subagent roles` | command | List each Role with its source: built-in, user override, or user. Show its resolved route model and thinking level, or its route error. Show tools, extensions, Skills, MCP servers, and load errors for each file. This command is read-only and requires no Herdr pane. |
| `/subagent prune` | command | Review remaining worker and integration worktrees and branches in the current canonical repository. After your confirmation, remove those that are already merged. Without interactive UI, the command only reports. It requires a running Herdr server to prove that no pane uses a checkout. |
| `/subagent recover` | command | Classify orphaned isolated work in the current canonical repository. Send Main one follow-up with request IDs, blockers, and reported next actions. This command requires no UI or Herdr pane. |
| `delegate_task` | tool | Start authorized shared-checkout work or a durable isolated checked graph. |
| `subagent_status` | tool | Read durable isolated state and the exact allowed continuation without replaying work. The tool declares an output schema. So `codemode` scripts receive the same bounded public projection as structured content. Its text shows failed review verdicts from tasks, the final gate, and integration generations. This includes tasks whose siblings still run. The text has one shared 32 KiB budget and counts omitted verdicts. The structured projection carries each verdict up to 32 KiB. It sets `verdictTruncated` when it cuts a verdict. |
| `subagent_resume` | tool | Perform the reported `retry`, `verify`, or `finalize` continuation. This does not replace staging or integration. A `retry` that sends a correction to the same worker accepts an optional `instruction` of at most 32000 characters. It adds this text to that prompt as Main's instruction after the saved failure. Other actions reject it. |
| `subagent_stage` | tool | Stage, resolve, reject, or revise an exact candidate. Rejection of a staged candidate freezes that generation. |
| `subagent_integrate` | tool | Advance staged dependents. Refresh after Main changes cleanly or validation fails without evidence. Validate in the background. Record one correction. Promote. Reconcile interrupted promotion. Clean up proven promotion. Explicitly release rejected or superseded resources. |
| `subagent_abort` | tool | Abort an isolated request only when no retained candidates or integration worktrees remain. This tool cannot discard them. |
| `git_read` | tool | For Role-declared children (not Main): inspect bounded local Git evidence without Bash, tests, network access, or writes. |
| `pi-subagent` | skill | Guide Main through delegation, authorization, checks, integration, and recovery. |
| Direct status widget (`D`) | ui | For you in the TUI: show direct worker references (such as `D7.1`), status, Role badges, names, and route. Show task elapsed time, measured task tokens, pending tools, and the latest tool's recorded time. |
| Isolated status widget (`I`) | ui | For you in the TUI: show recorded task state, Role/model-class badges, and retained workspaces. Readiness does not mean promotion. |

![Main, its coordinator extension, and a Herdr subagent through checked work, worker failure, and coordinator interruption](./docs/worker-lifecycle.svg)

`delegate_task`, `subagent_resume`, `subagent_stage`, `subagent_integrate`, and `subagent_abort` are model-only. Pi's `codemode` scripts cannot call them, because delegation and guarded state transitions need Main's visible reasoning. Scripts can still call `subagent_status`.

Main's calls that can write can run together without writer ownership. This includes all Bash calls and nested `codemode` writes. Only a direct request with a task that declares `access: "write"` reserves the checkout. Such a request cannot start while a direct writer owns the checkout. It also cannot start while a Main call that can write is in progress there.

The extension tracks each Main call separately until its result or execution end. The result of a script does not release its active nested writes. Reads never wait. To keep Main free to write, use `mode: isolated`. This mode adds worktree checks and explicit integration.

The coordinator is extension code that runs in Main's Pi process. It is not another agent. It saves the request, launches the Herdr subagent, checks its committed work, and reports saved results. Main chooses what to stage and promote.

If a worker fails, the coordinator reports attention after the wave settles. It does not always report immediately while siblings work. If Main's Pi process stops, a follow-up is not guaranteed. Restart Pi. Then run `/subagent recover` in the canonical repository.

This command classifies orphaned interruptions and sends Main one recovery report. Main then uses `subagent_status` for exact evidence and deliberate next actions. A stale `running` state does not prove that a worker is still active. The extension never replays interrupted actions or actions with unclear outcomes automatically.

The TUI has two separate compact status widgets. Each widget has one row for each visible worker or task. `D` marks direct work, and `I` marks isolated work. Badges such as `[S]` and `[I3]` identify the Role initial. Isolated badges also include the model class: `1` fast, `2` balanced, `3` frontier, `*` fav.

Each direct row starts with a saved direct reference such as `D7.1`. `D7` is the workflow number in this Pi session, and `.1` is the position of the worker in the original request. `/subagent` uses the same reference and name. The Herdr tab label shows them at launch. Numbers continue after reload, and the session never uses a number again.

A session switch can move a workflow into a session that already uses its number. In that case, the workflow gets a new number there. An existing Herdr tab keeps its original launch label.

The direct widget shows the launched model, thinking level, elapsed time, and measured task tokens (`— tok` until usage is available). Failed rows show before working and completed rows. When rows overflow, `… N more` includes counts by status.

The isolated widget shows the recorded task state and any retained workspace. It does not show reliable live model, thinking, or token readings from Herdr. Attention shows before ordinary work, and overflow uses `+N more · /subagent`. An aborted request with visible tasks has its own `request aborted` row. This row does not change the recorded statuses of the tasks.

A committed worker without a checked candidate can show attention, not readiness. Status glyphs use the active TUI theme. The text also names the status without color.

The direct widget and result summaries show measured tokens for the current task turn. This count adds input and output tokens from completed assistant usage records. It excludes cache-read and cache-write tokens. A continued worker counts only its new task turn. Missing usage stays unknown. This display count does not change token-limit accounting.

A ready isolated candidate is **not promoted** to Main. To reload the menu and the isolated widget from saved state, choose **Refresh** in `/subagent`. Refresh does not recover or change a request. Use `/subagent` or `subagent_status` for exact identities, failures, and recovery.

### Direct tool activity

Direct rows can show `pending read, bash` and `last read 125ms recorded`. Pending means that Pi saved the call, but the session of this task has no matching result. It does not prove that execution started. Parallel calls stay pending until their own results arrive.

Recorded time comes only from the `durationMs` of the latest matched tool result. The extension does not calculate it from assistant timestamps. If the latest result has no timing, the row shows no tool time, even if an earlier result had timing. Older sessions, and calls rejected before execution, can have no recorded time. Task elapsed time is a separate metric.

Activity uses the existing session sample and file-size cache. The extension ignores a partial trailing JSONL entry until it is complete. For display, the extension removes terminal control characters from tool names. Narrow rows remove activity before other metrics, so worker identity and failure state stay visible. Activity and time are display information, not proof of task completion, worker ownership, or a timeout.

### How Main routes delegation

Main chooses the mode from your request. You do not need to select one. Words such as “direct” and “isolated” can show your intent, but the work sets the route. Main declares the selected mode in each `delegate_task` call. The extension never falls back between modes.

| Mode | Request that triggers it | Checkout behavior |
| --- | --- | --- |
| `direct` | Bounded research, review, or explicitly authorized writes and commits in the shared checkout | Opens Herdr tabs without focus in Main's current workspace. Creates no worktree. |
| `isolated` | Implementation or a checked task graph | Runs changesets in owned Herdr worktrees. Main selects, validates, and promotes exact candidates. |

Keep trivial mechanically verifiable work in Main. Keep tightly coupled changes under one owner. Do not split them by file count.

### Direct delegation

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

Direct mode selects exactly one shape:

```text
Single:   { mode: "direct", role, name, task, access, ... }
Parallel: { mode: "direct", tasks: [{ role, name, task, access, ... }] }
Chain:    { mode: "direct", chain: [{ role, name, task, access, ... }] }
```

Every direct task declares `access: "read"` or `access: "write"`. A missing or other value fails before launch. Main declares `write` when the task can change files, Git state, or external resources. The extension does not enforce `read`. There is no sandbox, and a read task keeps all the tools of its Role.

A request is a write request when any task declares `write`. Read requests skip checkout admission and return plain-text answers. Their parallel `tasks` run concurrently up to `maxSubagents`, but a `chain` still runs in order. Use isolated mode for checked writes.

Direct tasks use the declared tools, extensions, Skills, and MCP servers of the selected Role, including resources that can write. Authorization comes from your request and Main's bounded task packet, not from the capabilities of the Role. Name the permitted paths, actions, and exclusions. Preserve unrelated edits and staged changes. Authorize commits or external actions explicitly.

For example, a configured Git operator with `bash` can stage named pending files and commit them on the `fast` route. Use isolated mode for a checked changeset.

Direct writes change Main's checkout immediately. They require no clean checkout. They give no automatic checks, rollback, or isolated integration guarantee. A write request cannot start while a direct writer owns the checkout. It also cannot start while a Main call that can write is in progress there.

A write request runs its tasks in sequence. It holds checkout admission after the initial handle returns. Competing direct writers and Main writes fail until the extension proves that all owned workers stopped. To keep Main free to write, use `mode: isolated`. This mode gives worktree checks and explicit integration, not immediate changes to the shared checkout. Parallel read requests still run concurrently.

A failure in a write request stops further dispatch, but a worker with an uncertain state can still run. Chains replace each literal `{previous}` with the preceding successful answer and stop on failure. Task outcome and worker termination are separate.

After settlement, the coordinator closes exact owned writer panes. It releases admission only after pane absence and two empty private process-lease scans. This proof requires native `lsof`. The coordinator removes no Git files, commits, or saved sessions. A failure stays a failure even when the coordinator releases admission.

Admission stays held if the close fails, identity changes, a leased child survives, or inspection is uncertain. In that case, open `/subagent`. Select the exact direct workflow. Then choose **Close/cancel-and-release ALL owned workers in this workflow** to cancel dispatch and try termination again. This action stops every owned worker of that workflow, not one selected worker.

The action checks session, branch, epoch, and live ownership. Recorded-only tasks cannot unlock anything. Resolve the reported blocker, including any surviving owned process. Then do the same action again. A restart of Pi is not termination proof.

Inspect partial changes before new writes. To recover, never retry a commit or delete work without inspection.

Tab creation can time out or return an incomplete or mismatched identity. In that case, `/subagent` retains the allocation intent. This includes the workspace, checkout, label, private lease and session paths, and any returned tab and pane IDs. No worker starts until the extension verifies the creation identity. These records are evidence, not ownership.

Close is not available for an unverified allocation. Admission stays held until you reconcile it manually against Herdr. Do not create the tab again. Do not guess missing IDs or restart to bypass this blocker.

A Close that starts while a worker is active keeps its branch, session, and epoch guards until the cancellation settles. Stale dialogs cannot close panes or release admission.

Tasks in a write request must return one JSON completion object, such as `{"outcome":"succeeded","answer":"Scoped commit completed."}`. `outcome` must be `succeeded`, `failed`, or `blocked`, and `answer` must be non-empty. A normal final Pi turn is not sufficient. Failure, blocked work, plain text, or a malformed completion stops later dispatch.

But admission depends on proved termination, not on the reported outcome. Success is the explicit report of the worker. It is not an independent validation of its changes.

The tool returns a task ID and the first Herdr tab after launch, not the answer. The extension observes each worker and sends one result to Main when the workflow finishes. If Main is busy, Pi queues the result after the current turn. If Main is idle, the result starts a turn. The extension does not report a blocked, stalled, unknown, or truncated result as success.

In the result, each launched worker has a line with its model, thinking level, measured task tokens, and elapsed time. For example: `✓ [1/2] Check · worker · provider/model · thinking high · 1.5k tok · 42s`. If Pi recorded no usage, the line shows `tokens unknown`. Failed and stopped workers show the usage that the extension measured until they ended. A worker that the extension skipped before launch shows no usage.

The result details contain the same values in each entry as `model`, `thinkingLevel`, `tokens`, and `elapsedMs`. When the token count is unknown, `tokens` is absent. If a task fails after its worker produced text, the result keeps a bounded excerpt marked as partial output. This excerpt is never success.

Every worker result delivered to Main starts with a header. The header states that the text is the output of the worker and carries no user authority. The extension inserts a backslash in text that imitates harness framing. Examples are `<system-reminder>`-style tags and lines that start with `Human:` or `Assistant:`. Nothing else changes. Isolated status and follow-up answer previews use the same header.

A session switch or shutdown stops observation and preserves tab identities for recovery. To inspect exact tabs, agents, and Pi session files, open `/subagent` on the session branch. This includes tabs launched after the first. The menu has one row for each workflow.

A single worker shows its reference, Role, and name (`D7.1 · worker · Search audit`). A multi-worker workflow shows its reference and worker count (`D8 · 3 workers`). When you select it, the menu lists each recorded worker by reference, Role, and name with its exact IDs. References and names help you match rows. The extension never uses them to decide ownership.

Older records without saved references show their saved allocation label or exact task ID. A `recorded only` row does not prove that its workers run or finished. The menu labels locally observed work separately.

### Continue or stop one direct worker

Main can continue a finished direct worker, so it does not have to start a new one. It adds `continueFrom` with the reference of the worker, such as `"continueFrom": "D7.1"`, to any single, parallel, or chain task. It uses the same `role` that the worker ran with. The worker resumes its saved Pi session in a new Herdr tab without focus, so it keeps its earlier context.

The new tab gets a new agent name and reference. Its record points to the same session and private lease file. The launch handle and the result say `continued from D7.1`. Access, admission, write rules, and model routes are the same as for a new task.

A request can continue each worker only one time, and only from the checkout and Herdr workspace where the worker ran. After a continuation, continue the newest reference. The extension refuses an older reference to the same session, because a later turn follows its own turn.

Before launch, the request fails if the reference is unknown or matches more than one record on this session branch. It also fails if the Role is different or a locally active task still owns the session of the worker. A missing session file or a session file larger than 16 MiB also causes failure. The last session turn for the recorded prompt must be finished.

If Herdr still lists the old agent, the agent must match the recorded name, pane, tab, workspace, and checkout. It must also be idle or done. The extension never closes a working or blocked agent. The extension closes the old pane, then proves pane absence and two empty lease scans.

Records saved before 27.0.0 have no turn identity. The extension cannot continue them. For these records, start a new task.

In a running workflow that has only `read` tasks, `/subagent` shows **Stop this worker** for each running worker. It aborts only that worker, sends Ctrl-C, closes its exact pane, and proves pane absence and two empty lease scans. The result of the worker becomes a failure, `Stopped by user from /subagent`, and keeps any partial output. Other workers continue, but a chain stops its later steps.

If the extension cannot prove termination of the stopped worker, the workflow keeps local ownership. So **Close/cancel-and-release** stays available. Main receives one result when the workflow finishes. A workflow with a `write` task offers only **Close/cancel-and-release ALL owned workers in this workflow**. Both actions check session, branch, and epoch, so a stale dialog cannot act.

### Isolated checked graphs

An isolated request has one durable ID, one goal, and 1 to 8 typed tasks:

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

`dependsOn` controls scheduling. `contextFrom` also schedules dependencies and carries completed text outputs in the declared order. Do not repeat the same task in both fields. Changesets require focused task checks. A graph with changesets requires final checks.

The canonical root `package.json` must have a test script. If `pnpm test` is not in the final checks, the runner adds it. Main runs it on the combined integration checkout before promotion. Checks and judgments bind to exact Git identities. Changes to the candidate or Main, changes during validation, unclear outcomes, or conflicts stop promotion. The extension retains evidence.

`delegate_task`, `subagent_resume`, and `subagent_integrate advance` return a durable request ID after the extension saves the wave. Productive work continues while Main is free. Main can do other work or end its turn. It does not need to sleep or poll. Pi sends a follow-up in the launching session when a checked worker becomes ready or a worker needs attention. Pi sends another follow-up when the wave finishes.

A worker can end its exact turn without a changed clean commit, for example after a failed or aborted turn. That worker needs attention, and the extension does not infer a candidate. Use `subagent_status` for its saved evidence.

A turn can end with tracked or untracked changes in the worktree. The coordinator then first sends the same worker one saved reminder for each dispatch try. The reminder tells the worker to commit the changes or explain why not. The reminder does not use a correction or a dispatch try. The coordinator never commits, stages, stashes, or discards the changes itself. If the worktree is still dirty after the reminder, the task needs attention, and the changes stay in place.

Follow-ups show only a short preview of a failed review verdict. They tell Main to run `subagent_status` for the full text. Session replacement or shutdown suppresses stale delivery. The extension then logs the request ID and reason, without prompts or credentials.

The extension reports synchronous delivery failures and does not replay them automatically. Pi reports asynchronous `send_message` failures through its native runtime. If delivery fails, inspect `subagent_status`.

The extension saves completed text answers independently of cleanup. Status and terminal follow-ups include a bounded preview of the accepted answer and cleanup evidence. Ignored automatic artifacts can retain a checkout, and this does not violate the read-only contract. The extension deletes no ignored files to make cleanup pass.

Tracked or untracked changes, a changed checkout identity, or unproved inspection still require attention. The completed answer stays saved. But the extension does not accept it as dependency context or retry it automatically. Retained text checkouts require deliberate manual inspection and cleanup. A retained checkout alone is not evidence that the Role edited source.

Isolated workers can start while Main has staged, unstaged, or untracked changes. They use only Main's pinned committed branch, HEAD, and tree. The extension does not copy those local edits into worker worktrees. It also does not stash, stage, reset, or merge them automatically. Main must stay at that committed identity while workers run. Changes to the branch or HEAD block new waves.

The worker produces a committed candidate without tracked or untracked changes. Then it runs focused preliminary checks and optional judgment. Ignored generated files do not block candidacy, but they prevent automatic worktree cleanup. Inspect them before you delete retained work. The runner records each ready candidate immediately but **does not integrate it automatically**. Main can inspect `subagent_status`.

While siblings still work, Main can use `subagent_stage` to select the exact candidate in an owned integration worktree. Main resolves conflicts there. Stage and resolve are available during an active wave, but rejection and revision wait until the wave settles. `subagent_integrate` can advance dependent tasks from a staged snapshot.

After the wave settles, it can validate the combined tip with full root checks and optional final judgment. It promotes the tip to Main only after exact validation. A definitive failed combined check or review permits one committed correction in the integration checkout, followed by another validation. Main must explicitly promote. Promotion and cleanup never silently discard retained work.

To select work by label, open `/subagent` without arguments. The menu shows direct records on this session branch and isolated requests in the current canonical Git checkout. This includes requests launched in other sessions. Select an isolated request. Then select **Inspect status and recovery**.

This launches a Herdr tab without focus, with the configured `scout` Role on the configured `fast` route. The tab runs a read-access task with the resources of the Role. Its prompt contains bounded saved status, including retained paths, but not the raw launch environment or session transcripts. The analysis stays in that tab and does not queue a Main turn. The tab shows in the direct list with its own reference and name, such as `D9.1 · scout · Inspect <request ID>`. The extension records the tab and session file for recovery, even if the launch becomes uncertain.

Before any stage or recovery action, the read-only `subagent_status` tool stays Main's authority for exact identities. If Herdr, the `scout` Role, or the fast route is not available, inspection fails and does not change the request. Main can then use `subagent_status`.

For older work, choose Refresh or completed/history. The extension shows a warning for invalid state IDs and preserves them. Direct recovery still works outside Git or when isolated inventory is not available. The browse action does not resume work or change resources. Direct **Close/cancel-and-release** is an explicit termination action.

For a locally active unsealed isolated changeset, choose **Send follow-up instructions** to open a native multiline editor. A submission queues the instruction, not a completed revision. Choose **Edit queued instructions** to withdraw *all still-pending* instructions for that selected task before the editor opens. Their full text shows in FIFO order, with blank lines between them. An explicit submission queues **one replacement** at the end. If you cancel, the withdrawn instructions stay removed.

You cannot recall already-claimed instructions, initial prompts, or automatic corrections. A worker can seal while you edit. If the submission fails, the editor opens again with the full submitted text. You can then edit or copy it deliberately. The extension never queues it again automatically.

The editor preserves combined text above the single-instruction limit, but rejects it until you make it shorter. A cancel before withdrawal makes no change. Neither action touches Main's editor or Pi's global Option+Up queue shortcut. Sessions without a UI can run `/subagent recover` or use agent tools for individual inspection and recovery.

A queued follow-up runs after the current turn settles. It must produce a new clean commit that passes preliminary checks again. When no queued revision remains, the checked candidate seals immediately. There is no guaranteed time to edit after completion. Late follow-ups fail visibly.

### Isolated recovery

`subagent_integrate validate` acknowledges only after it saves the validation intent of the exact generation. Then it runs checks and any final judgment in the background. A later turn cancellation does not cancel acknowledged validation. Session replacement or shutdown still stops it.

Completion sends a follow-up to the launching session. If delivery fails, use `subagent_status`. An acknowledgement is not passing evidence.

After an interruption to validation, first prove that the old coordinator and check processes stopped. Never take over a live productive lease. Use guarded `reconcile` on the saved generation and `combinedTip`. Missing checks or review never authorize `correct` or `promote`.

For a `validation_failed` generation with **no recorded checks, review, or prior combined correction**, `refresh` also accepts identical `expectedMain` and `newMain`. Supply the exact old combined `expectedTip` and the next generation number. Both Main and the retained integration tip must stay exact and clean. This action explicitly allocates a new checkout. It does not resume old checks.

Before promotion, restage the selected immutable candidates. Then run new full-suite checks and the required final judgment. The old generation stays retained, and the two-checkout limit still applies. Correction allowances do not reset. Other failures keep their existing recovery requirements.

After a coordinator interruption, run `/subagent recover` one time. It gets the repository productive lease before it changes any orphaned `pending` or `running` state. It preserves unreadable state files and retained candidates. It reports blockers and existing continuations to Main. It does not replay prompts, merges, promotion, or cleanup.

If another productive run holds the lease, the command only reads status and reports the live owner. Wait. Do not take over. You can safely run the command again.

Main uses `subagent_status` for exact identities. Main uses the recovery tools in the interface table above for deliberate decisions. The command never stages or promotes. Direct Herdr tab recovery stays in `/subagent`.

### Prune leftover worktrees

Run `/subagent prune` to clean up leftover worker and integration checkouts under `.worktrees/`. Their branches have the name `pi-subagent/subagent-` plus 24 hex characters. The command also cleans up such branches that have no checkout. The review lists each item with its path, branch, and tip. For each item, it also shows why the command can remove the item, or it shows every exact blocker. The command can remove an item only when all of these conditions are true:

- Its branch tip is already in Main's HEAD or in the local `origin` default-branch ref. The command does not fetch.
- Its checkout has no tracked or untracked changes. No merge, rebase, cherry-pick, revert, or bisect is in progress.
- No unfinished isolated request, in any checkout of this repository, records it. An unreadable state file blocks every item that it mentions.
- No productive run holds a repository lease.
- No Herdr pane works inside the checkout. If the command cannot inspect Herdr, it refuses every checkout.

One confirmation removes every listed removable item. When the command removes a checkout, it also deletes the ignored files of the checkout, such as `node_modules` or `dist`. So the command includes a checkout with ignored files only after a second confirmation. That confirmation names each ignored entry, and its approval covers all contents of each named entry.

If a top-level ignored entry is new or changed, the command skips the checkout. If the full list of ignored entries of a checkout does not fit in that dialog, the command excludes the checkout. The command blocks checkouts with initialized submodules. It also blocks owned checkouts that are detached or on another branch. Remove them manually.

The list shows removable items first. The command never cuts a long list silently. The list ends with `+N more not shown`, and the command does not remove the items that it did not show in that run. Run `/subagent prune` again to review them.

The command checks each item again immediately before removal and skips an item that changed. If the session or branch changes during removal, the command skips the remaining steps. The command deletes a branch only if the branch still points at the reviewed tip. Then the command reconciles each aborted request that recorded a removed resource. It uses the same guarded path as a repeated `subagent_abort`, so the cleanup of that request no longer shows as pending.

The report lists removed, skipped, and failed items, and each request that the command could not reconcile. Without interactive UI, the command only reports.

If an isolated worker produced no candidate, `subagent_abort` terminates it. It removes only owned resources that it proves are unchanged and clean. Cleanup includes ignored-file checks and never discards unique commits. The request stays aborted with retained-resource evidence if productive work has not settled, termination is uncertain, or cleanup fails.

Inspect `subagent_status`. Resolve the reported blocker. Then run `subagent_abort` again to reconcile cleanup. This does not replay worker prompts. Dirty work, unique commits, and uncertain allocations stay for deliberate manual recovery.

The following details describe exact identity and retained-work requirements.

A checked candidate stays retained if Main is dirty. Staging, combined validation, and promotion require Main to be clean at the pinned committed identity. Clean your local edits deliberately before you use those actions. The extension does not replay or merge dirty work automatically.

To stage, pass the exact `generation`, candidate (`taskId`, `attempt`, `candidate`), and `expectedTip` identities that status reports. To integrate, pass the generation and the combined `expectedTip`. If Main advances cleanly before promotion, call `subagent_integrate refresh` with the recorded `expectedMain`, the old `expectedTip`, and the new clean `newMain`. Main must restage selected immutable candidates into the new generation. Then Main must run combined checks again. Dirty or divergent Main blocks refresh.

Stale identities fail. If integration allocation was uncertain, `subagent_stage resolve` first proves that the owned checkout is still at its base. Then it starts the selected merge. Otherwise, it retains the intent.

Each request can keep at most two unreleased integration worktrees. A superseded generation is read-only. To release a superseded *clean* integration checkout, call `subagent_integrate` with `{ id, action: "release", generation, expectedTip }`. As `expectedTip`, use the last staged tip of that generation, or the integration base when no stage completed.

You can release a rejected candidate after its worker terminates and after release of all generations that use it. To release it, pass `{ id, action: "release", generation: <latest generation number, or 1>, taskId, attempt, expectedTip: <candidate tip> }`. Release saves each host, checkout, and branch step. It verifies ownership and cleanliness, including ignored files. It deletes the branch only if its ref still names the exact tip.

Dirty, conflicted, changed, or uncertain resources stay for manual inspection. After you resolve the obstacle, do the same release again. Each released checkout frees a retained slot. Abort is available after release of every retained resource.

Rejection can invalidate dependent work. If new dependent execution is not possible, start a new request. Do not force promotion.

Productive requests have no whole-run wall-clock deadline. Resume does not reset the recorded policy or correction count. Text tasks have two dispatch tries. Inspection failures before dispatch do not use a try. Verification requires passing preliminary checks and any required judgment. It cannot override a failed review.

Child limits, abort signals, process I/O, status inspection, exact termination, and cleanup keep finite safety bounds.

The extension never pushes, opens a pull request, publishes, deploys, force-cleans recoverable work, or silently falls back to Main.

## Config

pi-subagent owns `~/.pi/agent/config/pi-subagent/config.json`. If the file is missing, the extension silently uses the defaults.

| Name | Description | Values | Default |
| --- | --- | --- | --- |
| `maxSubagents` | Concurrent direct Herdr workers and ephemeral child-process limit | Safe integer ≥ 1 | `5` |
| `maxTurns` | Provider-turn limit per child | Safe integer ≥ 1 | `50` |
| `maxTokens` | Optional token limit per child | Safe integer ≥ 1 | Unlimited |
| `maxCorrections` | Same-worker automatic corrections per isolated request | Safe integer ≥ 0 | `1` |
| `timeout.idleMinutes` | Direct worker and ephemeral child idle timeout | Positive and within Node's timer range | `10` |
| `timeout.maxMinutes` | Ephemeral child hard runtime | Greater than idle and within Node's timer range | `30` |
| `roleDefaults` | Optional `extensions`, `tools`, and `skills` arrays merged into every built-in and user Role, with the same validation as Role fields | Object with `extensions`, `tools`, or `skills` | None |

In each merged list, `roleDefaults` entries come first, and the entries of the Role follow. The merge removes duplicates and occurs before resource resolution. Use `roleDefaults` for the provider extension that every child needs.

Limits come only from this global file. Request fields cannot override or replenish them. Existing durable requests keep their recorded policy, but a lower current correction limit can tighten recovery. There is no whole-run timeout setting.

A bad config never stops the extension. The extension shows each new problem one time at launch and each time it reads the file. It reads the file for `delegate_task`, each later worker of a direct chain, and each isolated Role launch. It also reads the file for `/subagent roles` or a status inspection:

- An unknown key shows a warning. The extension ignores the key.
- A misspelled key that is near a missing key, such as `maxToken` for `maxTokens`, counts as an invalid value of that key. The warning gives the likely key.
- An invalid value in `maxSubagents`, `maxTurns`, `maxCorrections`, or `timeout` shows a warning. The extension uses the finite default for that key. If `timeout.maxMinutes` is not greater than `timeout.idleMinutes`, the extension uses the default `timeout`.
- An unknown or invalid key in `roleDefaults` shows a warning. The extension ignores only that key, so Roles get fewer default resources.
- An invalid or misspelled `maxTokens` shows an error and blocks delegation. Malformed JSON, invalid UTF-8, a file larger than 64 KiB, or an unreadable file also causes this block. The default token limit is unlimited, so the extension does not use a default in these cases. `/subagent` stays available. Correct the file to enable delegation again.

  The block also applies to work that already runs. The next worker of a direct workflow, or the next Role launch of an isolated request, fails before it starts. A workflow that runs keeps the limits that it started with. If the file had the problem when the session started, also run `/reload`. The session took its execution limits from the defaults.

No key is required. The extension preserves the file and never rewrites it automatically.

### Roles

Role Markdown is in `~/.pi/agent/config/pi-subagent/`. It requires frontmatter and a Markdown system prompt.

| Field | Requirement |
| --- | --- |
| `name`, `description` | Required non-empty text without terminal control characters |
| `modelClass` | Optional `fast`, `balanced`, `frontier`, or `fav` default |
| `tools` | Required array of base or internal tool names; `[]` selects none. Name `codemode` or `git_read` here to activate it (see below) |
| `extensions` | Required array of trusted absolute paths, supported package sources, or Pi built-in extensions such as `builtin:codemode` |
| `skills` | Required array of effective Pi Skill names |
| `mcps` | Optional exact server names from `~/.pi/agent/mcp.json` in Pi's native `mcpServers` format; omitted or `[]` denies MCP access |
| body | Required system instructions |

The extension rejects unknown frontmatter keys and names the file and key. It reports each invalid file separately. Valid Roles still load. Delegation to the Role that an invalid file claims fails with the error of that file. Duplicate names make that name unavailable. `/subagent roles` lists the errors.

Roles describe responsibility and capabilities, not write access or isolation. Each task declares access, and each request chooses its mode. A user Role with the same name overrides a built-in Role. The package ships `implementer`, `reviewer`, and `scout`.

The built-in reviewer includes `git_read`. To opt in, add `git_read` to the `tools` array of an existing user reviewer. No additional extension or Bash access is necessary.

### Reviewer Git inspection

`git_read` is an internal child tool. The extension loads and registers it only for Roles that declare it. It accepts structured parameters, not shell commands or arbitrary Git options:

| `operation` | Parameters and evidence |
| --- | --- |
| `status` | Optional `path`; staged, unstaged, and untracked status |
| `diff` | `mode: "working"` (default, unstaged), `"staged"`, or `"committed"`; committed requires `base` and `tip`. Optional `path` |
| `show` | Optional `revision` (default `HEAD`) and `path`; commit patch or file content at that commit |
| `log` | Optional `revision`, `path`, and `maxCount` (default 20, maximum 100) |
| `blame` | Required `path`, optional `revision` and paired `startLine`/`endLine` |
| `rev-parse` | Optional `revision`; resolves one commit ID |

Revisions accept commit IDs or named refs with optional `~N`/`^N` ancestry, not ranges or reflog expressions. Paths are literal and relative to the assigned cwd. The tool rejects absolute paths, traversal, `.git` components, and paths that look like options.

Use named candidate refs. Do not assume that Main's checkout contains an isolated candidate. In isolated judgment, the supplied exact patch stays authoritative. Git inspection supplies only referenced context, not a replacement diff. Reviewers still cannot run tests, write, commit, or push. They approve only with exact `PASS`.

You can cancel each call, and each call has a limit of 30 seconds. Results keep at most the last 32 KiB of UTF-8 output, with an explicit `truncated` flag and notice. If output is truncated, make the path, log count, or blame lines narrower. Do not treat truncated evidence as complete. Missing refs or files, non-repositories, invalid UTF-8, timeouts, and Git failures fail visibly. The tool writes no full-output artifact.

Git must support `--no-lazy-fetch`. Older versions fail and do not permit network access. The tool disables lazy fetch, pager, optional locks, hooks, fsmonitor, external diffs, textconv, and clean and process filters. So working-tree comparisons use unfiltered bytes and can be different from filter-aware Git output (for example Git LFS). The tool does not inspect submodule contents. Concurrent edits can still make direct inspection stale.

### Child resources

Children run with `--no-extensions`. So a Role must list the extension that registers the provider of its route model. Only declared resources and required internal policy adapters load. `builtin:<name>` entries explicitly load Pi built-in extensions (`builtin:codemode`, `builtin:tool-search`, `builtin:llama.cpp`).

The extension rejects `builtin:mcp`, because it would connect every configured server and bypass `mcps`. Scripts can still call extension tools registered with `codemode` or `deferred` exposure. But the model gets their declarations only when `tools` names them.

Main's nested calls pass admission by their own tool names, not by script or ancestor ownership. Each call that can write, including Bash, prevents the start of a direct writer until that call returns a result or execution end. Main calls do not block each other. The completion of a script does not release its active nested calls. A nested call can still pass admission after its parent ends if no direct writer owns the checkout.

To let a Role run `codemode` scripts, list `builtin:codemode` in `extensions`. Also list `codemode` in `tools`. Both are required, because the built-in registers the tool as inactive and the Role tool policy activates it. If `tools` has `codemode` alone, the launch fails with an unavailable tool.

Pi's `codemode.mode` and `codemode.inlineBudget` settings apply in the child without change. So the Role never forces codemode-only operation. MCP configuration never activates `codemode` in a child. Scripts can call only the active tools of the Role, plus `codemode` and `deferred` extension and MCP tools. Inactive base tools such as `bash` stay unreachable.

The servers named in `mcps` come only from the global `~/.pi/agent/mcp.json`. In a Role that activates `codemode`, each selected server keeps its configured `exposure` and `toolExposure`. Pi's default `codemode` exposure makes tools callable from scripts without declarations. `direct` declares them. `deferred` tools stay reachable from scripts, and `hidden` tools stay unreachable. An invalid exposure value fails the launch.

In every other Role, the extension forces selected servers to `direct` exposure. It ignores `toolExposure`, because that child cannot reach undeclared tools. Declared tools show to the model as `mcp__<server>__<tool>` after the server connects. Pi replaces `-` in server and tool names with `_`. Pi appends a hash suffix when two tool names collide or a name is longer than 64 characters.

Before launch, the extension checks each selected entry against Pi's documented `mcpServers` rules, in Main and again in the child. The launch fails with the file path and field for each of these conditions:

- An entry is disabled, malformed, or uses an unknown transport.
- A server name is invalid.
- Two selected names differ only in `-` and `_`.
- `auth.provider` uses plain HTTP outside `localhost`, `127.0.0.1`, or `[::1]`.
- `oauth.authServerMetadataUrl` does not use HTTPS outside those hosts.

The extension never modifies the file. Fix the entry or choose another server. The extension passes valid `auth`, `oauth`, and `description` fields through, so Pi's native provider auth and OAuth apply. `oauth.clientRegistration` must be `dcr` or `cimd`. A `cimd` entry cannot use `clientId` or `clientName`. Any `callbackUrl` must use localhost or 127.0.0.1 with path `/callback`.

The extension still ignores project MCP overrides. A project cannot change the global server allowlist or exposure of the Role. Missing Skills, tools, MCP servers, Roles, or routes fail before productive work starts. The extension excludes Main-only delegation and recovery tools and `ask_question` from children.

## API

| Surface | Type | Purpose |
| --- | --- | --- |
| `loadRoleCatalog`, `findRole`, `parseRoleName`, `parseRoleDefaults` | functions | Load built-in and user Roles with `roleDefaults` and per-file errors, then select one by name. |
| `registerRoleDefaultsReporting(pi, agentDir?)` | function | Reports `roleDefaults` problems at each session start. Returns `report(ctx)`; call it before a lazy `loadRoleCatalog`. Each problem shows one time in each session. |
| `resolveRoleSkills`, `resolveRoleLaunch`, `resolveConfiguredRoleLaunch` | functions | Resolve effective Pi resources and model routes. |
| `prepareRoleLaunch`, `finalizeRoleLaunch` | functions | Prepare Role prompts, arguments, and tool policy. |
| `createEphemeralSubagentExecutor` | function | Run bounded no-session Pi children through a FIFO pool. |
| `createChildWorktree`, `finalizeChildWorktree` | functions | Create and conservatively finalize child worktrees. |
| `prepareExactReviewEvidence` | function | Prepare private exact base-to-tip review evidence. |
| `ExecuteRequestSchema`, `StageRequestSchema`, `IntegrationActionSchema` | schemas | Validate checked request and integration inputs. |
| `IsolatedRunner`, `FileRunStore` | classes | Run checked work and persist durable request state. |
| `RoleLaunchRuntime`, `HerdrHostRuntime`, `CheckedGitRuntime` | classes | Supply launch, host, and Git behavior to the runner. |
| `ExecutionPolicySnapshot`, `RunState`, `CoordinatorRuntime` | types | Describe persisted policy, state, and runner integration. |

Role route and launch helpers require only model routing fields and `isProjectTrusted()` from the context, plus `cwd` for configured package resources. They do not require UI methods.

`createEphemeralSubagentExecutor` accepts global concurrency, turn/token, idle, and hard-runtime policy. Queued time consumes no child timeout. A run resolves resources only after it receives its permit. It accepts abort, output, token, and activity callbacks. The executor limits output and diagnostics.

A child that reports `agent_settled.aborted: true` returns a failure result with `stopReason: "aborted"`, even if its process exits with code 0. The executor keeps collected output, usage, and child error text. `aborted: false` does not prove provider success. A parent abort or timeout still rejects with `EphemeralSubagentError`.

See [Orchestration and package-author API](./docs/orchestration.md) for the detailed contracts and recovery model.

## State and storage

Durable state is private under `config/pi-subagent/state/`. The extension creates isolated worker Pi sessions in advance with mode `0600` under `config/pi-subagent/leases/`. It does not change the umask of the worker. Reads stop at the 16 MiB limit, even if the session grows. A session above this limit requires inspection, and the extension does not accept it as completion evidence.

The extension removes sessions only after exact worker-tab cleanup. Retained sessions can contain prompts and answers, so do not share them. State v5 rejects v4 and older files and does not migrate them. Keep the old state. Recover its work manually.

## Limits and recovery

Role extensions and MCP servers are trusted executable code, not a sandbox. Select the smallest resource set. Direct tasks can use declared resources that can write in Main's checkout only in the authorized scope.

Checkout admission coordinates the Pi calls of this Main. It does not coordinate other Pi sessions, trusted extension lifecycle code, or external processes. Concurrent changes can make the read of a direct worker stale. Retained-work reports identify exact resources for deliberate recovery.
