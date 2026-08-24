# `@henryqw/pi-auto-dag`

Execute an exact Delivery Graph with Pi and Herdr: one hash-bound confirmation, dependency-aware workers, and exactly one PR.

## Why

- **Created for**: Executing an approved Delivery Graph of dependent tasks through a single entry point.
- **Advantage**: One exact graph in, one PR out — with every command visibly confirmed once before any process starts.

## Install

```bash
pi install npm:@henryqw/pi-auto-dag
```

Needs a POSIX host. Windows fails before execution.

Declare the orchestrator extension only; the worker extension ships internally and is injected into workers automatically.

```json
{
  "packages": [{
    "source": "npm:@henryqw/pi-auto-dag",
    "autoload": false,
    "extensions": ["extensions/auto-dag.ts"]
  }]
}
```

Workers run through user-owned `@henryqw/pi-subagent` Roles with package-fixed implementer and reviewer Roles. Subagent resolves Role Skills, tools, extensions, shared task-model route, Pi arguments, and managed Herdr lifecycle. Auto DAG adds its internal `extensions/worker.ts` with graph protocol tools and owns graph state, prompts, gates, receipts, and execution decisions.

## Use

| Surface | Type | Purpose |
| --- | --- | --- |
| `auto_dag_execute` | tool | Sole execution entry. Takes the exact `{graph}`, shows one hash-bound TUI confirmation rendering every escaped exact command and its Roles, then executes through PR creation. |
| `auto_dag_status` / `auto_dag_resume` | tools | Inspect or resume the active durable run. |
| `auto_dag_retry_gate` / `auto_dag_resolve` | tools | Recover a blocked gate or task through an explicit decision. |
| `auto_dag_abort` | tool | Abort the active run while retaining evidence. |

## Config

`~/.pi/agent/config/pi-auto-dag.json`

```json
{
  "version": 5,
  "max_parallel_tasks": 5,
  "max_review_rounds": 5,
  "required_gate_timeout_ms": 1800000
}
```

The file is optional. When present, `version` is required and must be `5`; the other values are optional positive integers. `required_gate_timeout_ms` cannot exceed `2147483647`; timeout exits `124`.

## Delivery Graph

Pass the exact graph object to `auto_dag_execute`. It is immutable for the duration of the run.

- Top-level fields are exactly `id`, `goal`, `constraints`, `non_goals`, `issues`, and `final_check`. No `status` field.
- Implementation issue fields are exactly `id`, `title`, `objective`, `acceptance`, `testing`, and `depends_on`.
- `final_check` has only `acceptance` and `testing`.
- IDs are lowercase hyphenated names; `final-check` is reserved.
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

## Workflow

1. The caller normalizes an approved plan into the exact graph and calls `auto_dag_execute`. Planning is externally owned (for example by `/ship`).
2. Auto DAG validates structure, then shows one TUI confirmation bound to the SHA-256 of the exact graph. It display-escapes every exact `testing` command that will later run through `sh -c`, alongside both fixed Roles. Execution never starts without this confirmation.
3. Ready tasks share one Git base at the frozen HEAD. Each gets a child worktree, the fixed implementer Role, one required commit, and the exact `testing` command through `sh -c`. The fixed reviewer Role sees the commit and gate evidence; approval requires system-owned exit code `0`.
4. After each wave passes, commits are cherry-picked by Local Issue ID and the next wave starts. A cherry-pick conflict returns that task to its workers.
5. After every implementation task, Final Check runs on clean integration `HEAD`; product failure repairs through the owning Local Issue.
6. When all gates pass, Auto DAG pushes one branch and opens exactly one PR. Ownership ends there; post-PR sweep and CI status are caller-owned (for example `/ship`).

## Events

Blocked and completed outcomes persist through a durable at-least-once outbox with stable event IDs. Consumers dedupe on event ID; redelivery never changes action, payload, or Git HEAD. Infrastructure-invalid Final Check evidence surfaces as a blocked outcome; only what durable receipts prove incomplete is ever rerun.

## Remove

```bash
pi remove npm:@henryqw/pi-auto-dag
```

## Development

```bash
npm test --workspace @henryqw/pi-auto-dag
npm run typecheck --workspace @henryqw/pi-auto-dag
npm run pack:check --workspace @henryqw/pi-auto-dag
```
