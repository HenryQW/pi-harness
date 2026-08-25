# 005. Knowledge Tier Model

- **Status:** accepted
- **Date:** 2026-08-22

## Context

Project knowledge was split between git and a parallel Obsidian hierarchy. Duplicate indexes, routers, and decision trees drifted without adding authority.

## Decision

Use one owner per knowledge tier:

1. Git owns durable project knowledge: `docs/adr/`, `CONTEXT.md`, `CONTEXT-MAP.md`, and `AGENTS.md`.
2. The synced memory store holds only auto-managed cross-project `MEMORY.md` and `USER.md`.
3. `.context/progress.md` is resumable per-worktree task state, not durable knowledge.
4. Accepted project insights move from memory into repository docs; the memory copy is then removed.

## Consequences

Repository decisions stay reviewable and versioned without a parallel documentation tree. Package knowledge uses package-prefixed ADRs and package `CONTEXT.md` files.
