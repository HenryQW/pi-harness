# Orchestration and package-author API

`pi-subagent` separates generic delegation from its execution mechanism:

```text
Role (built-in or user override) + latest Pi registries ── resolveRoleLaunch ──> PiLaunch
                                                        │
caller-owned task, cwd, signal ─────────────────────────┤
                                                        v
                                     active-Pi ephemeral executor
```

`delegate_task` owns its flat single/parallel/chain policy. The public executor runs one prepared delegation. Downstream packages compose their own workflows with ordinary JavaScript and own semantic protocols, shared workspace/state, retry decisions, and bounds. There is no recursive workflow AST.

`delegate_flow` is the exception: it is a fixed package-owned Git workflow, not an executor primitive or general workflow language. It uses package-shipped Roles and the same prepared-child runner; its contract is below.

## Frozen `delegate_task` contract

A call selects exactly one of these shapes. Unknown properties and nested modes are rejected.

### Single

```json
{
  "role": "user-configured-role",
  "task": "One bounded task packet",
  "modelClass": "balanced",
  "thinking": "high",
  "background": false
}
```

Single mode puts one delegation's fields at the top level.

### Parallel

```json
{
  "tasks": [
    { "role": "user-role-a", "task": "Inspect subsystem A", "modelClass": "fast" },
    { "role": "user-role-b", "task": "Inspect subsystem B", "model": "provider/model-id" }
  ],
  "background": false
}
```

`tasks` contains 1–8 independent delegations. All entries start concurrently subject to the shared executor cap, all settle even when a sibling fails, and outcomes remain in input order rather than completion order.

### Chain

```json
{
  "chain": [
    { "role": "user-role-a", "task": "Collect evidence" },
    { "role": "user-role-b", "task": "Review this evidence:\n{previous}" },
    { "role": "user-role-c", "task": "Summarize this review:\n{previous}" }
  ],
  "background": false
}
```

`chain` contains 1–8 sequential delegations. Before an entry starts, every literal `{previous}` in its task is replaced with the immediately preceding successful assistant output; the first entry receives an empty string. Replacement is literal and non-recursive. The chain stops at its first child or infrastructure failure.

### Delegation fields

| Field | Required | Contract |
| --- | --- | --- |
| `role` | yes | Name of a Role in the user's effective `config/pi-subagent` directory or a package-shipped built-in (`implementer`, `reviewer`); a same-named user file overrides the built-in. |
| `task` | yes | Non-empty bounded task packet. |
| `model` | no | Designated `provider/modelId`; takes precedence over `modelClass`. |
| `modelClass` | no | `fast`, `balanced`, `frontier`, or `fav`; omission uses shared task assignment. |
| `thinking` | no | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`; route selection skips models that cannot honor it. |

Those five fields are the complete delegation object. `tasks`, `chain`, and `background` cannot be nested. Route fallback occurs only before launch; a started child is never retried by this package.

### Background, failures, and transport

`background` is top-level policy for the whole selected mode. Foreground blocks until that mode settles. Background returns one acknowledgement and, while its launching session remains active, later delivers the settled workflow outcome; callers cannot background only one entry in an array. Session shutdown or reload aborts unfinished background work, which may deliver only recoverable isolated-work evidence or no follow-up message.

Any foreground entry failure makes the tool call throw. Parallel mode first settles every sibling, while chain mode stops immediately. The thrown failure retains available successful sibling output, failed/rejected entry evidence, and worktree recovery reports so useful work remains locatable.

All Main-visible text for one tool call shares one aggregate 50 KiB UTF-8 transport cap, including child output, sibling failures, and worktree/recovery evidence. Parallel execution does not multiply the cap by its entry count. Truncation is explicit; internal bookkeeping is not made visible by bypassing the cap.

## `delegate_flow`

`delegate_flow({ units })` accepts 1–8 units with unique non-empty `id` and `task` fields plus one or more direct `{command, args}` validation commands. `delegate_flow_continue({ guidance })` is available only for the one blocked unit of the active Flow.

A Flow is memory-only and permits one active Flow. It requires clean committed Git Main and creates every Unit Worktree before launching work; setup failure launches no Implementer. Each unit gets exactly one worktree and one package-shipped Implementer. Implementers run in parallel and all settle. Flow then processes units in declared order:

```text
Implementers (parallel, one Unit Worktree each)
                 │ all settle
                 v
for each declared unit:
  rebase in its Unit Worktree when earlier units advanced Main
  run declared validation in that worktree
  read-only Reviewer receives exact {base, tip, patchPath} there
  exact PASS → git merge --ff-only <full reviewed OID>
  git worktree remove; git branch -d
