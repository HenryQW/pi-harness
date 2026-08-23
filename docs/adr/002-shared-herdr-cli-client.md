# 002. Shared Herdr CLI Client

- **Status:** accepted
- **Date:** 2026-08-11 (migrated from Obsidian vault)

## Context

Pi packages that drive the Herdr CLI each duplicate process and error plumbing. Mirroring the full Herdr command catalog in each package would create drift and maintenance cost without much value over direct CLI execution.

## Decision

Use `@henryqw/pi-herdr` as the thin shared Herdr CLI boundary for Pi packages. It owns:

- executor binding,
- successful command handling,
- JSON-object parsing,
- command-failure formatting,
- structured error-code detection.

Herdr's schema remains the protocol source of truth; consuming packages retain command construction, orchestration, and command-specific response validation.

## Consequences

- Publish the adapter first; Auto DAG and Herdr Rename adopt it later through independent package releases.
- Typed command helpers remain demand-driven.

## Notes

Alternatives rejected: keeping local wrappers (duplicates inconsistent behavior); building a handwritten exhaustive SDK (richer autocomplete but a second source of truth). Related files: `packages/pi-herdr`.
