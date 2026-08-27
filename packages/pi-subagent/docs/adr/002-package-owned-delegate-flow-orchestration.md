# Package-owned `delegate_flow` orchestration

## Decision

`delegate_task` remains the generic bounded Role tool described by [ADR 001](./001-composable-ephemeral-execution.md). `delegate_flow` is a separate package-owned Git workflow with this fixed interface:

```ts
delegate_flow({ units: [{ id, task, validation: [{ command, args }] }] });
delegate_flow_continue({ guidance });
```

A Flow accepts 1–8 independent units with unique IDs. Only one memory-only Flow may be active. It requires a clean committed attached Main branch and creates one Unit Worktree per unit before launching package-shipped Implementers in parallel. All started Implementers settle; Flow then processes units in declared order.

For each unit, Flow verifies Main, rebases the Unit Worktree in place when earlier Flow units advanced Main, runs the declared validation commands there, and gives a package-shipped read-only Reviewer the exact `{base, tip, patchPath}` packet in that same worktree. Reviewer output whose trimmed text equals `PASS` approves. Flow then fast-forwards Main with the full reviewed OID and uses non-forced worktree removal and branch deletion. Cleanup refusal does not undo integration; it returns completion with retained worktree path and/or branch warnings.

If rebase drops all unit commits, `base === tip` is a no-op. Flow still validates and reviews the state, then skips the merge after `PASS`.

Implementer failure, dirty or missing committed work, validation failure, and reviewer findings block the first affected declared unit. `delegate_flow_continue({ guidance })` reruns the package-shipped Implementer in that same Unit Worktree once and derives, validates, and reviews again. A second block is terminal. Rebase conflicts abort and terminate the Flow; infrastructure and fast-forward failures also terminate it. Terminal outcomes retain worktrees for Main to reslice, and earlier integrations are never rolled back.

## Consequences

Flow owns its narrow deterministic Git protocol and uses package-shipped Roles directly, so user Role overrides do not affect it. It has no dependency graph, saved recovery, automatic retry, aggregate review, or post-merge validation. Units that overlap files, APIs, schemas, generated output, package metadata, lockfiles, or invariants must be combined or sequenced outside Flow.
