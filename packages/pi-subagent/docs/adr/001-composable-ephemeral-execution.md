# Compose workflows outside the ephemeral executor

## Decision

The public task executor is an execution mechanism: it receives a prepared Pi Launch, runs one bounded Delegated Task, and returns the result. `single`, `parallel`, and `chain` are tool policy selected by a downstream caller, not executor workflow primitives.

Downstream callers compose Workflows directly with JavaScript. Fan-out and fan-in use promises and collections; sequencing uses ordinary control flow; review loops use explicit iteration and caller-owned bounds. This package will not define or interpret a recursive workflow AST.

Resource Policy is split at launch preparation:

- Role owns base tools, extensions, and Skill names.
- Caller may add explicit tools, extensions, and environment through `createRoleLaunch`.
- The executor receives the resulting Pi Launch and does not discover resources.

Repository Role samples are inert and user-owned only after manual copying to `~/.pi/agent/config/pi-subagent/`. This package does not install, copy, or write user configuration; copy instructions belong in downstream user documentation.

## Consequences

The executor remains a stable mechanism while callers own orchestration, state, retry decisions, concurrency, fan-in, and review bounds. Callers can express the required Workflow without coupling this package to a recursive schema, validation language, or migration surface.
