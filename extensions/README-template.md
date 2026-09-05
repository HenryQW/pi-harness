<!-- Copy to extensions/<package>/README.md. Replace placeholders and delete optional sections that do not apply. Install and Use are required. Keep the remaining sections in the order shown. Keep trivial packages short. -->

# `@henryqw/<package>`

<Describe the concrete outcome users can achieve. Name the user or problem and the main benefit without adding a separate Why section.>

<!-- Optional: when the package was learned from or adapted from another project, add an "Inspired by" sentence here. -->

<!-- Optional: add a product screenshot here. If this README also has a non-decorative explanatory diagram, put it immediately after the screenshot. Without a screenshot, keep the diagram near relevant prose. Image paths must begin with `./` or `../`. -->

## Install

```bash
pi install npm:@henryqw/<package>
```

<Put prerequisites and required post-install actions here. For non-trivial setup, say how users can verify success. Do not repeat generic Pi version requirements enforced by peerDependencies.>

<!-- Optional: include only when another package is required, improves this package, or consumes it. Use a table only for multiple comparable packages. Use a sentence or list for one package. Link companion extension docs with https://pi.henry.wang/extensions/<directory>. Alphabetize table rows. Reasons begin Required., Improves., or Consumer. -->
## Works with

| Package | Why |
| --- | --- |
| [`@henryqw/<companion-a>`](https://pi.henry.wang/extensions/<companion-a>) | Required. <Why.> |
| [`@henryqw/<companion-b>`](https://pi.henry.wang/extensions/<companion-b>) | Improves. <Why.> |

<!-- Start with the shortest successful workflow. State the expected result before deep reference. Use a compact surface table for comparable commands, tools, skills, prompts, or roles. Use matching H3 headings only when a surface needs narrative detail. -->
## Use

<First successful workflow and expected result. Delete this paragraph for a trivial command whose result is obvious.>

| Surface | Type | Purpose |
| --- | --- | --- |
| `/<command>` | command | <What it does.> |
| `<tool>` | tool | <What it does.> |

<Explain normal behavior without repeating the introduction.>

<!-- Optional: explain a multi-step product workflow. Preserve useful existing diagrams, but do not add a decorative diagram. -->
## Flow

<Describe the user-visible sequence and important transitions.>

<!-- Optional: include only when the package owns user-editable config. Put companion or shared config guidance in Works with or Use. Do not present generated state as config. -->
## Config

`~/.pi/agent/config/<package>/config.json`

| Field | Required | Possible values | Default |
| --- | --- | --- | --- |
| `<setting-a>` | Yes or no | <Valid values> | <Default> |
| `<setting-b>` | Yes or no | <Valid values> | <Default> |

<Explain invalid-config behavior and recovery.>

<!-- Optional: document a public library or owner API. -->
## API

<Describe public exports, inputs, results, and failures.>

<!-- Optional: document generated files, session entries, caches, indexes, or storage behavior. -->
## State and storage

<Describe owned state, its lifecycle, and safe deletion or recovery.>

<!-- Optional: disclose data sent to models or services, model calls and possible cost, sync, trust, and privacy. -->
## Data, cost, and privacy

<Describe what leaves the machine, which models or services receive it, possible cost, and trust boundaries.>

<!-- Optional: document compatibility, supported managers, constraints, failure semantics, and recovery. -->
## Limits and recovery

<Make limits actionable and explain recovery.>
