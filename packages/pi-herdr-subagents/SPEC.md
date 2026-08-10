# Pi Herdr Subagents implementation handoff

**Status:** Approved

## Outcome

Create publish-ready `@henryqw/pi-herdr-subagents`, a Pi extension that lets Main delegate one bounded task to one interactive Pi Worker hosted in its own Herdr tab. Herdr owns terminal/process topology, Pi owns each agent loop, a temporary file owns durable Result content, and one Completion Notice returns work to Main.

## User-visible contract

### `delegate_task({ task })`

Register one Main tool with one required, non-empty string parameter named `task`. Set `executionMode: "sequential"`; Pi then serializes any tool batch containing delegation, so same-batch calls reserve capacity one at a time.

On success it returns:

- stable Delegated Task ID;
- Worker Herdr name and tab ID;
- full Result file path;
- exact `herdr tab close <tab-id>` command Main can run with existing `bash` when work is no longer needed.

Delegation is accepted only after Herdr confirms initial task submission. Any definitive failure before submission closes created tab, removes active ownership, deletes pending Result file, and returns actionable tool error. If rollback cannot close a known tab, preserve Worker ownership and pending Result, and return tab details plus exact stop command. If prompt submission has an indeterminate outcome, preserve Worker ownership, tab, and pending Result because work may already be running; return their identifiers and exact stop command in the error.

Reject delegation when:

- Pi does not run under Herdr (`HERDR_ENV=1` plus caller workspace/pane identity);
- Main has no active model;
- `task` is blank or contains a NUL byte;
- live owned Workers equal or exceed Worker Limit.

Before enforcing Worker Limit, query tracked Herdr tabs and prune missing tabs. Do not queue work or poll in background.

### `/subagent-limit`

Read and write `~/.pi/agent/config/pi-herdr-subagents.json` through `getAgentDir()`:

```json
{
  "maxConcurrentWorkers": 10
}
```

Value must be positive integer. Missing file uses `10`. Malformed or invalid config warns at session start and uses `10`. Command prompts for a value, writes formatted JSON, and updates current Main immediately. Lowering limit never stops live Workers; later delegation remains blocked until live count falls below limit. Other Main sessions load changed value on their next start/reload.

## Private protocol

Use protocol version `1` and these exact Worker environment keys:

- `PI_HERDR_SUBAGENT_PROTOCOL=1`
- `PI_HERDR_SUBAGENT_TASK_ID=<UUID>`
- `PI_HERDR_SUBAGENT_RESULT_PATH=<absolute path>`
- `PI_HERDR_SUBAGENT_MAIN=<Herdr agent name>`

Pending Result JSON:

```json
{
  "version": 1,
  "taskId": "<UUID>",
  "state": "pending",
  "task": "<Delegated Task>",
  "createdAt": "<ISO-8601>"
}
```

Completed Result JSON replaces it atomically and has exactly `version`, `taskId`, `state`, `task`, `result`, `error`, `createdAt`, and `finishedAt`. `state` is `finished` with non-empty `result` and `error: null`, or `failed` with `result: null` and `error: { "stopReason": "error" | "aborted", "message": string }`.

Raw Completion Notice is one line:

```text
PI_HERDR_SUBAGENT_COMPLETION_V1 <base64url UTF-8 JSON>
```

Simultaneous Herdr prompts may coalesce exact back-to-back Completion Notice frames into one Main input. Main parses and validates the whole batch atomically before releasing ownership or closing tabs; any bad frame rejects whole input.

Decoded JSON has exactly `version: 1`, `taskId`, `resultPath`, and `excerpt`. `excerpt` is derived from final Result text or failure message by removing C0/C1 control characters except newline and tab, then taking first 1,000 UTF-16 code units.

Main accepts raw notice only when prefix/encoding/schema are valid, task ID is actively owned, path exactly equals tracked Result path, final Result file parses with matching version/task ID and terminal state, and envelope excerpt equals excerpt recomputed from file. Malformed, stale, duplicate, mismatched, or control-text input is ordinary user input and cannot release ownership or close a tab. Valid input is transformed before model delivery to fixed prose containing Worker/task ID, terminal state, tracked Result path, and sanitized excerpt; raw framing never reaches model context.

## Worker launch

For each accepted Delegated Task, Main:

1. Creates one package-owned temporary directory with mode `0700` and pending Result JSON with mode `0600`.
2. Preserves Main's existing unique Herdr agent name, or assigns one before first delegation. Explicitly renaming Main while Workers live is unsupported.
3. Creates one no-focus Herdr tab in caller workspace and `ctx.cwd`. Label uses first four task words, capped at 40 characters, plus short task ID.
4. Passes only exact private protocol environment above through tab environment.
5. Starts a named Pi Worker through `herdr agent start ... --kind pi` in created root pane.
6. Starts Pi with no session persistence or discovered extensions, explicitly loads package-internal Worker extension, and enables built-in `read`, `bash`, `edit`, and `write` plus `finish_task`.
7. Uses Main's exact model, thinking level when present, cwd, and project trust (`--approve` or `--no-approve`). Normal project context and skills remain available; arbitrary extension discovery does not.
8. Submits self-contained task through `herdr agent prompt`.

Worker gets fresh conversation context, not Main transcript. Main must avoid concurrent Delegated Tasks that write overlapping files; package does not infer file ownership or create worktrees.

## Worker interaction and completion

