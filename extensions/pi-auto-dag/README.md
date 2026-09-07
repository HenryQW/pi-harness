# `@henryqw/pi-auto-dag`

Run checked, dependent Pi tasks serially in one Git workspace. Auto DAG persists progress outside the repository for deliberate recovery.

## Install

Install and activate the required task-model companion with Auto DAG:

```bash
pi install npm:@henryqw/pi-task-models
pi install npm:@henryqw/pi-auto-dag
```

Start a new Pi session after installation. Run `/task-models` and configure usable `fast` and `balanced` routes before the first request.

## Works with

| Package | Relationship | Purpose |
| --- | --- | --- |
| [`@henryqw/pi-subagent`](https://pi.henry.wang/extensions/pi-subagent) | Required | Provides Roles and bounded child execution. |
| [`@henryqw/pi-task-models`](https://pi.henry.wang/extensions/pi-task-models) | Required | Routes each task's `fast` or `balanced` model class. |

## Use

Use Auto DAG for non-trivial work with dependent tasks and explicit checks. Run small requests directly in Main.

| Surface | Type | Purpose |
| --- | --- | --- |
| `auto_dag_execute` | tool | Validates and starts one new durable request. |
| `auto_dag_status` | tool | Reads state and reports workspace drift. |
| `auto_dag_resume` | tool | Retries, replaces, verifies, finalizes, or approves unfinished work. |
| `auto_dag_abort` | tool | Stops active work or marks inactive work for attention. |

`auto_dag_execute` requires:

- a clean Git workspace without submodules;
- one or more tasks in supplied order;
- explicit Role names from `@henryqw/pi-subagent`;
- a `fast` or `balanced` model class for every launch;
- at least one direct `{command, args}` check per task;
- at least one final direct check;
- a single total elapsed budget; and
- an explicit choice about worker commits.

```json
{
  "id": "update-parser",
  "goal": "Ship the checked parser update.",
  "commitsAllowed": false,
  "budgetMs": 1800000,
  "tasks": [
    {
      "id": "implement-parser",
      "role": "implementer",
      "modelClass": "balanced",
      "requirements": "Update the parser and its focused tests.",
      "deliverable": "The parser accepts the new valid form and rejects invalid forms.",
      "dependsOn": [],
      "checks": [
        { "command": "pnpm", "args": ["test", "--", "parser"] }
      ]
    }
  ],
  "finalChecks": [
    { "command": "pnpm", "args": ["test"] }
  ]
}
```

Commands run directly. Auto DAG does not pass them through a shell.

### Acceptance

Worker text never proves completion. A task completes only when its checks pass on an identified workspace state.

The identity includes staging changes and non-ignored untracked files. A successful manual verification replaces stale worker output with an explicit manual-verification summary.

Add `judgment` only when direct checks cannot decide a clear criterion:

```json
{
  "criterion": "The public error explains the caller's next action.",
  "role": "reviewer",
  "modelClass": "balanced"
}
```

Without that object, Auto DAG does not launch a Reviewer. A review must leave the workspace unchanged and return exactly `PASS`.

After all tasks, Auto DAG runs `finalChecks` against the combined workspace. A failed final check leaves the request unaccepted.

An optional `finalJudgment` uses the same shape. An unverifiable judgment remains explicit until Main reruns verification or approves the unchanged checked state.

## Flow

Auto DAG accepts only evidence from the checked workspace. It persists each important transition before continuing.

```mermaid
flowchart TD
    A[Validate request and workspace] --> B[Select next serial eligible task]
    B --> C[Launch pi-subagent Role child]
    C --> D[Run direct task checks]
    D --> E{Explicit judgment?}
    E -- Yes --> F[Run read-only Reviewer]
    E -- No --> G[Persist task result]
    F --> G
    G --> H{Retry needed and available?}
    H -- Yes --> B
    H -- No --> I[Run final checks and optional judgment]
    I --> J[Accept unchanged checked workspace]
```

## State and storage

Auto DAG owns generated state under:

```text
~/.pi/agent/config/pi-auto-dag/state/<workspace-root-sha256>/<request-id>.json
```

The actual prefix follows Pi's active agent directory. The canonical workspace root hash separates repositories, and the request ID separates runs.

State never lives in the Git workspace, so Auto DAG's own writes cannot cause workspace drift. Only Auto DAG writes this directory.

Deleting one request file discards its recovery record. Delete it only when that run no longer matters.

## Limits and recovery

Auto DAG rejects repositories containing Git submodules because workspace identity does not cover dirty submodule contents. Remove the submodules or use another workflow.

A normalized `auto_dag_execute` request may use at most 262144 UTF-8 bytes. Durable state may use at most 2 MiB. Reduce request text, task count, command arguments, or captured failure evidence when a bound fails.

Auto DAG stores only `pending`, `running`, `completed`, and `needs_attention` lifecycle states. Interrupted `running` work becomes `needs_attention` and never replays automatically.

Each task gets at most two launched worker attempts. A correction receives the original task, direct dependency outputs, prior failure evidence, and current workspace identity.

Use `auto_dag_resume` with one deliberate action:

- `retry` retries an unfinished task when an attempt remains.
- `replace` replaces one unfinished task definition when an attempt remains.
- `verify` checks work that Main repaired manually.
- `finalize` reruns final verification after every task completes.
- `approve_final_judgment` approves only the unchanged final checked state.

The total elapsed budget continues across retries and resumes. Usage and manual interventions also accumulate in durable state.

Auto DAG never stashes, resets, or discards workspace changes. It does not create worktrees, run tasks in parallel, push, or open pull requests.
