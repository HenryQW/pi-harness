<!--
Copy to extensions/<package>/README.md. Keep only sections with package-specific user information, in this order. Delete the rest: no `None`, `N/A`, or filler. Put other topics under an H3. Use tables for comparable rows, prose for explanation, and numbered lists for ordered steps. Start local links with `./` or `../`. `pnpm run docs:validate` checks headings, introduction length, and the root AGENTS.md language rules.
-->

# `@henryqw/<package>`

<State the user outcome in one to three short sentences. Attribution and meaningful images may follow the introduction.>

<!-- Optional: when the package was learned from or adapted from another project, add an "Inspired by" sentence here. -->

<!-- Optional: add a product screenshot that follows docs/screenshot-style.md. -->

<!-- Optional: after the command, add only prerequisites and setup, with a verification step when setup is not trivial. The command alone is fine. -->
## Install

```bash
pi install npm:@henryqw/<package>
```

<!-- Optional: list only Pi extensions, not libraries, in one alphabetized row each. Relationship is Required, Improves, or Consumer; link to https://pi.henry.wang/extensions/<directory>. -->
## Works with

| Package | Relationship | Purpose |
| --- | --- | --- |
| [`@henryqw/<companion-a>`](https://pi.henry.wang/extensions/<companion-a>) | Required | <What the package provides.> |
| [`@henryqw/<companion-b>`](https://pi.henry.wang/extensions/<companion-b>) | Improves | <What becomes better.> |

<!-- Optional: start with the shortest successful workflow and its result. With two or more surfaces, add one table listing every package-owned command (with arguments), tool, skill, shortcut, and ui entry. -->
## Use

<Shortest successful workflow and its result.>

| Surface | Type | Purpose |
| --- | --- | --- |
| `/<command> <argument>` | command | <What it does.> |
| `<tool>` | tool | <What it does.> |

<!-- Optional: describe user-visible multi-step behavior and important transitions. Add an explanatory diagram when flows or relationships are meaningful; never a decorative one. -->
## Flow

<User-visible sequence and important transitions.>

<!-- Optional: package-owned, user-editable config only. Start with the path and use the four columns below; Default states omitted behavior or a lone dash, and no JSON copy of the table. State only what differs from the root README Config files section. -->
## Config

Package-owned: `~/.pi/agent/config/<package>/config.json`

| Name | Description | Values | Default |
| --- | --- | --- | --- |
| `<setting-a>` | <What it controls. Required when <condition>.> | <Type, range, enum, or structural constraint.> | — |
| `<setting-b>` | <What it controls.> | <Type, range, enum, or structural constraint.> | <Effective behavior when omitted.> |

<After the table, state only what differs from [Config files](https://pi.henry.wang/overview#config-files): who writes the file, when edits apply, settings that disable a feature or block an action, what a file problem does, and recovery. Link Config files.>

<!-- Optional: public library or owner APIs only. Use this table for two or more exports. -->
## API

| Surface | Type | Purpose |
| --- | --- | --- |
| `<export-a>` | function | <What it does.> |
| `<export-b>` | type | <What it represents.> |

<!-- Optional: package-owned generated files, session entries, caches, or indexes, with paths, lifecycle, and safe deletion when they matter. Do not call generated state config. -->
## State and storage

<Owned state.>

<!-- Optional and always last: actionable limits, failure meaning, and recovery. -->
## Limits and recovery

<Actionable limits and recovery.>
