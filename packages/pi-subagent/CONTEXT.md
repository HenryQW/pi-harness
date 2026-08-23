# Pi Subagent Context

## Purpose

Provide validated user Roles, shared task-model Pi launch policy, generic managed Herdr Subagent hosting, and a `delegate_task` extension that runs one bounded task in one isolated child process.

## Domain glossary

- **Main**: Pi session delegating work.
- **Subagent**: isolated Pi child process handling one task.
- **Role**: user-owned Markdown profile defining name, description, system instructions, optional exact tool allowlist, extensions, and Skill names.
- **Model Class**: `fast`, `balanced`, `frontier`, or `fav`, assigned in shared task-model settings or overridden by Main from task complexity.
- **Route**: configured model and thinking-level pair selected from a shared Model Class profile; the primary route precedes its optional fallback.
- **Delegated Task**: one bounded work request sent from Main to one Role.
- **Pi Launch**: reusable `{env,args}` policy for one Role, resolved model route, explicit caller resources, and project trust.
- **Managed Subagent**: Pi agent hosted in a reconciled Herdr tab or pane; lifecycle orchestration remains with the caller.

## Invariants

- One Delegated Task creates one ephemeral child process and no saved session. Default timeouts: 10-minute soft deadline; active model/tool execution or activity within the last minute grants one 5-minute grace period before a hard stop. Every value is configurable via the `timeout` object in `~/.pi/agent/config/pi-subagent/pi-subagent.json` (`softMinutes`, `graceMinutes`, `activeWindowSeconds`).
- Up to five active ephemeral `delegate_task` children run per Main by default, configurable via `maxSubagents` in `~/.pi/agent/config/pi-subagent/pi-subagent.json` or the `PI_SUBAGENT_MAX_SUBAGENTS` environment variable; excess calls wait FIFO. Queued calls do not start a child or consume child timeout. Managed Herdr workers are unaffected.
- Ambient child extensions and Skills stay disabled; Role explicitly selects extension sources and named Skills. Pi loads Skills supplied by those extension packages or their resource discovery. Omitted Role tools use Pi's effective `defaultTools`; an explicit list sets base tools while loaded extension tools activate automatically.
- Role Skill names resolve through Main's effective Pi Skill registry; unavailable names warn and skip without blocking delegation.
- Main selects Role and may override Model Class and thinking level per task; omitted class uses shared `pi-subagent/delegateTask` assignment, initially `balanced`. Library callers select Role plus their own shared task ID.
- The selected profile resolves primary then fallback only before launch when a route, model, or thinking level is unavailable. If neither route is usable, launch rejects with `Run /task-models`; a started child is never retried by this package.
- Role and Subagent JSON config live only in the user `config/pi-subagent` directory; model routes live in shared `config/pi-task-models.json`; repository roles do not execute.
- Numbered Codex routes prefer Main's active account slot and explicitly load the multi-Codex child extension.
- Generic Herdr host functions validate workspace ownership and provisioning identity while callers retain domain state, prompts, and lifecycle decisions.
