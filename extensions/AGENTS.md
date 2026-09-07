# Package instructions

## Extension config

Extensions must use `@henryqw/pi-config-store` for configuration storage.

Repository default: most extension owners may assume one active config writer unless their package explicitly documents multi-process or concurrent writers.

Under that consumer assumption, reload the extension after a manual or external edit before its next write. A stale in-memory full replacement is outside the supported workflow.

`store.save(value)` locks and replaces the whole config. The lock serializes writes, but does not merge fields from stale values.

Use `store.update(mutator)` for read-modify-write when an extension supports multiple processes, sessions, or writers. Use it also to preserve concurrent field changes. It reads the latest valid config under the store lock.

## README

Every package `README.md` must use [README-template.md](README-template.md). Copy it and replace placeholders. All H2 sections are optional. Include a section only when it contains package-specific user information. Delete an inapplicable or empty heading instead of writing `None`, `N/A`, `Not applicable`, placeholder filler, or generic information. Keep retained sections in canonical order.

Each extension `README.md` must contain one diagram when the extension has enough features or interactions to explain visually. Skip the diagram for lightweight extensions with no meaningful flow or relationship to show. Do not add a decorative diagram only to satisfy this rule.
