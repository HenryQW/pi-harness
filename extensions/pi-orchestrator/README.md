# `@henryqw/pi-orchestrator`

Run durable, checked local implementation graphs from Pi Main. Independent tasks run in parallel. Dependencies run in later waves.

This package is the sole owner of that checked protocol. `delegate_task` remains lightweight generic delegation.

## Install

Settle every unfinished Auto DAG run before upgrading. Old Auto DAG state is inert. Pi Orchestrator does not read or migrate it.

The repository installer installs all selected packages first. When Pi Orchestrator was selected, it then removes only the exact `npm:@henryqw/pi-auto-dag` source if present. A missing source needs no action.

Install the Main-side packages:

```bash
pi install npm:@henryqw/pi-task-models
pi install npm:@henryqw/pi-subagent
pi install npm:@henryqw/pi-orchestrator
```

### Requirements

- Use a clean Git worktree on an attached branch with a committed `HEAD`. Task worktrees may contain ignored dependency and index artifacts created by Role tooling.
- Use Herdr `0.9.0` or newer, with protocol version 22 or newer. Run `herdr --version` to verify the installed version.
- Configure Pi task-model profiles for every requested model class. Run `/task-models` to verify the profiles.
- Use `@henryqw/pi-subagent` 17 or newer for Role launch, execution, worktrees, and exact judgment evidence.
- Changeset workers wait until the new worktree workspace pane list is stable, then create a dedicated worker tab. They never use the workspace root pane.
- Herdr labels each workspace as `<request-id>/<task-id>#<attempt>` and its worker tab as `<role>/<model-class>`.

## Works with

| Package | Relationship | Purpose |
| --- | --- | --- |
| [`@henryqw/pi-subagent`](https://pi.henry.wang/extensions/pi-subagent) | Required | Provides Role launch, execution, worktrees, and exact review evidence. |
| [`@henryqw/pi-task-models`](https://pi.henry.wang/extensions/pi-task-models) | Required | Provides configured profiles for every requested model class. |

## Use

Call `orchestrate_execute` with a bounded request. It runs the graph through checked integration in the local repository.

| Surface | Type | Purpose |
| --- | --- | --- |
| `orchestrate_execute` | tool | Start one durable checked task graph. |
| `orchestrate_status` | tool | Read one request and report workspace drift. |
| `orchestrate_resume` | tool | Retry, verify, or finalize an unfinished request. |
| `orchestrate_abort` | tool | Stop workers and abort an unfinished request. |
| `pi-orchestrator` | skill | Guide Main to choose generic delegation or checked orchestration. |

Use `delegate_task` for lightweight generic delegation. Use `orchestrate_*` when implementation needs durable state, checks, dependencies, integration, or recovery.

### Roles

Pi Orchestrator reuses the effective Roles named by each task and judgment. Keep one set of Role files in `config/pi-subagent/`. You do not need orchestrator-specific copies.

Pi Subagent resolves each Role's model, tools, extensions, Skills, and MCP policy. The orchestrator resolves each Role during preflight and again at launch.

Herdr starts each changeset agent with its task's exact Role launch. It rejects a mismatched Role or any caller Role environment.

Judgment launches use the declared judgment Role without adding arguments, environment, or resources. Configure judgment Roles with read-only tools.

### Start a request

```json
{
  "id": "repair-auth",
  "goal": "Repair sign-in and prove the release is ready.",
  "budgetMs": 1800000,
  "tasks": [
    {
      "id": "auth-runtime",
      "kind": "changeset",
      "role": "implementer",
      "modelClass": "balanced",
      "requirements": "Fix the sign-in failure without changing unrelated session behavior.",
      "deliverable": "A focused committed runtime fix.",
      "dependsOn": [],
      "contextFrom": [],
      "checks": [
        { "command": "pnpm", "args": ["test", "--filter", "auth"] }
      ]
    }
  ],
  "finalChecks": [
    { "command": "pnpm", "args": ["typecheck"] }
  ]
}
```

Use `kind: "text"` for bounded analysis or synthesis. Text tasks omit `checks` and `judgment`. A later task lists their IDs in `contextFrom` to receive the exact outputs in that order.

## Flow

The graph runs ready tasks in waves. Independent tasks run in parallel. Dependencies run in later waves.

The architecture diagram shows both execution channels. Text returns to durable state. Changesets continue through isolated Herdr work, checks, optional judgment, and Main integration.

![Architecture showing text and changeset tasks using task-selected Roles before checked Main integration](./docs/orchestration-architecture.svg)

### Execution and review

A request accepts one to eight tasks. Every task needs an explicit kind, Role, and model class. Changeset tasks also need direct checks.

`dependsOn` creates order-only edges. `contextFrom` adds ordered text-task output as task data. Both edge types control readiness and participate in cycle checks.

Ready text tasks use bounded ephemeral execution. Ready changeset tasks use separate worktrees and visible Herdr workers. Identity checks ignore Git-ignored artifacts, such as dependencies installed by `pi-deps` and indexes created by Herdr plugins. They still reject tracked changes, non-ignored untracked files, hidden index entries, gitlinks, and branch or commit drift.

Preliminary validation uses checks only while the worker remains available. A settled implementation block or unchanged failed check can trigger one same-agent correction.

The worker then stops. The orchestrator rebases the candidate and reruns every task check directly, without a shell.

Add `judgment` only for a criterion that checks cannot decide. Its selected Role runs after the rebase with exact private patch evidence. Configure that Role with read-only tools. Its final response is mandatory. Zero findings must return exactly `PASS`; blank or other output fails.

## API

The package root exports its strict request and state schemas, runner contracts, checked Git runtime, Herdr host runtime, and composition helpers. The Pi entry point is `extensions/orchestrator.ts`.

## State and storage

State lives under `~/.pi/agent/config/pi-orchestrator/state/`, namespaced by repository and request ID. Do not edit state files.

Each task and judgment names one effective Role and model class. Durable state never stores a Role prompt or prompt-file path.

Pi Subagent resolves each Role's configured launch. A resolution failure during preflight or immediately before launch blocks productive work.

Pi needs a file to keep a multiline Role prompt out of process arguments. The orchestrator creates a private temporary file only at the final launch boundary. It removes the file after Herdr reports readiness or after the judgment exits.

Task goals, requirements, upstream text, checks, corrections, and judgment packets remain task messages. They never become Role instructions.

Each saved check result keeps its exact command, arguments, exit code, killed status, and Git identity. Successful batches save no output. A failed batch saves bounded output only for its first failed or killed command. If only Git identity drift fails the batch, the final command keeps bounded output. Cancellation, timeout, output overflow, spawn failure, and malformed UTF-8 interrupt the operation instead of becoming synthetic command evidence.

Runtime diagnostics and possible-resource evidence are bounded before each save. Oversized state files are rejected and left unchanged.

## Limits and recovery

### Recovery actions

Use `orchestrate_status` after interruption or when a request needs attention. Then choose one reported action:

- `retry` continues pre-dispatch recovery or sends one eligible correction to the same agent. It never replaces a prompted agent. A text-task retry runs only its selected ready task when others need attention.
- `verify` checks retained task work before integration or finishes pending cleanup.
- `finalize` reruns the final gate when Main still matches the recorded identity.

`orchestrate_abort` terminates owned workers and records an aborted request. It does not claim uncertain cleanup succeeded.

The current state schema rejects older state versions. It does not migrate them or delete prompt files that another process may still use.

### Scope

Pi Orchestrator stops after checked integration in the local repository. It does not push, open or manage pull requests, run swarms, or support old protocols and state.

It does not use outboxes, delivery hosts, receipts, or broad transport machinery.
