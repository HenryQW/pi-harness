# 011. pi-auto-dag Required Gate Process Ownership

- **Status:** accepted (guidance)
- **Date:** 2026-08-11 (migrated from Obsidian vault)

## Context

Required gates run as detached processes that must survive host death and be recoverable after interruption. Host identity alone cannot terminate a detached command after host death, and sampling cancellation after command exit can discard valid completion.

## Guidance

Persist detached gate-host identity and isolated command process-group identity before releasing the user command. Recovery must verify identities, preserve completion already won, and otherwise durably mark cancellation before terminating the command group and cleaning the worktree.

## Watch for

PID reuse, zombies, startup races, background descendants, and completion-versus-cancellation ordering.

## Notes

Applies when changing required-gate launch, timeout, abort, resume, or cleanup. Source: PR #50 review 4904289152 and regression tests in `packages/pi-auto-dag/test/core.test.ts`.
