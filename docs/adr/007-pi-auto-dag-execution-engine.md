# 007. pi-auto-dag Execution Engine

- **Status:** retired
- **Date:** 2026-08-24

## Context

Auto DAG accumulated planning, profile selection, split approval/start tools, and post-PR health handling around its core executor. Those caller concerns expanded the trusted surface and obscured the durable execution guarantees.

## Decision

`@henryqw/pi-auto-dag` is an execution engine for one supplied Delivery Graph:

- `auto_dag_execute({ graph })` is the sole execution entry. The validated graph is immutable for the run, and one SHA-256-bound TUI confirmation displays both fixed Roles and every escaped exact testing command before execution.
- Auto DAG owns dependency waves, isolated worktrees, implementer/reviewer dispatch, integration, Required Gates, Final Check, push, and creation of exactly one pull request. Planning normalization and post-PR feedback/CI handling remain caller-owned.
- The package fixes the `implementer` and `reviewer` Roles. `@henryqw/pi-subagent` owns Role, Skill, model-route, launch, and managed Herdr infrastructure; Auto DAG supplies only phase-specific protocol and tools.
- Auto DAG, not model output, owns required test evidence. It runs the exact command against a verified clean commit and durably records commit, exit status, and bounded output before review. Detached gate hosts and completion journals prevent orphaned commands or duplicate execution after lifecycle-process loss.
- Run State records accepted worker-envelope bindings before successful receipts. Recovery reruns only work not proven complete.
- Blocked and completed outcomes use an at-least-once outbox with stable event IDs. Consumers acknowledge idempotently and deduplicate by event ID.
- The worker widget is a projection of durable state and live Herdr status; UI cleanup never mutates orchestration state.

Durable status, resume, abort, focused gate retry, and gate-command amendment controls remain recovery surfaces. There is no planning review, draft graph, configurable worker profile, separate validate/approve/start chain, health tool, or PR-health lifecycle. Earlier Run State schemas are unsupported.

## Consequences

The executor has one user-facing trust boundary while retaining commit-bound gates, capability isolation, durable handoffs, and crash recovery. `/ship` can compose planning and post-PR work without duplicating execution policy.
