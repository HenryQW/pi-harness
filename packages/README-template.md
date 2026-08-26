<!-- Copy to packages/<package>/README.md. Replace placeholders, delete optional sections that do not apply, and keep remaining sections in this order. -->

# `@henryqw/<package>`

<One sentence describing user-visible value.>

## Why

- **Created for**: <One sentence: who needs this and what problem it solves.>
- **Advantage**: <One sentence: what makes it better than alternatives or doing without.>

<!-- Optional: include only when the package was learned from or adapted from another project. -->
- **Inspired by**: <One sentence naming the source project and the idea borrowed from it.>

## Install

```bash
pi install npm:@henryqw/<package>
```

<Runtime requirement or setup step, if needed.>

<!-- Optional: separately installed companion Pi packages only. -->
## With

| Package | Why |
| --- | --- |
| `@henryqw/<companion>` | Required or improves. <Why.> |

## Use

| Surface | Type | Purpose |
| --- | --- | --- |
| `/<command>` | command | <What it does.> |
| `<tool>` | tool | <What it does.> |

<Behavior, limits, integrations, and safety caveats.>

## Config

`~/.pi/agent/config/<package>.json`

| Field | Required | Possible values | Default |
| --- | --- | --- | --- |
| `<setting>` | Yes or no | <Valid values> | <Default> |

<Invalid-config behavior. Packages with no package-owned editable config use exactly:>

| Package-owned editable config | Required | Fields | Possible values | Default |
| --- | --- | --- | --- | --- |
| None | No | No fields | No possible values | Built-in behavior |

<Document package-owned generated state separately; do not present companion-package config as this package's config.>

<!-- Optional: add feature-specific sections here, for example Library API, Workflow, or Recovery. -->
## <Feature>

<Feature-specific documentation.>

<!-- Pi extensions only. -->
## Remove

```bash
pi remove npm:@henryqw/<package>
```

## Development

```bash
npm test --workspace @henryqw/<package>
npm run typecheck --workspace @henryqw/<package>
npm run pack:check --workspace @henryqw/<package>
```
