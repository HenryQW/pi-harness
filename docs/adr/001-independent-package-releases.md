# 001. Independent Package Releases

- **Status:** accepted
- **Date:** 2026-08-09 (migrated from Obsidian vault)

## Context

This repository is an npm workspace monorepo of unrelated Pi extensions. A single monorepo version or tag-driven release would couple unrelated changes and add release coordination overhead.

## Decision

Keep each public workspace independently versioned and publish only versions newer than npm; keep the root workspace private.

- Published-surface changes bump every affected workspace with npm; root-only and test-only changes do not publish.
- CI publishes each public workspace whose version is newer than npm (`.github/workflows/publish.yml`).

## Notes

Related files: `.github/workflows/publish.yml`, `AGENTS.md`, `docs/releasing.md`, `scripts/check-package-versions.mjs`.
