# Orchestration and package-author API

`pi-subagent` separates generic delegation from its execution mechanism:

```text
Role (built-in or user override) + latest Pi registries ── resolveRoleLaunch ──> PiLaunch
                                                        │
caller-owned Model Task declaration, cwd, signal ────────┤
                                                        v
                                     active-Pi ephemeral executor
```

Main plans and orchestrates. `delegate_task` owns its flat single/parallel/chain policy, while the public executor runs one prepared delegation. Downstream packages compose their own workflows with ordinary JavaScript and own semantic protocols, shared workspace/state, retry decisions, and bounds. There is no recursive workflow AST.

`delegate_flow` is the exception: it is a fixed package-owned Git workflow, not an executor primitive or general workflow language. It uses the effective `implementer` Role and, only for explicit judgment review, the effective `reviewer` Role through the same prepared-child runner; its contract is below.

## Frozen `delegate_task` contract

A call selects exactly one of these shapes. Unknown properties and nested modes are rejected.

### Single

```json
{
  "role": "user-configured-role",
  "name": "Inspect authentication flow",
  "task": "One bounded task packet",
  "modelClass": "balanced",
  "background": false
}
```

Single mode puts one delegation's fields at the top level.

### Parallel

```json
{
  "tasks": [
    { "role": "user-role-a", "name": "Inspect subsystem A", "task": "Inspect subsystem A", "modelClass": "fast" },
    { "role": "user-role-b", "name": "Inspect subsystem B", "task": "Inspect subsystem B", "model": "provider/model-id" }
  ],
  "background": false
}
```

`tasks` contains 1–8 independent delegations. All entries start concurrently subject to the shared executor cap, all settle even when a sibling fails, and outcomes remain in input order rather than completion order.

### Chain

```json
{
  "chain": [
    { "role": "user-role-a", "name": "Collect evidence", "task": "Collect evidence" },
    { "role": "user-role-b", "name": "Review collected evidence", "task": "Review this evidence:\n{previous}" },
    { "role": "user-role-c", "name": "Summarize evidence review", "task": "Summarize this review:\n{previous}" }
  ],
  "background": false
}
```

`chain` contains 1–8 sequential delegations. Before an entry starts, every literal `{previous}` in its task is replaced with the immediately preceding successful assistant output; the first entry receives an empty string. Replacement is literal and non-recursive. The chain stops at its first child or infrastructure failure.

### Delegation fields

| Field | Required | Contract |
| --- | --- | --- |
| `role` | yes | Name of a Role in the user's effective `config/pi-subagent` directory or a package-shipped built-in (`implementer`, `reviewer`, `scout`); a same-named user file overrides the built-in. |
| `name` | yes | Main-supplied short task name: about five words and fewer than 30 characters; C0/C1 control characters are rejected. |
| `task` | yes | Non-empty bounded task packet. |
| `model` | no | Designated `provider/modelId`; replaces only the selected route model and must support that route's thinking level. |
| `modelClass` | no | `fast`, `balanced`, `frontier`, or `fav`; selects the route. Main prioritizes `fast` for straightforward work and `balanced` for complex work. It reserves `frontier` for exceptionally complex or tricky work. Omission uses the selected Role default, then pi-subagent's local Model Task assignment or declared default. |

Those five fields are the complete delegation object. An explicit call `modelClass` wins over the selected Role's optional default. If neither is present, the local Model Task assignment or declared default selects the route. Routes set exact thinking levels. A direct model never changes that level and fails before launch if it cannot support it. `tasks`, `chain`, and `background` cannot be nested. Route fallback occurs only before launch; a started child is never retried by this package.

### Background, failures, and transport

`background` is top-level policy for the whole selected mode. Foreground blocks until that mode settles. Background returns one acknowledgement and, while its launching session remains active, later delivers the settled workflow outcome; callers cannot background only one entry in an array. Session shutdown or reload aborts unfinished background work, which may deliver only recoverable isolated-work evidence or no follow-up message.

Any foreground entry failure makes the tool call throw. Parallel mode first settles every sibling, while chain mode stops immediately. The thrown failure retains available successful sibling output, failed/rejected entry evidence, and worktree recovery reports so useful work remains locatable.

