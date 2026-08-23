# 019. pi-subagent Task Routing

- **Status:** accepted
- **Date:** 2026-08-13 (migrated from Obsidian vault)

## Context

Roles define capability and instructions; runtime cost and reasoning needs are a separate concern. Coupling them would duplicate Roles or hide routing choices.

## Decision

Keep model and thinking Route separate from Role and resolve it through shared `@henryqw/pi-task-models` configuration.

## Consequences

`delegate_task` maps requested `fast`, `balanced`, or `frontier` class to shared profiles, while library callers use stable task IDs such as `pi-auto-dag/implement`. Resolution uses Pi's effective model registry and fails before launch when no route is usable.

## Notes

Source: shared task-routing refactor.
