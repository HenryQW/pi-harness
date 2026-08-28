---
name: pi-subagent-delegated-development
description: Run bounded independent implementation through the runtime-managed Delegate Flow.
---

# Delegated Development

You are Main, the planner/orchestrator: slice work and call `delegate_flow`. Do not implement child work yourself or use external model tools, push, publish, or release.

## Slice

Use the fewest cohesive units. `delegate_flow` is for independent units expected to commute; combine or sequence work that overlaps files, APIs, schemas, generated output, package metadata, lockfiles, or invariants. Dependent work remains outside Flow, in one task or ordinary caller-controlled sequencing.

Give every unit a bounded objective, owned scope and exclusions, and its direct validation command/argument array. Do not pass the parent request unchanged. Use `modelClass: "fast"` normally; use `"balanced"` upfront only for obviously complex work. Add non-empty `review` only for an explicit judgment that automated validation cannot establish. Call `delegate_flow` with 1–8 units; the runtime always supplies the effective Implementer and supplies the Reviewer only when a unit needs review.

## Runtime Flow

The runtime owns the unit worktrees and all Git identity, rebasing, committed-state inspection, declared validation, conditional exact read-only review, fast-forward integration, and cleanup. Declared validation is the authority for objective verification. A validated unit without `review` skips review evidence and Reviewer launch, then integrates its exact validated tip. A unit with `review` receives the existing exact `{base, tip, patchPath}` protocol and must receive exactly `PASS` before integration.

Trust the structured Flow outcome. Never edit a child worktree, manage its branches, prepare review evidence, reimplement Flow, or manually integrate its changes. Do not repeat Flow validation after it has completed or integrated a unit.

A successful Flow owns integration and cleanup. A blocked outcome is repairable once: provide one explicit continuation and no more:

```ts
delegate_flow_continue({ guidance: "Address the reported block and complete the bounded unit.", modelClass: "balanced" })
```

Make the guidance specific to the reported implementation, validation, or review failure. Omit `modelClass` to retain the blocked unit's current class; supply it only to replace that one repair's class. Do not call continuation unless Flow reports a repairable block. If continuation or Flow returns a terminal failure, inspect every retained path reported by the runtime, then reslice or manually recover from Main; do not retry the Flow or guess a rebase resolution. A cleanup warning does not undo successful integration.

## Ordinary delegation

Use `delegate_task` for a single bounded task, independent parallel tasks, or dependent chain work that is not a Flow. Give each entry its objective, exact scope and exclusions, relevant context and constraints, expected deliverable, and focused validation. Populate direct `model` and `thinking` only when the user explicitly asks for those overrides; otherwise choose only `modelClass` (`fast` normally, `balanced` upfront for obviously complex work). Keep integration and cross-cutting decisions in Main, and use the minimum number of Subagents needed.
