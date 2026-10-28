# Orchestration and package-author API

`pi-subagent` owns both delegation paths behind `delegate_task`:

```text
                         ┌─ direct ─── authorized shared-checkout Herdr tab
request + Role + route ──┤
                         └─ isolated ─ Herdr worktree, checked candidate, durable state
```

Both paths resolve Roles and model routes from Pi's effective registries. They share the package's global concurrency, turn/token, timeout, and correction policy. A request cannot supply or refill execution limits.

## Choose a delegation mode

Main chooses the mode from your request. You do not need to select one. Words such as “direct” and “isolated” can show your intent, but the work sets the route. Main declares the selected mode in each `delegate_task` call. The extension never falls back between modes.

| Mode | Request that triggers it | Checkout behavior |
| --- | --- | --- |
| `direct` | Bounded research, review, or explicitly authorized writes and commits in the shared checkout | Opens Herdr tabs without focus in Main's current workspace. Creates no worktree. |
| `isolated` | Implementation or a checked task graph | Runs changesets in owned Herdr worktrees. Main selects, validates, and promotes exact candidates. |

Keep trivial mechanically verifiable work in Main. Keep tightly coupled changes under one owner. Do not split them by file count.

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
| `paths` | no | Write tasks only: 1 to 32 repo-relative globs (`path.matchesGlob` syntax, such as `src/**`). The change report flags changed paths outside them. A report only, not enforced |
| `continueFrom` | no | Direct reference such as `D7.1`; continues that finished worker's Pi session. `role` must equal the recorded Role |
| `kind` | no | `text` only (default); direct `changeset` is rejected |
| `modelClass` | no | `fast`, `balanced`, `frontier`, or `fav` route |
| `model` | no | `provider/modelId`; replaces only the route model |

An explicit model must support the route's thinking level. A launched child is never retried automatically after provider or process failure.

Direct `changeset` is rejected; use isolated mode for checked integration. Resource validation and recursive-delegation exclusions apply to every task. A request becomes a write request when any task declares `access: "write"`.

### Dry run

Set `"dryRun": true` on a direct or isolated `delegate_task` request to check it without a launch. The dry run does the same checks as a launch: request shape, Role lookup, route and model with thinking level, Skills, tools, MCP allowlist, Role extensions, config, and `continueFrom` eligibility. For an isolated request, it also checks the task graph and that Main is clean and committed. If the request has a changeset task, it also checks the canonical root `package.json` test script and adds `pnpm test` to the final checks. A failed check gives the same error as a launch.

The result is a bounded plan. It shows each task's Role, resolved `provider/model`, thinking level, access or kind, dependencies, and checks. An isolated plan also shows the final checks. The dry run makes no Herdr call, Herdr tab, session record, saved state, worktree, lease, checkout admission, or follow-up. The plan lists each check it cannot do without such an effect as `Not checked: <reason>`. Examples are the Herdr host preflight, checkout admission, and the stop of a continued agent.

Read requests skip checkout admission and return plain text. Parallel `tasks` run concurrently up to `maxSubagents`; chains stay ordered. The extension does not enforce `read`. Results stay in request order.

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

### Continue or stop one direct worker

Main can continue a finished direct worker, so it does not have to start a new one. It adds `continueFrom` with the reference of the worker, such as `"continueFrom": "D7.1"`, to any single, parallel, or chain task. It uses the same `role` that the worker ran with. The worker resumes its saved Pi session in a new Herdr tab without focus, so it keeps its earlier context.

The new tab gets a new agent name and reference. Its record points to the same session and private lease file. The launch handle and the result say `continued from D7.1`. Access, admission, write rules, and model routes are the same as for a new task.

A request can continue each worker only one time, and only from the checkout and Herdr workspace where the worker ran. After a continuation, continue the newest reference. The extension refuses an older reference to the same session, because a later turn follows its own turn.

Before launch, the request fails if the reference is unknown or matches more than one record on this session branch. It also fails if the Role is different or a locally active task still owns the session of the worker. A missing session file or a session file larger than 16 MiB also causes failure. The last session turn for the recorded prompt must be finished.

If Herdr still lists the old agent, the agent must match the recorded name, pane, tab, workspace, and checkout. It must also be idle or done. The extension never closes a working or blocked agent. The extension closes the old pane, then proves pane absence and two empty lease scans.

An absent old agent still requires two empty lease scans.

Records saved before 27.0.0 have no turn identity. The extension cannot continue them. For these records, start a new task.

In a running workflow that has only `read` tasks, `/subagent` shows **Stop this worker** for each running worker. It aborts only that worker, sends Ctrl-C, closes its exact pane, and proves pane absence and two empty lease scans. The result of the worker becomes a failure, `Stopped by user from /subagent`, and keeps any partial output. Other workers continue, but a chain stops its later steps.

If the extension cannot prove termination of the stopped worker, the workflow keeps local ownership. So **Close/cancel-and-release** stays available. Main receives one result when the workflow finishes. A workflow with a `write` task offers only **Close/cancel-and-release ALL owned workers in this workflow**. Both actions check session, branch, and epoch, so a stale dialog cannot act.

### Direct results and records

