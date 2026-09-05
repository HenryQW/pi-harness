# `@henryqw/pi-subagent`

Delegate bounded work from Main to isolated Pi Roles, or run independent implementation units through a fixed Git Flow. One Role system covers focused research, review, implementation, parallel work, and ordered chains without loading every detail into Main.

![Pi showing six delegated tasks running in parallel](./example.png)
![Delegate Flow lifecycle](./docs/delegate-flow.svg)

## Install

```bash
pi install npm:@henryqw/pi-task-models
pi install npm:@henryqw/pi-subagent
```

Run `/task-models` and configure the `fast` profile before delegating.

## Works with

**Required.** [`@henryqw/pi-task-models`](https://pi.henry.wang/extensions/pi-task-models) supplies `fast`, `balanced`, `frontier`, and `fav` model routes.

Routes come from `~/.pi/agent/config/pi-task-models/config.json`. It stores explicit task overrides. Missing shared model config warns once because delegation needs a route.

## Use

Start with one read-only delegation:

```json
{
  "role": "scout",
  "name": "Map sign-in flow",
  "task": "Trace the sign-in request from entry point to session creation. Report the relevant files and unresolved risks. Do not edit files."
}
```

A separate child returns a bounded report to Main. It creates no saved Pi session and makes model requests through the selected route.

| Surface | Type | Purpose |
| --- | --- | --- |
| `delegate_task` | tool | Run one bounded task, independent tasks in parallel, or dependent tasks in a chain. |
| `delegate_flow` | tool | Implement and integrate 1–8 independent Git units. |
| `delegate_flow_continue` | tool | Repair the one blocked Flow unit once. |
| `pi-subagent-delegated-development` | skill | Guide Main's planning and orchestration. |

Pi's built-in tool block shows each call and result.

Select exactly one `delegate_task` shape:

```text
// Single
{ role, name, task, model?, modelClass?, background? }

// Parallel: 1–8 independent tasks
{ tasks: [{ role, name, task, model?, modelClass? }], background? }

// Chain: 1–8 dependent tasks
{ chain: [{ role, name, task, model?, modelClass? }], background? }
```

Main supplies each `name`. It must be a short description, about five words and fewer than 30 characters. Names cannot contain C0/C1 control characters such as newlines or terminal escapes. `role` and an explicit `model` also reject those controls.

`modelClass` selects `fast`, `balanced`, `frontier`, or `fav`. An explicit call class wins over a Role class. Without either, the configured task assignment or declared default applies. The route sets the model and exact thinking level.

An explicit `model` (`provider/modelId`) replaces only the route model and must support that thinking level. `background` applies to the whole selected mode, never one entry.

Parallel tasks start together, settle together, and report in input order. Chains are sequential and fail at the first failure. `{previous}` passes only the immediately preceding successful assistant output.

Foreground failures throw after keeping bounded sibling and recovery evidence. One call has one aggregate 50 KiB cap for Main-visible text. Live updates show task names and statuses without opaque IDs. Final results show summaries first and full evidence below.

Background work belongs to its launching session. Shutdown or reload aborts it and may leave only recoverable-work evidence or no follow-up message.

Each entry resolves its own Role, resources, route, and optional isolation. A Role with `isolation: worktree` gets a separate deterministic worktree when available. Non-Git and unborn-`HEAD` contexts can use Main's directory. Other setup failures, including unsafe submodule layouts, reject instead of falling back. Siblings and chain steps never share a created worktree.

See the [orchestration guide](./docs/orchestration.md) for full delegation, transport, isolation, and UI behavior.

### Skills

The bundled [`pi-subagent-delegated-development`](./skills/pi-subagent-delegated-development/SKILL.md) Skill guides Main's planning and orchestration. It adds no runtime code, config, or Role installation. `delegate_flow` owns its Git mechanics and validation authority.

## Flow

Flow requires a clean Main worktree on an attached branch with a committed `HEAD`. Use it only for independent Git changes that can merge in any order. Do not split units that overlap files, APIs, schemas, generated output, package metadata, lockfiles, or invariants.

```text
delegate_flow({ units: [{ id, name, task, modelClass?, validation: [{ command, args }], review? }] })
delegate_flow_continue({ guidance, modelClass? })
```

A Flow has 1–8 units with unique non-empty IDs and allows one active Flow. It freezes the effective Implementer at start. It freezes the Reviewer only when a unit requests `review`.

- Each unit gets one worktree. Implementers run in parallel. Flow handles units in declared order.
- Flow runs each declared command with its arguments. That validation is authoritative for objective checks.
- Without `review`, Flow fast-forwards the exact validated tip.
- With `review`, the Reviewer receives the exact `{base, tip, patchPath}` packet and must return exactly `PASS` before the same integration path. Use `review` only for stated judgment that validation cannot decide.

An explicit unit `modelClass` overrides both frozen Roles. Without one, each Role uses its own `modelClass`, configured `pi-subagent/delegateTask` assignment, or declared default.

One `delegate_flow_continue` can repair an Implementer, validation, or review block in the same worktree. Omitting its class keeps the unit's explicit class and frozen Role defaults. Supplying one replaces both Role defaults for that repair and its later Reviewer launch.

A second block is terminal. Rebase and infrastructure failures are terminal.

Flow has no dependency graph, saved recovery, automatic retry, aggregate review, or post-merge validation.

## Config

pi-subagent owns `~/.pi/agent/config/pi-subagent/config.json`. It is optional. A missing file uses these defaults without a warning.

| Field | Valid value | Default |
| --- | --- | --- |
| `maxSubagents` | Safe integer ≥ 1 | `5` |
| `maxTurns` | Safe integer ≥ 1 | `50` |
| `timeout.idleMinutes` | Positive minutes; minutes × 60,000 ≤ 2,147,483,647 ms | `10` |
| `timeout.maxMinutes` | Positive minutes greater than `idleMinutes`; minutes × 60,000 ≤ 2,147,483,647 ms | `30` |

Excess children wait FIFO without using a child timeout. A terminal response on turn 50 succeeds. An attempted continuation rejects with `turn_limit`.

Malformed or unreadable JSON, a non-object root, unknown keys, and invalid values produce one warning. Invalid settings use defaults while valid settings still apply. If the effective maximum is not greater than the idle timeout, both timeout settings use defaults. The file is never rewritten.

`PI_SUBAGENT_MAX_SUBAGENTS` overrides `maxSubagents` for the session. It must be a positive integer. An invalid value prevents the extension from loading, so `delegate_task` is unavailable.

### Roles

Role Markdown files live beside the config file. They require frontmatter and a Markdown system prompt body.

| Field | Requirement |
| --- | --- |
| `name` | Required unique, non-empty text without C0/C1 controls. |
| `description` | Required non-empty text without C0/C1 controls. |
| `modelClass` | Optional; `fast`, `balanced`, `frontier`, or `fav`. |
| `tools` | Required YAML array of non-empty tool names. `[]` selects no base built-ins. |
| `isolation` | Optional; only `worktree`. |
| `extensions` | Required YAML array. Entries are absolute paths, `~/…`, `file://`, or `npm:`, `git:`, `github:`, `https?:`, or `ssh:` sources. |
| `skills` | Required YAML array of non-empty Skill names. |
| body | Required Markdown system prompt after the frontmatter. |

A Role's `modelClass` is a default. A call-level or Flow-unit class wins.

An unreadable or invalid Role fails loading fast. Duplicate Role names are rejected. A same-named user file overrides a built-in Role.

The package always provides these built-in Roles. Their files leave `modelClass` unset, so they use the configured `pi-subagent/delegateTask` assignment or declared default unless a call or Flow unit overrides it:

| Role | Purpose | Isolation/use |
| --- | --- | --- |
| `implementer` | Make and validate one focused change. | Requests a worktree; commits scoped work locally. Never pushes or opens a PR without permission. |
| `reviewer` | Review supplied plans or files for correctness. | Read-only. For Flow review, reads the exact packet in the Unit Worktree; never edits or commits. |
| `scout` | Map code and evidence for one bounded task. | Read-only and generic `delegate_task` only; never changes files. |

Flow uses the effective Implementer and, only when requested, Reviewer. The Scout is not part of Flow.

## API

The package root exports `loadRoles`, `resolveRoleSkills`, `resolveRoleLaunch`, `createRoleLaunch`, `createEphemeralSubagentExecutor`, and worktree helpers.

The executor works only inside the active Pi process. It does not discover or start a standalone Node.js Pi installation.

`finalizeChildWorktree` returns the breaking `WorktreePayload` lifecycle union. `pruned` proves zero commits, a clean tree, and removed worktree and branch. `retained` contains measured `commits` and `dirty` values. `recovery` has an actionable `note` and only completed measurements. An omitted recovery measurement is unknown.

See the [public Role and executor API](./docs/orchestration.md#public-role-and-executor-api) for contracts and a `prepare` example. Pass `modelClass` to `resolveRoleLaunch` to override a Role default.

## State and storage

Flow state is memory-only.

## Data, cost, and privacy

A Role selects base tools, extensions, named Skills, instructions, and optional worktree isolation. Named Skills resolve from Main's effective Pi registry. Unavailable names warn and skip.

Children disable ambient extension and Skill discovery. `tools: []` adds no base tools, but selected extension tools and caller tools still activate. `extensions: []` adds no Role extension bundle. `skills: []` adds no separately named Role Skills, but selected extension Skills still load.

An explicitly selected extension is trusted, not sandboxed. Its tools, Skills, and executable behavior load together. Select fewer trusted extensions to reduce scope. pi-subagent does not guess or remove undocumented dependencies.

Parent-only delegation tools and `ask_question` are always excluded. Requested Role or caller tool names are checked after provider loading. Unavailable tools fail before the first model turn.

## Limits and recovery

Flow never force-deletes recoverable work. Failed or uncertain units, and cleanup refusals after integration, retain their worktree path or branch for recovery.

See [Flow mechanics and recovery](./docs/orchestration.md#delegate_flow) for retained-work recovery.
