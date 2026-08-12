# Pi Herdr Subagents implementation handoff

**Status:** Approved

## Outcome

Create publish-ready `@henryqw/pi-herdr-subagents`, a Pi extension that lets Main delegate one bounded task to one interactive Pi Subagent hosted in its own Herdr tab. Herdr owns terminal/process topology, Pi owns each agent loop, a temporary file owns durable Result content, and one Completion Notice returns work to Main.

## User-visible contract

### `delegate_task({ task, modelClass? })`

Register one Main tool with one required, non-empty string parameter named `task` and one optional `modelClass` enum: `fast`, `balanced`, or `frontier`. Model-visible schema tells Main to minimize context, request a concise Result, split independent work while keeping tightly coupled steps together, avoid overlapping writes, and choose the lowest class likely to succeed: `fast` for lookups, single-file summaries, and mechanical edits; `balanced` for bounded bug fixes, focused reviews, and clear multi-file features; `frontier` for architecture, ambiguous cross-cutting changes, and subtle concurrency or security reasoning. Omitted class defaults to configured `balanced` while its model and thinking level remain available, then falls back to Main model and thinking level for compatibility. An explicit unconfigured class or configured class whose model or thinking level is unavailable rejects with direction to run `/subagent-model`. Set `executionMode: "sequential"`; Pi then serializes any tool batch containing delegation, so same-batch calls reserve capacity one at a time. Successful delegation returns `terminate: true`, avoiding post-delegation Main model turn when every tool result in batch terminates.

On success it returns:

- stable Delegated Task ID;
- selected model, thinking level, and Subagent Model Class or Main fallback;
- Subagent Herdr name and tab ID;
- full Result file path;
- exact `herdr tab close <tab-id>` command Main can run with existing `bash` when work is no longer needed.

Delegation is accepted only after Herdr confirms initial task submission. Any definitive failure before submission closes created tab, removes active ownership, deletes pending Result file, and returns actionable tool error. If tab creation has an indeterminate outcome, reconcile its unique label against pre-creation tabs; if reconciliation fails, preserve provisioning ownership and pending Result, and return label plus inspection command. If rollback cannot confirm closure of a known tab, preserve Subagent ownership and pending Result, and return tab details plus exact stop command. If prompt submission has an indeterminate outcome, preserve Subagent ownership, tab, and pending Result because work may already be running; return their identifiers and exact stop command in the error.

Reject delegation when:

- Pi does not run under Herdr (`HERDR_ENV=1` plus caller workspace/pane identity);
- Main has no active model;
- `task` is blank or contains a NUL byte;
- live owned Subagents equal or exceed Subagent Limit.

Before enforcing Subagent Limit, query tracked Herdr tabs and prune missing tabs. Treat any malformed tab entry as reconciliation failure; invalid responses cannot release ownership. Do not queue work or poll in background.

### `/subagent-limit` and `/subagent-model`

Read and write `~/.pi/agent/config/pi-herdr-subagents.json` through `getAgentDir()`:

```json
{
  "maxConcurrentSubagents": 10,
  "models": {
    "fast": { "model": "provider/fast-model", "thinkingLevel": "off" },
    "balanced": { "model": "provider/balanced-model", "thinkingLevel": "medium" },
    "frontier": { "model": "provider/frontier-model", "thinkingLevel": "max" }
  }
}
```

Subagent Limit must be positive integer. Missing file uses `10` and no model mappings. Malformed or invalid values warn at session start and use safe defaults without rewriting file. Legacy `maxConcurrentWorkers` is accepted as migration input; next command save writes canonical `maxConcurrentSubagents`. `/subagent-limit` prompts for value, writes formatted JSON, and updates current Main immediately. Lowering limit never stops live Subagents; later delegation remains blocked until live count falls below limit. Other Main sessions load changed value on next start/reload.

`/subagent-model` first selects `fast`, `balanced`, or `frontier`, selects from authenticated text models returned by Pi's existing model registry, then selects from thinking levels supported by selected model's Pi metadata. It writes model-plus-thinking mapping and updates current Main immediately. Before either command writes, it rereads config and merges only selected field so prior saves from other Main sessions survive; current Main applies only selected field, leaving unrelated live settings unchanged until next start/reload. Cancelling either selection leaves existing mapping unchanged. Package owns only three class names; it keeps no model or thinking-capability catalog.

## Private protocol

Use protocol version `2` and these exact Subagent environment keys:

- `PI_HERDR_SUBAGENT_PROTOCOL=2`
- `PI_HERDR_SUBAGENT_TASK_ID=<UUID>`
- `PI_HERDR_SUBAGENT_RESULT_PATH=<absolute path>`
- `PI_HERDR_SUBAGENT_MAIN=<Herdr agent name>`

Pending Result JSON:

