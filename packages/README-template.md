<!-- Copy to packages/<package>/README.md. Replace placeholders, delete optional sections that do not apply, and keep remaining sections in this order. -->

# `@henryqw/<package>`

<One sentence describing what users can do.>

## Why

- **Created for**: <One sentence: who needs this and what problem it solves.>
- **Advantage**: <One sentence: what makes it better than alternatives or doing without.>

<!-- Optional: include only when the package was learned from or adapted from another project. -->
- **Inspired by**: <One sentence naming the source project and the idea borrowed from it.>

## Install

```bash
pi install npm:@henryqw/<package>
```

<Runtime prerequisite or setup step, if needed. Do not repeat generic Pi version requirements already enforced by peerDependencies.>

<!-- Optional: use a table only for multiple comparable companion packages. Use a sentence or list for one companion. Alphabetize rows by package. Reasons begin Required., Improves., or Consumer. -->
## With

| Package | Why |
| --- | --- |
| `@henryqw/<companion-a>` | Required. <Why.> |
| `@henryqw/<companion-b>` | Improves. <Why.> |

<!-- Use a table for multiple comparable surfaces. Use a sentence or list for one surface. -->
## Use

| Surface | Type | Purpose |
| --- | --- | --- |
| `/<command>` | command | <What it does.> |
| `<tool>` | tool | <What it does.> |

<Behavior, limits, integrations, and safety caveats.>

<!-- Optional: include Config only when the package owns a user-editable config file. Put companion/shared config guidance in With or Use, not here. Do not present generated state as this package's config. Use a table for multiple comparable settings. Use a sentence or list for one setting unless a fixed field layout is clearer. -->
## Config

`~/.pi/agent/config/<package>/config.json`

| Field | Required | Possible values | Default |
| --- | --- | --- | --- |
| `<setting-a>` | Yes or no | <Valid values> | <Default> |
| `<setting-b>` | Yes or no | <Valid values> | <Default> |

<Invalid-config behavior.>

<!-- Optional: add feature-specific sections here, for example Library API, Workflow, or Recovery. Add a diagram only when a flow or relationship is clearer than prose. Do not add a Mermaid placeholder. -->
## <Feature>

<Feature-specific documentation.>
