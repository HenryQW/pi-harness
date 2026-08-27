# `@henryqw/pi-subagent`

Delegate bounded work to isolated Pi child processes. Generic `delegate_task` selects one flat single, parallel, or chain mode. Package-owned `delegate_flow` runs a fixed Git implementation-and-review Flow. Package authors can reuse the same Role launch policy and active-Pi executor from JavaScript.

## Why

- **Created for**: Pi users who need to delegate bounded work to isolated child Pi processes without losing Main's context.
- **Advantage**: Generic bounded delegation plus a deterministic package-owned Git Flow, with reusable Role launch policies for package authors.

## Install

```bash
pi install npm:@henryqw/pi-task-models
pi install npm:@henryqw/pi-multi-codex
pi install npm:@henryqw/pi-subagent
```

## With

| Package | Why |
| --- | --- |
| `@henryqw/pi-task-models` | Required shared `fast` / `balanced` / `frontier` / `fav` routes. |
| `@henryqw/pi-multi-codex` | Required so children can use Main's active Codex slot. |

## Use

| Surface | Type | Purpose |
| --- | --- | --- |
| `delegate_task` | tool | Generic bounded delegation in one single, parallel, or chain mode. |
| `delegate_flow` | tool | Package-owned parallel implementation and declared-order Git integration for 1–8 independent units. |
| `delegate_flow_continue` | tool | Repair the blocked Flow unit once in its existing worktree. |

### `delegate_task`

Select exactly one shape:

```text
// Single
{ role, task, model?, modelClass?, thinking?, background? }

// Parallel: 1–8 independent delegations
{ tasks: [{ role, task, model?, modelClass?, thinking? }], background? }

// Chain: 1–8 dependent delegations
{ chain: [{ role, task, model?, modelClass?, thinking? }], background? }
```

`model` is `provider/modelId` and overrides `modelClass`. `modelClass` is `fast`, `balanced`, `frontier`, or `fav`; omission uses the shared `pi-subagent/delegateTask` assignment. `background` applies to the entire selected mode and is never a per-delegation field.

Parallel mode starts entries concurrently, waits for every entry, and reports them in input order. Chain mode is sequential and fail-fast; every literal `{previous}` receives only the immediately preceding successful assistant output. Foreground failures throw after retaining bounded sibling and recovery evidence. One tool call has one aggregate 50 KiB Main-visible transport cap, not 50 KiB per child.

Background workflows are session-scoped. Session shutdown or reload aborts them and may deliver only recoverable-work evidence or no follow-up message.

Each delegation resolves its own Role, resources, route, and optional worktree request. When available, `isolation: worktree` gives each entry a deterministic separate worktree; non-Git or unborn-`HEAD` contexts may use Main's cwd. Siblings and chain steps never implicitly share one created worktree.

See [Orchestration, isolation, and the public API](./docs/orchestration.md) for generic delegation, Flow behavior, and JavaScript composition examples.

### `delegate_flow`

Use Flow only for independent, commuting Git changes. It accepts 1–8 uniquely identified units, each with a bounded task and direct command/argument validation gate:

```text
delegate_flow({ units: [{ id, task, validation: [{ command, args }] }] })
delegate_flow_continue({ guidance })
```

One memory-only Flow may be active. It creates one Unit Worktree per unit, runs package-shipped Implementers in parallel, then processes settled results in declared order. For each unit, Flow rebases onto the current Flow Main when needed, runs its declared validation, gives a read-only package-shipped Reviewer the exact `{base, tip, patchPath}` packet in that same worktree, and only exact `PASS` permits `git merge --ff-only` of the full reviewed OID. It removes the worktree and branch non-forcibly after integration; a refusal is a completion warning with the retained worktree path and/or branch.

A rebase that drops all unit commits is a no-op: Flow validates it, skips Reviewer and merge, then cleans up ordinarily. Implementer, validation, or review blocks can be repaired once through `delegate_flow_continue` in the same worktree. Rebase and infrastructure failures are terminal. A reported fast-forward failure completes with its diagnostic as a warning only when Git left Main clean at the exact reviewed tip; otherwise it is terminal and retains the affected worktree. Flow has no graph, saved recovery, automatic retry, aggregate review, or post-merge gate.

`delegate_task` is unchanged: it remains generic and can use user Roles and its ordinary isolation behavior. Flow always uses the package-shipped Implementer and Reviewer Roles, so user Role overrides do not affect it.

## Config

