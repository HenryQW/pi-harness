# Compose generic workflows outside the ephemeral executor

## Decision

The public task executor is an execution mechanism: it receives a prepared Pi Launch, runs one bounded Delegated Task, and returns the result. The `delegate_task` extension composes it for direct workflows and isolated checked graphs; those modes are not executor primitives.

Generic callers compose workflows with JavaScript. Fan-out and fan-in use promises and collections; sequencing uses ordinary control flow; review loops use explicit caller-owned bounds. The package does not define a recursive workflow AST.

Resource Policy is split at launch preparation:

- Pi Subagent alone parses and resolves effective Roles.
- Role owns base tools, extension capability bundles, Skill names, and an exact MCP server allowlist.
- Caller may add explicit tools, extensions, and environment through `createRoleLaunch`.
- `resolveConfiguredRoleLaunch` reloads the current Role, package resources, Skill registry, model route, and MCP policy for each launch.
- The prepared launch keeps the Role system prompt separate from prompt-free argv until the caller's final launch boundary.
- The executor receives the resulting Pi Launch and does not discover resources.

Built-in `implementer`, `reviewer`, and `scout` Roles ship as Markdown in `examples/roles/` and use the same parser as user Roles. For generic delegation, a same-named user Role explicitly overrides a built-in. The package does not install, copy, or write user configuration.

An explicit call `modelClass` selects a task-model route. Without one, an optional Role `modelClass` default wins; without either, the caller's Model Task assignment or declared default selects the route. The route owns its exact thinking level. A direct `model` replaces only the route model and must honor that level.

## Scope boundary

The executor remains generic and policy-free beyond child execution limits. Direct and isolated workflow policy belongs to the extension and checked runner, not the executor. External library callers may still compose the mechanism with their own protocols.

## Consequences

The executor remains stable while pi-subagent owns its direct and checked-isolated semantics. Mechanism callers continue to own any protocol they build outside those surfaces.
