# 004. Extension Config Safety

- **Status:** accepted; path layout superseded by ADR 018; load rule amended 2026-10-14
- **Date:** 2026-08-09

## Context

Extension JSON under `getAgentDir()/config` is user-owned, hand-editable, and untrusted. Startup must not destroy malformed data or silently weaken correctness.

All-or-nothing parsers made one typo or bad value fail the whole config. Each owner then chose its own response: some threw, some fell back silently, and some ignored misspelled keys. Users could not predict whether a bad config crashed an extension, disabled it, or had no effect.

## Decision

- Validate reads at the boundary.
- Preserve malformed files; never rewrite config during startup.
- Write only after explicit user action.
- A bad config never crashes an extension and is never silent:
  - an unknown key and an invalid optional value produce a visible launch warning; each invalid key falls back to its safe default;
  - a near-miss key (an unknown key that misspells a declared key that is not in the file) is an invalid value of that declared key, so it follows the rule of that key;
  - a missing or invalid required key, or an invalid value whose default would be unsafe (for example, a storage directory or an unlimited token limit), fails at launch with a visible error and disables the extension's features; its config repair commands still work.
- A repair write reports the issues of the file before it replaces the file. It never drops a setting whose default would be unsafe unless the command sets that setting. A repair built from an earlier read replaces the file only if the file is unchanged under the write lock.
- Each issue shows one time in each session, also when several extensions read the same file. An owner API that a consumer loads exposes its issues, so the consumer can report them when the owner extension is not active.
- Generated state and recovery files stay strict; this rule covers user-edited config only.
- `@henryqw/pi-config-store` owns these load mechanics ([ADR 018](018-extension-config-homes.md)). Owners declare the fields, defaults, and required or unsafe keys.
- Path layout now follows [ADR 018](018-extension-config-homes.md).

## Consequences

Bad optional config is reported without blocking unrelated use, while correctness-critical settings cannot silently fall back. A typo is visible instead of silently ignored, and a typo of a correctness-critical key fails closed. Every extension responds to bad config in the same way.
