# Domain Docs

How engineering skills consume domain documentation in this multi-context workspace.

## Before exploring, read these

- **`CONTEXT-MAP.md`** at repo root, if present. It points to each package's `CONTEXT.md`; read contexts relevant to task.
- **`docs/adr/`** for system-wide decisions affecting task.
- **`packages/<package>/docs/adr/`** for package-specific decisions affecting task.

If files don't exist, proceed silently. Don't suggest creating them upfront. `/domain-modeling` creates them when terms or decisions get resolved.

## File structure

```text
/
├── CONTEXT-MAP.md
├── docs/adr/                         ← system-wide decisions
└── packages/
    ├── pi-auto-compact/
    │   ├── CONTEXT.md
    │   └── docs/adr/                 ← package-specific decisions
    └── <future-package>/
        ├── CONTEXT.md
        └── docs/adr/
```

## Use glossary vocabulary

When output names domain concept—issue title, refactor proposal, hypothesis, or test name—use term defined in relevant `CONTEXT.md`. Don't drift to rejected synonyms.

Missing concept means language may be wrong or glossary has real gap. Reconsider term or note gap for `/domain-modeling`.

## Flag ADR conflicts

If output contradicts existing ADR, surface conflict explicitly:

> _Contradicts ADR-0007 — worth reopening because…_
