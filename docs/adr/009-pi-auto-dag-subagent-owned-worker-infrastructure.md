# 009. pi-auto-dag Subagent-Owned Worker Infrastructure

- **Status:** accepted
- **Date:** 2026-08-17, updated 2026-08-19 (migrated from Obsidian vault)
- **Supersedes:** ADR 008 (config-defined worker profiles)

## Context

Config-defined worker profiles (ADR 008) had Auto DAG itself defining agent directories, skills, and tools — duplicating Pi profile management and coupling Auto DAG to host backends.

## Decision

Pi Auto DAG configuration version 4 references user-owned `@henryqw/pi-subagent` Roles through `implementation_roles`, `reviewer_role`, and `repair_role`. Auto DAG does not define agent directories, Skills, tools, extensions, or models.

`@henryqw/pi-subagent` resolves Roles against Pi's effective Skill registry, resolves shared `@henryqw/pi-task-models` assignments, creates isolated Pi launch arguments, owns generic managed worker hosting, and provides durable mailbox IPC. Auto DAG task IDs are `pi-auto-dag/implement` and `pi-auto-dag/review`.

Auto DAG retains graph scheduling, worktrees, prompts, protocol extension and phase tools, action tickets, durable receipts, Required Gates, integration, and recovery decisions. It publishes worker envelopes to a run-scoped mailbox, persists accepted-event binding before its receipt, and acknowledges mailbox entries only after lifecycle return. Run State version 5 persists opaque worker IDs only; it contains no host, pane, tab, workspace, or copied Skill registry data.

## Consequences

- Role and model launch policy is shared with other Subagent consumers.
- Auto DAG has no direct host-backend dependency or generic worker-host implementation; host details remain inside Pi Subagent.
- Missing Roles or unusable task routes fail before Worker launch.
- Malformed mailbox entries remain visible without blocking valid entries; the same event ID cannot change an accepted envelope body.
- Earlier Run State schemas are intentionally unsupported by package major version 8.
