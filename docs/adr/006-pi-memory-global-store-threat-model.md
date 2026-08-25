# 006. pi-memory Global Store Threat Model

- **Status:** accepted
- **Date:** 2026-08-22

## Context

`@henryqw/pi-memory` writes `MEMORY.md` and `USER.md` to a user-synced directory. A package-level permission gate would not constrain an agent that already has local filesystem access.

## Decision

Do not add a permission layer around the store. The supported deployment is a single-user machine; the files protect against accidental loss and drift, not adversarial local processes. Keep data plain, visible, size-bounded, and recoverable through the sync provider.

## Consequences

Correctness comes from transparent files and the promotion boundary in ADR 005. Revisit only for multi-user or remote execution.
