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
| `/remember <instruction>` | command | Process an instruction into compact durable memory, deduplicating against live entries. |
| `/dream` | command | Promote invariant memory instructions into the agent-global `~/.pi/agent/SYSTEM.md`. |
| `memory` | tool | Add, replace, remove, or batch-edit entries across sessions. |

The extension maintains two markdown stores: `MEMORY.md` (global agent notes shared across all projects — do not store project-specific facts here, those belong in the repo) and `USER.md` (user profile). Each file holds `§`-delimited entries and is size-capped — 8800 characters by default for `MEMORY.md`, 5500 for `USER.md`. When a write would exceed the cap, the tool rejects it and reports current usage; consolidate by issuing one batch that removes or shortens stale entries and adds the new entry together (batch checks the final size only). If the on-disk file exceeds the cap (external edit or sync), the session snapshot omits the overflow and warns instead of injecting it.

At session start, both stores are captured; later edits do not alter injected memory. Pi recommends `/dream` when memory is non-empty and no previous dream is recorded, the last dream was over 30 days ago, or either store is at least 70% full and the last dream was at least 7 days ago. `/dream` records its completed run time in `~/.pi/agent/config/pi-memory/last-dream.txt`, validates live state first, and reuses unchanged memory snapshots, but always requires the model to read and edit only the agent-global `~/.pi/agent/SYSTEM.md`—never a project `.pi/SYSTEM.md`. That global file must already exist and be readable; establish it deliberately and completely, because a partial SYSTEM replaces Pi's default prompt. Use `/remember <instruction>` to ask the agent to normalize and deduplicate an instruction against the live contents of both stores before using the memory tool; unsuitable project-specific, temporary, trivial, or otherwise unsuitable content is refused. Each turn also includes a short memory check: save explicit durable preferences or corrections immediately, inferred habits after two independent signals from the conversation and/or existing profile, merge overlaps, and skip project- or repository-specific facts, task-local behavior, progress, and temporary preferences.

To inspect live state, read `<directory>/MEMORY.md`.

## Config

Optional JSON file at the exact package-owned path `~/.pi/agent/config/pi-memory/config.json`. All fields are optional; a missing file uses defaults.

| Field | Required | Possible values | Default |
| --- | --- | --- | --- |
| `directory` | No | Non-empty absolute path without control characters, e.g. an iCloud- or Obsidian-synced folder | `~/.pi/agent/config/pi-memory/memory` |
| `memoryCharLimit` | No | Safe integer 1–100000 | `8800` |
| `userCharLimit` | No | Safe integer 1–100000 | `5500` |

Any other invalid configuration fails fast: malformed JSON, invalid UTF-8, files over 64 KiB, non-object roots, unknown keys, or out-of-range values throw an error naming the problem; the file is never rewritten.

## Storage & sync

Point `directory` at an iCloud Drive or Obsidian-vault-synced folder. The synced vault acts as a dumb sync pipe: pi-memory owns the file format and treats the remote as opaque storage, so no merge logic runs on the Pi side.

Backups and the lock file live outside `directory`, under `~/.pi/agent/config/pi-memory/backups/`.

## Threat model

Because the directory can be a globally synced location readable outside Pi, review [`ADR 006 — pi-memory global store threat model`](https://github.com/HenryQW/pi-packages/blob/main/docs/adr/006-pi-memory-global-store-threat-model.md) before pointing it at a shared or cloud-synced path.
