# 022. pi-auto-dag Execution-Only Boundary

- **Status:** accepted
- **Date:** 2026-08-24
- **Supersedes:** the planning, approval, and interactive-lifecycle portions of ADR 007 and ADR 009, plus the `/dag-plan` planning-command decision in ADR 010 (see those ADRs for the still-valid worker and process trust decisions)

## Context

Auto DAG v7 exposed planning, approval, run start, resume, gate retry, resolution, health, and abort as separate orchestrator tools. This made the orchestrator responsible for plan normalization, multi-step lifecycle state, and post-PR follow-up — surface area that belongs to callers, not to an execution engine.

## Decision

Package major version 8 narrows Auto DAG to a single execution boundary:

- **Sole execution entry.** `auto_dag_execute({graph})` replaces separate validate, approve, and start tools. It takes one exact Delivery Graph object with top-level fields `id`, `goal`, `constraints`, `non_goals`, `issues`, and `final_check`; no `status` or profile field. The graph is immutable for the duration of the run. There is no draft state, no separate validate/approve/start tools.
- **Fixed roles.** Implementer and reviewer Roles are fixed by the package; user configuration no longer selects them. Every implementation issue executes through the fixed implementer Role; review through the fixed reviewer Role.
- **One hash-bound TUI confirmation.** Execution begins after exactly one TUI confirmation bound to the SHA-256 of the exact graph. The confirmation display-escapes every exact `testing` command that will later run through `sh -c`, alongside both fixed Roles, before any process starts.
- **Executor-only ownership.** Auto DAG owns execution from start through PR creation: waves, worktrees, implementer/reviewer dispatch, required gates, Final Check on integration HEAD, push, and opening exactly one PR. Ownership ends at PR creation.
- **Durable event outbox.** Blocked and completed run outcomes persist through an at-least-once outbox in Run State: stable event IDs, persisted before dispatch acknowledgment. Consumers dedupe on event ID; redelivery never changes action, payload, or Git HEAD.
- **Caller-owned surroundings.** `/ship` externally owns planning normalization (producing the exact graph passed to `auto_dag_execute`) and the post-PR phase: a one-time sweep of PR feedback plus CI status after PR creation.
- **Remaining interactive boundaries.** Initial execution has one TUI confirmation. Durable status/resume/abort controls remain non-interactive; infrastructure-invalid gate retries and exact gate-command amendments retain focused confirmations. Other blocked outcomes surface through the outbox, and recovery reruns only what durable receipts prove incomplete.

Removed: planning review, hash approval flow, `/dag-plan`, separate validate/approve/start tools, the health tool, explicit PR-health repair, configurable implementation/reviewer/repair roles, and graph `status`. Durable status/resume/retry/resolve/abort tools remain for recovery. No compatibility layer or migration path exists; earlier Run State schemas are unsupported.

## Consequences

- The trust guarantees of ADRs 007 and 009 remain for execution: canonical frozen graph content, executor-owned required gates with commit-bound evidence, detached gate-host process ownership, subagent-owned worker infrastructure, and durable receipts.
- Approval semantics move to the caller: whoever normalizes the graph into `auto_dag_execute` owns that the graph reflects reviewed intent; Auto DAG enforces the hash-bound human confirmation before any command runs.
