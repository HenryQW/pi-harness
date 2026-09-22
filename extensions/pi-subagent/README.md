# `@henryqw/pi-subagent`

Delegate work to configured Pi Roles with one tool. Use direct mode for compact work in the current checkout. Use isolated mode for durable checked task graphs in Herdr worktrees.

![Pi showing six delegated tasks running in parallel](./example.png)

## Install

```bash
pi install npm:@henryqw/pi-task-models
pi install npm:@henryqw/pi-subagent
```

Isolated changeset tasks require Herdr `0.9.0` or newer. Run `/task-models` and configure the `fast`, `balanced`, `frontier`, and `fav` routes you use.

Install `pi-mcp-adapter` only when a Role declares an MCP server allowlist:

```bash
pi install npm:pi-mcp-adapter
```

## Choose a mode

Every `delegate_task` call declares its mode. The extension never falls back between modes.

| Mode | Use it for | Checkout behavior |
| --- | --- | --- |
| `direct` | Bounded research, analysis, review, or tightly coupled implementation | Runs in Main's current checkout. Changes remain uncommitted. |
| `isolated` | Independently implementable checked changes, exploratory candidates, or work that must not disturb Main | Runs each changeset in an owned Herdr worktree and integrates only exact accepted evidence. |

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

A checked implementation:

```json
{
  "mode": "direct",
  "role": "implementer",
  "name": "Fix token refresh",
  "task": "Fix the localized refresh regression. Leave the change uncommitted.",
  "kind": "changeset",
  "checks": [
    { "command": "pnpm", "args": ["test", "--", "refresh"] }
  ],
  "judgment": {
    "role": "reviewer",
    "modelClass": "balanced",
    "criterion": "The exact working snapshot fixes refresh without widening scope."
  }
}
```

Direct mode selects exactly one shape:

```text
Single:   { mode: "direct", role, name, task, ... }
Parallel: { mode: "direct", tasks: [{ role, name, task, ... }], background? }
Chain:    { mode: "direct", chain: [{ role, name, task, ... }], background? }
```

Each entry defaults to `kind: "text"`. A `changeset` requires at least one exact command/argv check. Optional judgment receives private evidence for the exact working snapshot and must return `PASS`.

Parallel entries report in input order. Writer-capable entries are serialized because they share Main's checkout. Chains replace each literal `{previous}` with only the preceding successful assistant output and stop on failure.

Background mode is available only for Roles proven read-only from their declared resources. It belongs to the launching session; shutdown aborts unfinished work. Direct text tasks fail if they mutate the checkout. Checked direct work rejects pre-existing or drifting evidence instead of changing the real index, committing, stashing, resetting, or cleaning files.

## Isolated checked graphs

An isolated request has one durable ID, one goal, and 1–8 typed tasks:

```json
{
  "mode": "isolated",
  "id": "refresh-repair",
  "goal": "Repair token refresh with exact checked evidence.",
  "approval": "scoped",
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

`approval: "scoped"` is the default. It records acceptance of the exact preliminary checked candidate and continues automatically. Use `"supervised"` only when the user requested an explicit checkpoint:

```text
/subagent-followup <request-id> <task-id> <instruction>
/subagent-accept <request-id> <task-id>
```

The same worker is retained for follow-up or the one configured correction. Acceptance is invalidated whenever the candidate changes.

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
| `maxSubagents` | Active child-process limit; safe integer ≥ 1 | `5` |
| `maxTurns` | Provider-turn limit per child; safe integer ≥ 1 | `50` |
| `maxTokens` | Optional token limit per child; safe integer ≥ 1 | Unlimited |
| `maxCorrections` | Same-worker automatic corrections per isolated request; safe integer ≥ 0 | `1` |
| `timeout.idleMinutes` | Child idle timeout; positive and within Node's timer range | `10` |
| `timeout.maxMinutes` | Child hard runtime; greater than idle and within Node's timer range | `30` |

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

Role extensions and MCP servers are trusted executable code, not a sandbox. Select the smallest resource set. The checkout coordinator reduces races among Pi-owned calls but cannot control unrelated external processes.

Durable state is private under `config/pi-subagent/state/`. Malformed or older state is rejected rather than migrated silently. Retained-work reports identify exact resources for deliberate recovery.
