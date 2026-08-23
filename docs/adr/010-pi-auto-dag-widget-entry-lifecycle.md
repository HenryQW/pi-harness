# 010. pi-auto-dag Widget Entry Lifecycle

- **Status:** accepted
- **Date:** 2026-08-11 (migrated from Obsidian vault)

## Context

The worker widget renders live worker state; UI cleanup must not alter durable orchestration state.

## Decision

- **Use `/dag-plan` for delivery planning and `/dag-widget show|hide|fix` for worker-widget control.** One `dag-` command namespace makes Auto DAG commands discoverable. Tradeoff: replacing `/plan-delivery` breaks existing command usage and requires a major package release; the packaged prompt and extension command share the new name and the old command is removed. Source: user request.
- **Keep the widget as a projection, never an orchestration-state owner.** Run State defines desired worker entries; live Herdr status supplies liveness evidence. Normal lifecycle changes remove entries automatically because each render derives them again. Rejected alternative: mutating Run State when a widget entry looks stale could hide or corrupt recoverable work (task recovery, locks, worktrees, worker dispatch).
- **Make `/dag-widget fix` dismiss only confirmed-missing, non-blocked worker incarnations.** Dismissal is session-local and keyed by run, issue, activity, pane, and activity start. It clears when Herdr reports the worker live or Run State advances to another incarnation. Blocked entries remain visible because they represent actionable task state, not stale worker processes. Tradeoffs: dismissals reset on Pi reload; fixing requires a successful Herdr status read. Source: user-approved implementation strategy.
