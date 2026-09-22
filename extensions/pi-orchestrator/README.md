# `@henryqw/pi-orchestrator`

Run durable, checked local implementation graphs from Pi Main. Independent tasks run in parallel. Dependencies run in later waves.

This package is the sole owner of that checked protocol. `delegate_task` remains lightweight generic delegation.

Runs have no elapsed-time deadline. Workers can continue through long implementations and follow-ups without a 30-minute cutoff. Cancel explicitly when work should stop.

## Install

Before upgrading, finish or explicitly abort unfinished requests with their matching package: 5.x for schema v3, or 6.x for schema v4. Version 7 removes `budgetMs` from requests and reads schema v5 only. It preserves rejected state and owned work, so do not delete state files or worker worktrees to recover them.

Settle every unfinished Auto DAG run before upgrading. Old Auto DAG state is inert. Pi Orchestrator does not read or migrate it.

Restart Pi after updating so the loaded coordinator uses the new contract. Updating package files alone does not replace an already loaded runtime.

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
- Use `@henryqw/pi-subagent` 18.1 or newer for Role launch, execution, worktrees, and exact judgment evidence.
- Changeset workers wait until the new worktree workspace pane list is stable, then create a dedicated worker tab. They never use the workspace root pane.
- Herdr gives each workspace a short opaque six-character token label and labels its worker tab as `<role>/<model-class>`.
- While workspaces are active, Pi's widget area lists each workspace label, task status, compact Role/model badge, and task ID. A row disappears after that workspace is cleaned up. Non-TUI tool results include the same active-workspace rows as plain text.

The widget combines the Role initial and model profile code in one badge. For example, `[I1] 8f3a2c · working · implement-api` is an implementer using the fast profile. Custom Roles use their uppercase first character, so Roles with the same initial share a code.

| Position | Code | Meaning |
| --- | --- | --- |
| Role | `I` | `implementer` |
| Role | `R` | `reviewer` |
| Role | `S` | `scout` |
| Role | `<initial>` | Uppercase first character of any custom Role |
| Profile | `1` | `fast` |
| Profile | `2` | `balanced` |
| Profile | `3` | `frontier` |
| Profile | `*` | `fav` |

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
| `orchestrate_status` | tool | Read durable recovery state and report Main drift without mutation. |
| `orchestrate_resume` | tool | Deliberately retry, verify, or finalize an unfinished request. |
| `orchestrate_abort` | tool | Explicitly terminate owned workers and abort an unfinished request. |
| `/orchestrate-followup <request-id> <task-id> <message>` | command | Optionally queue a revision while the active task is still working. |
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

Every changeset advances automatically after its agent produces a clean candidate and preliminary checks pass. The orchestrator records durable readiness, rebases and rechecks the exact candidate, runs any declared judgment, integrates it into Main, then terminates the worker and cleans up.

You may queue a bounded same-agent revision while the task is actively working. A task accepts at most 32 worker prompts and queues at most 16 follow-ups at once:

```text
/orchestrate-followup repair-auth auth-runtime Keep the error copy but simplify the control flow.
```

A queued follow-up runs after the current turn settles and must produce a new clean commit that passes preliminary checks again. When no queued revision remains, the checked candidate seals immediately; there is no guaranteed post-completion editing window. Late follow-ups fail visibly. After sealing, use the reported recovery workflow for retained failed work, or start a new bounded request after the current run settles.

Expiry, cancellation, ambiguity, failed checks or judgment, and Main drift retain the owned worker and fail closed. Automatic progression does not expand permission boundaries: the package still stops after checked local integration and never publishes, deploys, pushes, or opens a pull request.

## Flow

The graph runs ready tasks in waves. Independent tasks run in parallel. Dependencies run in later waves.

The architecture diagram shows both execution channels. Text returns to durable state. Changesets continue through isolated Herdr work, checks, optional judgment, and Main integration.

