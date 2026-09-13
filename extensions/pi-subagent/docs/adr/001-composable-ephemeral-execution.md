# Compose generic workflows outside the ephemeral executor

## Decision

The public task executor is an execution mechanism: it receives a prepared Pi Launch, runs one bounded Delegated Task, and returns the result. Main plans and orchestrates; `delegate_task` selects its flat `single`, `parallel`, or `chain` tool policy, while those modes are not executor primitives.

Generic callers compose workflows with JavaScript. Fan-out and fan-in use promises and collections; sequencing uses ordinary control flow; review loops use explicit caller-owned bounds. The package does not define a recursive workflow AST.

Resource Policy is split at launch preparation:

- Role owns base tools, extensions, and Skill names.
- Caller may add explicit tools, extensions, and environment through `createRoleLaunch`.
- The executor receives the resulting Pi Launch and does not discover resources.

Built-in `implementer`, `reviewer`, and `scout` Roles ship as Markdown in `examples/roles/` and use the same parser as user Roles. For generic delegation, a same-named user Role explicitly overrides a built-in. The package does not install, copy, or write user configuration.

An explicit call `modelClass` selects a task-model route. Without one, an optional Role `modelClass` default wins; without either, the caller's Model Task assignment or declared default selects the route. The route owns its exact thinking level. A direct `model` replaces only the route model and must honor that level.

## Scope boundary

`delegate_task` and library callers remain generic. The package does not own checked implementation orchestration.

## Consequences

The executor remains a stable mechanism while callers own semantic protocols, shared workspace and state, validation, review, retry decisions, integration, cleanup, and bounds.
