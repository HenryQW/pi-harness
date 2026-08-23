# 006. pi-memory Global Store Threat Model

- **Status:** accepted
- **Date:** 2026-08-22

## Context

The upcoming `@henryqw/pi-memory` extension writes agent memory (`MEMORY.md`, `USER.md`) into an Obsidian vault synced over iCloud. A natural instinct is to gate tool-level access to this store — permissions, sandboxing, per-tool allowlists.

## Decision

Document the threat model instead of gating access:

- **Single-user machine.** The store protects against accidental loss/drift, not adversarial local processes.
- **The agent already has full disk access.** Any tool-level gate on the memory path would be theater: the same agent can read/write any other file, so gating one directory adds friction without reducing actual capability.
- **Memory writes are visible by construction** — plain markdown in a user-synced vault, inspectable and recoverable through iCloud versioning.

## Consequences

No permission layer around the memory store. Correctness comes from format discipline (plain markdown), transparency (user-readable files), and the promotion flow in ADR 0005 rather than from access control. Revisit only if the deployment model changes (multi-user or remote execution).
