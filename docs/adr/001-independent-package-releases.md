# 001. Independent Package Releases

- **Status:** accepted
- **Date:** 2026-08-09

## Context

This npm workspace monorepo contains independently useful Pi packages. A shared version would couple unrelated releases.

## Decision

Each public workspace owns its npm version. Published-surface changes bump every affected workspace with npm; root-only and test-only changes do not. CI publishes only workspace versions newer than npm. The root workspace remains private.

## Consequences

Packages release without monorepo-wide coordination. Release policy and enforcement live in `AGENTS.md`, `docs/releasing.md`, and `.github/workflows/publish.yml`.
