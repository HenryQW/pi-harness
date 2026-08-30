# 018. Extension Config Homes

- **Status:** accepted
- **Date:** 2026-08-30

## Context

Extension-owned files currently use two layouts under `getAgentDir()/config`: a flat JSON file for some single-file extensions and an extension-named directory for packages with multiple files. Each package repeats path, JSON, locking, and atomic-write logic. Consumers that read another extension's file directly would also couple themselves to that owner's storage schema.

The repository needs one ownership boundary that works for user-edited JSON, generated state, databases, and custom formats without turning a shared utility into a schema registry.

## Decision

**Extension Config Home.** Every extension owns one directory at `getAgentDir()/config/<extension-id>/`. The canonical extension ID is one validated lowercase path component.

**Default config.** User-edited JSON defaults to `<home>/config.json`. An extension may own other files and formats anywhere inside its home. Missing generated state and missing optional config with usable defaults are normal. A missing config warns only when the user must act before the extension can work.

**Shared mechanics.** `@henryqw/pi-config-store` owns the canonical directory and default-config path helpers plus safe JSON load, save, locked update, and removal. Extensions continue to own schemas, validation, defaults, and user-facing errors. Custom formats use the directory helper and their native library.

**Ownership.** Only an extension writes its home. Consumers obtain validated effective values through an owner package API or a namespaced Pi event protocol. They do not read or write the owner's files directly.

**Migration.** The one-time migration is complete. Existing files were moved through the repository agent runbook, runtime code reads only the new path, and `AGENTS.md` now requires this layout. No legacy readers, aliases, dual schemas, adapters, or fallback paths are permitted.

## Consequences

- Every extension has one stable filesystem boundary.
- Single-file extensions move from `config/<extension>.json` to `config/<extension>/config.json`.
- Existing extension-named homes retain custom state in place; some nonstandard config filenames move to `config.json`.
- Missing required config becomes visible without destructive startup writes; optional defaults stay quiet.
- Shared storage mechanics can improve once without centralizing domain policy.
- The one-time migration must coordinate owners, consumers, tests, documentation, versions, and local user files.

## Rejected Alternatives

- **Keep flat files for single-config extensions:** preserves two ownership rules and repeated path logic.
- **One global config document:** couples independent package releases and creates shared-write conflicts.
- **Direct cross-extension file reads:** exposes storage schemas and bypasses owner validation and defaults.
- **Runtime legacy-path fallback:** becomes permanent compatibility code and hides incomplete migration.
- **Duplicate package and repository migration guides:** two agent runbooks would drift.