The extension retrieves each final answer from its exact Pi session file, not its possibly truncated screen. Idle, blocked, unknown, or malformed answers fail with recoverable tab and session identities. No whole-run deadline applies.

The tasks in a request share a 40 KiB inline answer budget. Each worker prompt states its share. A longer exact answer is still a success. The result shows a UTF-8-safe prefix and a truncation marker. The marker gives the path of a private `answer-<turn>.md` file beside the session file, which holds the full answer. For a write task, the budget applies to the `answer` field of the completion object. A chain step receives the full answer of the previous step in `{previous}`; the budget applies only to the result for Main. The result details keep `answerFile` for each full-answer file. Recovery text includes these paths outside the output limit, even when checkout notes remove the inline link.

Herdr accepts prompt text as one command argument. To stay below the operating system's argument limit, a task packet above 64 KiB uses a private, exclusively created `task-<turn>.md` file beside the session file. This packet includes the full chain context. The worker prompt requires the Role's `read` tool to read all parts with line offsets before work starts. Pi's native `read` can return a line of exactly 50 KiB (51,200 bytes), but not a longer line. If any packet line is longer, or `read` is absent, the worker uses the Role's `bash` tool. If a line is too long and `bash` is absent, the task fails before tab creation with the read limit and a request for `bash` or shorter lines. A Role with neither tool also fails before tab creation; the extension adds no tool. The task file stays available for recovery.

The tool returns a task ID and the first Herdr tab after launch, not the answer. The extension observes each worker and sends one result to Main when the workflow finishes. If Main is busy, Pi queues the result after the current turn. If Main is idle, the result starts a turn. The extension does not report a blocked, stalled, or unknown result as success.

In the result, each launched worker has a line with its model, thinking level, measured task tokens, cost, and elapsed time. For example: `✓ [1/2] Check · worker · provider/model · thinking high · 1.5k tok · $0.12 · 42s`. The first line also shows the request total, such as `total $0.12`. Unknown and zero cost are not shown. If Pi recorded no usage, the line shows `tokens unknown`. Failed and stopped workers show the usage that the extension measured until they ended. A worker that the extension skipped before launch shows no usage.

The result details contain the same values in each entry as `model`, `thinkingLevel`, `tokens`, `cost`, and `elapsedMs`, and the request total as `cost`. When a value is unknown, its field is absent. If a task fails after its worker produced text, the result keeps a bounded excerpt marked as partial output. This excerpt is never success.

Every worker result delivered to Main starts with a header. The header states that the text is the output of the worker and carries no user authority. The extension inserts a backslash in text that imitates harness framing. Examples are `<system-reminder>`-style tags and lines that start with `Human:` or `Assistant:`. Nothing else changes. Isolated status and follow-up answer previews use the same header.

A session switch or shutdown stops observation and preserves tab identities for recovery. To inspect exact tabs, agents, and Pi session files, open `/subagent` on the session branch. This includes tabs launched after the first. The menu has one row for each workflow.

A single worker shows its reference, Role, and name (`D7.1 · worker · Search audit`). A multi-worker workflow shows its reference and worker count (`D8 · 3 workers`). When you select it, the menu lists each recorded worker by reference, Role, and name with its exact IDs. After Main receives the result, the row shows the request cost and each worker line shows its cost. References and names help you match rows. The extension never uses them to decide ownership.

Older records without saved references show their saved allocation label or exact task ID. A `recorded only` row does not prove that its workers run or finished. The menu labels locally observed work separately.

### Checkout change reports

For each task in a write request, the extension takes a Git snapshot of Main's checkout before the worker starts and again when the task ends (success, failure, blocked work, or stop). A snapshot contains the `HEAD` OID and `git status --porcelain=v1 -z --untracked-files=all`, with the content identity of each dirty path. The result of the task then lists:

- New commits from `git rev-list before..after`, as a short OID and subject. If `HEAD` moved to a commit that does not descend from the start `HEAD`, the report says so.
- Paths with a changed status or content, and the paths that the new commits changed. If the task declares `paths`, each changed path outside them shows `outside declared paths`.

The report shows at most 10 commits and 20 paths, and it counts the omitted items. Paths outside the declaration come first. The same report is in the `checkout` field of the result details entry. The report does not enforce scope. Checkout admission blocks Main writes during a write request, so the report assigns changes to the worker. It cannot exclude changes from other processes.

For a read request, the extension compares the same snapshot at launch and when each task ends. If `HEAD`, status, or dirty content changed, the result of that task shows `checkout changed during task; result may be stale`.

Outside a Git repository, the extension makes no report and the task continues. If a snapshot fails, the task does not fail; the result shows `change report unavailable: <reason>` (or `stale-read check unavailable: <reason>` for a read request).

### Status widgets

The TUI has two separate compact status widgets. Each widget has one row for each visible worker or task. `D` marks direct work, and `I` marks isolated work. Badges such as `[S]` and `[I3]` identify the Role initial. Isolated badges also include the model class: `1` fast, `2` balanced, `3` frontier, `*` fav.

Each direct row starts with a saved direct reference such as `D7.1`. `D7` is the workflow number in this Pi session, and `.1` is the position of the worker in the original request. `/subagent` uses the same reference and name. The Herdr tab label shows them at launch. Numbers continue after reload, and the session never uses a number again.

