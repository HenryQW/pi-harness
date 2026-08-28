---
name: pi-subagent-delegated-development
description: Run bounded independent implementation through the runtime-managed Delegate Flow.
---

# Delegated Development

You are Main: slice work and call `delegate_flow`. Do not implement child work yourself or use external model tools, push, publish, or release.

## Slice

Use the fewest cohesive units. `delegate_flow` is for independent units expected to commute; combine or sequence work that overlaps files, APIs, schemas, generated output, package metadata, lockfiles, or invariants. Dependent work remains outside Flow, in one task or ordinary caller-controlled sequencing.

Give every unit a bounded objective, owned scope and exclusions, acceptance criteria, and its direct validation command/argument array. Do not pass the parent request unchanged. Call `delegate_flow` with 1–8 units; the runtime supplies the effective Implementer and Reviewer Roles.

## Runtime Flow

The runtime owns the unit worktrees and all Git identity, rebasing, declared validation, exact read-only review, fast-forward integration, and cleanup. It records the clean committed Main state, runs independent Implementers in isolated unit worktrees, processes units in declared order, and integrates only the exact reviewed tip OID.

Trust the structured Flow outcome. Never edit a child worktree, manage its branches, prepare review evidence, reimplement Flow, or manually integrate its changes. Do not repeat Flow validation after it has completed or integrated a unit.

A successful Flow owns integration and cleanup. A blocked outcome is repairable: provide one explicit continuation and no more:

```ts
delegate_flow_continue({ guidance: "Address the reported block and complete the bounded unit." })
```

Make the guidance specific to the reported implementation, validation, or review failure. Do not call continuation unless Flow reports a repairable block. If continuation or Flow returns a terminal failure, inspect every retained path reported by the runtime, then reslice or manually recover from Main; do not retry the Flow or guess a rebase resolution. A cleanup warning does not undo successful integration.

## Ordinary delegation

Use `delegate_task` for a single bounded task, independent parallel tasks, or dependent chain work that is not a Flow. Give each entry its objective, exact scope and exclusions, relevant context and constraints, expected deliverable, and focused validation. Preserve ordinary Role selection and isolation behavior. Keep integration and cross-cutting decisions in Main, and use the minimum number of Subagents needed.
