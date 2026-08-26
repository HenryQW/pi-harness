# `@henryqw/pi-subagent`

Delegate bounded work to isolated Pi child processes. The `delegate_task` tool has one flat contract with exactly one selected mode: single, parallel, or chain. Package authors can reuse the same Role launch policy and active-Pi executor from JavaScript.

## Why

- **Created for**: Pi users who need to delegate bounded work to isolated child Pi processes without losing Main's context.
- **Advantage**: One flat `delegate_task` tool contract with single, parallel, and chain modes, plus reusable Role launch policies for package authors.

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
| `delegate_task` | tool | Delegate bounded work to one or more isolated Pi child processes. |

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

See [Orchestration, isolation, and the public API](./docs/orchestration.md) for the complete contract and JavaScript composition examples.

## Config

`~/.pi/agent/config/pi-subagent/pi-subagent.json` controls the ephemeral child pool and timeouts:

```json
{
  "maxSubagents": 5,
  "timeout": { "idleMinutes": 10, "maxMinutes": 30 }
}
```

Excess children wait FIFO without consuming child timeout. `PI_SUBAGENT_MAX_SUBAGENTS` overrides the configured concurrency for the session.

## Roles

The package ships two working built-in Roles, always available without any configuration:

- `implementer`: focused edits requesting worktree isolation; commits completed scoped changes locally and never pushes or opens PRs without authorization
- `reviewer`: read-only correctness review from a supplied exact patch and referenced files; never edits or commits

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

The bundled [`pi-subagent-delegated-development`](./skills/pi-subagent-delegated-development/SKILL.md) Skill is opinionated orchestration policy for Main. It fails before delegation unless Main's cwd is a Git working tree with a committed `HEAD`; then it requires a clean retained implementer worktree, a verified base/branch/tip committed diff, review of the supplied exact patch plus referenced files, branch-tip re-verification, and merging the reviewed commit itself. Dirty or incomplete work goes to a fresh repair delegation. This leaves the generic `delegate_task` non-Git/unborn-`HEAD` fallback unchanged. All model and agent work stays in Pi via `delegate_task`; deterministic developer tools remain allowed. It is guidance only — it adds no runtime code, config, or Role installation, and preserves the [composition-outside-the-executor](./docs/adr/001-composable-ephemeral-execution.md) boundary.

A Role owns its base tools, extensions, named Skills, instructions, and optional `isolation: worktree`. Ambient extension and Skill discovery is disabled in children. With neither Role tools nor caller tools, Pi defaults remain; caller tools with omitted Role tools snapshot Main's effective active built-ins and install the child policy. Loaded Role/caller extension tools still activate, parent-only tools stay excluded, and unavailable named Skills warn and skip.

## Library API

The package root exports Role loading and launch resolution, `createEphemeralSubagentExecutor`, worktree helpers, and generic managed Herdr lifecycle helpers. The ephemeral executor is for code already running inside active Pi; it does not provide standalone Node.js Pi discovery or launch support.

Use [`docs/orchestration.md`](./docs/orchestration.md#public-role-and-executor-api) for exact API behavior and a post-permit `prepare` example using `resolveRoleLaunch` against the latest Pi context.

## Remove

```bash
pi remove npm:@henryqw/pi-subagent
```

## Development

```bash
npm test --workspace @henryqw/pi-subagent
npm run typecheck --workspace @henryqw/pi-subagent
npm run pack:check --workspace @henryqw/pi-subagent
```