A session switch can move a workflow into a session that already uses its number. In that case, the workflow gets a new number there. An existing Herdr tab keeps its original launch label.

The direct widget shows the launched model, thinking level, elapsed time, measured task tokens (`— tok` until usage is available), and cost next to the tokens (such as `$0.12`; not shown when unknown or zero). Failed rows show before working and completed rows. When rows overflow, `… N more` includes counts by status.

The isolated widget shows the recorded task state and any retained workspace. It does not show reliable live model, thinking, or token readings from Herdr. Attention shows before ordinary work, and overflow uses `+N more · /subagent`. An aborted request with visible tasks has its own `request aborted` row. This row does not change the recorded statuses of the tasks.

A committed worker without a checked candidate can show attention, not readiness. Status glyphs use the active TUI theme. The text also names the status without color.

The direct widget and result summaries show measured tokens for the current task turn. This count adds input and output tokens from completed assistant usage records. It excludes cache-read and cache-write tokens. A continued worker counts only its new task turn. Missing usage stays unknown. This display count does not change token-limit accounting. The cost is the sum of `usage.cost.total` from the same records, read in the same session read. Isolated task state records no usage, so isolated rows show no tokens or cost.

A ready isolated candidate is **not promoted** to Main. To reload the menu and the isolated widget from saved state, choose **Refresh** in `/subagent`. Refresh does not recover or change a request. Use `/subagent` or `subagent_status` for exact identities, failures, and recovery.

### Direct tool activity

Direct rows can show `pending read, bash` and `last read 125ms recorded`. Pending means that Pi saved the call, but the session of this task has no matching result. It does not prove that execution started. Parallel calls stay pending until their own results arrive.

Recorded time comes only from the `durationMs` of the latest matched tool result. The extension does not calculate it from assistant timestamps. If the latest result has no timing, the row shows no tool time, even if an earlier result had timing. Older sessions, and calls rejected before execution, can have no recorded time. Task elapsed time is a separate metric.

Activity uses the existing session sample and file-size cache. The extension ignores a partial trailing JSONL entry until it is complete. For display, the extension removes terminal control characters from tool names. Narrow rows remove activity before other metrics, so worker identity and failure state stay visible. Activity and time are display information, not proof of task completion, worker ownership, or a timeout.

## Isolated contract

An isolated request has one durable ID, one goal, and 1 to 8 typed tasks.

New worktrees use `.worktrees/subagent-<name>-<24hex>` and branch `pi-subagent/subagent-<name>-<24hex>`. The name uses the request and task IDs. Text tasks also include `text-<attempt>`. Integration checkouts use the request ID and `integration-<generation>`. Each name component has at most 24 characters; the full readable part has at most 72. Names use lowercase ASCII letters, digits, and hyphens. The 24-hex identity suffix keeps names distinct when readable parts are shortened or normalized.

Herdr workspace labels use the worker worktree name. Worker tab labels add the model class. Names never use goals, requirements, or other free-form task text. Saved opaque worktree names and their Herdr labels stay unchanged. Resume and cleanup use the exact saved allocations; the extension does not rename existing resources.

For example:

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

The request also accepts optional `finalJudgment` with `role`, `modelClass`, and `criterion`, using the same shape as task `judgment`.

Every task declares `id`, `kind`, `role`, `modelClass`, `requirements`, `deliverable`, `dependsOn`, and `contextFrom`.

- A `text` task runs in a disposable child worktree and must leave it unchanged.
- A `changeset` task requires focused checks and owns one worktree, Herdr workspace, worker tab, and retained worker.
- `dependsOn` controls ready waves; dependent tasks can run from a selected staged snapshot only after Main explicitly advances it.
- `contextFrom` may reference completed text tasks only, implies scheduling dependencies, and preserves declaration order. It must not overlap `dependsOn`.
- A graph containing changesets requires final checks. The repository root must have a `package.json` test script; admission prepends canonical `pnpm test` if absent from final checks. Combined validation rejects a changed root test script.

Admission and worker-wave dispatch pin Main's exact committed branch, HEAD, and tree without inspecting or modifying its staged, unstaged, or untracked edits. Worker allocation verifies the same committed identity around worktree creation, including resumed waves; staged-dependent waves verify their clean integration snapshot. A dirty Main can therefore produce a checked retained candidate, but branch/HEAD drift stops new waves. The runner executes ready worker tasks concurrently, inspects clean committed candidates, runs preliminary task checks and optional preliminary judgment, then records ready candidates for Main. **It does not automatically integrate them.**

Main selects exact candidates through `subagent_stage` into an owned integration checkout in explicit order. Each stage is a committed merge of the candidate, not a mutation of Main. Conflicts retain the checkout for Main to resolve; `resolve` verifies the exact two-parent merge instead of replaying an uncertain merge. Main can explicitly run dependent tasks from an exact staged tip with `subagent_integrate advance` and stage their results afterward. Independent candidates may be staged without re-running workers.