pi-subagent owns the extension-named config directory `~/.pi/agent/config/pi-subagent/`, which holds two kinds of user-owned configuration: one Markdown file per Role (see [Roles](#roles)) and its own optional JSON file below. Model routing is *not* configured here; children resolve routes through the shared `@henryqw/pi-task-models` config at `~/.pi/agent/config/pi-task-models.json`.

`~/.pi/agent/config/pi-subagent/pi-subagent.json` controls the ephemeral child pool and timeouts. All fields are optional; a missing file uses defaults.

| Field | Required | Possible values | Default |
| --- | --- | --- | --- |
| `maxSubagents` | No | Safe integer ≥ 1 | `5` |
| `timeout.idleMinutes` | No | Positive number of minutes where minutes × 60 000 ms ≤ 2,147,483,647 | `10` |
| `timeout.maxMinutes` | No | Positive number within the same ms cap that must be greater than `timeout.idleMinutes`, otherwise the whole `timeout` object falls back to defaults | `30` |

Excess children wait FIFO without consuming child timeout. `PI_SUBAGENT_MAX_SUBAGENTS` overrides `maxSubagents` for the session (positive integer; an invalid value prevents the extension from loading, leaving `delegate_task` unavailable).

This JSON is read leniently: malformed JSON, a non-object root, unknown keys, or invalid values are collected into one warning and the affected settings fall back to defaults; the file is never rewritten.

### Role frontmatter

Each Role `.md` file in the same directory accepts these frontmatter fields:

| Field | Required | Possible values | Default |
| --- | --- | --- | --- |
| `name` | Yes | Non-empty text; unique across roles | — |
| `description` | Yes | Non-empty text | — |
| `tools` | No | Array or comma-separated string of tool names | Omitted: caller tools win, else Pi defaults apply |
| `isolation` | No | `worktree` | None |
| `extensions` | No | Absolute paths, `~/…`, `file://`, or package sources (`npm:`, `git:`, `github:`, `https?:`, `ssh:`) | None |
| `skills` | No | Array or comma-separated string of skill names | None; unavailable names warn and skip |
| body | Yes | System-prompt Markdown after the frontmatter | — |

An unreadable or invalid Role file fails role loading fast; duplicate role names are rejected.

## Roles

The package ships two working built-in Roles, always available without any configuration:

- `implementer`: focused edits requesting worktree isolation; commits completed scoped changes locally and never pushes or opens PRs without authorization
- `reviewer`: read-only correctness review of supplied plans/files, or of Flow's exact `{base, tip, patchPath}` packet in its Unit Worktree; never edits or commits

A same-named Markdown file in `~/.pi/agent/config/pi-subagent/` explicitly overrides the built-in default.

The repository also includes optional inert samples:

- [`scout`](./examples/roles/scout.md): read-only discovery
- [`synthesizer`](./examples/roles/synthesizer.md): reconcile supplied reports

Copy them manually from your installed `@henryqw/pi-subagent` package (npm installs ship the `examples/roles/` directory) if you want them as a starting point:

```bash
mkdir -p ~/.pi/agent/config/pi-subagent
cp <package-install-dir>/examples/roles/scout.md ~/.pi/agent/config/pi-subagent/
```

Locate the install directory with `npm root` inside your project, or via Pi's package installation path.

The package never installs or writes Role configuration. Sample names are not built-ins; after copying, edit or replace them as your own Roles.

## Skill

The bundled [`pi-subagent-delegated-development`](./skills/pi-subagent-delegated-development/SKILL.md) Skill is Main-side policy only. `delegate_flow` owns its fixed Git mechanics; the Skill adds no runtime code, configuration, or Role installation. Generic orchestration remains outside the executor under [ADR 001](./docs/adr/001-composable-ephemeral-execution.md).

A Role owns its base tools, extensions, named Skills, instructions, and optional `isolation: worktree`. Ambient extension and Skill discovery is disabled in children. With neither Role tools nor caller tools, Pi defaults remain; caller tools with omitted Role tools snapshot Main's effective active built-ins and install the child policy. Loaded Role/caller extension tools still activate, parent-only tools stay excluded, and unavailable named Skills warn and skip.

## Library API

The package root exports Role loading and launch resolution, `createEphemeralSubagentExecutor`, worktree helpers, and generic managed Herdr lifecycle helpers. The ephemeral executor is for code already running inside active Pi; it does not provide standalone Node.js Pi discovery or launch support.

Use [`docs/orchestration.md`](./docs/orchestration.md#public-role-and-executor-api) for exact API behavior and a post-permit `prepare` example using `resolveRoleLaunch` against the latest Pi context.