![Architecture showing text and changeset tasks using task-selected Roles before checked Main integration](./docs/orchestration-architecture.svg)

### Execution and review

A request accepts one to eight tasks. Every task needs an explicit kind, Role, and model class. Changeset tasks also need direct checks.

`dependsOn` creates order-only edges. `contextFrom` adds ordered text-task output as task data. Both edge types control readiness and participate in cycle checks.

Ready text tasks use bounded ephemeral execution. Ready changeset tasks use separate worktrees and visible Herdr workers. Identity checks ignore Git-ignored artifacts, such as dependencies installed by `pi-deps` and indexes created by Herdr plugins. They still reject tracked changes, non-ignored untracked files, hidden index entries, gitlinks, and branch or commit drift.

Preliminary validation uses checks only while the worker remains available. A settled implementation block or unchanged failed check can trigger one same-agent correction.

After each successful preliminary check batch, the orchestrator drains any follow-up already queued for the same live worker. Each revision must produce a new clean commit and reruns preliminary checks. When the queue is empty, it atomically seals the candidate and persists exact readiness evidence without waiting for input.

The worker remains live while the orchestrator records each exact rebase, reruns every task check directly without a shell, runs any judgment, and integrates the candidate into Main. If Main moves during that sequence, the orchestrator records and checks another exact rebase. After exact integration is durably recorded, it terminates that worker and then cleans up its resources. Independent ready tasks still dispatch in parallel waves, and changesets integrate in declared request order after their wave settles.

Add `judgment` only for a criterion that checks cannot decide. Its selected Role runs after the rebase with exact private patch evidence while the task worker remains live. Configure the judgment Role with read-only tools. Its final response is mandatory. Zero findings must return exactly `PASS`; blank or other output fails.

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

Execute and resume have no whole-run timer or request budget field. Task checks also have no elapsed-time cutoff; hung checks require cancellation. Text tasks and judgments retain their 10-minute idle timeout and turn limit, but no maximum elapsed runtime. Direct `delegate_task` settings are separate and unchanged.

Git inspection, Herdr startup/acknowledgment and individual polling calls, status inspection, and safety termination remain bounded. A worker prompt is sent once; after acknowledgment the coordinator observes it through bounded lifecycle calls until a candidate, failure or cancellation. It does not resend a prompt because work takes a long time. Interrupting the coordinator retains worker resources; use `orchestrate_abort` to terminate them.

### Recovery actions

Use `orchestrate_status` after interruption or when a request needs attention. Status is read-only: it does not reconcile, terminate, replay, or clean up workers. It reports an exact continuation only when saved evidence proves that action safe, including an eligible failed text-task retry. Applying that continuation still requires a deliberate `orchestrate_resume` call. Otherwise inspect the retained worker or abort explicitly.

A resume has no elapsed-time deadline. It preserves resources when reconciliation, checks, review, integration, or termination remain uncertain. Choose one reported action:

- `retry` continues pre-dispatch recovery or sends one eligible correction to the same agent. It never replaces a prompted agent. A text-task retry runs only its selected ready task when others need attention.
- `verify` checks exact retained task work, records readiness for a precisely retained preliminarily checked candidate, continues a ready rebase or integration, reconciles post-integration termination, or finishes pending cleanup.
- `finalize` reruns the final gate when Main still matches the recorded identity.

`orchestrate_abort` terminates owned workers and records an aborted request. It does not claim uncertain cleanup succeeded.

State schema v5 rejects v4 and all older state without modifying files or cleaning resources. To recover an unfinished request, use its matching package to finish or explicitly abort it before upgrading: 6.x for v4, or 5.x for v3. Never edit version fields or delete state or worker worktrees as a migration shortcut.

### Scope

Pi Orchestrator stops after checked integration in the local repository. It does not push, open or manage pull requests, run swarms, or support old protocols and state.

It does not use outboxes, delivery hosts, receipts, or broad transport machinery.
