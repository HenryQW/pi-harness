# 004. Extension Config Safety

- **Status:** accepted (guidance)
- **Date:** 2026-08-09

## Context

Extension JSON under `getAgentDir()/config` is user-owned, hand-editable, and untrusted. Startup must not destroy malformed data or silently weaken correctness.

## Decision

- Validate reads at the boundary.
- Preserve malformed files; never rewrite config during startup.
- Write only after explicit user action.
- Use explicit defaults only for optional settings; fail fast when invalid config would make execution unsafe.
- Store a package's sole config at `config/<extension>.json`; if it owns multiple files, store all under `config/<extension>/`.

## Consequences

Bad optional config can be reported without blocking unrelated use, while correctness-critical settings cannot silently fall back.
