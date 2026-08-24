# 004. Extension Config Safety

- **Status:** accepted (guidance)
- **Date:** 2026-08-09 (migrated from Obsidian vault)

## Context

Pi extension config files under `getAgentDir()/config` are user-owned data that may be malformed or hand-edited. Naive handling can destroy user data at startup or let bad optional config block unrelated use.

## Decision

Treat extension config as untrusted user-owned data:

- Validate parsed JSON on read.
- Use explicit defaults for optional config; fail fast for correctness-critical config.
- Preserve malformed files; never rewrite config during startup. Write only after an explicit user action/command.
- Do not use fail-soft defaults for correctness-critical orchestration config.

## Consequences

Bad optional config does not block unrelated Pi use or get silently destroyed, while mandatory Auto DAG config still fails before unsafe execution.

## Notes

Applies when adding or changing any Pi extension config file under `getAgentDir()/config`. Related files: `packages/pi-auto-compact/extensions/auto-compact.ts`, `packages/pi-auto-dag/src/config.ts`, `packages/pi-herdr-rename/extensions/rename.ts`, `packages/pi-open-in/extensions/open.ts`.
