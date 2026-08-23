# 015. pi-auto-compact Extension Compaction File History

- **Status:** accepted (guidance)
- **Date:** 2026-08-11 (migrated from Obsidian vault)

## Context

When returning extension-provided results from `session_before_compact` across repeated auto-compactions, Pi excludes `fromHook` compaction details while preparing later compactions — so prior file history would otherwise be dropped before the first extension compaction's records.

## Guidance

Merge the latest compaction entry's `details.readFiles` and `details.modifiedFiles` into the next automatic `preparation.fileOps` before generating the replacement compaction:

- Add prior reads to `fileOps.read` and prior modifications to `fileOps.edited`.
- Scope the merge to extension-owned automatic runs so manual `/compact` remains native.

## Consequences

Repeated configured-model compactions retain an authoritative cumulative file history instead of dropping paths recorded before the first extension compaction.

## Future attention

Remove this local carry-forward if Pi starts preserving extension-provided file details itself.

## Notes

Source: user correction confirmed by Pi Coding Agent 0.84.1 source and regression test. Files: `packages/pi-auto-compact/extensions/auto-compact.ts`, `packages/pi-auto-compact/test/activation.test.ts`.