All Main-visible text for one tool call shares one aggregate 50 KiB UTF-8 transport cap, including child output, sibling failures, and worktree/recovery evidence. Parallel execution does not multiply the cap by its entry count. Truncation is explicit; internal bookkeeping is not made visible by bypassing the cap.

## `delegate_flow`

`delegate_flow({ units })` accepts 1–8 units with unique non-empty `id`, a required Main-supplied short `name` (about five words and fewer than 30 characters, without C0/C1 control characters), a non-empty `task`, one or more direct `{command, args}` validation commands, optional `modelClass`, and optional non-empty `review` text. `delegate_flow_continue({ guidance, modelClass? })` is available only for the one blocked unit of the active Flow.

A Flow is memory-only and permits one active Flow. At start it always resolves/freezes the effective `implementer` Role, including a same-named user override. It resolves/freezes the effective `reviewer` only if at least one requested unit declares `review`. An explicit unit class overrides both frozen Roles. Without one, the Implementer and Reviewer each use their own optional Role default; a Role without one uses pi-subagent's local `pi-subagent/delegateTask` assignment or declared `fast` default. The selected class resolves through its existing `pi-task-models` profile model-and-thinking route. It requires clean committed Git Main and creates every Unit Worktree before launching work; setup failure launches no Implementer. Each unit gets exactly one worktree and one Implementer. Implementers run in parallel and all settle. Flow then processes units in declared order:

```text
Implementers (parallel, one Unit Worktree each)
                 │ all settle
                 v
for each declared unit:
  rebase in its Unit Worktree when earlier units advanced Main
  inspect committed state; run declared validation (objective authority)
  ├─ no review: git merge --ff-only <exact validated tip>
  └─ review: Reviewer receives exact {base, tip, patchPath}
             exact PASS → git merge --ff-only <full reviewed OID>
  git worktree remove; git branch -d
```

Flow derives identity from Git, not child output. Add `review` only for an explicit judgment criterion that automated validation cannot establish; it is not a second generic verification pass. The Reviewer reads the exact patch as authoritative and may use the same worktree only for referenced context. A full-OID fast-forward is the only integration path. Cleanup is non-forced; after a successful integration, cleanup refusal returns `completed` with a retained path/branch warning.

If rebase drops all unit commits, `base === tip` is a no-op: Flow validates current state, skips Reviewer and merge, then cleans up ordinarily. Implementer failure, dirty or missing committed work, validation failure, or reviewer findings block the first affected declared unit. `delegate_flow_continue({ guidance, modelClass? })` reruns the Flow's frozen Implementer Role in that same worktree once, then repeats derivation, validation, and conditional review with fresh exact evidence. An omitted continuation class retains a supplied Unit class; when no Unit class was supplied, each frozen Role uses its own default. A supplied continuation class replaces both Role defaults for that repair and any subsequent Reviewer launch. A second block is terminal. A failed rebase is aborted and terminates as an infrastructure failure with Git diagnostics; other infrastructure failures are terminal. A reported fast-forward failure completes with its diagnostic as a warning only when Main is clean at the exact integrated tip; otherwise it is terminal. Terminal outcomes retain worktrees for Main to reslice. Earlier integrated units are never rolled back.

Flow has no dependency graph, saved state, automatic retry, aggregate review, or post-merge validation. Use it only for commuting changes; combine or sequence units that overlap files, APIs, schemas, generated output, package metadata, lockfiles, or invariants.

`delegate_task` remains generic: its optional worktree isolation, non-Git behavior, and direct plan/file review are unchanged. The built-in `scout` is available only through generic `delegate_task`; Flow uses package-shipped Implementer and conditional Reviewer Roles as defaults while retaining same-named user Role overrides.

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

A Role file requires:

- base tools: a YAML array; `tools: []` activates no base built-ins, while trusted selected extension tools still activate;
- explicit extension paths or package sources: a YAML array; `extensions: []` selects no Role extension bundle;
- additional effective Pi Skill names: a YAML array; `skills: []` selects no separately named Role Skills, while trusted selected extension Skills still load;
- system instructions;
- optional `modelClass` default (`fast`, `balanced`, `frontier`, or `fav`); and
- optional `isolation: worktree` for the tool layer.

Every launch installs the Role tool policy. At launch, a package caller may add `tools`, `extensions`, and `env`; caller tools are unioned into the Role base list and loaded extension tools activate in every case. Caller `env` adds to or overrides the active Pi process environment for the child.

