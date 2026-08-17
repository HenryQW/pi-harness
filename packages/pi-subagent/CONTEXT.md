# Pi Subagent Context

## Purpose

Provide validated user Roles, shared task-model Pi launch policy, generic managed Herdr Subagent hosting, and a `delegate_task` extension that runs one bounded task in one isolated child process.

## Domain glossary

- **Main**: Pi session delegating work.
- **Subagent**: isolated Pi child process handling one task.
- **Role**: user-owned Markdown profile defining name, description, system instructions, optional exact tool allowlist, extensions, and Skill names.
- **Model Class**: `fast`, `balanced`, or `frontier`, assigned in shared task-model settings or overridden by Main from task complexity.
- **Route**: configured model and thinking-level pair selected from a shared Model Class profile; the primary route precedes its optional fallback.
- **Delegated Task**: one bounded work request sent from Main to one Role.
- **Pi Launch**: reusable `{env,args}` policy for one Role, resolved model route, explicit caller resources, and project trust.
- **Managed Subagent**: Pi agent hosted in a reconciled Herdr tab or pane; lifecycle orchestration remains with the caller.

## Invariants

- One Delegated Task creates one ephemeral child process and no saved session.
- Ambient child extensions and Skills stay disabled; Role explicitly selects extensions and Skills. Omitted Role tools use Pi's effective `defaultTools` for built-ins; an explicit list is strict.
- Role Skill names resolve through Main's effective Pi Skill registry; unavailable names warn and skip without blocking delegation.
- Main selects Role and may override Model Class per task; omitted class uses shared `pi-subagent/delegateTask` assignment, initially `balanced`. Library callers select Role plus their own shared task ID.
- The selected profile resolves primary then fallback only before launch when a route, model, or thinking level is unavailable. If neither route is usable, launch rejects with `Run /task-models`; a started child is never retried by this package.
- Role config lives only in user `config/pi-subagent` directory; model routes live in shared `config/pi-task-models.json`; repository roles do not execute.
- Numbered Codex routes prefer Main's active account slot and explicitly load the multi-Codex child extension.
- Generic Herdr host functions validate workspace ownership and provisioning identity while callers retain domain state, prompts, and lifecycle decisions.
