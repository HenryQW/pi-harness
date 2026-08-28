# Pi Subagent Context

## Purpose

Provide validated built-in and user Roles, shared task-model Pi launch policy, generic managed Herdr Subagent hosting, generic `delegate_task` delegation, and package-owned `delegate_flow` Git orchestration. `delegate_task` remains a flat bounded delegation tool; Flow uses package-shipped Roles and owns its fixed implementation, validation, exact review, integration, and cleanup mechanics. The bundled Main-side Skill adds no runtime behavior or changes generic fallback.

## Domain glossary

- **Main**: Pi session delegating work.
- **Subagent**: isolated Pi child process handling one task.
- **Role**: package-shipped built-in or user-owned Markdown definition of a reusable responsibility, with a name, description, system instructions, optional base tool allowlist, extensions, and Skill names.
- **Model Class**: `fast`, `balanced`, `frontier`, or `fav`, assigned in shared task-model settings or overridden by Main from task complexity.
- **Route**: configured model and thinking-level pair selected from a shared Model Class profile; the primary route precedes its optional fallback.
- **Delegated Task**: one bounded work request sent from Main to one Role.
- **Workflow**: generic orchestration of one or more Delegated Tasks; `delegate_task` owns its selected mode, while library callers compose executor runs in JavaScript.
- **Workflow Mode**: `delegate_task` tool policy selected per call for `single`, `parallel`, or `chain` execution; not a Role property or executor API.
- **Flow**: package-owned, memory-only Git implementation and integration workflow started by `delegate_flow`.
- **Unit Worktree**: one Flow-owned worktree and branch for one Flow unit; it is reused for rebase, validation, review, and one repair.
- **Review Packet**: exact `{base, tip, patchPath}` evidence delivered to the Flow Reviewer in the Unit Worktree.
- **Resource Policy**: Role ownership of base tools, extensions, and Skill names, plus explicit caller additions of tools, extensions, and environment through `createRoleLaunch`.
- **Pi Launch**: reusable `{env,args}` policy for one Role, resolved model route, explicit caller resources, and project trust.
- **Ephemeral Executor**: mechanism that receives a prepared Pi Launch, runs one bounded Delegated Task in one no-session child process, and returns its result without discovering resources or composing a Workflow.
- **Managed Subagent**: Pi agent hosted in a reconciled Herdr tab or pane; lifecycle orchestration remains with the caller.

## Invariants

- One Delegated Task creates one ephemeral child process and no saved session. Timeout behavior: `deadline = min(last recognized Pi JSON event + idle timeout, child start + maximum runtime)` (recognized Pi events renew; raw bytes do not; max always terminates). After direct Pi exits, inherited stdout/stderr drain until EOF unless an escaped descendant holds them past short inactivity or a one-second hard deadline. Configurable via the `timeout` object in `~/.pi/agent/config/pi-subagent/pi-subagent.json` (`idleMinutes`, `maxMinutes`; defaults 10/30).
- Up to five active ephemeral `delegate_task` children run per Main by default, configurable via `maxSubagents` in `~/.pi/agent/config/pi-subagent/pi-subagent.json` or the `PI_SUBAGENT_MAX_SUBAGENTS` environment variable; excess calls wait FIFO. Queued calls do not start a child or consume child timeout. Managed Herdr workers are unaffected.
- Ambient child extensions and Skills stay disabled; Role explicitly selects extension sources and named Skills. Pi loads Skills supplied by those extension packages or their resource discovery. With Role and caller tools omitted, no allowlist is installed and Pi uses its defaults. Caller tools with omitted Role tools snapshot Main's effective active built-ins into the installed policy; explicit Role tools set the base. Loaded extension tools activate automatically in every case.
- Role Skill names resolve through Main's effective Pi Skill registry; unavailable names warn and skip without blocking delegation. Explicit Role/caller tool names verify against the final filtered child registry after explicit provider `session_start` handlers, and unavailable names fail before the first turn.
- Main selects Role and may override Model Class and thinking level per task; omitted class uses shared `pi-subagent/delegateTask` assignment, initially `balanced`. Library callers select Role plus their own shared task ID.
- The selected profile resolves primary then fallback only before launch when a route, model, or thinking level is unavailable. If neither route is usable, launch rejects with `Run /task-models`; a started child is never retried by this package.
- User Role Markdown files and Subagent JSON config live only in the user `config/pi-subagent` directory; model routes live in shared `config/pi-task-models.json`. Package-shipped built-in Roles (`implementer`, `reviewer`) resolve from the package's own `examples/roles/` Markdown through the same parser; a same-named user file explicitly overrides a built-in for generic `delegate_task`. Flow loads its package-shipped Roles directly.
- `delegate_flow` accepts 1–8 independent units with direct validation commands. One active Flow creates every Unit Worktree before launching package-shipped Implementers in parallel, then processes settled units in declared order. For each unit Flow rebases in place when earlier units advanced Main, validates in that worktree, sends the exact Review Packet to a read-only Reviewer in the same worktree, and integrates only exact `PASS` using `git merge --ff-only` with the full reviewed OID.
- Flow is memory-only. Only a post-rebase commit drop produces a no-op (`base === tip`); it validates, skips Reviewer and merge, then cleans up ordinarily. Initial zero-commit implementations block. Implementer, validation, or reviewer blocks allow one `delegate_flow_continue({ guidance })` repair in the same worktree; a second block is terminal. Rebase and evidence/Reviewer/infrastructure failures retain worktrees. A reported fast-forward failure retains its worktree unless Main is clean at the exact reviewed tip, which completes with the merge diagnostic as a warning. Cleanup uses non-forced worktree removal and branch deletion; cleanup refusal is a completion warning.
- Flow has no graph, saved recovery, automatic retry, aggregate review, or post-merge validation. It never changes generic `delegate_task` Role resolution, isolation, non-Git fallback, or ordinary direct plan/file review.
- Numbered Codex routes prefer Main's active account slot and explicitly load the multi-Codex child extension.
- Generic Herdr host functions validate workspace ownership and provisioning identity while callers retain domain state, prompts, and lifecycle decisions.
