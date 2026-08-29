# `@henryqw/pi-auto-dag` (retired)

Package retired and no longer maintained.

This package is preserved for source history and is no longer an active workspace. There is no replacement.

Remove existing installs with:

```bash
pi remove npm:@henryqw/pi-auto-dag
```

## Historical documentation

> **Historical reference only:** The following pre-retirement documentation is retained for source history. The package is retired; the installation and usage instructions below are not current guidance.

A durable run stores state so it can resume.

Run an exact Delivery Graph with Pi and Herdr. A Delivery Graph is a set of dependent tasks.

It uses one confirmation tied to a hash and creates exactly one PR. Workers respect task dependencies.

### Why

- **Created for**: Execute an approved Delivery Graph of dependent tasks through one entry point.
- **Advantage**: One exact graph goes in. One PR comes out. Every command is visibly confirmed once before any process starts.

### Install

```bash
pi install npm:@henryqw/pi-auto-dag
```

Needs a POSIX host. Windows fails before execution.

Declare only the orchestrator extension. The worker extension ships internally and is injected into workers automatically.

```json
{
  "packages": [{
    "source": "npm:@henryqw/pi-auto-dag",
    "autoload": false,
    "extensions": ["extensions/auto-dag.ts"]
  }]
}
```

Workers use user-owned `@henryqw/pi-subagent` Roles with package-fixed implementer and reviewer Roles.

- Subagent resolves Role Skills, tools, extensions, shared task-model route, Pi arguments, and managed Herdr lifecycle.
- Auto DAG adds its internal `extensions/worker.ts` with graph protocol tools.
- Auto DAG owns graph state, prompts, gates, receipts, and execution decisions.

### Use

| Surface | Type | Purpose |
| --- | --- | --- |
| `auto_dag_execute` | tool | Sole execution entry. Takes the exact `{graph}`, shows one hash-bound TUI confirmation rendering every escaped exact command and its Roles, then executes through PR creation. |
| `auto_dag_status` / `auto_dag_resume` | tools | Inspect or resume the active durable run. |
| `auto_dag_retry_gate` / `auto_dag_resolve` | tools | Recover a blocked gate or task through an explicit decision. |
| `auto_dag_abort` | tool | Abort the active run while retaining evidence. |
| `auto_dag_acknowledge` | tool | Idempotently acknowledge one exact notification `event_id` after durably handling it; delivery is at-least-once and unacknowledged events are redelivered. Releases a settled terminal run once every event is acknowledged. |

### Config

Package-owned: `~/.pi/agent/config/pi-auto-dag.json`

```json
{
  "version": 5,
  "max_parallel_tasks": 5,
  "max_review_rounds": 5,
  "required_gate_timeout_ms": 1800000
}
```

| Field | Required | Possible values | Default (missing file or omitted field) |
| --- | --- | --- | --- |
| `version` | Yes when the file exists | Exactly `5` | `5` when the file is missing |
| `max_parallel_tasks` | No | Positive integer | `5` |
| `max_review_rounds` | No | Positive integer | `5` |
| `required_gate_timeout_ms` | No | Positive integer, at most `2147483647`; timeout exits `124` | `1800000` |

The file is optional. A missing file uses all defaults.

Unknown keys are rejected. Malformed or invalid files fail fast and are never rewritten.

Shared: `~/.pi/agent/config/pi-task-models.json`, owned by `@henryqw/pi-task-models`, assigns profiles to tasks `pi-auto-dag/implement` and `pi-auto-dag/review` for worker routes.

Package-owned generated state: `<project>/.context/pi-auto-dag/`. Do not edit it.

### Delivery Graph

Pass the exact graph object to `auto_dag_execute`. It is immutable for the duration of the run.

- Top-level fields are exactly `id`, `goal`, `constraints`, `non_goals`, `issues`, and `final_check`. There is no `status` field.
- Implementation issue fields are exactly `id`, `title`, `objective`, `acceptance`, `testing`, and `depends_on`.
- `final_check` has only `acceptance` and `testing`.
- IDs are lowercase hyphenated names. `final-check` is reserved.
- Dependencies must be acyclic.

```json
{
  "id": "example-delivery",
  "goal": "Deliver one checked change.",
  "constraints": [],
  "non_goals": [],
  "issues": [
    {
      "id": "implement-change",
      "title": "Implement change",
      "objective": "Make requested behavior observable end to end.",
      "acceptance": ["Caller observes requested behavior."],
      "testing": "npm test",
      "depends_on": []
    }
  ],
  "final_check": {
    "acceptance": ["Integrated verification passes."],
    "testing": "npm ci && npm test && npm run typecheck"
  }
}
```

### Workflow

1. The caller normalizes an approved plan into the exact graph and calls `auto_dag_execute`. Planning belongs outside this package, for example `/ship`.
2. Auto DAG validates the structure. It shows one TUI confirmation tied to the SHA-256 of the exact graph. It display-escapes every exact `testing` command that later runs through `sh -c`, with both fixed Roles. Execution never starts without this confirmation.
3. Ready tasks share one Git base at the frozen HEAD.
   - Each gets a child worktree, the fixed implementer Role, one required commit, and the exact `testing` command through `sh -c`.
   - A fresh fixed reviewer Role receives the commit and gate evidence.
   - It also receives a read-only run-private exact binary patch reference: path, base, commit, size, and SHA-256.
   - The patch body is never in its prompt. Approval requires system-owned exit code `0`.
4. After each wave passes, commits are cherry-picked by Local Issue ID and the next wave starts. A cherry-pick conflict returns that task to its workers.
5. After every implementation task, Final Check runs on clean integration `HEAD`. A product failure repairs through the owning Local Issue.
6. When all gates pass, Auto DAG pushes one branch and opens exactly one PR. Ownership ends there. The caller owns post-PR sweep and CI status, for example `/ship`.

### Events

- Blocked and completed outcomes persist through a durable at-least-once outbox with stable event IDs.
- Consumers dedupe on event ID. Redelivery never changes action, payload, or Git HEAD.
- Infrastructure-invalid Final Check evidence is a blocked outcome. Only work that durable receipts prove incomplete is rerun.
