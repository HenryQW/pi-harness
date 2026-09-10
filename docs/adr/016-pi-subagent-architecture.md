# 016. pi-subagent Architecture

- **Status:** accepted
- **Date:** 2026-08-24

## Context

Delegation needs portable user-owned capabilities, shared model policy, bounded context transfer, and an executor that larger packages can compose without inheriting workflow policy.

## Decision

- Roles are Markdown files in `config/pi-subagent/`. They combine instructions with explicit tools, extensions, Skill names, optional worktree isolation, and an optional `modelClass` default. Package-shipped `implementer`, `reviewer`, and `scout` Roles provide generic defaults. A same-named user Role overrides a built-in.
- Role Skill names resolve through Main's effective Pi registry. Ambient child resources stay disabled. Explicitly selected extensions may supply their Pi-discovered tools and Skills. Missing named Skills warn and skip.
- Model and thinking routes resolve through `@henryqw/pi-task-models`. Route precedence is call `modelClass`, then Role `modelClass`, then the configured Model Task assignment or declared default. A direct `model` changes only the model. A started child is never retried through fallback.
- `delegate_task` remains lightweight generic delegation. It runs one bounded task, independent parallel tasks, or a simple chain in ephemeral `pi --mode json -p --no-session` children. It owns abort propagation, bounded concurrency, deadlines, result transport, and optional isolated worktrees. It does not own checked implementation policy.
- The public package API exposes Role resolution, Pi launch policy, the ephemeral executor, low-level worktree lifecycle helpers, and exact review evidence. Callers own durable state, checks, review criteria, integration, retry, and cleanup policy.
- Worktree helpers never force-delete uncertain work. Exact review evidence binds a private patch to measured base and tip identities. Callers decide what to do with both results.
- Main-visible updates, results, and errors stay bounded. The TUI widget projects active ephemeral children and owns no durable lifecycle state.

## Consequences

Pi remains the resource authority, and task-model configuration remains the routing authority. pi-subagent provides a small generic Role and execution boundary. `@henryqw/pi-orchestrator` composes that boundary for durable checked local implementation graphs.
