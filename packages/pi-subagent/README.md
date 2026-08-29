# `@henryqw/pi-subagent`

Delegate bounded work to isolated Pi child processes. Main plans and orchestrates; generic `delegate_task` selects one flat single, parallel, or chain mode. Package-owned `delegate_flow` runs a fixed Git implementation-and-verification Flow. Package authors can reuse the same Role launch policy and active-Pi executor from JavaScript.

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

All three delegation tools use Pi's built-in renderer. Its tool-execution block shows live updates and Pi's configured expansion hint; expanding shows the call and result content.

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

`model` is `provider/modelId` and overrides `modelClass`. Main populates `model` and `thinking` only for an explicit user override; otherwise it chooses only `modelClass`—`fast` normally, or `balanced` upfront for obviously complex work. This is Main policy only: the runtime records no provenance and does not enforce it. `modelClass` is `fast`, `balanced`, `frontier`, or `fav`; omission uses pi-subagent's local `pi-subagent/delegateTask` Model Task declaration (default `fast`), which shared config can explicitly override. `background` applies to the entire selected mode and is never a per-delegation field.

Parallel mode starts entries concurrently, waits for every entry, and reports them in input order. Chain mode is sequential and fail-fast; every literal `{previous}` receives only the immediately preceding successful assistant output. Foreground failures throw after retaining bounded sibling and recovery evidence. One tool call has one aggregate 50 KiB Main-visible transport cap, not 50 KiB per child.

Background workflows are session-scoped. Session shutdown or reload aborts them and may deliver only recoverable-work evidence or no follow-up message.

The transient status widget renders one line per child with: status glyph, role, task summary, activity (thinking… or active tool with elapsed time and path basename), and metrics (completed turns, started tools, model, thinking level, tokens, total duration). Rows are ordered active-first (working items first, stable insertion order for the rest). A hard six-physical-line maximum applies: when total items are six or fewer, all child rows render; above six, five child rows plus one status-aware overflow line render (`… N more · X working · Y complete · Z failed · W stopped`). Terminal rows clear on the next real user input; active rows persist until the child settles. It is separate from Pi's built-in tool-execution block.

Each delegation resolves its own Role, resources, route, and optional worktree request. When available, `isolation: worktree` gives each entry a deterministic separate worktree; non-Git or unborn-`HEAD` contexts may use Main's cwd. Siblings and chain steps never implicitly share one created worktree.

See [Orchestration, isolation, and the public API](./docs/orchestration.md) for generic delegation, Flow behavior, and JavaScript composition examples.

### `delegate_flow`

Use Flow only for independent, commuting Git changes. It accepts 1–8 uniquely identified units, each with a bounded task, optional `modelClass`, direct command/argument validation gate, and optional non-empty `review` judgment criterion:

```text
delegate_flow({ units: [{ id, task, modelClass?, validation: [{ command, args }], review? }] })
delegate_flow_continue({ guidance, modelClass? })
```

Objective verification is authoritative. Flow always inspects committed Git state and runs declared validation. A unit without `review` skips review evidence and Reviewer launch, then fast-forwards its exact validated tip through the existing guarded `git merge --ff-only` path. Add `review` only for an explicit judgment that automation cannot establish; that unit retains the exact `{base, tip, patchPath}` protocol and requires exact `PASS` before the same integration path.

One memory-only Flow may be active. At start it resolves/freezes the effective `implementer` Role, including a same-named user override, and resolves/freezes the effective `reviewer` only if at least one requested unit has `review`. Omitted `modelClass` uses pi-subagent's local `pi-subagent/delegateTask` declaration (default `fast`); a selected class resolves through its shared profile model-and-thinking route for the unit's Implementer and, when applicable, Reviewer. It creates one Unit Worktree per unit, runs Implementers in parallel, then processes settled results in declared order. It removes the worktree and branch non-forcibly after integration; a refusal is a completion warning with the retained worktree path and/or branch.

A rebase that drops all unit commits is a no-op: Flow validates it, skips Reviewer and merge, then cleans up ordinarily. Implementer, validation, or review blocks can be repaired once through `delegate_flow_continue` in the same worktree. Omitted continuation `modelClass` retains the blocked unit's current class; a supplied class replaces it for that one repair. Rebase and infrastructure failures are terminal. A reported fast-forward failure completes with its diagnostic as a warning only when Git left Main clean at the exact integrated tip; otherwise it is terminal and retains the affected worktree. Flow has no graph, saved recovery, automatic retry, aggregate review, or post-merge gate.

`delegate_task` remains generic with its ordinary isolation behavior. Flow uses the package-shipped Implementer by default and the package-shipped Reviewer only when a unit requests review; same-named user Roles remain supported overrides.

### Delegate UI summary

| Aspect | Behavior |
| --- | --- |
| Tool-execution block | Pi's built-in renderer: live updates and expandable call/result content |
| Widget rows | One line per child: glyph, role, task, activity, metrics |
| Ordering | Active-first stable (working first, then insertion order) |
| Line cap | 6 physical lines max (≤6 items: all child rows; >6 items: 5 rows + 1 status-aware overflow) |
| Terminal retention | Active rows persist; terminal rows clear on next user input |

## Config

