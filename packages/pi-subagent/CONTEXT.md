# Pi Subagent Context

## Purpose

Provide validated user Roles, shared task-model Pi launch policy, generic managed Herdr Subagent hosting, a `delegate_task` extension that runs one selected bounded workflow in one or more ephemeral child processes, and a bundled Main-side `pi-subagent-delegated-development` orchestration Skill (policy text only; no runtime behavior).

## Domain glossary

- **Main**: Pi session delegating work.
- **Subagent**: isolated Pi child process handling one task.
- **Role**: user-owned Markdown definition of a reusable responsibility, with a name, description, system instructions, optional base tool allowlist, extensions, and Skill names.
- **Model Class**: `fast`, `balanced`, `frontier`, or `fav`, assigned in shared task-model settings or overridden by Main from task complexity.
- **Route**: configured model and thinking-level pair selected from a shared Model Class profile; the primary route precedes its optional fallback.
- **Delegated Task**: one bounded work request sent from Main to one Role.
- **Workflow**: orchestration of one or more Delegated Tasks; `delegate_task` owns its selected mode, while library callers compose executor runs in JavaScript.
- **Workflow Mode**: `delegate_task` tool policy selected per call for `single`, `parallel`, or `chain` execution; not a Role property or executor API.
- **Resource Policy**: Role ownership of base tools, extensions, and Skill names, plus explicit caller additions of tools, extensions, and environment through `createRoleLaunch`.
- **Pi Launch**: reusable `{env,args}` policy for one Role, resolved model route, explicit caller resources, and project trust.
- **Ephemeral Executor**: mechanism that receives a prepared Pi Launch, runs one bounded Delegated Task in one no-session child process, and returns its result without discovering resources or composing a Workflow.
- **Managed Subagent**: Pi agent hosted in a reconciled Herdr tab or pane; lifecycle orchestration remains with the caller.

## Invariants

- One Delegated Task creates one ephemeral child process and no saved session. Timeout behavior: `deadline = min(last recognized Pi JSON event + idle timeout, child start + maximum runtime)` (recognized Pi events renew; raw bytes do not; max always terminates). Configurable via the `timeout` object in `~/.pi/agent/config/pi-subagent/pi-subagent.json` (`idleMinutes`, `maxMinutes`; defaults 10/30).
- Up to five active ephemeral `delegate_task` children run per Main by default, configurable via `maxSubagents` in `~/.pi/agent/config/pi-subagent/pi-subagent.json` or the `PI_SUBAGENT_MAX_SUBAGENTS` environment variable; excess calls wait FIFO. Queued calls do not start a child or consume child timeout. Managed Herdr workers are unaffected.
- Ambient child extensions and Skills stay disabled; Role explicitly selects extension sources and named Skills. Pi loads Skills supplied by those extension packages or their resource discovery. With Role and caller tools omitted, no allowlist is installed and Pi uses its defaults. Caller tools with omitted Role tools snapshot Main's effective active built-ins into the installed policy; explicit Role tools set the base. Loaded extension tools activate automatically in every case.
- Role Skill names resolve through Main's effective Pi Skill registry; unavailable names warn and skip without blocking delegation.
- Main selects Role and may override Model Class and thinking level per task; omitted class uses shared `pi-subagent/delegateTask` assignment, initially `balanced`. Library callers select Role plus their own shared task ID.
- The selected profile resolves primary then fallback only before launch when a route, model, or thinking level is unavailable. If neither route is usable, launch rejects with `Run /task-models`; a started child is never retried by this package.
- Role Markdown files and Subagent JSON config live only in the user `config/pi-subagent` directory; model routes live in shared `config/pi-task-models.json`; repository roles do not execute.
- Numbered Codex routes prefer Main's active account slot and explicitly load the multi-Codex child extension.
- Generic Herdr host functions validate workspace ownership and provisioning identity while callers retain domain state, prompts, and lifecycle decisions.
