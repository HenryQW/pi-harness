---
name: pi-subagent-delegated-development
description: Run bounded independent implementation through the runtime-managed Delegate Flow.
---

# Delegated Development

You are Main, the planner/orchestrator: slice work and call `delegate_flow`. Do not implement child work yourself or use external model tools, push, publish, or release.

## Slice

Before slicing, identify applicable repository prohibitions. If the request or plan conflicts with them, stop and resolve the conflict before delegation. Copy them into every affected task and into `review` when automated validation cannot establish compliance; never replace repository policy with generic preservation or migration assumptions. When compatibility is disallowed, require deletion of replaced paths and forbid legacy readers, aliases, adapters, dual schemas, deprecation paths, and compatibility fallbacks.

Use the fewest cohesive units. `delegate_flow` is for independent units expected to commute: split independent outcomes into units, combine or sequence work that overlaps files, APIs, schemas, generated output, package metadata, lockfiles, or invariants, and never divide one invariant across multiple units. Dependent work remains outside Flow; sequence it in one task or ordinary caller-controlled sequencing.

Give every unit a bounded objective, owned scope and exclusions, and its direct validation command/argument array; each delegation must own one concrete outcome with one focused validation story. If the affected flow or scope is not yet known, perform bounded read-only discovery first. Do not pass the parent request unchanged. Choose `modelClass` according to the delegation tool's guidance. Add non-empty `review` only for an explicit judgment that automated validation cannot establish. Call `delegate_flow` with 1–8 units; the runtime always supplies the effective Implementer and supplies the Reviewer only when a unit needs review.

## Runtime Flow

The runtime owns the unit worktrees and all Git identity, rebasing, committed-state inspection, declared validation, conditional exact read-only review, fast-forward integration, and cleanup. Declared validation is the authority for objective verification. A validated unit without `review` skips review evidence and Reviewer launch, then integrates its exact validated tip. A unit with `review` receives the existing exact `{base, tip, patchPath}` protocol and must receive exactly `PASS` before integration.

Trust the structured Flow outcome. Never edit a child worktree, manage its branches, prepare review evidence, reimplement Flow, or manually integrate its changes. Do not repeat Flow validation after it has completed or integrated a unit.

A successful Flow owns integration and cleanup. A blocked outcome is repairable once: provide one explicit continuation and no more:

```ts
delegate_flow_continue({ guidance: "Address the reported block and complete the bounded unit.", modelClass: "balanced" })
```

Make the guidance specific to the reported implementation, validation, or review failure. Omit `modelClass` to retain an explicit blocked-unit class or otherwise use each frozen Role's default; supply it only to replace both defaults for that one repair. Do not call continuation unless Flow reports a repairable block. If continuation or Flow returns a terminal failure, inspect every retained path reported by the runtime, then reslice or manually recover from Main; do not retry the Flow or guess a rebase resolution. A cleanup warning does not undo successful integration.

## Ordinary delegation

Use `delegate_task` for a single bounded task, independent parallel tasks, or dependent chain work that is not a Flow. Give each entry its objective, exact scope and exclusions, relevant context and constraints, expected deliverable, and focused validation. Choose `modelClass` according to the delegation tool's guidance. A direct `model` replaces only the selected route's model. The route keeps its thinking level. Keep integration and cross-cutting decisions in Main, and use the minimum number of Subagents needed.