```

Flow derives identity from Git, not child output. Reviewer reads the exact patch as authoritative and may use the same worktree only for referenced context. A full-OID fast-forward is the only integration path. Cleanup is non-forced; after a successful integration, cleanup refusal returns `completed` with a retained path/branch warning.

If rebase drops all unit commits, `base === tip` is a no-op: Flow validates current state, skips Reviewer and merge, then cleans up ordinarily. Implementer failure, dirty or missing committed work, validation failure, or reviewer findings block the first affected declared unit. `delegate_flow_continue({ guidance })` reruns its package-shipped Implementer in that same worktree once, then repeats derivation, validation, and review with fresh exact evidence. A second block is terminal. A failed rebase is aborted and terminates as an infrastructure failure with Git diagnostics; other infrastructure and fast-forward failures are terminal. Terminal outcomes retain worktrees for Main to reslice. Earlier integrated units are never rolled back.

Flow has no dependency graph, saved state, automatic retry, aggregate review, or post-merge validation. Use it only for commuting changes; combine or sequence units that overlap files, APIs, schemas, generated output, package metadata, lockfiles, or invariants.

`delegate_task` remains generic: its user Role resolution, optional worktree isolation, non-Git behavior, and direct plan/file review are unchanged. Flow loads package-shipped Implementer and Reviewer Roles directly, so user overrides do not apply.

## Per-delegation resources and isolation

For `delegate_task`, every single entry, parallel sibling, and chain step independently:

1. loads its selected Role;
2. resolves its route and named Skills from the latest effective Pi context after receiving an executor permit;
3. creates its Role launch policy; and
4. when the Role requests `isolation: worktree`, creates a worktree identified by the tool call, mode, and input index.

Separate deterministic identities produce separate worktree paths and branches. Parallel siblings cannot collide, and a chain does not base one step's worktree on the preceding step's branch. `{previous}` passes text only. There is no implicit shared worktree or hidden workflow state.

A worktree starts from Main's current `HEAD`. Clean worktrees with no child commits are pruned; committed, dirty, switched, unmeasurable, or otherwise recoverable work is preserved and reported. Non-git directories and repositories with an unborn `HEAD` use Main's working directory. Git submodules reject worktree isolation, and setup failure in a real repository throws rather than silently sharing Main's checkout. This generic fallback remains unchanged: the bundled delegated-development Skill separately refuses to begin without a committed Git `HEAD`.

If steps must share files, make that an explicit caller decision: use an intentionally shared workspace, merge preserved child commits, or pass state through a caller-owned store. Do not rely on chain order to imply filesystem sharing.

## Resource Policy

Every Role launch centrally prepends this child identity contract to its system instructions before the Role prompt: the child is a delegated Pi Subagent, not Main; it executes its assigned Role and task directly; Main-only delegation rules do not apply; recursive delegation is unavailable and it must not seek or invoke delegation tools.

A Role file owns:

- base tools (`tools` omitted does not itself define an allowlist; `tools: []` means extension tools only);
- explicit extension paths or package sources;
- additional effective Pi Skill names;
- system instructions; and
- optional `isolation: worktree` for the tool layer.

At launch, a package caller may add `tools`, `extensions`, and `env`. With an explicit Role tool list, caller tools are unioned into that base list. When Role tools and caller tools are both omitted, no allowlist is installed and Pi defaults remain active. When Role tools are omitted but caller tools are supplied, launch snapshots Main's effective active built-ins, unions the caller tools, and installs that policy. Loaded extension tools activate in every case. Caller `env` adds to or overrides the active Pi process environment for the child.

Children start with ambient extension and Skill discovery disabled. Only explicit Role/caller extensions, explicitly resolved Skill paths, resources supplied by those extension packages, and any required internal tool-policy or Codex adapter load. Loaded extension tools activate even when the Role base list is empty. Child-inappropriate parent tools are always excluded: `delegate_task`, `delegate_flow`, `delegate_flow_continue`, and `ask_question`.

Role Skill names resolve through Main's effective Pi Skill registry at launch. Missing names are returned in `ResolvedRoleLaunch.missingSkills`; `delegate_task` warns and skips them. Library callers must surface that warning themselves. Missing Skills do not block launch.

## Public Role and executor API

The package root exports the following mechanism-level APIs:

| API | Responsibility |
| --- | --- |
| `loadRoles(agentDir?)` | Validate and load package-shipped built-in and user Role Markdown. |
| `resolveRoleSkills(pi, role)` | Resolve Role Skill names from Pi's effective registry. |
| `resolveRoleLaunch(pi, ctx, input)` | Resolve a shared task route and produce `ResolvedRoleLaunch`. |
| `createRoleLaunch(pi, ctx, input)` | Produce the same launch from a caller-supplied resolved route. |
| `createEphemeralSubagentExecutor(options)` | Queue and run one prepared no-session child per `run`. |
| `createChildWorktree` / `finalizeChildWorktree` | Optional caller-managed worktree lifecycle. |

A loaded `Role` contains `name`, `description`, optional `tools` and `isolation`, plus normalized `extensions`, `skills`, and `systemPrompt`. `resolveRoleLaunch` accepts `role`, `taskId`, and optional `agentDir`, `extensions`, `tools`, and `env`. Its result is a `PiLaunch` (`{ env, args }`) plus the selected `model`, `thinkingLevel`, and `missingSkills`.

`createEphemeralSubagentExecutor` requires:

```js
const executorOptions = {
  maxConcurrency: 4,
  timeout: { idleMs: 10 * 60_000, maxMs: 30 * 60_000 },
};
```

Concurrency is FIFO. `run` accepts optional `signal`, `onUpdate(text)`, and `onTokens(number)` callbacks plus required `prepare()`. A queued run receives its permit before `prepare` executes, so resource and route resolution can use the latest Pi state. Queued time does not consume child timeout. `maxConcurrency`, `idleMs`, and `maxMs` must be positive; `maxMs` must exceed `idleMs`.

The executor is **active-Pi-only**. It reuses the currently running Pi invocation and does not locate or support a standalone Node.js Pi installation.

### Prepare after the permit

This JavaScript runs inside a Pi extension. `pi` is that extension's `ExtensionAPI`; it is not a standalone Node entry point.

```js
import {
  createEphemeralSubagentExecutor,
  resolveRoleLaunch,
} from "@henryqw/pi-subagent";

