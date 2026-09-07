# 019. pi-auto-dag Serial Runner

- **Status:** accepted
- **Date:** 2026-09-07

## Context

Some requests need task dependencies, durable recovery, and direct checks in one shared workspace. `@henryqw/pi-subagent` already supplies effective Roles and bounded child execution. The repository needs a durable coordinator without restoring the old Auto DAG engine.

ADR 007 remains retired historical evidence. It does not describe v9.

## Decision

`@henryqw/pi-auto-dag` coordinates one durable request. It owns:

- strict task and dependency records;
- serial coordination in one shared workspace;
- v9 persistence;
- bounded correction attempts and the total request budget;
- runner-observed verification of direct checks;
- final request acceptance; and
- aggregate request metrics.

`@henryqw/pi-subagent` owns effective Roles and their resolution, focused child launch, model-class routing, child limits, and child usage. Auto DAG asks pi-subagent to run each child. It does not own Roles or child execution policy.

Use pi-subagent directly for bounded work that does not need durable request coordination. Choose Auto DAG when a request needs durable coordination of dependent tasks, not because the work seems difficult or complex.

Only the v9 state and protocol are supported. Older Auto DAG state and protocol are rejected. There is no migration or compatibility path.

The runner does not restore old parallel workers, worktrees, merge integration, Herdr coordination, outboxes, pushes, pull requests, or post-PR handling.

## Consequences

The runner can resume a durable serial request while pi-subagent remains the owner of Role-based child execution. Worker text does not prove completion. The runner observes checks and decides task completion and final request acceptance.

Whole-request comparisons use dedicated Pi sessions that run one request. A mixed Pi session has no reliable request-cost boundary. Metrics support later evaluation; this ADR makes no cost or performance conclusion before that evaluation.
