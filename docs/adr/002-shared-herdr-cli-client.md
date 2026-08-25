# 002. Shared Herdr CLI Client

- **Status:** accepted
- **Date:** 2026-08-11

## Context

Packages that drive Herdr need the same process, JSON, and error plumbing. Duplicating that plumbing drifts; mirroring Herdr's full command catalog creates a second protocol authority.

## Decision

Use `@henryqw/pi-herdr` as the thin shared CLI boundary. It owns executor binding, successful execution, JSON-object parsing, failure formatting, and structured error-code detection.

Herdr remains the schema authority. Consumers own command construction, orchestration, and command-specific response validation; typed helpers are added only when repeated use justifies them.
