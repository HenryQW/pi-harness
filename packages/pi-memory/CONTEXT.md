# pi-memory — Context

## Domain

Session-scale, cross-session scratch memory for the Pi agent: two auto-managed markdown stores (`MEMORY.md` = agent notes, `USER.md` = user profile), each a list of entries delimited by `\n§\n`, size-capped in characters (model-independent).

## Boundary

| Concern | Home |
| --- | --- |
| Task progress (this session/worktree) | `.context/progress.md` |
| Session-scale facts, user preferences | this extension's `MEMORY.md` / `USER.md` |
| Durable repo/project knowledge | `docs/adr/`, root `AGENTS.md`, package `CONTEXT.md` files |

Knowledge-tier model and vault-as-sync-pipe decision: [ADR 005](../../docs/adr/005-knowledge-tier-model.md). Global-store threat model: [ADR 006](../../docs/adr/006-pi-memory-global-store-threat-model.md).

Promotion flow: recurring memory entries are promoted into `AGENTS.md`/`CONTEXT.md` via PR, then removed from the memory store. The memory store is an inbox with exits, not an archive.
