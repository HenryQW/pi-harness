# 020. pi-subagent Bounded Result Transport

- **Status:** accepted
- **Date:** 2026-08-13, updated 2026-08-18 (migrated from Obsidian vault)

## Context

Delegated output must not consume Main context without bound; the Pi authoritative Subagent example uses a 50 KiB per-task ceiling. Result files and retrieval protocols would add lifecycle complexity; a configurable limit adds policy before need.

## Decision

- **Cap every Main-visible Subagent streaming update, final result, and error at 50 KiB of UTF-8 text with an exact omitted-byte marker.** Scouting Roles return conclusion-first indexes with file and line references, and Main splits work that cannot fit; no full-result artifact is retained. Source: user-approved output-bound implementation.
- **Discard JSON event types unused by delegation after bounded prefix classification, before buffering their payloads; retain the 1 MiB cap for consumed or unclassifiable events.** Pi's valid `agent_end` event repeats the full child transcript and can exceed the protocol cap after the needed `message_end` output is already captured. Raising the cap leaves memory unbounded; text mode removes streaming and token status; buffering all events wastes memory. Large lifecycle summaries no longer fail `delegate_task`, while malformed or relevant oversized lines still fail bounded. Source: user-approved 2.0.1 transport fix.

## Notes

Files: `packages/pi-subagent/README.md`, `packages/pi-subagent/extensions/subagent.ts`, `packages/pi-subagent/test/subagent.test.ts`.
