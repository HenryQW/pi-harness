# 016. pi-subagent Architecture

- **Status:** accepted
- **Date:** 2026-08-24

## Context

Delegation needs portable user-owned capabilities, shared model policy, bounded context transfer, and two distinct lifecycles: disposable tasks and durable caller-managed workers.

## Decision

- Roles are user-owned Markdown files in `config/pi-subagent/`, combining instructions with explicit tools, extensions, and Skill names. Repository Roles do not execute.
- Role Skill names resolve through Main's effective Pi registry. Ambient child resources stay disabled; explicitly selected extensions may contribute their Pi-discovered tools and Skills. Missing named Skills warn and skip.
- Model and thinking routes remain separate from Role capability. They resolve through `@henryqw/pi-task-models`; fallback is attempted only before launch, and a started child is never retried.
- Each `delegate_task` runs one bounded task in an ephemeral `pi --mode json -p --no-session` child with abort propagation, configurable idle/hard deadlines, and bounded concurrency. Main owns decomposition, integration, and cross-cutting decisions.
- Main-visible streaming updates, results, and errors are capped at 50 KiB. Unused JSON event payloads are discarded before buffering.
- Generic managed Herdr hosting is a separate library surface for workers that must survive orchestrator pauses or restarts. Callers retain domain prompts, state, and lifecycle decisions.
- The TUI widget projects active ephemeral children and briefly shows terminal status; it owns no lifecycle state.

## Consequences

Pi remains the resource authority, task-model configuration remains the routing authority, and one package supplies isolation for both short delegation and durable managed hosting without owning caller orchestration.
