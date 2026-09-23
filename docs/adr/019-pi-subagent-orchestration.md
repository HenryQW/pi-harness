# 019. Unified pi-subagent orchestration

- **Status:** accepted
- **Date:** 2026-09-23

## Context

Generic Role delegation and durable checked implementation graphs share Role, route, executor, evidence, and worktree mechanisms. Separate packages duplicated configuration and exposed overlapping tools. A whole-run wall-clock deadline also expired valid retained work despite finite safety bounds for child operations.

Background direct work previously ran as a separate child process, invisible in Herdr. Moving workers into Herdr tabs makes them visible, but a tab does not isolate files: the shared-checkout writer reservation ends when `delegate_task` returns. A non-blocking direct writer could race Main and invalidate its evidence. Herdr lifecycle status alone does not carry an exact final answer into Main's Pi conversation.

## Decision

`@henryqw/pi-subagent` owns both paths behind one explicit `delegate_task` mode:

- `mode: "direct"` runs only Roles with proven read-only resources in non-focused Herdr tabs in Main's current workspace. It supports single, parallel, and chain tasks, not direct changesets or a separate `background` option.
- `mode: "isolated"` runs durable checked task graphs. Changesets use isolated Herdr worktrees with exact validation, guarded integration, and recovery. Requests never silently fall back between modes.

Background execution is a scheduling behavior, not a third `delegate_task` mode. A direct call returns after its first worker is launched; the extension records exact tab identities, observes Herdr lifecycle asynchronously, and verifies a bounded final answer from each worker's Pi session rather than trusting an idle badge or screen contents. An isolated execute/resume acknowledges only after durable state is saved, then continues productive work asynchronously. Its candidate/readiness, follow-up, correction, rebase, authoritative check and judgment, integration, exact termination, and conservative cleanup safeguards remain authoritative.

Completed workflows deliver Pi messages to their launching session with `triggerTurn: true, deliverAs: "followUp"`. A busy Main finishes its current turn before consuming a result; idle Main starts a turn. Session replacement suppresses stale delivery but retains exact recoverable identity. No new daemon or whole-run wall-clock deadline is introduced.

Execution policy comes only from `config/pi-subagent/config.json`; requests cannot override or replenish limits. Child turn/token/idle/runtime, external I/O, status, termination, and cleanup remain independently bounded. Pi is the Role and model authority; Herdr owns worker tabs and isolated workspaces. The extension stops at checked local integration and never pushes, publishes, deploys, or opens a pull request.

## Consequences

One package owns delegation. Main continues while workers run visibly in Herdr. Shared-checkout writing now requires isolated mode; direct Role capability checks are not an OS sandbox, and external checkout changes can make a concurrent read stale. A missed delivery or uncertain worker outcome requires status/recovery rather than guessed completion. The old direct/background public contract changes in the next major pi-subagent release. Older durable state is rejected rather than migrated silently. The retired package record remains in [`deprecated/pi-orchestrator`](../../deprecated/pi-orchestrator/README.md).
