# Architecture Decision Records

Numbered ADRs for durable decisions and guidance across the pi-packages monorepo. Package-specific ADRs are prefixed with their package name.

## Repository-wide

- [001 — Independent Package Releases](001-independent-package-releases.md)
- [002 — Shared Herdr CLI Client](002-shared-herdr-cli-client.md)
- [003 — Prepare Dependencies at Worktree Creation](003-worktree-dependency-preparation.md)
- [004 — Extension Config Safety](004-extension-config-safety.md)
- [005 — Knowledge Tier Model (Git Owns Durable Knowledge)](005-knowledge-tier-model.md) — supersedes former Obsidian vault decisions
- [006 — pi-memory Global Store Threat Model](006-pi-memory-global-store-threat-model.md)

## pi-auto-dag

- [007 — Trust Model](007-pi-auto-dag-trust-model.md) (partially superseded by 022)
- [008 — Config-Defined Worker Profiles](008-pi-auto-dag-config-defined-worker-profiles.md) (superseded by 009)
- [009 — Subagent-Owned Worker Infrastructure](009-pi-auto-dag-subagent-owned-worker-infrastructure.md) (partially superseded by 022)
- [010 — Widget Entry Lifecycle](010-pi-auto-dag-widget-entry-lifecycle.md) (partially superseded by 022)
- [011 — Required Gate Process Ownership](011-pi-auto-dag-required-gate-process-ownership.md)
- [012 — Durable Worker Receipts](012-pi-auto-dag-durable-worker-receipts.md)
- [022 — Execution Boundary](022-pi-auto-dag-execution-boundary.md)

## pi-auto-compact

- [013 — Sole Compaction Owner](013-pi-auto-compact-sole-compaction-owner.md)
- [014 — Dedicated Compaction Model](014-pi-auto-compact-dedicated-compaction-model.md)
- [015 — Extension Compaction File History](015-pi-auto-compact-compaction-file-history.md)

## pi-subagent

- [016 — Role Configuration](016-pi-subagent-role-configuration.md)
- [017 — Role Skill Resolution](017-pi-subagent-role-skill-resolution.md)
- [018 — Subagent Execution](018-pi-subagent-execution.md)
- [019 — Task Routing](019-pi-subagent-task-routing.md)
- [020 — Bounded Result Transport](020-pi-subagent-bounded-result-transport.md)
- [021 — Widget](021-pi-subagent-widget.md)

## Process

Propose new ADRs via PR. Superseded ADRs keep their number with `Status: superseded by <link>`. See ADR 005 for where knowledge lives: git owns durable knowledge; the Obsidian vault is only an iCloud sync pipe for auto-managed `MEMORY.md`/`USER.md`.
