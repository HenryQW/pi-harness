# 016. pi-subagent Role and executor boundary

- **Status:** superseded by [ADR 019](019-pi-subagent-orchestration.md)
- **Date:** 2026-08-24

## Context

Delegation needs portable user-owned capabilities, shared model policy, bounded context transfer, and a reusable child executor.

## Decision

Roles are Markdown files under `config/pi-subagent/`. They combine instructions with explicit tools, trusted extension sources, Skill names, optional MCP server names, and an optional model-class default. Model routes come from `@henryqw/pi-task-models`. Ambient child resources remain disabled.

The package exposes Role resolution, Pi launch policy, a bounded FIFO ephemeral executor, conservative worktree lifecycle helpers, and exact review evidence. Main-visible transport remains bounded. Uncertain work is never force-deleted.

## Consequences

Pi remains the resource authority and task-model configuration remains routing authority. ADR 019 later unified durable checked orchestration into the same package and removed Role-owned isolation.
