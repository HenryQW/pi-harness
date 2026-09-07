# `@henryqw/pi-auto-dag`

Run checked, dependent Pi tasks in one Git workspace.

Auto DAG uses one child at a time. It keeps durable state under `.context/pi-auto-dag/`.

## Install

```bash
pi install npm:@henryqw/pi-auto-dag
```

The package needs Git and an active Pi session. Configure task-model routes with `/task-models` before use.

## When to use it

Use Auto DAG for non-trivial work with dependent tasks and explicit checks.

Run small requests directly in Main. Auto DAG adds persistence and child launches that trivial work does not need.

## Tools

| Tool | Purpose |
| --- | --- |
| `auto_dag_execute` | Validate and start one new durable request. |
| `auto_dag_status` | Read state and report workspace drift. |
| `auto_dag_resume` | Deliberately retry, replace, verify, finalize, or approve unfinished work. |
| `auto_dag_abort` | Stop active work or mark inactive work for attention. |

`auto_dag_execute` requires:

- a clean Git workspace;
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

## Acceptance

Worker text never proves completion. A task completes only when its declared checks pass on an identified workspace state. This identity includes staging changes and non-ignored untracked files.

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

An optional `finalJudgment` uses the same shape. An unverifiable judgment stays explicit until Main reruns final verification or deliberately approves the unchanged checked state.

## Recovery and limits

Auto DAG stores only `pending`, `running`, `completed`, and `needs_attention` lifecycle states.

Interrupted `running` work becomes `needs_attention`. Auto DAG never replays it automatically.

Each task gets at most two launched worker attempts. A correction receives the original task, direct dependency outputs, prior failure evidence, and current workspace identity.

Use `auto_dag_resume` with one deliberate action:

- `retry` retries an unfinished task when an attempt remains.
- `replace` replaces one unfinished task definition when an attempt remains.
- `verify` checks work that Main repaired manually.
- `finalize` reruns final verification after every task completes.
- `approve_final_judgment` records approval only for the unchanged final checked state.

The total elapsed budget continues across retries and resumes. Usage and manual interventions also accumulate in durable state.

Auto DAG never stashes, resets, or discards workspace changes. It does not create worktrees, run tasks in parallel, push, or open pull requests.
