# 005. Knowledge Tier Model (Git Owns Durable Knowledge)

- **Status:** accepted
- **Supersedes:** Obsidian vault decisions "Knowledge Location Boundaries" and "Package Memory Boundaries" (content preserved in this ADR's Context; vault files are torn down separately)
- **Date:** 2026-08-22

## Context

Durable agent knowledge for this project previously lived in an Obsidian vault under `projects/Pi/Packages`, split into per-package `Agent/Memory/` subtrees:

- *Knowledge Location Boundaries* (2026-08-09): keep README.md, CONTEXT.md, and CONTEXT-MAP.md content in the repository; use Obsidian package subtrees only for durable decisions and guidance. Moving or mirroring repository documentation into Obsidian would remove public context or create duplicate sources that drift.
- *Package Memory Boundaries* (2026-08-09): give every public workspace package its own Obsidian project subtree and package-local AGENTS.md declaration, so package work resolves only its package knowledge while repository-wide memory remains a router.

Both decisions correctly kept public docs in git, but the vault-side decision/guidance tree (indexes, routers, wikilinks) duplicated structure that git already provides and added maintenance overhead. The vault's remaining unique value is being an iCloud-synced plain-markdown location for auto-managed memory files.

## Decision

Replace the vault decision/guidance subtrees with a tier model:

1. **Git owns all durable repo/project knowledge:**
   - `docs/adr/` — numbered ADRs for every durable decision and guidance note (this directory).
   - `CONTEXT.md` / `CONTEXT-MAP.md` — domain routing.
   - `AGENTS.md` — agent instructions.
2. **Obsidian vault is reduced to a dumb iCloud sync pipe** holding exactly two auto-managed files written by the upcoming `@henryqw/pi-memory` extension:
   - `MEMORY.md`
   - `USER.md`

   No hand-maintained decision/guidance trees, indexes, or routers remain in the vault.
3. **`.context/progress.md` remains per-worktree task scratch** — resumable multi-step work state, not durable knowledge.
4. **Promotion flow:** insights accumulate in memory (`MEMORY.md`), get proposed via PR into repo docs (`docs/adr/`, `CONTEXT.md`), and only land in `AGENTS.md` once accepted — then the memory entry is removed.

## Consequences

- One source of truth per tier; no vault/repo drift for decisions.
- Package-scoped knowledge becomes package-prefixed ADRs (e.g. `NNN-pi-auto-dag-worker-profiles.md`) instead of vault subtrees; per-package AGENTS.md declarations of Obsidian projects are retired with teardown.
- The vault needs no structure beyond the two memory files.

## Notes

Vault teardown (deleting `*/Agent/Memory/**`) is a separate later task; this ADR governs the target state.
