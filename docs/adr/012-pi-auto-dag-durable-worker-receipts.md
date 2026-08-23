# 012. pi-auto-dag Durable Worker Receipts

- **Status:** accepted (guidance)
- **Date:** 2026-08-11 (migrated from Obsidian vault)

## Context

A worker receipt written before its acceptance is durably recorded creates conflicts after restart; reusing a rejected action ticket poisons a corrected retry.

## Guidance

Persist accepted event binding and Run State before writing a successful receipt. After rejecting the current action ticket, rotate the ticket immediately. A worker retry may adopt the replacement only when action identity still matches.

## Watch for

Same-commit no-ops, receipt-write failure, stale tickets, and changed action identity.

## Notes

Applies when changing lifecycle worker-envelope acceptance, receipts, action tickets, or retry handling. Source: PR #50 review 4904289152 and regression tests in `packages/pi-auto-dag/test/orchestration.test.ts` and `test/handoff.test.ts`.