Once all selected work is staged, Main calls `subagent_integrate validate` on the exact clean combined tip. It acknowledges the durably saved validation intent and continues in the session-owned background, independent of later turn cancellation; session replacement/shutdown still cancels it. A follow-up reports completion; status remains authoritative if delivery is missed. This runs every final check, including `pnpm test`, unless [exact check reuse](#validate-and-promote) applies, and optional final judgment in the integration checkout before any Main mutation. A failed check/review can be followed by one Main-authored committed correction in that checkout, recorded with `correct`, then another `validate`.

Staging, combined validation, and `promote` require clean Main at the recorded committed identity. Dirty edits block these actions even when the checked candidate stays retained. The extension never replays or merges dirty work automatically. `promote` requires exact passing combined evidence and unchanged Main and uses a guarded update to Main. Only proven promotion leads to selected-worker termination and verified cleanup. A changed candidate, integration tip, or Main identity invalidates prior evidence or blocks promotion; review accepts only exact `PASS`.

### Text results and cleanup

The extension saves completed text answers independently of cleanup. Status and terminal follow-ups include a bounded preview of the accepted answer and cleanup evidence. Ignored automatic artifacts can retain a checkout, and this does not violate the read-only contract. The extension deletes no ignored files to make cleanup pass.

Tracked or untracked changes, a changed checkout identity, or unproved inspection still require attention. The completed answer stays saved. But the extension does not accept it as dependency context or retry it automatically. Retained text checkouts require deliberate manual inspection and cleanup. A retained checkout alone is not evidence that the Role edited source.

### Readiness and Main actions

The user's request can authorize the declared local graph, checks, review, and Main's later explicit integration actions. After each successful preliminary check batch, the runner drains any follow-up already queued for the same live worker. Each revision must produce a new clean commit and rerun preliminary checks. When the queue is empty, the runner atomically seals the candidate and persists exact readiness evidence without waiting for input.

After readiness, use `subagent_stage revise` with the exact candidate, generation, current `expectedTip`, and instruction. A same-worker correction must remain available. Material scope growth, missing authorization, user-owned conflicts, and consequential external actions require a new decision. Pi Subagent never pushes, publishes, deploys, or opens a pull request.

### Inspect and revise active work

To select work by label, open `/subagent` without arguments. First, a **Current subagent work** report shows the work that local and saved evidence proves is running: locally owned direct workflows with a running worker, and active isolated requests while a live run holds the repository lease. The report lists active requests without a live lease as interrupted, and recorded-only direct work as unverified. A live lease does not identify its request, so several active requests in one checkout all show as working. The menu shows direct records on this session branch and isolated requests in the current canonical Git checkout. This includes requests launched in other sessions. Select an isolated request. Then select **Inspect status and recovery**.

The menu also shows requests whose saved parent checkout no longer exists, in their own **Orphaned · parent checkout removed** group. Saved `running` and `pending` states have a `saved` prefix and an `unverified` suffix. The report lists them under **Unverified**, never **Working**, even if the current checkout has a live lease. These labels do not change saved state or prove completion. Orphaned requests with retained resources or `needs_attention` show under **Needs attention**. You can open this view from any checkout of the same repository. The saved worker or integration path identifies the primary repository. Orphaned requests have the same **Close and delete worktrees (discard work)** action, but no inspection or follow-up actions. The extension reads their original state directories; it does not recreate the removed parent checkout. Unreadable files stay preserved and are reported.

This launches a Herdr tab without focus, with the configured `scout` Role on the configured `fast` route. The tab runs a read-access task with the resources of the Role. Its prompt contains bounded saved status, including retained paths, but not the raw launch environment or session transcripts. The analysis stays in that tab and does not queue a Main turn. The tab shows in the direct list with its own reference and name, such as `D9.1 · scout · Inspect <request ID>`. The extension records the tab and session file for recovery, even if the launch becomes uncertain.

Before any stage or recovery action, the read-only `subagent_status` tool stays Main's authority for exact identities. If Herdr, the `scout` Role, or the fast route is not available, inspection fails and does not change the request. Main can then use `subagent_status`.

Both isolated groups hide terminal requests by default: `completed`, `aborted`, `final_failed`, and `superseded`. Requests with retained resources or unresolved recovery stay visible. Select **Completed / history** to see all saved requests; **Refresh** reloads the current view. The filter does not delete records. Without interactive UI, the request list includes history. The extension shows a warning for invalid state IDs and preserves them. Direct recovery still works outside Git or when isolated inventory is not available. The browse action does not resume work or change resources. Direct **Close/cancel-and-release** is an explicit termination action.

For a locally active unsealed isolated changeset, choose **Send follow-up instructions** to open a native multiline editor. A submission queues the instruction, not a completed revision. Choose **Edit queued instructions** to withdraw *all still-pending* instructions for that selected task before the editor opens. Their full text shows in FIFO order, with blank lines between them. An explicit submission queues **one replacement** at the end. If you cancel, the withdrawn instructions stay removed.

You cannot recall already-claimed instructions, initial prompts, or automatic corrections. A worker can seal while you edit. If the submission fails, the editor opens again with the full submitted text. You can then edit or copy it deliberately. The extension never queues it again automatically.

The editor preserves combined text above the single-instruction limit, but rejects it until you make it shorter. A cancel before withdrawal makes no change. Neither action touches Main's editor or Pi's global Option+Up queue shortcut. Sessions without a UI can run `/subagent recover` or use agent tools for individual inspection and recovery.

A queued follow-up runs after the current turn settles. It must produce a new clean commit that passes preliminary checks again. When no queued revision remains, the checked candidate seals immediately. There is no guaranteed time to edit after completion. Late follow-ups fail visibly.

### Exact integration actions

`subagent_status` shows failed review verdicts from each task's latest dispatch, the final gate, and each generation, including while siblings run. Its text uses one shared 32 KiB budget and counts omitted verdicts. Structured output carries each verdict up to 32 KiB and sets `verdictTruncated` when necessary. Follow-ups give short previews and direct Main to status for the full text.

Status reports ready candidates with `taskId`, `attempt`, and `tip`. Each generation records its number, stage lineage, combined tip, checks, promotion, and retained worktree. Use these exact identities, including branch, HEAD, index, and tree. Do not guess commits.

#### Stage and resolve

```text
{ id, action: "stage" | "resolve" | "reject" | "revise", generation, taskId, attempt, candidate, expectedTip, instruction? }
```

`candidate` is the ready candidate's `tip`. For the first stage, `expectedTip` is Main's recorded identity. Later stages use the previous stage's exact tip. `resolve` checks a pending or conflicted merge, including its exact two-parent identity. It never replays an uncertain merge.

Stage and resolve remain available during an active wave; rejection and revision wait until the wave settles. If allocation was uncertain, resolve first proves that the owned checkout remains at its base before starting the selected merge. Otherwise, it retains the intent.

Rejection or revision of a staged candidate supersedes that generation and leaves its checkout read-only. Main must explicitly restage selected candidates into a new generation. Each request permits at most two unreleased integration worktrees. Superseded generations and rejected candidates remain until explicit release.

Rejection invalidates dependent work. Rejection and revision ignore dependent work that refresh or an earlier rejection already invalidated. If fresh dependent execution exceeds dispatch or lineage limits, start a new request. Do not force promotion.

#### Validate and promote

```text
{ id, action: "advance" | "validate" | "correct" | "promote" | "reconcile" | "cleanup", generation, expectedTip }
```

Use the generation's exact `combinedTip` as `expectedTip`. `advance` dispatches ready dependents from that snapshot. `correct` records one clean committed correction after a definitive failed check or review. `reconcile` inspects interrupted validation or promotion without replaying uncertain promotion. `cleanup` finishes proved post-promotion cleanup.

Post-promotion cleanup handles each promoted stage separately. A blocked termination or cleanup step records its failure on that step, and cleanup continues with the other stages and then the promoted integration checkout. Clean Main at the promoted identity is a shared precondition; if Main changed, every pending step records the blocker. Dirty, untracked, or ignored files block worktree removal and stay preserved. Until every promoted termination and cleanup step completes, the request stays `needs_attention` with promotion proven, selected tasks `completed`, and not accepted, so `/subagent` lists it. Resolve the recorded blockers, then call `cleanup` again; the request becomes `completed` and accepted only after cleanup completes.

Validation acknowledges only after saving the exact generation's validation intent. Checks and final judgment then run in the background. Later turn cancellation does not cancel acknowledged validation; session replacement or shutdown does. Acknowledgement is not passing evidence. Inspect status if the completion follow-up fails.

Validation reuses a passed preliminary result for a final check, and does not run that check again, only when all of these conditions are true:

- The candidate is staged in this generation.
- The tree OID of the combined tip is equal to the tree OID of the candidate. This usually occurs when you stage one candidate onto unchanged pinned Main.
- The saved preliminary checks of the candidate passed, and their `candidate` and `identityAfter` are equal to the candidate tip.
- The preliminary result has the identical command and argv, exit code 0, and no timeout or signal.

Any mismatch runs the check normally. Each reused result records `reusedFrom` with `taskId`, `attempt`, and `candidate`. Status text and the validation follow-up show each reused command. Promotion, reconciliation, and state loading accept a reused result only after they prove these conditions again from saved identities. Final judgment still runs. Reuse assumes that checks use only tracked content. Ignored files, for example `node_modules`, can be different between the worker and integration worktrees.

#### Refresh

```text
{ id, action: "refresh", generation, expectedTip, expectedMain, newMain }
```

If Main advances to a clean same-branch descendant, refresh freezes the old generation and allocates a new checkout from `newMain`. Restage selected immutable candidates in order, resolve fresh conflicts, and rerun combined validation. Dirty, divergent, or uncertain Main blocks refresh.

After interrupted validation, prove that the old coordinator and check processes stopped. Never take over a live productive lease. Use guarded `reconcile` on the saved generation and `combinedTip`. Missing checks or review never authorize `correct` or `promote`.

A reconciled `validation_failed` generation without recorded checks, review, or a prior combined correction permits refresh with identical `expectedMain` and `newMain`. Supply the exact old combined `expectedTip` and next generation number. Main and the retained integration tip must remain exact and clean. This allocates a new checkout; it never resumes uncertain checks.

Restage selected candidates and run all final checks and required judgment before promotion. The old generation remains retained, the two-checkout limit still applies, and correction allowances do not reset.

#### Release and abort

```text
{ id, action: "release", generation, expectedTip, taskId?, attempt? }
```

Without a task, release a superseded clean checkout using its recorded tip. Use its correction tip, otherwise its last staged tip, otherwise its integration base. Supersession preserves the correction record.

With `taskId` and `attempt`, release a rejected candidate, including dependent work invalidated by refresh or rejection. First release every generation that staged it. Supply its candidate tip and the latest generation number, or `1` if none exists.

Release proves exact worker termination before cleanup. An absent worker still requires pane absence and two empty lease scans. An observed live worker without saved termination intent can close with the same proof. Uncertain termination never replays automatically.

Release saves each host, checkout, and branch step separately. It checks ownership and cleanliness, including ignored files. Branch deletion requires the exact recorded tip. A repeated release proves absence for already-removed resources. Dirty, conflicted, changed, uncertain, or still-needed resources remain for manual inspection. Resolve the blocker, then repeat release; each released checkout frees a slot.

Abort cannot discard retained resources. It becomes available after rejection and release of all candidates and owned checkouts. It also removes an empty refreshed generation that remains clean at its base.

If you removed resources outside Pi Subagent, abort can reconcile their absence. Each retained candidate or staged integration checkout must be unregistered, its path absent, and its branch absent. Workers must also be proved absent through pane and lease checks. Abort then records candidates as rejected and released and completes cleanup. Any present resource blocks abort without changing the request.

### Recovery and state

State version 5 lives privately under:

```text
<agent-dir>/config/pi-subagent/state/<repository-hash>/<request-id>.json
```

Parsing rejects unknown properties, malformed evidence, invalid lineage, and v4 or older state without migration. Preserve old files and recover work manually. Writes are atomic. A productive lease prevents concurrent execution or resumption but permits status inspection and abort.

`delegate_task`, `subagent_resume`, and `subagent_integrate advance` return a durable request ID after saving the wave. Work continues asynchronously. A saved worker attention state sends a follow-up to the launching session, including while siblings run. The wave also reports its final result.

Isolated workers save private exact Pi sessions under their owned process leases. A proved final answer without a changed clean commit requires attention. Missing or mismatched session proof cannot establish completion and never permits prompt replay.

When a finished turn leaves tracked or untracked changes in a valid owned worktree, the runner sends one commit reminder per dispatch try. It saves the reminder before delivery. This uses neither a correction nor a dispatch try. The runner never commits, stages, stashes, or discards. A resulting commit follows normal candidate checks; remaining dirty work requires attention.

`subagent_status` stays read-only and authoritative if delivery fails. Session replacement or shutdown suppresses stale follow-ups and logs the request ID and reason, not prompts or credentials. Synchronous delivery failures report without automatic replay. Pi reports asynchronous `send_message` failures through its runtime.

`subagent_resume` accepts only the reported `retry`, `verify`, or `finalize` continuation. A same-worker correction `retry` permits optional `instruction`: at most 32000 exact characters, with no NUL. The prompt includes this as Main's instruction after the saved failure and saves it before delivery. Other actions reject it.

Without retained candidates, abort terminates exact owned workers and removes only owned checkouts that remain clean and unchanged from their pinned base. Cleanup includes ignored-file checks. Productive execution delays cleanup until it settles. Repeat abort to reconcile pending cleanup without replaying uncertain termination. Dirty or committed work and uncertain allocations remain with blockers. `/subagent recover` includes aborted requests with retained resources.

### Recover after interruption

After a coordinator interruption, run `/subagent recover` one time. It gets the repository productive lease before it changes any interrupted `pending` or `running` state. It preserves unreadable state files and retained candidates. It reports blockers and existing continuations to Main. It does not replay prompts, merges, promotion, or cleanup.

If another productive run holds the lease, the command only reads status and reports the live owner. Wait. Do not take over. You can safely run the command again.

Main uses `subagent_status` for exact identities. Main uses the recovery tools in the interface table above for deliberate decisions. The command never stages or promotes. Direct Herdr tab recovery stays in `/subagent`.

### Close and delete isolated worktrees

Open `/subagent`, select an isolated request, then select **Close and delete worktrees (discard work)**. This is a user action, not an agent tool. Without interactive UI, `/subagent` only reports requests.

The read-only review groups resources by worker attempt or integration generation. It shows each recorded checkout path, branch, tip, commits ahead of the recorded base, dirty state, ignored entries, and Herdr resources. Text attempts do not save their base; their commit count is shown as unknown. The review also includes owned branches with no checkout. If a complete resource group does not fit, the report gives the number of groups not shown. Those groups are not removed.

One confirmation permits permanent deletion of committed, uncommitted, and ignored content in the listed checkouts. It also permits closure of the listed Herdr tabs and workspaces. Cancel makes no change. The command uses the existing abort termination and host cleanup paths before forced checkout removal. It deletes a branch only at its reviewed tip. It saves each completed cleanup step.

Each resource is checked again before removal. A live productive lease or local job blocks the action. Uncertain allocations, changed branch tips, locked or redirected checkouts, and other Herdr panes inside a checkout block that resource. Initialized submodules and index flags that hide clean-state evidence also require separate inspection. If Herdr cannot be inspected, checkouts stay in place.

Main cannot run inside a checkout selected for deletion. A session change stops further removal. Only this request's recorded `pi-subagent/subagent-<name>-<24hex>` branches, saved legacy `pi-subagent/subagent-<24hex>` branches, and their exact primary `.worktrees/` paths can be removed. The primary checkout is never removed.

To close and delete many requests, select **Select multiple…** in `/subagent`, select the requests, then select **Continue** and **Close and delete worktrees (discard work)**. The command shows the review of each request. Then one confirmation covers the unblocked resource groups of all of them. The same menu can close all owned workers of each selected direct workflow that can close. The command reports the number of selected rows that the action skipped.

The report lists removed, skipped, and failed resources. After complete cleanup, the request is `aborted`, candidates are `released`, and integration generations are superseded with completed cleanup. Partial cleanup remains visible as retained work. Reopen the request to review the remaining resources. Abort, prune, and release keep their existing preservation rules.

### Subagent Collection

Subagent Collection closes only verified completed worker tabs. It keeps saved sessions, process leases, worktrees, candidates, and recovery records. It never closes a workspace or its root tab.

Automatic collection checks each relevant workspace after direct `delegate_task` launches, after direct or isolated workflows finish, and when Main settles. More than 10 tabs in that workspace triggers collection. Ten is a trigger, not a maximum. Collection can close all eligible tabs, even after the count falls below 10. User tabs count toward the trigger but are never collection targets. There is no timer: changes from other clients wait for the next check.

Direct collection uses exact records on the current Pi session branch, in the current checkout and Herdr workspace. It requires the recorded final session turn. If the exact agent remains, it must be idle or done. Active local tasks, continued sessions, unverified allocations, and uncertain identities stay open. Pane absence and two empty process-lease scans must pass before an empty tab can close. Saved conversations remain available for `continueFrom`.

Isolated collection uses saved requests in the current checkout. It requires saved termination proof, then verifies agent and pane absence and two empty process-lease scans again. A live productive lease blocks collection. **Ready candidates keep their live workers because Main can still request a revision.** Workspaces, root tabs, orphaned requests, and requests in other checkouts stay unchanged. Use their existing recovery or cleanup actions.

Every `/subagent prune` call tries collection without the tab-count trigger, including calls while a worktree scan is busy. Collection runs before worktree review and does not require deletion approval. Collection failure does not prevent that review. Worktree and branch deletion still require the existing review and confirmation. `/subagent prune cancel` stops new collection steps; a dispatched close can finish.

### Prune leftover worktrees

Each `/subagent prune` call first runs [Subagent Collection](#subagent-collection), which closes only verified completed worker tabs and keeps their evidence. This separate action has no tab-count requirement and runs even if worktree review fails or has no candidates. It does not grant permission to delete worktrees or branches. A later cancellation does not reopen collected tabs.

Run `/subagent prune` to scan leftover worker and integration checkouts under `.worktrees/`. In interactive mode, the command starts a background scan, shows progress, and returns without waiting. It inspects at most four candidates at once. Candidates that share one checkout, including path aliases, are inspected one at a time. The results stay sorted and include every blocker.

When the scan is ready, the command sends a notification. It does not open a dialog. Run `/subagent prune` again to review that plan. Repeated commands during a scan, review, or cleanup show its status; they do not start another worktree operation. Tab collection remains independent. All selection and confirmation dialogs stay in the foreground, including the review of whole owning requests. After confirmation, cleanup runs in the background. It removes items one at a time and reports removed, skipped, and failed items.

Use `/subagent prune cancel` to cancel a scan, ready plan, or cleanup. Cancellation stops new removal steps. An active step can finish; completed removals are not undone. The final cleanup report includes completed steps and partial removal, such as a removed checkout whose branch was kept. Wait for the active step to finish before starting another scan.

Each operation belongs to its launching session and branch generation. A session or branch change, reload, or shutdown cancels it and clears progress. Old plans, notifications, and reports are not delivered to the new context. Runtime shutdown waits for active background steps to finish, so a replacement runtime cannot inspect the same index at the same time. Plans are not saved across reloads.

Candidate branches have the name `pi-subagent/subagent-<name>-<24hex>`, or the saved legacy name `pi-subagent/subagent-<24hex>`. The command also cleans up such branches that have no checkout. The review starts with the number of removable and blocked items. It groups the items by the exact reason that the command can remove them, or by their exact blockers, and shows each reason once. Under each reason, it shows the readable name, if present, and the first 8 characters of the identity suffix. The command can remove an item only when all of these conditions are true:

- Its branch tip is already in Main's HEAD or in the local `origin` default-branch ref. The command does not fetch.
- Its checkout has no tracked or untracked changes. No merge, rebase, cherry-pick, revert, or bisect is in progress.
- No unfinished isolated request, in any checkout of this repository, records it. An unreadable state file blocks every item that it mentions. An unfinished orphaned request, whose parent checkout was removed, also blocks its items.
- No productive run holds a repository lease.
- No Herdr pane works inside the checkout. If the command cannot inspect Herdr, it refuses every checkout.

After the review, the command shows a selection list. Removable items are selected (`[x]`). Blocked items that the command can still remove are not selected; each one shows its short ID and its blockers. Select a row to change it, or use **Select all** or **Clear**. Select **Continue** to remove the selected removable items, or **Cancel** to make no change. Items with other blockers are not in the list.

You can select these blocked items:

- **An item that one readable unfinished request owns**, orphaned or not. The row shows `delete whole request <id>`. The command does not remove the item alone. It shows the [Close and delete](#close-and-delete-isolated-worktrees) review of the whole owning request. After one confirmation, it closes the request and deletes its unblocked resources, as in `/subagent`. That flow also closes the request's own workers and Herdr panes. When you select items of different requests, one confirmation covers all of them.
- **An unowned item whose blockers are only unique commits, tracked or untracked changes, a Git operation in progress, or initialized submodules.** The row shows `force`. A separate confirmation names each item and its blockers. **This permanently deletes those commits and changes.** Before removal, the command checks the item again. It keeps the item if a new kind of blocker appears. Then it uses `git worktree remove --force` and deletes the branch only at the reviewed tip.

These blockers always keep an item: a productive lease, unreadable state, more than one owner, Main inside the checkout, a locked checkout, a checkout that is not at its owned path or that is detached or on another branch, a missing checkout directory, Herdr that cannot be inspected, and Herdr panes inside an unowned checkout.

When the command removes a checkout, it also deletes the ignored files of the checkout, such as `node_modules` or `dist`. So the command includes a checkout with ignored files only after a second confirmation. That confirmation names each ignored entry, and its approval covers all contents of each named entry.

If a top-level ignored entry is new or changed, the command skips the checkout. If the full list of ignored entries of a checkout does not fit in that dialog, the command excludes the checkout. Remove owned checkouts that are detached or on another branch manually.

The list shows removable items first. The command never cuts a long list silently. The list ends with `+N more not shown`, where `N` counts items, and the command does not remove the items that it did not show in that run. Run `/subagent prune` again to review them.

The command checks each item again immediately before removal and skips an item that changed. It checks ownership, the productive lease, Herdr panes, checkout state, the branch tip, ignored entries, and the launching session. The command deletes a branch only if it still points at the reviewed tip. It does not run automatic request-abort cleanup, because that separate workflow can remove other resources. If an aborted request still shows retained resources, inspect `subagent_status` and repeat `subagent_abort` to reconcile its saved cleanup state.

Without an interactive user interface, the command still collects eligible tabs. It then waits for the worktree scan and reports its results. It never deletes worktrees or branches in this mode.

A non-regular or unreadable state entry can block every item because its resource ownership is unknown. State files never change directly.

### Execution limits

Text tasks permit two dispatch tries. Inspection failures before dispatch require task-level attention without using a try or replacing earlier diagnostics. An interrupted dispatch still uses a try. Verification requires the same passing preliminary checks, judgment, and ownership as candidate retention; readiness and the verified candidate are saved together.

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

An empty `tools` list adds no base tools. Selected extension tools can still activate.

Children run with `--no-extensions`. So a Role must list the extension that registers the provider of its route model. Only declared resources and required internal policy adapters load. `builtin:<name>` entries explicitly load Pi built-in extensions (`builtin:codemode`, `builtin:tool-search`, `builtin:llama.cpp`).

The extension rejects `builtin:mcp` and direct loading of `pi-mcp-adapter`, because they bypass the `mcps` allowlist. Scripts can still call extension tools registered with `codemode` or `deferred` exposure. But the model gets their declarations only when `tools` names them.

To let a Role run `codemode` scripts, list `builtin:codemode` in `extensions`. Also list `codemode` in `tools`. Both are required, because the built-in registers the tool as inactive and the Role tool policy activates it. If `tools` has `codemode` alone, the launch fails with an unavailable tool.

Pi's `codemode.mode` and `codemode.inlineBudget` settings apply in the child without change. So the Role never forces codemode-only operation. MCP configuration never activates `codemode` in a child. Scripts can call only the active tools of the Role, plus `codemode` and `deferred` extension and MCP tools. Inactive base tools such as `bash` stay unreachable.

Every child loads the Role MCP adapter. It also connects the servers that Role extensions register with `pi.registerMcpServer()`, for example the CodeGraph watcher of `pi-codegraph`. These servers keep the exposure that the extension sets, and `mcps` does not gate them, because the Role already trusts the extension.

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

Isolated Herdr Role launches receive the same turn, token, and child-runtime budget metadata as ephemeral launches. Retained workers therefore keep one non-refilling session budget across follow-ups rather than receiving a new request budget.

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

A child that reports `agent_settled.aborted: true` returns a failure result with `stopReason: "aborted"`, even if its process exits with code 0. The executor keeps collected output, usage, and child error text. `aborted: false` does not prove provider success. A parent abort or timeout still rejects with `EphemeralSubagentError`.

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

No cleanup path uses `git clean`, force deletion, hidden fallback to Main, or deletion of unproved work. The one exception is user-confirmed discard: after the user selects **Close and delete worktrees (discard work)** in `/subagent` and confirms, it force-removes the reviewed owned worktrees.
