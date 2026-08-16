# Pi Subagent Context

## Purpose

Run one bounded task in one isolated Pi child process using a configured role.

## Domain glossary

- **Main**: Pi session delegating work.
- **Subagent**: isolated Pi child process handling one task.
- **Role**: user-owned Markdown profile defining name, description, system instructions, optional exact tool allowlist, extensions, and Skill names.
- **Model Class**: `fast`, `balanced`, or `frontier`, chosen by Main from task complexity.
- **Route**: configured model and thinking-level pair selected from Model Class; omitted class uses `balanced`, then Main route fallback.
- **Delegated Task**: one bounded work request sent from Main to one Role.

## Invariants

- One Delegated Task creates one ephemeral child process and no saved session.
- Ambient child extensions and Skills stay disabled; Role explicitly selects extensions and Skills. Omitted Role tools use Pi's effective `defaultTools` for built-ins; an explicit list is strict.
- Role Skill names resolve through Main's effective Pi Skill registry; unavailable names warn and skip without blocking delegation.
- Main selects Role and Model Class per task; omitted class uses configured `balanced`, then Main route fallback.
- Role config lives only in user `config/pi-subagent` directory; model routes live in user `config/pi-subagent.json`; repository roles do not execute.
