# 005. Knowledge Tier Model

- **Status:** accepted
- **Date:** 2026-08-22
- **Updated:** 2026-08-31

## Context

Project knowledge was split between Git and a parallel Obsidian hierarchy. Duplicate indexes, routers, and decision trees drifted without adding authority.

Global memory must also stay useful across projects. Project facts do not meet that scope, but some useful facts are not ready for hand-written project documentation.

## Decision

Use one owner per knowledge tier:

1. Git owns authoritative project knowledge: `docs/adr/`, `CONTEXT.md`, `CONTEXT-MAP.md`, and `AGENTS.md`.
2. The synced global store holds auto-managed cross-project `MEMORY.md` and `USER.md`.
3. Each trusted project may use one auto-managed root `MEMORY.md`. Use the Git root, or Pi's current directory outside Git.
4. Keep `USER.md` global. Do not add folder-level memory inheritance.
5. `.context/progress.md` is resumable per-worktree task state, not durable knowledge.
6. Do not copy facts already represented in project documentation into project memory.

## Consequences

Global memory stays relevant across projects. Project facts can remain project-scoped before promotion into authoritative documentation.

Repository decisions stay reviewable and versioned. Teams may commit or ignore project `MEMORY.md` according to project policy.

A project has one memory scope. This avoids folder precedence and duplicate user profiles.
