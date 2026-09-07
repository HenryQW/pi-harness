<!--
README contract:
- Copy this file to extensions/<package>/README.md. Replace placeholders and delete optional sections that do not apply.
- Use the exact package H1 format shown below. Follow it with one to three short sentences about the user outcome.
- Install and Use are required.
- Keep H2 headings in this order: Install, Works with, Use, Flow, Config, API, State and storage, Limits and recovery.
- Do not add other H2 headings. Nest package-specific topics under the relevant section with H3 headings.
- Limits and recovery, when present, must be last.
- Keep simple packages short. Use simple English. Preserve exact commands, paths, errors, safety advice, and recovery steps.
-->

# `@henryqw/<package>`

<State the user outcome in one to three short sentences. Attribution and meaningful images may follow the introduction.>

<!-- Optional: when the package was learned from or adapted from another project, add an "Inspired by" sentence here. -->

<!-- Optional: add a product screenshot here. Keep a meaningful explanatory diagram near the relevant prose. Do not add decorative diagrams. Image paths must begin with `./` or `../`. -->

## Install

```bash
pi install npm:@henryqw/<package>
```

<After the command, include only prerequisites and required setup. Add a concrete verification step when setup is not trivial. Do not repeat generic Pi version requirements enforced by peerDependencies.>

<!-- Optional: include only when another package is required, improves this package, or consumes it. Always use this exact table. Add one alphabetized row per package. Relationship must be Required, Improves, or Consumer. Purpose must not repeat the relationship word. Link companion docs with https://pi.henry.wang/extensions/<directory>. -->
## Works with

| Package | Relationship | Purpose |
| --- | --- | --- |
| [`@henryqw/<companion-a>`](https://pi.henry.wang/extensions/<companion-a>) | Required | <What the package provides.> |
| [`@henryqw/<companion-b>`](https://pi.henry.wang/extensions/<companion-b>) | Improves | <What becomes better.> |

<!-- Start with the shortest successful workflow and its expected result. For two or more comparable user surfaces, use exactly this table with lowercase types such as command, tool, skill, or ui. Use H3 headings only when a surface needs more detail. -->
## Use

<First successful workflow and expected result. Delete this paragraph only when a trivial command makes the result obvious.>

| Surface | Type | Purpose |
| --- | --- | --- |
| `/<command>` | command | <What it does.> |
| `<tool>` | tool | <What it does.> |

<Add normal-use detail without repeating the introduction.>

<!-- Optional: include only for user-visible multi-step behavior and important transitions. H3 subsections are allowed. Preserve useful existing diagrams. -->
## Flow

<Describe the user-visible sequence and important transitions.>

<!-- Optional: include only for package-owned user-editable configuration. Start with the exact path or an ownership sentence. Do not present shared config or generated state as this package's config. Do not repeat a flat config table as JSON; a nested JSON example may explain structure. Every Config section must include the exact four-column primary table below: Name, Description, Values, and Default. Put genuinely conditional requirements briefly in Description. Keep explanation in Description and type, range, enum, or structural constraints in Values. State effective omitted behavior in Default. Use — when no default exists. -->
## Config

Package-owned: `~/.pi/agent/config/<package>/config.json`

| Name | Description | Values | Default |
| --- | --- | --- | --- |
| `<setting-a>` | <What it controls. Required when <condition>.> | <Type, range, enum, or structural constraint.> | — |
| `<setting-b>` | <What it controls.> | <Type, range, enum, or structural constraint.> | <Effective behavior when omitted.> |

<After the table, explain invalid or missing config, who writes it, when changes reload, and recovery.>

<!-- Optional: document public library or owner APIs only. For two or more comparable exports, use exactly this table. A single API may use concise prose or code. -->
## API

| Surface | Type | Purpose |
| --- | --- | --- |
| `<export-a>` | function | <What it does.> |
| `<export-b>` | type | <What it represents.> |

<!-- Optional: document package-owned generated files, session entries, caches, indexes, or storage. Include paths, lifecycle, safe deletion, and recovery when they matter. -->
## State and storage

<Describe owned state. Do not call generated state config.>

<!-- Optional and always last: document actionable constraints, failure meaning, and recovery. Use this heading instead of variants such as Safety limits or Limits and failures. -->
## Limits and recovery

<Make limits actionable and explain recovery.>
