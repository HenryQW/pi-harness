# Architecture Decision Records

An Architecture Decision Record (ADR) records one current architecture choice. These ADRs describe the current architecture of the pi-harness monorepo. Package-specific ADR filenames include the package name.

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

Propose lasting decisions through a pull request. ADRs describe accepted architecture, not a full implementation timeline.

When a decision changes, move lasting reasons and rules into the current ADR. Remove old text or files. Git keeps the history.

See ADR 005 for knowledge ownership. Git owns project knowledge.

The memory store holds only auto-managed cross-project memory. `.context/progress.md` holds task state that can resume.
