# 014. pi-auto-compact Dedicated Compaction Model

- **Status:** accepted
- **Date:** 2026-08-12 (migrated from Obsidian vault)

## Decision

- `/auto-compact` opens one menu for threshold or model configuration; no command subcommands.
- Dedicated model selection also asks for a model-supported thinking level and saves both in one config write.
- Selecting the current session model clears both `compactionModel` and `compactionThinkingLevel`.
- Model and thinking overrides apply only to extension-owned automatic compactions. Manual `/compact` stays native.
- Missing, invalid, unavailable, unauthenticated, unsupported, or failing overrides fall back to the current session model.

## Compatibility

Use the exported `compact()` thinking-level argument available in Pi Coding Agent 0.80.7+. Derive supported levels from model metadata without adding a runtime dependency.
