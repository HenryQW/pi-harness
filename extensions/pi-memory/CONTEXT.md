# pi-memory — Context

## Domain

Cross-session scratch memory for the Pi agent: global `MEMORY.md` and `USER.md`, plus one trusted project-root `MEMORY.md`. Each store is a list of entries delimited by `\n§\n` and size-capped in characters. Adds are independently reviewed through the local `pi-memory/reviewCandidate` Model Task (default `balanced`) against live SYSTEM and all active stores; `/dream` and final memory qualification remain current-session-agent workflows.

## Boundary

| Concern | Home |
| --- | --- |
| Task progress (this session/worktree) | `.context/progress.md` |
| Cross-project facts and user preferences | global `MEMORY.md` / `USER.md` |
| Project-scoped scratch knowledge | trusted project-root `MEMORY.md` |
| Authoritative repo/project knowledge | `docs/adr/`, root `AGENTS.md`, package `CONTEXT.md` files |

Knowledge-tier model: [ADR 005](../../docs/adr/005-knowledge-tier-model.md). Global-store threat model: [ADR 006](../../docs/adr/006-pi-memory-global-store-threat-model.md).

Promotion flow: recurring memory entries are promoted into `AGENTS.md`/`CONTEXT.md` via PR, then removed from memory. Memory is an inbox with exits, not an archive.