Children start with ambient extension and Skill discovery disabled. Only explicit Role/caller extensions, explicitly resolved Skill paths, resources supplied by those extension packages, and any required internal tool-policy or Codex adapter load. Loaded extension tools activate even when the Role base list is empty. Child-inappropriate parent tools are always excluded: `delegate_task`, `delegate_flow`, `delegate_flow_continue`, and `ask_question`. Explicit Role/caller tool names are verified against the final filtered active child registry after every explicit provider extension completes `session_start`; unavailable names fail before the first model turn and identify the missing names with provider-extension guidance.

Role Skill names resolve through Main's effective Pi Skill registry at launch. Missing names are returned in `ResolvedRoleLaunch.missingSkills`; `delegate_task` warns and skips them. Library callers must surface that warning themselves. Missing Skills do not block launch.

## Public Role and executor API

The package root exports the following mechanism-level APIs:

| API | Responsibility |
| --- | --- |
| `loadRoles(agentDir?)` | Validate and load package-shipped built-in and user Role Markdown. |
| `resolveRoleSkills(pi, role)` | Resolve Role Skill names from Pi's effective registry. |
| `resolveRoleLaunch(pi, ctx, input)` | Resolve a caller-owned Model Task route, applying call-level then Role `modelClass` precedence, and produce `ResolvedRoleLaunch`. |
| `createRoleLaunch(pi, ctx, input)` | Produce the same launch from a caller-supplied resolved route. |
| `createEphemeralSubagentExecutor(options)` | Queue and run one prepared no-session child per `run`. |
| `createChildWorktree` / `finalizeChildWorktree` | Optional caller-managed worktree lifecycle. |

A loaded `Role` contains `name`, `description`, required normalized `tools`, `extensions`, and `skills` arrays, optional `modelClass` and `isolation`, and `systemPrompt`. `resolveRoleLaunch` accepts `role`, a caller-owned `task` Model Task declaration, optional call-level `modelClass`, and optional caller `agentDir`, `extensions`, `tools`, and `env`. At extension load, callers invoke `registerModelTask(pi, task)` from `@henryqw/pi-task-models` once to expose that declaration in the shared control plane. Its result is a `PiLaunch` (`{ env, args }`) plus the selected `model`, `thinkingLevel`, and `missingSkills`.

`createEphemeralSubagentExecutor` requires:

```js
const executorOptions = {
  maxConcurrency: 4,
  maxTurns: 50,
  timeout: { idleMs: 10 * 60_000, maxMs: 30 * 60_000 },
};
```

Concurrency is FIFO. `run` accepts optional `signal`, `onUpdate(text)`, `onTokens(number)`, and `onActivity(event)` callbacks plus required `prepare()`. A queued run receives its permit before `prepare` executes, so resource and route resolution can use the latest Pi state. Queued time does not consume child timeout. `maxConcurrency`, `maxTurns`, `idleMs`, and `maxMs` must be positive; integer limits must be safe integers, `maxMs` must exceed `idleMs`, and omitted `maxTurns` defaults to 50.

The executor is **active-Pi-only**. It reuses the currently running Pi invocation and does not locate or support a standalone Node.js Pi installation. Once direct Pi exits, stdout/stderr drain normally until EOF; an escaped descendant retaining either stream is cut off after short output inactivity or a one-second hard deadline so it cannot retain the FIFO permit.

### Prepare after the permit

This JavaScript runs inside a Pi extension. `pi` is that extension's `ExtensionAPI`; it is not a standalone Node entry point.

```js
import {
  createEphemeralSubagentExecutor,
  resolveRoleLaunch,
} from "@henryqw/pi-subagent";
import { registerModelTask } from "@henryqw/pi-task-models";

const MODEL_TASK = {
  id: "your-package/delegate",
  label: "Package delegation",
  purpose: "Run one package-owned delegated task.",
  defaultProfile: "fast",
};

export function createRunRole(pi) {
  // Register the Model Task at extension load so /task-models discovery works.
  registerModelTask(pi, MODEL_TASK);

  const executor = createEphemeralSubagentExecutor({
    maxConcurrency: 4,
    maxTurns: 50,
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
      modelClass,
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
          task: MODEL_TASK,
          modelClass,
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

  return { runRole };
}
```

