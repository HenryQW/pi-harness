# 019. Unified pi-subagent orchestration

- **Status:** accepted
- **Date:** 2026-09-06

## Context

Generic Role delegation and durable checked implementation graphs shared the same Role, route, executor, evidence, and worktree mechanisms but were shipped as separate packages. That split duplicated configuration and installation, exposed overlapping tools, and forced callers to choose package ownership before choosing execution semantics.

A productive checked request may also wait for explicit acceptance or deliberate recovery. One whole-run wall-clock deadline made valid retained work expire even though child processes and every external operation already had finite safety bounds.

## Decision

`@henryqw/pi-subagent` is the sole owner of both paths behind `delegate_task`:

- `mode: "direct"` runs compact text or checked changeset work in Main's checkout;
- `mode: "isolated"` runs durable checked text and changeset graphs with Herdr workers.

The mode is explicit and never falls back. Roles own responsibility and capabilities, not isolation.

The isolated path owns strict request/state schemas, dependency waves, exact allocation intent, retained workers, preliminary and authoritative checks, optional exact-`PASS` judgment, scoped or supervised candidate acceptance, guarded Main integration, durable recovery, exact termination, and conservative cleanup.

Execution policy comes only from `config/pi-subagent/config.json`. Request fields cannot override or replenish concurrency, child turn/token/runtime, or correction limits. Durable state records the policy and correction count. Productive execution has no whole-run wall-clock deadline. Child limits, abort propagation, process I/O, status inspection, termination, and cleanup retain finite independent bounds.

Pi remains Role and model resource authority. Herdr owns isolated worker processes. The extension stops at checked local integration and never pushes, publishes, deploys, or opens a pull request.

The previous separate package and its tool names are removed rather than retained as aliases. Older durable formats are rejected explicitly; there is no silent migration or fallback.

## Consequences

Users install and configure one delegation package. Main chooses semantics per request. Direct delegation stays lightweight, while isolated work gains durable exact-evidence guarantees without a second Role catalog or policy source.

Long supervised waits and later recovery do not expire due to elapsed wall time. Safety remains local to the child or external operation that can actually stall.
