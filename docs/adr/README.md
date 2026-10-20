# Architecture Decision Records

An Architecture Decision Record (ADR) records one current architecture choice. These ADRs describe the current architecture of the pi-harness monorepo. Package-specific ADR filenames include the package name.

## Repository-wide

- [001 — Independent Package Releases](001-independent-package-releases.md)
- [002 — Shared Herdr CLI Client](002-shared-herdr-cli-client.md)
- [004 — Extension Config Safety](004-extension-config-safety.md)
- [005 — Knowledge Tier Model](005-knowledge-tier-model.md)
- [017 — Consumer-Owned Task-Model Routing](017-consumer-owned-task-model-routing.md)
- [018 — Extension Config Homes](018-extension-config-homes.md)

## Package architecture

- [006 — pi-memory Global Store Threat Model](006-pi-memory-global-store-threat-model.md)
- [013 — pi-auto-compact Architecture](013-pi-auto-compact-architecture.md)
- [019 — Unified pi-subagent orchestration](019-pi-subagent-orchestration.md)
- [020 — pi-cron In-Session Scheduler](020-pi-cron-in-session-scheduler.md)
- [021 — One Herdr Workflow Extension](021-herdr-workflow-consolidation.md)

## Process

Propose lasting decisions through a pull request. ADRs describe accepted architecture, not a full implementation timeline.

When a decision changes, move lasting reasons and rules into the current ADR. Remove old text or files. Git keeps the history.

See [ADR 005](005-knowledge-tier-model.md) for knowledge ownership and storage rules.
