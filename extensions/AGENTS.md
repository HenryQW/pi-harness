# Package instructions

## Extension config

Extensions must use `@henryqw/pi-config-store` for configuration storage.

Repository default: most extension owners may assume one active config writer unless their package explicitly documents multi-process or concurrent writers.

Under that consumer assumption, reload the extension after a manual or external edit before its next write. A stale in-memory full replacement is outside the supported workflow.

`store.save(value)` locks and replaces the whole config. The lock serializes writes, but does not merge fields from stale values.

Use `store.update(mutator)` for read-modify-write when an extension supports multiple processes, sessions, or writers. Use it also to preserve concurrent field changes. It reads the latest valid config under the store lock.

## Widget messages

These rules apply to message-style widgets. Do not force data or list widgets into this card shape.

- Give each widget one purpose and concise copy.
- Persistent actions should prefer one concise action line. Add identity or state only when it adds information not already shown elsewhere.
- Use semantic `ctx.ui.theme` colors for emphasis. Text must still state the meaning without color.
- Emphasize the exact command. Never hard-code ANSI sequences.
- Keep dynamic content width-safe. Truncate it or use a width-aware renderer when it can grow.
- In non-TUI or RPC modes, use a plain-text fallback.
- Define when each widget clears. Clear it at that lifecycle point.

## README

Every package `README.md` must use [README-template.md](README-template.md). Copy it, replace placeholders, delete inapplicable optional sections, and keep remaining sections in order.

Each extension `README.md` must contain one diagram when the extension has enough features or interactions to explain visually. Skip the diagram for lightweight extensions with no meaningful flow or relationship to show. Do not add a decorative diagram only to satisfy this rule.
