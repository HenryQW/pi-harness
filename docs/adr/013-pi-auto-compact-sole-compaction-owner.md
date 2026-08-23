# 013. pi-auto-compact Sole Compaction Owner

- **Status:** accepted
- **Date:** 2026-08-09 (migrated from Obsidian vault)

## Context

Competing compactors (extension and Pi built-in) can start duplicate summaries and break predictable Current-task resumption. Coexistence would reduce setup but permit duplicate compaction and lifecycle races.

## Decision

Make `pi-auto-compact` the sole automatic compaction owner and refuse activation while Pi built-in auto-compaction remains enabled.

## Consequences

Users disable built-in auto-compaction; the extension guards against duplicate runs and resumes only mid-task compactions.

## Notes

Files: `packages/pi-auto-compact/extensions/auto-compact.ts`.