const executor = createEphemeralSubagentExecutor({
  maxConcurrency: 4,
  timeout: { idleMs: 10 * 60_000, maxMs: 30 * 60_000 },
});

let latestCtx;
pi.on("session_start", (_event, ctx) => { latestCtx = ctx; });
pi.on("model_select", (event, ctx) => {
  latestCtx = { ...ctx, model: event.model };
});
pi.on("agent_settled", (_event, ctx) => { latestCtx = ctx; });

function latestContext() {
  if (!latestCtx) throw new Error("Pi session has not started.");
  return latestCtx;
}

async function runRole(role, task, options = {}) {
  const {
    signal,
    cwd,
    extensions = [],
    tools,
    env = {},
  } = options;

  return executor.run({
    signal,
    prepare: async () => {
      // prepare runs only after this delegation owns a FIFO permit.
      const ctx = latestContext();
      const launch = resolveRoleLaunch(pi, ctx, {
        role,
        taskId: "your-package/delegate",
        extensions,
        tools,
        env,
      });
      if (launch.missingSkills.length && ctx.hasUI) {
        ctx.ui.notify(
          `Skipped unavailable Skills: ${launch.missingSkills.join(", ")}`,
          "warning",
        );
      }
      return { launch, task, cwd: cwd ?? ctx.cwd };
    },
  });
}
```

`run` resolves to `EphemeralSubagentResult`. Both outcome variants contain `exitCode`, `output`, `stderr`, and optional `stopReason`, `errorMessage`, and `usage`. A launched child/model failure is a typed `{ outcome: "failure", ... }` result. Abort, timeout, spawn, protocol, preparation, and callback failures reject with `EphemeralSubagentError` and a stable `code`. Assistant `output` and `stderr` are bounded, and `usage` contains aggregate child usage when Pi supplies it.

The low-level executor does not interpret `Role.isolation`, discover resources, compose modes, create shared state, or promote child failure outcomes to tool errors. A direct caller that wants worktrees must call `createChildWorktree` after the permit, choose the returned `cwd`, call `finalizeChildWorktree` on every exit path, and preserve its recovery payload.

Generic managed Herdr exports (`managedSubagentWorkspaceId`, reconciliation helpers, `startManagedSubagent`, prompting/listing, and retirement) consume the same launch policy for durable workers. They intentionally contain no workflow prompts, semantic state, or retry policy.

## JavaScript composition

The examples below use caller-selected `Role` objects and the `runRole` helper above. Variable names such as `reviewRole` are local bindings, not reserved Role names. The executor's `maxConcurrency` bounds launches; callers must also bound collections and loops.

A small caller-owned failure policy keeps the examples readable:

```js
async function successfulOutput(run) {
  const result = await run;
  if (result.outcome === "failure") {
    const error = new Error(
      result.errorMessage || result.stderr || result.output ||
        `Child exited ${result.exitCode}`,
    );
    error.result = result;
    throw error;
  }
  return result.output;
}
```

### Single

```js
const result = await runRole(selectedRole, boundedTask, {
  signal,
  cwd: sharedWorkspace,
});
```

### Bounded parallel

```js
const settled = await Promise.allSettled(
  taskPackets.map((task) =>
    successfulOutput(runRole(selectedRole, task, { signal, cwd: sharedWorkspace }))),
);
// Promise.allSettled preserves taskPackets order; child failure outcomes reject here,
// and the executor caps active children.
```

Unlike the tool's fixed maximum of eight entries, a library caller owns its collection bound. Do not pass an unbounded producer merely because active execution is capped.

### Chain

```js
let previous = "";
for (const step of steps) {
  const task = step.task.replaceAll("{previous}", () => previous);
  previous = await successfulOutput(
    runRole(step.role, task, { signal, cwd: sharedWorkspace }),
  );
}
```

The loop is fail-fast, and only the immediate successful output becomes `previous`.

### Fan-out / fan-in

```js
const reports = await Promise.all(
  partitions.map((packet) =>
    successfulOutput(runRole(analysisRole, packet, { signal, cwd: sharedWorkspace }))),
);

