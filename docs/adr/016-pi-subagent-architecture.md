# 016. pi-subagent Architecture

- **Status:** accepted
- **Date:** 2026-08-24

## Context

Delegation needs portable user-owned capabilities, shared model policy, bounded context transfer, and distinct lifecycles for disposable tasks, package-owned Git Flow, and durable caller-managed workers.

## Decision

- Roles are user-owned Markdown files in `config/pi-subagent/`, combining instructions with explicit tools, extensions, and Skill names. Package-shipped `implementer` and `reviewer` Roles are defaults; a same-named user Role overrides them for generic delegation and Flow. Flow resolves and freezes both effective Roles when it starts.
- Role Skill names resolve through Main's effective Pi registry. Ambient child resources stay disabled; explicitly selected extensions may contribute their Pi-discovered tools and Skills. Missing named Skills warn and skip.
- Model and thinking routes remain separate from Role capability. They resolve through `@henryqw/pi-task-models`; fallback is attempted only before launch, and a started child is never retried.
- `delegate_task` remains generic: it runs one bounded task in an ephemeral `pi --mode json -p --no-session` child, with abort propagation, configurable idle/hard deadlines, bounded concurrency, and its flat `single`, `parallel`, or `chain` policy. Its ordinary plan/file review and non-Git/unborn-`HEAD` behavior do not require Flow Git preparation.
- `delegate_flow` is a separate fixed package-owned workflow. One memory-only Flow creates one Unit Worktree per independent unit, runs effective-role Implementers in parallel, then in declared order rebases in place when needed, validates, sends exact `{base, tip, patchPath}` evidence to the effective Reviewer in that same worktree, and fast-forwards only an exact-`PASS` full reviewed OID. It supports one same-worktree repair through `delegate_flow_continue({ guidance })`; units whose rebase drops all commits still validate but skip review and merge as no-ops, rebase conflicts are terminal, and non-forced cleanup refusal is a completion warning.
- Main-visible streaming updates, results, and errors are capped at 50 KiB. Unused JSON event payloads are discarded before buffering.
- The bundled delegated-development Skill is Main-side policy only. Flow owns its fixed Git mechanics; the Skill does not change generic delegation behavior.
- Generic managed Herdr hosting is a separate library surface for workers that must survive orchestrator pauses or restarts. Callers retain domain prompts, state, and lifecycle decisions.
- The TUI widget projects active ephemeral children and briefly shows terminal status; it owns no lifecycle state.

## Consequences

Pi remains the resource authority, task-model configuration remains the routing authority, and one package supplies generic ephemeral delegation, fixed Flow orchestration, and durable managed hosting without making the executor a general workflow engine.
