# Architecture Decision Records

Current durable architecture for the pi-packages monorepo. Package-specific ADRs use the package name in the filename.

## Repository-wide

- [001 — Independent Package Releases](001-independent-package-releases.md)
- [002 — Shared Herdr CLI Client](002-shared-herdr-cli-client.md)
- [003 — Prepare Dependencies at Worktree Creation](003-worktree-dependency-preparation.md)
- [004 — Extension Config Safety](004-extension-config-safety.md)
- [005 — Knowledge Tier Model](005-knowledge-tier-model.md)
- [006 — pi-memory Global Store Threat Model](006-pi-memory-global-store-threat-model.md)
- [017 — Consumer-Owned Task-Model Routing](017-consumer-owned-task-model-routing.md)

## Package architecture

- [013 — pi-auto-compact Architecture](013-pi-auto-compact-architecture.md)
- [016 — pi-subagent Architecture](016-pi-subagent-architecture.md)

## Retired package architecture

- [007 — pi-auto-dag Execution Engine](007-pi-auto-dag-execution-engine.md)

## Process

Propose durable decisions through a pull request. ADRs describe the current accepted architecture, not a full implementation chronology. When a decision changes, fold any enduring rationale and invariants into the current ADR and remove obsolete text or files; git retains the history.

See ADR 005 for knowledge ownership: git owns project knowledge, the memory store holds only auto-managed cross-project memory, and `.context/progress.md` holds resumable task state.
