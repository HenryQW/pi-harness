# 021. pi-subagent Widget

- **Status:** accepted
- **Date:** 2026-08-13 (migrated from Obsidian vault)

## Decision

Show active Subagents in one responsive aligned TUI widget with only working, success, failure, and abort states; display one cumulative token total and elapsed time, then auto-remove terminal rows after one second.

## Context

Child Pi JSON events provide exact process state and per-turn usage, so the widget needs no Herdr polling, reconciliation, retained terminals, or intermediate tool phases.

## Consequences

Role/route and task text truncate before right-aligned token and elapsed columns; cumulative usage sums authoritative `usage.totalTokens` once per assistant turn; an empty widget occupies no rows.

Alternatives rejected: persistent terminal rows (need manual cleanup); tool-by-tool status (noise); token categories and context ratios (crowd narrow terminals); unaligned strings (hard to scan).

## Notes

Source: user-approved widget implementation. Files: `packages/pi-subagent/README.md`, `packages/pi-subagent/extensions/subagent.ts`.
