# 017. Consumer-Owned Task-Model Routing

- **Status:** accepted
- **Date:** 2026-08-29

## Context

Task-model routing defaults are centralized in `DEFAULT_TASK_ASSIGNMENTS` inside `@henryqw/pi-task-models`, so the shared routing package must name every consumer task and release when a consumer changes its defaults. Moving model settings into each consumer config would instead duplicate routing policy, while bundling the shared control plane into consumers would create duplicate extensions. The architecture also needs a clear boundary between current-session-agent work and independently executed model operations.

## Decision

**Model Task definition.** A **Model Task** exists only for an independently executed model operation — not for work performed by the current session agent. Each consumer owns its Model Task ID, label/purpose, execution/prompt, and default Task Profile.

**Ownership boundaries.**
- **Consumer** (each importing package): declares its Model Tasks and default Task Profiles via namespaced Pi events at load time. Owns task identity and intent.
- **@henryqw/pi-task-models**: owns shared Task Profiles (`fast`, `balanced`, `frontier`, `fav`), explicit user Task overrides, route resolution, and configuration UI. Does not own consumer defaults.
- **Pi model registry**: owns available models, authentication, and capabilities. Task Routes resolve model references against the registry; they do not copy model metadata.

**Configuration persistence.** Shared config persists **explicit user overrides only**. Startup never writes consumer defaults. Consumer declarations are the source of truth for defaults; user overrides layer on top.

**Discovery and registration.** Replace centralized `DEFAULT_TASK_ASSIGNMENTS` with consumer declarations. Resolvers accept the consumer declaration directly. The control-plane extension discovers active declarations through an idempotent, namespaced Pi event request/response handshake, so either extension load order works. No central consumer-task map remains.

**SDK consumption.** Consumers import `@henryqw/pi-task-models` as a normal runtime dependency. They do **not** bundle or activate duplicate task-model control-plane extensions. The control plane is installed once as a top-level Pi package.

**No core package split.** Absent evidence, `@henryqw/pi-task-models` remains a single package.

**pi-memory specifics.** `pi-memory` declares the independently invoked `pi-memory/reviewCandidate` Model Task with default **balanced** Profile and imports `@henryqw/pi-task-models` as a normal runtime dependency. `/dream` and the final memory check stay current-agent work until separately executed.

## Consequences

- Dependency inversion: consumers declare, `pi-task-models` resolves. No package-wide model settings, no central defaults map.
- Request/response discovery avoids making extension load order part of the contract.
- Single control-plane extension prevents duplicate UI/state conflicts.
- `pi-memory` uses task-model routing only for independent candidate review; current-agent commands add no routed model invocation.
- Clear boundary: "Model Task" = independent model execution only.

## Rejected Alternatives

- **Central `DEFAULT_TASK_ASSIGNMENTS` map**: load-order fragile, couples consumers to pi-task-models internals, prevents independent default evolution.
- **Bundled control-plane per consumer**: duplicate extensions, conflicting UI/state, wasted resources.
- **Splitting pi-task-models into core + UI**: premature; single package serves both concerns today.
- **Making all pi-memory commands Model Tasks**: conflates current-agent work with independent execution; adds routing where none is needed.