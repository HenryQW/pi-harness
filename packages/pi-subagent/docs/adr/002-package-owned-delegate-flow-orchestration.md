# Package-owned `delegate_flow` orchestration

## Decision

`delegate_task` remains the generic bounded Role tool described by [ADR 001](./001-composable-ephemeral-execution.md). Main plans and orchestrates; `delegate_flow` is a separate package-owned Git workflow with this fixed interface:

```ts
delegate_flow({ units: [{ id, task, modelClass?, validation: [{ command, args }], review? }] });
delegate_flow_continue({ guidance, modelClass? });
```

A Flow accepts 1–8 independent units with unique IDs. `modelClass` is optional and otherwise uses the shared `pi-subagent/delegateTask` assignment. The class resolves through the existing `pi-task-models` profile model-and-thinking route for the unit's Implementer and, when applicable, Reviewer. `review` is optional non-empty text for the explicit judgment that declared validation cannot establish.

Only one memory-only Flow may be active. At start it resolves/freezes the effective `implementer` Role, including a same-named user override. It resolves/freezes the effective `reviewer` Role only when at least one requested unit has `review`. It requires a clean committed attached Main branch and creates one Unit Worktree per unit before launching Implementers in parallel. All started Implementers settle; Flow then processes units in declared order.

For each unit, Flow verifies Main, rebases the Unit Worktree in place when earlier Flow units advanced Main, inspects committed Git state, and runs declared validation. Validation is authoritative for objective verification. Without `review`, Flow skips exact evidence and Reviewer launch, then fast-forwards the exact validated tip through the existing guarded `git merge --ff-only` path. With `review`, it gives the Reviewer the exact `{base, tip, patchPath}` packet in that same worktree; only trimmed output exactly equal to `PASS` permits the same full-OID fast-forward. Cleanup uses non-forced worktree removal and branch deletion; cleanup refusal does not undo integration and returns completion with retained-work warnings.

If rebase drops all unit commits, `base === tip` is a no-op. Flow validates the state, skips Reviewer and merge, then cleans up ordinarily. Implementer failure, dirty or missing committed work, validation failure, and reviewer findings block the first affected declared unit. `delegate_flow_continue({ guidance, modelClass? })` launches a fresh ephemeral child with the frozen Implementer Role in that same Unit Worktree once, with original requirements, authoritative validation, previous block evidence, and Main guidance. Omitted continuation class retains the Unit's current class; a supplied class replaces it for that one repair, including any subsequent Reviewer launch. A second block is terminal. Failed rebase, evidence/Reviewer, and other infrastructure failures retain worktrees. A reported fast-forward failure completes with its diagnostic as a warning only when Main is clean at the exact integrated tip; otherwise it is terminal. Earlier integrations are never rolled back.

## Consequences

Flow owns narrow deterministic Git mechanics while allowing user-owned Implementer and conditional Reviewer policy through same-named Role overrides. Overrides do not change validation authority, exact review protocol, approval, integration, or cleanup. Flow has no dependency graph, saved recovery, automatic retry, aggregate review, post-merge validation, Planner Role, or generic-role restriction. Units that overlap files, APIs, schemas, generated output, package metadata, lockfiles, or invariants must be combined or sequenced outside Flow.
