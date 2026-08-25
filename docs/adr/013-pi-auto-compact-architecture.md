# 013. pi-auto-compact Architecture

- **Status:** accepted
- **Date:** 2026-08-24

## Context

Automatic compaction must avoid competing lifecycle owners, preserve task continuity, and keep model policy shared with other task-routed packages.

## Decision

- `@henryqw/pi-auto-compact` is the sole automatic compaction owner and refuses activation while Pi's built-in auto-compaction is enabled.
- `/auto-compact` configures only the threshold. The `pi-auto-compact/autoCompact` shared task assignment selects primary and fallback routes; if neither is usable, compaction uses the current session model.
- Overrides affect extension-owned automatic compaction only. Manual `/compact` remains native.
- A mid-task automatic compaction resumes the current task.
- Before repeated extension compactions, merge the latest compaction's read and modified paths into the next automatic preparation so cumulative file history is retained.

## Consequences

Only one lifecycle can trigger automatic compaction, model routing has one authority, and repeated compactions do not lose earlier file context. Remove the local file-history carry-forward if Pi preserves extension-provided details natively.
