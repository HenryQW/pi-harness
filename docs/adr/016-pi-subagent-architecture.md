# 016. pi-subagent Architecture

- **Status:** accepted
- **Date:** 2026-08-24

## Context

Delegation needs portable user-owned capabilities, shared model policy, bounded context transfer, and distinct lifecycles for disposable tasks and package-owned Git Flow.

## Decision

- Roles are user-owned Markdown files in `config/pi-subagent/`, combining instructions with explicit tools, extensions, and Skill names. Package-shipped `implementer` and `reviewer` Roles are defaults; a same-named user Role overrides them for generic delegation and Flow. Flow always resolves/freezes its effective Implementer and resolves/freezes its Reviewer only when a requested unit declares an explicit `review` criterion.
- Role Skill names resolve through Main's effective Pi registry. Ambient child resources stay disabled; explicitly selected extensions may contribute their Pi-discovered tools and Skills. Missing named Skills warn and skip.
- Model and thinking routes remain separate from Role capability. They resolve through `@henryqw/pi-task-models`; fallback is attempted only before launch, and a started child is never retried. Main populates direct `model` and `thinking` only for explicit user overrides; otherwise it selects only `modelClass` (`fast` normally and `balanced` upfront for obvious complexity). This is policy, without provenance tracking or runtime enforcement.
- Main is the planner/orchestrator. `delegate_task` remains generic: it runs one bounded task in an ephemeral `pi --mode json -p --no-session` child, with abort propagation, configurable idle/hard deadlines, bounded concurrency, and its flat `single`, `parallel`, or `chain` policy. Its ordinary plan/file review and non-Git/unborn-`HEAD` behavior do not require Flow Git preparation.
- `delegate_flow` is a separate fixed package-owned workflow. A unit has direct validation, optional `modelClass`, and optional non-empty `review` judgment text. One memory-only Flow creates one Unit Worktree per independent unit, runs effective-role Implementers in parallel, then in declared order rebases in place when needed, inspects committed state, and validates. Validation is authoritative for objective verification: a unit without `review` fast-forwards its exact validated tip through the guarded path; a unit with `review` sends exact `{base, tip, patchPath}` evidence to the effective Reviewer in that same worktree and fast-forwards only exact-`PASS` full reviewed OID. It supports one same-worktree repair through `delegate_flow_continue({ guidance, modelClass? })`; omission retains the current unit class and presence replaces it for that repair. Units whose rebase drops all commits still validate but skip review and merge as no-ops, rebase conflicts are terminal, and non-forced cleanup refusal is a completion warning.
- Main-visible streaming updates, results, and errors are capped at 50 KiB. Unused JSON event payloads are discarded before buffering.
- The bundled delegated-development Skill is Main-side policy only. Flow owns its fixed Git mechanics; the Skill does not change generic delegation behavior.
- The TUI widget projects active ephemeral children and briefly shows terminal status; it owns no lifecycle state.

## Consequences

Pi remains the resource authority, task-model configuration remains the routing authority, and one package supplies generic ephemeral delegation and fixed Flow orchestration without making the executor a general workflow engine.
