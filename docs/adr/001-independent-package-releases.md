# 001. Independent Package Releases

- **Status:** accepted
- **Date:** 2026-08-09

## Context

This npm workspace monorepo contains independently useful Pi packages. A shared version would couple unrelated releases.

## Decision

Each public workspace owns its npm version. Published-surface changes bump every affected workspace with npm; root-only and test-only changes do not. CI publishes only workspace versions newer than npm. The root workspace remains private.

## Consequences

Packages release without monorepo-wide coordination. Release policy and enforcement live in `AGENTS.md`, `docs/releasing.md`, and `.github/workflows/publish.yml`.

## Workspace dependency order

Use manifest dependencies and pnpm's workspace order for releases. An ordered list in the workflow can miss dependencies of a newly added package. A second dependency sorter would need to reproduce pnpm's workspace resolution rules. The release script asks pnpm for a complete order before it runs any publication command. An automated fixture checks dependency order and verifies that cycles prevent publication.
