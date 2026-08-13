# Pi Subagent Context

## Purpose

Run one bounded task in one isolated Pi child process using a configured role.

## Domain glossary

- **Main**: Pi session delegating work.
- **Subagent**: isolated Pi child process handling one task.
- **Role**: user-owned Markdown profile defining name, description, system instructions, exact tools, extensions, and Skill names.
- **Route**: model and thinking-level pair selected for one delegation; defaults to Main route.
- **Delegated Task**: one bounded work request sent from Main to one Role.

## Invariants

- One Delegated Task creates one ephemeral child process and no saved session.
- Ambient child extensions and Skills stay disabled; Role explicitly selects resources.
- Role Skill names resolve through Main's effective Pi Skill registry; unavailable names warn and skip without blocking delegation.
- Main selects Role and may select Route per task.
- Role config lives only in user `config/pi-subagent` directory; repository roles do not execute.