`run` resolves to `EphemeralSubagentResult`. Both outcome variants contain `exitCode`, `output`, `stderr`, and optional `stopReason`, `errorMessage`, and `usage`. A launched child/model failure is a typed `{ outcome: "failure", ... }` result. Abort, timeout, turn-limit, spawn, protocol, preparation, and callback failures reject with `EphemeralSubagentError` and a stable `code`. A terminal response at `maxTurns` succeeds; an attempted continuation rejects with `turn_limit`, accumulated `usage`, and bounded `output`. The executor supplies the same turn/maximum-runtime budget to the existing child Role tool extension, which steers the fixed convergence warning before another model turn once at each 80% threshold, combines thresholds first due together, and uses no timer or extra turn. Assistant `output` and `stderr` are bounded, and `usage` contains aggregate child usage when Pi supplies it.

### Activity callbacks

The optional `onActivity` callback receives structured activity events serially in child JSON-event order. This ordering applies only to `onActivity`; `onUpdate` and `onTokens` remain independent. A thrown or rejected activity callback fails the run with an `EphemeralSubagentError` whose code is `callback`.

| Event type | Fields |
| --- | --- |
| `tool_execution_start` | `toolCallId: string`, `toolName: string`, `path?: string` |
| `tool_execution_end` | `toolCallId: string`, `toolName: string` |
| `message_end` | none |

Activity text is limited to 4 KiB per field. An invalid `toolCallId` or `toolName`, or an oversized `path`, drops the event. A blank path or one containing C0/C1 terminal controls or Unicode line/paragraph separators is omitted from an otherwise valid start event.

The low-level executor does not interpret `Role.isolation`, discover resources, compose modes, create shared state, or promote child failure outcomes to tool errors. A direct caller that wants worktrees must call `createChildWorktree` after the permit, choose the returned `cwd`, call `finalizeChildWorktree` on every exit path, and preserve its recovery payload.

## JavaScript composition

The examples below use caller-selected `Role` objects and the `runRole` function returned by the package's initializer. A consuming Pi extension calls the initializer once at startup:

```js
import { createRunRole } from "your-package";

export default function yourExtension(pi) {
  const { runRole } = createRunRole(pi);
}
```

Variable names such as `reviewRole` are local bindings, not reserved Role names. The executor's `maxConcurrency` bounds launches; callers must also bound collections and loops.

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

The package ships three working built-in Roles, validated by the same parser as user roles and always present even with no `config/pi-subagent` directory. Their files leave `modelClass` unset, so they use the local Model Task route unless a caller overrides it:

| Built-in | Behavior |
| --- | --- |
| `implementer` | Focused implementation requesting `isolation: worktree`; commits scoped changes locally, never pushes or opens PRs without authorization. Non-Git or unborn-`HEAD` contexts may use Main's cwd. |
| `reviewer` | Read-only correctness review of supplied plans/files, or—when a Flow unit declares `review`—Flow's exact `{base, tip, patchPath}` packet in its Unit Worktree; never edits or commits. |
| `scout` | Read-only code and evidence mapping for one bounded task; never changes files. |

A same-named Markdown file in `config/pi-subagent/` explicitly overrides the built-in default.

The repository includes one optional inert sample, not installed configuration:

| Sample | Intended starting point |
| --- | --- |
| [`synthesizer`](../examples/roles/synthesizer.md) | Reconcile supplied reports without broad discovery. |

Copy the package-shipped sample from your installed `@henryqw/pi-subagent` package (npm installs include `examples/roles/`) if you want it:

```bash
mkdir -p ~/.pi/agent/config/pi-subagent
cp <package-install-dir>/examples/roles/synthesizer.md ~/.pi/agent/config/pi-subagent/
```

The package never creates, copies, updates, or removes files in `~/.pi/agent/config/pi-subagent/`. Once copied, the file and its name are entirely user-owned.

The bundled [`pi-subagent-delegated-development`](../skills/pi-subagent-delegated-development/SKILL.md) Skill is Main-side planner/orchestrator policy only. `delegate_flow` owns its fixed Git mechanics and objective validation authority; the Skill defines no runtime code or configuration. `delegate_task` remains the generic flat single/parallel/chain mechanism.

See [ADR 001](./adr/001-composable-ephemeral-execution.md) for the executor boundary and [ADR 002](./adr/002-package-owned-delegate-flow-orchestration.md) for Flow.
