<!-- Copy to extensions/<package>/README.md. Replace placeholders and delete optional sections that do not apply. Keep the Why -> Install -> optional With -> Use backbone. Keep trivial packages short. -->

# `@henryqw/<package>`

<One sentence describing a concrete outcome users can achieve. Lead with the outcome, not the implementation.>

## Why

- **Created for**: <Name the user and problem without repeating the introduction.>
- **Advantage**: <State one concrete benefit over the alternative or doing without.>

<!-- Optional: include only when the package was learned from or adapted from another project. -->
- **Inspired by**: <Name the source project and the specific idea borrowed from it.>

## Install

```bash
pi install npm:@henryqw/<package>
```

<Put prerequisites and required post-install actions here. For non-trivial setup, say how users can verify success. Do not repeat generic Pi version requirements enforced by peerDependencies.>

<!-- Optional: use a table only for multiple comparable companion packages. Use a sentence or list for one companion. Link companion extension docs with https://pi.henry.wang/extensions/<directory>. Alphabetize rows. Reasons begin Required., Improves., or Consumer. -->
## With

| Package | Why |
| --- | --- |
| [`@henryqw/<companion-a>`](https://pi.henry.wang/extensions/<companion-a>) | Required. <Why.> |
| [`@henryqw/<companion-b>`](https://pi.henry.wang/extensions/<companion-b>) | Improves. <Why.> |

<!-- For non-trivial packages, start with the shortest successful workflow. State the expected result before deep reference. Use a table only for multiple comparable surfaces. -->
## Use

<First successful workflow and expected result. Delete for a trivial command whose result is obvious.>

| Surface | Type | Purpose |
| --- | --- | --- |
| `/<command>` | command | <What it does.> |
| `<tool>` | tool | <What it does.> |

<Explain behavior and integrations without repeating the introduction or Why. Link companion docs when that helps the next step.>

<!-- Optional: disclose data sent to models or services, model calls and possible cost, and local or remote storage. Include only what applies. -->
## Data and cost

<What leaves the machine, which models or services receive it, possible cost, and where state is stored.>

<!-- Optional: include Config only when the package owns a user-editable config file. Put companion/shared config guidance in With or Use, not here. Do not present generated state as config. Use a table for multiple comparable settings. -->
## Config

`~/.pi/agent/config/<package>/config.json`

| Field | Required | Possible values | Default |
| --- | --- | --- | --- |
| `<setting-a>` | Yes or no | <Valid values> | <Default> |
| `<setting-b>` | Yes or no | <Valid values> | <Default> |

<Explain invalid-config behavior and recovery.>

<!-- Optional: add only useful feature-specific sections, such as Library API, Workflow, Limits, or Recovery. Make limits actionable and explain recovery. Add a diagram only when it is clearer than prose. Do not add a Mermaid placeholder. -->
## <Feature>

<Feature-specific documentation.>