pi-subagent owns the extension-named config directory `~/.pi/agent/config/pi-subagent/`, which holds two kinds of user-owned configuration: one Markdown file per Role (see [Roles](#roles)) and its own optional JSON file below. Model routing is *not* configured here; children resolve routes through the shared `@henryqw/pi-task-models` config at `~/.pi/agent/config/pi-task-models.json`, which stores only explicit task overrides. The local `pi-subagent/delegateTask` declaration supplies the omitted-class default.

`~/.pi/agent/config/pi-subagent/pi-subagent.json` controls the ephemeral child pool and execution budgets. All fields are optional; a missing file uses defaults.

| Field | Required | Possible values | Default |
| --- | --- | --- | --- |
| `maxSubagents` | No | Safe integer ≥ 1 | `5` |
| `maxTurns` | No | Safe integer ≥ 1 | `50` |
| `timeout.idleMinutes` | No | Positive number of minutes where minutes × 60 000 ms ≤ 2,147,483,647 | `10` |
| `timeout.maxMinutes` | No | Positive number within the same ms cap that must be greater than `timeout.idleMinutes`, otherwise the whole `timeout` object falls back to defaults | `30` |

Excess children wait FIFO without consuming child timeout. A terminal response on turn 50 succeeds; an attempted continuation starts no model work and rejects with `turn_limit`. Before a continuing turn, the child receives the execution-budget warning once when completed turns reach 80% and once when elapsed time reaches 80% of the maximum runtime; thresholds first reached together produce one combined warning. `PI_SUBAGENT_MAX_SUBAGENTS` overrides `maxSubagents` for the session (positive integer; an invalid value prevents the extension from loading, leaving `delegate_task` unavailable).

This JSON is read leniently: malformed JSON, a non-object root, unknown keys, or invalid values are collected into one warning and the affected settings fall back to defaults; the file is never rewritten.

### Role frontmatter

Each Role `.md` file in the same directory accepts these frontmatter fields:

| Field | Required | Possible values | Default |
| --- | --- | --- | --- |
| `name` | Yes | Non-empty text; unique across roles | — |
| `description` | Yes | Non-empty text | — |
| `tools` | Yes | YAML array of non-empty tool names | `[]` activates no base built-ins; trusted extension tools and caller additions still activate |
| `isolation` | No | `worktree` | None |
| `extensions` | Yes | YAML array of absolute paths, `~/…`, `file://`, or package sources (`npm:`, `git:`, `github:`, `https?:`, `ssh:`) | `[]` selects no Role extension bundle |
| `skills` | Yes | YAML array of non-empty Skill names | `[]` selects no separately named Role Skills; trusted extension Skills still load |
| body | Yes | System-prompt Markdown after the frontmatter | — |

An unreadable or invalid Role file fails role loading fast; duplicate role names are rejected.

## Roles

The package ships two working built-in Roles, always available without any configuration:

- `implementer`: focused edits requesting worktree isolation; commits completed scoped changes locally and never pushes or opens PRs without authorization
- `reviewer`: read-only correctness review of supplied plans/files, or—only when a Flow unit declares `review`—of Flow's exact `{base, tip, patchPath}` packet in its Unit Worktree; never edits or commits

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

The bundled [`pi-subagent-delegated-development`](./skills/pi-subagent-delegated-development/SKILL.md) Skill is Main-side planner/orchestrator policy only. `delegate_flow` owns its fixed Git mechanics and validation authority; the Skill adds no runtime code, configuration, or Role installation. Generic orchestration remains outside the executor under [ADR 001](./docs/adr/001-composable-ephemeral-execution.md).

A Role explicitly owns base tools, extensions, named Skills, instructions, and optional `isolation: worktree`. Every launch installs its Role tool policy: `tools: []` activates no base built-ins, while trusted selected extension tools and explicit caller tool additions still activate. `skills: []` selects no separately named Role Skills, while trusted selected extension Skills still load; `extensions: []` selects no Role extension bundle. Ambient extension and Skill discovery is disabled in children. Selecting an extension explicitly is selecting a trusted atomic capability bundle, not just a provider path: every tool it registers and every Skill supplied through its Pi package metadata or dynamic `resources_discover` loads alongside separately named Role Skills. This is intentional because an extension may depend on its own tools, Skills, lifecycle, and prompt behavior; loading it permits that executable behavior and is not sandboxing. To scope a child, select fewer trusted extensions. Finer-grained selection requires separate extension entry points/configuration or an upstream split—pi-subagent does not infer or externally narrow undocumented dependencies. Parent-only recursive orchestration tools stay excluded. Explicit Role or caller tool names are verified against the child’s final filtered active registry after provider extensions finish `session_start`; all unavailable names fail before the first model turn with provider-extension guidance, while unavailable named Skills warn and skip.

## Library API

The package root exports Role loading and launch resolution, `createEphemeralSubagentExecutor`, worktree helpers, and generic managed Herdr lifecycle helpers. The ephemeral executor is for code already running inside active Pi; it does not provide standalone Node.js Pi discovery or launch support. It defaults to a 50-turn hard cap and rejects attempted continuation with `turn_limit` while preserving accumulated usage and bounded output. After Pi itself exits, it drains inherited stdout/stderr normally but destroys streams still held by escaped descendants after a short inactivity deadline or one-second hard deadline, so they cannot retain a pool permit.

Use [`docs/orchestration.md`](./docs/orchestration.md#public-role-and-executor-api) for exact API behavior and a post-permit `prepare` example using `resolveRoleLaunch` with a caller-owned Model Task declaration against the latest Pi context.
