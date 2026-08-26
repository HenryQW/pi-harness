# `@henryqw/pi-memory`

Auto-managed markdown memory for Pi: two size-capped entry stores (`MEMORY.md`, `USER.md`) with a frozen system-prompt snapshot per session.

## Why

- **Created for**: Giving Pi compact global notes and user facts that survive across sessions.
- **Advantage**: Size-capped, auto-managed Markdown stores provide predictable prompt cost without a hand-maintained knowledge tree.
- **Inspired by**: [Hermes Agent](https://github.com/NousResearch/hermes-agent) and its bounded `MEMORY.md`/`USER.md` cross-session memory pattern.

## Install

```bash
pi install npm:@henryqw/pi-memory
```

## Use

| Surface | Type | Purpose |
| --- | --- | --- |
| `memory` | tool | Add, replace, remove, or batch-edit entries across sessions. |

The extension maintains two markdown stores: `MEMORY.md` (global agent notes shared across all projects — do not store project-specific facts here, those belong in the repo) and `USER.md` (user profile). Each file holds `§`-delimited entries and is size-capped — 8800 characters by default for `MEMORY.md`, 5500 for `USER.md`. When a write would exceed the cap, the tool rejects it and reports current usage; consolidate by issuing one batch that removes or shortens stale entries and adds the new entry together (batch checks the final size only). If the on-disk file exceeds the cap (external edit or sync), the session snapshot omits the overflow and warns instead of injecting it.

At session start, the current contents of both stores are frozen into the system prompt; later edits during the session do not alter what the model already saw. Each turn also includes a short memory check: save explicit durable preferences or corrections immediately, inferred habits after two independent signals from the conversation and/or existing profile, merge overlaps, and skip project- or repository-specific facts, task-local behavior, progress, and temporary preferences.

To inspect live state, read `<directory>/MEMORY.md`.

## Config

`~/.pi/agent/config/pi-memory/config.json`

```json
{
  "directory": "/absolute/path/to/memory",
  "memoryCharLimit": 8800,
  "userCharLimit": 5500
}
```

- `directory`: absolute path where `MEMORY.md` and `USER.md` live. Required only when overriding the default (`~/.pi/agent/config/pi-memory/memory`). Point it at an iCloud- or Obsidian-synced folder to sync across machines.
- `memoryCharLimit` / `userCharLimit`: positive integers, maximum 100000.

Invalid configuration fails fast; malformed config files are never rewritten.

## Storage & sync

Point `directory` at an iCloud Drive or Obsidian-vault-synced folder. The synced vault acts as a dumb sync pipe: pi-memory owns the file format and treats the remote as opaque storage, so no merge logic runs on the Pi side.

Backups and the lock file live outside `directory`, under `~/.pi/agent/config/pi-memory/backups/`.

## Threat model

Because the directory can be a globally synced location readable outside Pi, review [`ADR 006 — pi-memory global store threat model`](https://github.com/HenryQW/pi-packages/blob/main/docs/adr/006-pi-memory-global-store-threat-model.md) before pointing it at a shared or cloud-synced path.

## Remove

```bash
pi remove npm:@henryqw/pi-memory
```

## Development

```bash
npm test --workspace @henryqw/pi-memory
npm run typecheck --workspace @henryqw/pi-memory
npm run pack:check --workspace @henryqw/pi-memory
```