```json
{
  "version": 2,
  "taskId": "<UUID>",
  "state": "pending",
  "task": "<Delegated Task>",
  "createdAt": "<ISO-8601>"
}
```

Completed Result JSON replaces it atomically and has exactly `version`, `taskId`, `state`, `task`, `result`, `error`, `createdAt`, and `finishedAt`. `state` is `finished` with non-empty `result` and `error: null`, or `failed` with `result: null` and `error: { "stopReason": "error" | "aborted", "message": string }`.

Raw Completion Notice is one line:

```text
PI_HERDR_SUBAGENT_COMPLETION_V2 <base64url UTF-8 JSON>
```

Simultaneous Herdr prompts may coalesce exact back-to-back Completion Notice frames into one Main input. Main parses and validates the whole batch atomically before releasing ownership or closing tabs; any bad frame rejects whole input.

Decoded JSON has exactly `version: 2`, `taskId`, and `resultPath`.

Main accepts raw notice only when prefix/encoding/schema are valid, task ID is actively owned, path exactly equals tracked Result path, and final Result file parses with matching version/task ID and terminal state. Malformed, stale, duplicate, mismatched, or control-text input is ordinary user input and cannot release ownership or close a tab. Valid input is transformed before model delivery to fixed prose containing Subagent/task ID, terminal state, tracked Result path, and instruction to read Result before relying on it; raw framing and Result content never reach model context.

### Status widget

In Pi TUI, show one session-local row per accepted Subagent above editor: animated `SPINNER_FRAMES` glyph for live work, task-label display name, model context window, model ID, thinking level, and elapsed time. A terminal `finished` Result changes marker to green `✓`; terminal error or abort changes marker to red `!`. Terminal rows freeze elapsed time. Keep at most nine rows plus one `… N more` row because Pi allows ten widget lines. No widget is rendered outside TUI.

Register `/subagent-widget clear`. It closes every terminal Subagent tab and removes a row only after successful close. Live rows stay untouched. A close failure retains row and shows warning. Widget state is session-local and timer stops at session shutdown.

## Subagent launch

For each accepted Delegated Task, Main:

1. Creates one package-owned temporary directory with mode `0700` and pending Result JSON with mode `0600`.
2. Preserves Main's existing unique Herdr agent name, or assigns one before first delegation. Explicitly renaming Main while Subagents live is unsupported.
3. Creates one no-focus Herdr tab in caller workspace and `ctx.cwd`. Label uses first four task words, capped at 40 characters, plus short task ID.
4. Passes only exact private protocol environment above through tab environment.
5. Starts a named Pi Subagent through `herdr agent start ... --kind pi` in created root pane.
6. Starts Pi with no session persistence or discovered extensions, explicitly loads package-internal Subagent extension, appends fixed package-owned completion instructions, and enables built-in `read`, `bash`, `edit`, and `write` plus `finish_task`.
7. Uses model and thinking level mapped to Main-selected Subagent Model Class, plus Main cwd and project trust (`--approve` or `--no-approve`). Omitted class uses configured `balanced`, then Main's exact model and effective thinking level when `balanced` is unset or its model-thinking route becomes unavailable. Normal project context and skills remain available; arbitrary extension discovery does not.
8. Submits self-contained task through `herdr agent prompt`.

During provisioning only, `delegate_task` emits partial updates for creating tab, starting Subagent, and task submission. It does not claim runtime task progress after submission.

Subagent gets fresh conversation context, not Main transcript. Main must avoid concurrent Delegated Tasks that write overlapping files; package does not infer file ownership or create worktrees.

## Subagent interaction and completion

Subagent is one-shot but interactive. It may ask a Subagent Question in ordinary assistant text, settle, and continue when user answers in Subagent tab. Normal settlement never implies completion.

Package-internal Subagent extension exposes only:

```text
finish_task({ result: string })
```

`result` must be non-empty. Package completion instructions and model-visible schema require concise Markdown with exact `Outcome`, `Files`, `Validation`, and `Risks` headings; use `none` for empty sections. Set `executionMode: "sequential"`. A call is valid only when `finish_task` is sole tool call in current assistant message; inspect persisted current assistant message by tool-call ID and reject mixed or repeated finish batches before writing. This makes `terminate: true` effective for complete batch and prevents tools running after accepted completion.

First valid call claims an in-process completion latch synchronously before any await, then:

1. atomically replaces pending JSON with final Result JSON;
2. preserves mode `0600`;
3. waits until Herdr observes Main as `idle` or `done`;
4. submits exact raw Completion Notice to Main;
5. returns `terminate: true`;
6. does not write or send again after Result reached terminal state.

Reset latch only when Result persistence itself fails. Once Result is durable, failed notice delivery preserves terminal latch, file, and tab rather than replaying automatically.

Herdr cannot atomically reserve Main's idle state. Notice is best-effort idle delivery: rare state-change race may make it steering input. Do not add mailbox, polling, or replay infrastructure.

