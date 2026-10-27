# 018. Extension Config Homes

- **Status:** accepted; shared mechanics amended 2026-10-14; workspace-local state amended 2026-10-27
- **Date:** 2026-08-30

## Context

Extension-owned files currently use two layouts under `getAgentDir()/config`: a flat JSON file for some single-file extensions and an extension-named directory for packages with multiple files. Each package repeats path, JSON, locking, and atomic-write logic. Consumers that read another extension's file directly would also couple themselves to that owner's storage schema.

The repository needs clear ownership boundaries for user-edited JSON, generated state, databases, and custom formats without turning a shared utility into a schema registry. Some state belongs to one workspace and must live with that workspace instead of in the user config home.

## Decision

**Extension Config Home.** Every extension owns one directory at `getAgentDir()/config/<extension-id>/`. The canonical extension ID is one validated lowercase path component.

**Default config.** User-edited JSON defaults to `<home>/config.json`. An extension may own other files and formats inside its home. Missing generated state and missing optional config with usable defaults are normal. A missing config warns only when the user must act before the extension can work.

**Workspace-local state.** A Pi Harness extension stores generated state that belongs to a workspace under `<workspace-directory>/.context/pi-harness/<extension-id>/`. For example, `pi-herdr-tools` may use `.context/pi-harness/pi-herdr-tools/state.json`. Create the directory when needed, including outside Git repositories. For a worktree, use its checkout directory. For other workspaces, the extension must establish a shared directory for all processes that use the state. Do not assume that `.context/` is ignored by Git or change ignore rules automatically. Workspace-local state can be lost when its directory is removed; keep user config and state that must outlive the workspace in the extension config home.

**Shared mechanics.** `@henryqw/pi-config-store` owns the canonical path helpers, bounded strict UTF-8 reads, and private atomic text writes. These text helpers do not choose a format, parse data, interpret missing files, or expose locks. Each extension owns its formats, schemas, recovery rules, and lock policy.

The package also keeps the JSON store for user-edited config. It provides safe load, save, locked update, locked replacement of an unchanged file, and removal for `config.json` and other hand-edited JSON files in the home. The store owns load-time validation mechanics: per-key fields, unknown-key reports, near-miss key detection, per-key defaults, dropped nested entries, disabled results, and launch reporting deduplicated across extensions under [ADR 004](004-extension-config-safety.md). Owners own the schemas: fields, defaults, required or unsafe keys, and cross-field rules. Every user-edited extension config loads through store fields; no extension reads a config file with direct JSON parsing. Generated state and custom files may use the shared text mechanics, but their format, strict validation, and locking stay owner-local.

**Ownership.** Only an extension writes its config home and workspace-local state directory. Consumers obtain validated effective values through an owner package API or a namespaced Pi event protocol. They do not read or write the owner's files directly.

**Migration.** The one-time migration is complete. The migrated config-home files were moved through the repository agent runbook, runtime code reads them only from the new paths, and `AGENTS.md` now requires this layout. No legacy readers, aliases, dual schemas, adapters, or fallback paths are permitted.

## Consequences

- Each extension has a config home and, when needed, a separate workspace-local state directory.
- Single-file extensions move from `config/<extension>.json` to `config/<extension>/config.json`.
- Existing extension-named homes retain custom state in place; some nonstandard config filenames move to `config.json`.
- Missing required config becomes visible without destructive startup writes; optional defaults stay quiet.
- Invalid or unknown keys warn at launch with the same text in every extension.
- Shared file safety can improve once without centralizing formats, schemas, or locking policy.
- The one-time migration coordinated owners, consumers, tests, documentation, versions, and local user files.

## Rejected Alternatives

- **Keep flat files for single-config extensions:** preserves two ownership rules and repeated path logic.
- **One global config document:** couples independent package releases and creates shared-write conflicts.
- **Direct cross-extension file reads:** exposes storage schemas and bypasses owner validation and defaults.
- **Runtime legacy-path fallback:** becomes permanent compatibility code and hides incomplete migration.
- **Duplicate package and repository migration guides:** two agent runbooks would drift.