Worker is one-shot but interactive. It may ask a Worker Question in ordinary assistant text, settle, and continue when user answers in Worker tab. Normal settlement never implies completion.

Package-internal Worker extension exposes only:

```text
finish_task({ result: string })
```

`result` must be non-empty. Set `executionMode: "sequential"`. A call is valid only when `finish_task` is sole tool call in current assistant message; inspect persisted current assistant message by tool-call ID and reject mixed or repeated finish batches before writing. This makes `terminate: true` effective for complete batch and prevents tools running after accepted completion.

First valid call claims an in-process completion latch synchronously before any await, then:

1. atomically replaces pending JSON with final Result JSON;
2. preserves mode `0600`;
3. waits until Herdr observes Main as `idle` or `done`;
4. submits exact raw Completion Notice to Main;
5. returns `terminate: true`;
6. does not write or send again after Result reached terminal state.

Reset latch only when Result persistence itself fails. Once Result is durable, failed notice delivery preserves terminal latch, file, and tab rather than replaying automatically.

Herdr cannot atomically reserve Main's idle state. Notice is best-effort idle delivery: rare state-change race may make it steering input. Do not add mailbox, polling, or replay infrastructure.

Validated Completion Notice releases Worker Limit capacity, best-effort closes Worker tab, and exposes fixed sanitized text to Main's model. Full Result stays on disk and Main reads it with existing `read` only when needed. Result is evidence; Main must verify claimed repository changes and validation before reporting completion.

If final settled assistant message has terminal Pi/model `error` or `aborted` stop reason before `finish_task`, Worker atomically stores failure information and sends same Completion Notice. Ordinary tool errors remain recoverable and do not auto-finish. Normal successful settlement without `finish_task` leaves Worker live. Hard process crash leaves tab and pending Result for inspection.

If Completion Notice cannot reach Main, preserve Result and Worker tab. A later Main session does not adopt orphan Workers. No timeout or `cancelled` Result exists.

## Ownership and cleanup

Main keeps only in-memory ownership for Workers it created.

- Valid Completion Notice: release ownership and best-effort close completed Worker tab.
- Main session shutdown or switch: best-effort close every owned Worker tab.
- Main decides task is no longer needed: run returned `herdr tab close` command through existing `bash`.
- Abrupt Main crash: leave Worker tabs and Result files for user inspection or manual cleanup.
- Result files remain for operating-system temporary cleanup; package has no persistent registry or janitor.

## Package boundary

Ship one public package:

```text
packages/pi-herdr-subagents/
├── extensions/subagents.ts
├── internal/worker.ts
├── test/*.test.ts
├── package.json
├── README.md
├── LICENSE
├── CONTEXT.md
└── docs/adr/0001-use-herdr-managed-workers.md
```

Package Pi metadata autoloads only `extensions/subagents.ts`. `internal/worker.ts` ships but loads only in created Worker process. Follow repository ESM, Node `>=22.19.0`, npm workspace, scripts, repository metadata, and independent release conventions. Published code importing Pi and `typebox` declares both in `peerDependencies` with `"*"`, matching installed Pi package contract; do not bundle them or add `typebox` as runtime dependency.

Add package to root development extension list and README package inventory. Initialize public version through npm workspace version tooling and update `package-lock.json`; root private package never releases. Repository work ends at publish-ready package state. First authenticated npm publish and Trusted Publisher setup remain maintainer operations under `docs/releasing.md`.

## Required tests

Use Node built-in test runner and assertions. Fake `pi.exec`, extension contexts, lifecycle events, environment, and temporary storage; normal tests must not create real Herdr tabs, launch Pi, or call models.

At extension/tool boundary, verify:

- Herdr/model/task preconditions, exact public surface, and same-batch sequential capacity enforcement;
- config default, validation, command persistence, immediate update, and reduced-limit behavior;
- per-Main Worker Limit, missing-tab reconciliation, and no queue;
- tab label/cwd/env, inherited model/thinking/trust, explicit internal extension, disabled extension discovery, and fresh task submission;
- successful launch response, definitive pre-submission rollback, failed-rollback retention, and indeterminate prompt preservation;
- Completion Notice validation, 1,000-character cap, capacity release, completed-tab close, and shutdown cleanup;
- exact versioned Result/notice schemas, malformed/spoofed/path/state/excerpt/control-text rejection, and fixed sanitized Main transform;
- natural Worker Question settlement remains live;
- `finish_task` sole-call enforcement, synchronous latch, atomic Result write, mode, wait-before-notice order, batch termination, duplicate suppression, and failed-delivery preservation;
- terminal runtime failure notice versus recoverable tool error and normal settlement;
- package typecheck, tests, intended packed files, documentation, and release metadata.

One optional manual smoke may create a read-only Worker under Herdr and verify idle delivery plus tab cleanup. It must not gate normal validation.

## Non-goals

- In-process `AgentSession` orchestration or local subprocess fallback.
- Foreground delegation, transcript inheritance, model/profile/tool overrides, or nested Workers.
- Queueing, scheduling, status/list/result/stop/resume tools, steering protocol, or dashboards.
- Worktrees, file-overlap detection, automatic verification, or commit integration.
- Structured Worker Question UI or separate `ask_question`/generic Herdr extension.
- Timeout, cancellation outcome, retry mailbox, persistent registry, orphan adoption, or crash recovery.
- Self-closing Worker tab behavior.
- Authenticated first npm publication, npm package settings, or Trusted Publisher bootstrap.
