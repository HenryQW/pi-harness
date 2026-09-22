# `@henryqw/pi-subagent`

Delegate work to configured Pi Roles with one tool. Read-only direct tasks run in Herdr tabs in your current workspace; checked implementation runs in isolated Herdr worktrees. Both return a handle so Main can continue while they work.

![Pi showing six delegated tasks running in parallel](./example.png)

## Install

```bash
pi install npm:@henryqw/pi-task-models
pi install npm:@henryqw/pi-subagent
```

Delegation requires a Herdr-managed Pi session; isolated changeset tasks require Herdr `0.9.0` or newer. Run `/task-models` and configure the `fast`, `balanced`, `frontier`, and `fav` routes you use.

`@henryqw/pi-orchestrator` is retired. Isolated `delegate_task` absorbed that protocol. Remove the old package with `pi remove npm:@henryqw/pi-orchestrator`. Old orchestrator state is not migrated.

Install `pi-mcp-adapter` only when a Role declares an MCP server allowlist:

```bash
pi install npm:pi-mcp-adapter
```

## Choose a mode

Every `delegate_task` call declares its mode. The extension never falls back between modes.

| Mode | Use it for | Checkout behavior |
| --- | --- | --- |
| `direct` | Read-only research, analysis, or review | Opens non-focused Herdr tabs in Main's current workspace. No worktree is created. |
| `isolated` | Any implementation or checked task graph | Runs changesets in owned Herdr worktrees and integrates only exact validated evidence. |

Keep trivial mechanically verifiable work in Main. Keep tightly coupled changes under one owner rather than splitting by file count.

## Direct delegation

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

Only Roles with known read-only tools and no extensions or MCP servers may run direct. Write-capable Roles and direct `changeset` tasks are rejected; use isolated mode for implementation. Parallel tasks run independently; chains replace each literal `{previous}` with the preceding successful answer and stop on failure.

The tool returns a task ID and first Herdr tab after launch, not the answer. The extension observes each worker and sends one result to Main when the workflow finishes. If Main is busy, Pi queues it after the current turn; if idle, it starts a turn. A blocked, stalled, unknown, or truncated result is not reported as success. Session switch or shutdown stops observation and preserves tab identities for recovery. Run `/subagent-direct-recovery` on the session branch to list exact tabs, agents, and Pi session files, including tabs launched after the first.

## Isolated checked graphs

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
      "dependsOn": ["inspect"],
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

`dependsOn` controls scheduling. `contextFrom` may name completed text tasks and preserves the declared order. Changesets require task checks. A graph with a changeset requires final checks. Checks and judgments bind to exact Git identities; candidate drift, Main drift, mutation during validation, ambiguity, or conflicts stop integration and retain evidence.

`delegate_task` and `subagent_resume` return a durable request ID after its state is saved; productive work continues while Main is free. Pi delivers completion or attention as a follow-up message in the launching session. Use `subagent_status` if delivery is missed or you need current state.

Every changeset advances automatically after its worker produces a clean candidate and preliminary checks pass. The runner records durable readiness, rebases and rechecks the exact candidate, runs any declared judgment, integrates it into Main, then terminates the worker and cleans up.

You may queue a bounded same-worker revision while the task is actively working:

```text
/subagent-followup <request-id> <task-id> <instruction>
```

A queued follow-up runs after the current turn settles and must produce a new clean commit that passes preliminary checks again. When no queued revision remains, the checked candidate seals immediately; there is no guaranteed post-completion editing window. Late follow-ups fail visibly.

### Recovery tools

| Surface | Purpose |
| --- | --- |
| `subagent_status` | Read durable state and the exact allowed continuation without replaying work. |
| `subagent_resume` | Perform that explicit `retry`, `verify`, or `finalize` continuation. |
| `subagent_abort` | Terminate exactly owned workers and abort an unfinished request. |

Productive requests have no whole-run wall-clock deadline. Resume does not reset the recorded policy or correction count. Child limits, abort signals, process I/O, status inspection, exact termination, and cleanup retain finite safety bounds.

The extension never pushes, opens a pull request, publishes, deploys, force-cleans recoverable work, or silently falls back to Main.

## Config

pi-subagent owns `~/.pi/agent/config/pi-subagent/config.json`. A missing file silently uses defaults.

| Name | Contract | Default |
| --- | --- | --- |
| `maxSubagents` | Concurrent direct Herdr workers and ephemeral child-process limit; safe integer ≥ 1 | `5` |
| `maxTurns` | Provider-turn limit per child; safe integer ≥ 1 | `50` |
| `maxTokens` | Optional token limit per child; safe integer ≥ 1 | Unlimited |
| `maxCorrections` | Same-worker automatic corrections per isolated request; safe integer ≥ 0 | `1` |
| `timeout.idleMinutes` | Direct worker and ephemeral child idle timeout; positive and within Node's timer range | `10` |
| `timeout.maxMinutes` | Ephemeral child hard runtime; greater than idle and within Node's timer range | `30` |

Limits come only from this global file. Request fields cannot override or replenish them. Existing durable requests keep their recorded policy, while a lower current correction limit can tighten recovery. There is intentionally no whole-run timeout setting.

Malformed or unreadable JSON, unknown keys, and invalid values block delegation with one actionable warning. The file is preserved and never rewritten automatically.

## Roles

Role Markdown lives in `~/.pi/agent/config/pi-subagent/` and requires frontmatter plus a Markdown system prompt.

| Field | Requirement |
| --- | --- |
| `name`, `description` | Required non-empty text without terminal control characters |
| `modelClass` | Optional `fast`, `balanced`, `frontier`, or `fav` default |
| `tools` | Required array of base tool names; `[]` selects none |
| `extensions` | Required array of trusted absolute paths or supported package sources |
| `skills` | Required array of effective Pi Skill names |
| `mcps` | Optional exact MCP server names; omitted or `[]` denies MCP access |
| body | Required system instructions |

Roles describe responsibility and capabilities. They do not choose isolation; each request does. A same-named user Role overrides a built-in Role. The package ships `implementer`, `reviewer`, and `scout`.

Children disable ambient extension and Skill discovery. Only declared resources and required internal policy adapters load. Missing Skills, tools, MCP servers, Roles, or routes fail before productive work starts. Main-only delegation and recovery tools plus `ask_question` are excluded from children.

## Public API

The package root exports the Role loader and launch APIs, the FIFO ephemeral executor, child-worktree helpers, exact review and working-change evidence helpers, checked isolated schemas, runtimes, and runner types.

`createEphemeralSubagentExecutor` accepts global concurrency, turn/token, idle, and hard-runtime policy. Queued time consumes no child timeout. A run resolves resources only after receiving its permit and accepts abort, output, token, and activity callbacks. Output and diagnostics are bounded.

See [Orchestration and package-author API](./docs/orchestration.md) for the detailed contracts and recovery model.

## Safety

Role extensions and MCP servers are trusted executable code, not a sandbox. Select the smallest resource set. Read-only direct Roles cannot write through their declared tools. This is a capability check, not an OS sandbox; external processes and changes to Main's checkout can still make a concurrent read stale.

Durable state is private under `config/pi-subagent/state/`. Malformed or older state is rejected rather than migrated silently. Retained-work reports identify exact resources for deliberate recovery.