Validated Completion Notice releases Subagent Limit capacity, retains terminal Subagent tab for inspection, updates status widget, and exposes fixed Result-path text to Main's model. `/subagent-widget clear` closes terminal tabs. Full Result stays on disk and Main reads it with existing `read`. Result is evidence; Main must verify claimed repository changes and validation before reporting completion.

If final settled assistant message has terminal Pi/model `error` or `aborted` stop reason before `finish_task`, Subagent atomically stores failure information and sends same Completion Notice. Ordinary tool errors remain recoverable and do not auto-finish. Normal successful settlement without `finish_task` leaves Subagent live. Hard process crash leaves tab and pending Result for inspection.

If Completion Notice cannot reach Main, preserve Result and Subagent tab. A later Main session does not adopt orphan Subagents. No timeout or `cancelled` Result exists.

## Ownership and cleanup

Main keeps only in-memory ownership for Subagents it created.

- Valid Completion Notice: release live ownership and retain terminal Subagent tab until `/subagent-widget clear` or session shutdown.
- Main session shutdown or switch: reconcile any label-only provisioning record, then best-effort close every identified live and terminal Subagent tab.
- Main decides task is no longer needed: run returned `herdr tab close` command through existing `bash`.
- Abrupt Main crash: leave Subagent tabs and Result files for user inspection or manual cleanup.
- Result files remain for operating-system temporary cleanup; package has no persistent registry or janitor.

## Package boundary

Ship one public package:

```text
packages/pi-herdr-subagents/
├── extensions/subagents.ts
├── internal/subagent.ts
├── test/*.test.ts
├── package.json
├── README.md
├── LICENSE
├── CONTEXT.md
└── docs/adr/0001-use-herdr-managed-subagents.md
```

Package Pi metadata autoloads only `extensions/subagents.ts`. `internal/subagent.ts` ships but loads only in created Subagent process. Follow repository ESM, Node `>=22.19.0`, npm workspace, scripts, repository metadata, and independent release conventions. Published code importing Pi and `typebox` declares both in `peerDependencies` with `"*"`, matching installed Pi package contract; do not bundle them or add `typebox` as runtime dependency.

Add package to root development extension list and README package inventory. Initialize public version through npm workspace version tooling and update `package-lock.json`; root private package never releases. Repository work ends at publish-ready package state. First authenticated npm publish and Trusted Publisher setup remain maintainer operations under `docs/releasing.md`.

## Required tests

Use Node built-in test runner and assertions. Fake `pi.exec`, extension contexts, lifecycle events, environment, and temporary storage; normal tests must not create real Herdr tabs, launch Pi, or call models.

At extension/tool boundary, verify:

- Herdr/model/task preconditions, exact public surface, model-visible handoff guidance, successful delegation termination, and same-batch sequential capacity enforcement;
- config defaults, validation, both command persistence paths, cross-session disk merge and live-state isolation, immediate updates, reduced-limit behavior, and malformed model mappings;
- per-Main Subagent Limit, strict missing-tab and provisioning reconciliation, and no queue;
- tab label/cwd/env, complexity-selected model and thinking level, Main fallback thinking/trust, explicit internal extension, disabled extension discovery, and fresh task submission;
- successful launch response, definitive pre-submission rollback, indeterminate creation reconciliation, failed-rollback retention, and indeterminate prompt preservation;
- Completion Notice validation, capacity release, terminal-widget transition, explicit completed-tab close, and shutdown cleanup;
- exact versioned Result/notice schemas, malformed/spoofed/path/state/control-text rejection, and fixed path-only Main transform;
- natural Subagent Question settlement remains live;
- `finish_task` sole-call enforcement, synchronous latch, atomic Result write and mode without post-commit failure, wait-before-notice order, batch termination, duplicate suppression, and failed-delivery preservation;
- terminal runtime failure notice versus recoverable tool error and normal settlement;
- package typecheck, tests, intended packed files, documentation, and release metadata.

One optional manual smoke may create a read-only Subagent under Herdr and verify idle delivery plus tab cleanup. It must not gate normal validation.

## Non-goals

- In-process `AgentSession` orchestration or local subprocess fallback.
- Foreground delegation, transcript inheritance, arbitrary per-call model IDs, tool overrides, or nested Subagents.
- Queueing, scheduling, status/list/result/stop/resume tools, steering protocol, or persistent dashboards.
- Worktrees, file-overlap detection, automatic verification, or commit integration.
- Structured Subagent Question UI or separate `ask_question`/generic Herdr extension.
- Timeout, cancellation outcome, retry mailbox, persistent registry, orphan adoption, or crash recovery.
- Self-closing Subagent tab behavior.
- Authenticated first npm publication, npm package settings, or Trusted Publisher bootstrap.