const synthesis = await successfulOutput(runRole(
  synthesisRole,
  `Reconcile these caller-bounded reports:\n${JSON.stringify(reports)}`,
  { signal, cwd: sharedWorkspace },
));
```

The caller chooses report bounds and the fan-in protocol; the executor supplies no hidden aggregation state.

### Bounded review loop

```js
function parseReviewVerdict(text) {
  const value = JSON.parse(text);
  if (
    !value || typeof value !== "object" ||
    typeof value.approved !== "boolean" ||
    !Array.isArray(value.findings) ||
    value.findings.some((finding) => typeof finding !== "string")
  ) {
    throw new Error("Invalid review verdict.");
  }
  return value;
}

const maxReviewRounds = 3;
let findings = [];
let approved = false;

for (let round = 1; round <= maxReviewRounds; round += 1) {
  await successfulOutput(runRole(
    changeRole,
    `Apply round ${round}. Address: ${JSON.stringify(findings)}`,
    { signal, cwd: sharedWorkspace },
  ));

  const review = await successfulOutput(runRole(
    reviewRole,
    'Return JSON only: {"approved":boolean,"findings":string[]}',
    { signal, cwd: sharedWorkspace },
  ));
  ({ approved, findings } = parseReviewVerdict(review));
  if (approved) break;
}

if (!approved) throw new Error(`Review did not pass after ${maxReviewRounds} rounds.`);
```

The verdict schema, parser, round state, shared workspace, and terminal decision all belong to the caller. Add a richer protocol only when the workflow requires one; do not encode it as a recursive package workflow definition.

## Built-in Roles and samples

The package ships two working built-in Roles, validated by the same parser as user roles and always present even with no `config/pi-subagent` directory:

| Built-in | Behavior |
| --- | --- |
| `implementer` | Focused implementation requesting `isolation: worktree`; commits scoped changes locally, never pushes or opens PRs without authorization. Non-Git or unborn-`HEAD` contexts may use Main's cwd. |
| `reviewer` | Read-only correctness review of supplied plans/files, or Flow's exact `{base, tip, patchPath}` packet in its Unit Worktree; never edits or commits. |

A same-named Markdown file in `config/pi-subagent/` explicitly overrides the built-in default.

Additional repository samples are inert starting points, not installed configuration:

| Sample | Intended starting point |
| --- | --- |
| [`scout`](../examples/roles/scout.md) | Read-only code/evidence mapping. |
| [`synthesizer`](../examples/roles/synthesizer.md) | Reconcile supplied reports without broad discovery. |

Copy the package-shipped samples from your installed `@henryqw/pi-subagent` package (npm installs include `examples/roles/`) if you want them:

```bash
mkdir -p ~/.pi/agent/config/pi-subagent
cp <package-install-dir>/examples/roles/scout.md ~/.pi/agent/config/pi-subagent/
```

The package never creates, copies, updates, or removes files in `~/.pi/agent/config/pi-subagent/`. Once copied, the files and their names are entirely user-owned.

The bundled [`pi-subagent-delegated-development`](../skills/pi-subagent-delegated-development/SKILL.md) Skill is Main-side policy only. `delegate_flow` owns its fixed Git mechanics; the Skill defines no runtime code or configuration. `delegate_task` remains the generic flat single/parallel/chain mechanism.

See [ADR 001](./adr/001-composable-ephemeral-execution.md) for the executor boundary and [ADR 002](./adr/002-package-owned-delegate-flow-orchestration.md) for Flow.
