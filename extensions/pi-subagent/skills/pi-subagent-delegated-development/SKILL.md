---
name: pi-subagent-delegated-development
description: Use Delegate Flow, or coordinate explicitly required judgment review for ordinary delegated implementation.
---

# Delegated Development

You are Main, the planner/orchestrator: slice work and choose `delegate_flow` or `delegate_task` as described below. Do not implement child work yourself or use external model tools, push, publish, or release.

## Slice

Before slicing, identify applicable repository prohibitions. If the request or plan conflicts with them, stop and resolve the conflict before delegation. Copy them into every affected task and into `review` when automated validation cannot establish compliance; never replace repository policy with generic preservation or migration assumptions. When compatibility is disallowed, require deletion of replaced paths and forbid legacy readers, aliases, adapters, dual schemas, deprecation paths, and compatibility fallbacks.

Run a concise decomposition pass. Identify independently deliverable concrete outcomes. Maximize safe parallelism at those boundaries: give each outcome focused validation and clear ownership, and parallelize commuting work. Prefer parallel delegation when at least two independent outcomes exist. For naturally multi-part work, roughly 3–5 useful units is a guide, not a quota. Never manufacture units.

Before selecting a Flow unit, require that one Implementer launch can plausibly finish before the configured maximum runtime. Cohesion alone is not enough when work has multiple preservable, separately verifiable milestones. Use `delegate_flow` for independent units expected to commute. Keep work together or sequence it when splitting would divide an invariant, overlap mutable ownership, or create coordination. Combine or sequence work that overlaps files, APIs, schemas, generated output, package metadata, lockfiles, or invariants. Units inside one Flow remain independent and commuting. Dependent work remains outside Flow. Split oversized dependent work into serial one-unit Flows after each milestone integrates; otherwise sequence it in one task or ordinary caller-controlled sequencing.

Give every unit a bounded objective, owned scope and exclusions, and its direct validation command/argument array. Each task packet must name the neighboring behavior that must stay unchanged. Include the exact test name or error when known CI evidence exists. Never claim a validation command matches unknown CI.

Each delegation must own one concrete outcome with one focused validation story. When a known regression exists and the runner supports test-name filtering, require its exact test-name filter for that unit; for Node, use `node --test --test-name-pattern "exact test name" test/example.test.ts`. Keep each unit's declared validation focused on that unit's outcome; do not include a broad package or workspace suite. Its declared Flow validation remains authoritative for that outcome. Reserve required broad package or cross-unit checks for one distinct caller-owned final integration validation after relevant units integrate. Do not duplicate checks against the same state. Flow itself has no post-merge validation. If the affected flow or scope is not yet known, perform bounded read-only discovery first. Do not pass the parent request unchanged. Choose `modelClass` according to the delegation tool's guidance. Add non-empty `review` only for an explicit judgment that automated validation cannot establish. Call `delegate_flow` with 1–8 units; the runtime always supplies the effective Implementer and supplies the Reviewer only when a unit needs review.

## Runtime Flow

The runtime owns the unit worktrees and all Git identity, rebasing, committed-state inspection, declared validation, conditional exact read-only review, fast-forward integration, and cleanup. Declared validation is the authority for objective verification. A validated unit without `review` skips review evidence and Reviewer launch, then integrates its exact validated tip. A unit with `review` receives the existing exact `{base, tip, patchPath}` protocol and must receive exactly `PASS` before integration.

Trust the structured Flow outcome. Never edit a child worktree, manage its branches, prepare review evidence, reimplement Flow, or manually integrate its changes. Do not repeat Flow validation after it has completed or integrated a unit.

A successful Flow owns integration and cleanup. A blocked outcome is repairable once: provide one explicit continuation and no more:

```ts
delegate_flow_continue({ guidance: "Address the reported block and complete the bounded unit.", modelClass: "balanced" })
```

Make the guidance specific to the reported implementation, validation, or review failure. Omit `modelClass` to retain an explicit blocked-unit class or otherwise use each frozen Role's default; supply it only to replace both defaults for that one repair. Do not call continuation unless Flow reports a repairable block. If continuation or Flow returns a terminal failure, inspect each exact retained path reported by the runtime directly, then reslice or manually recover from Main; do not retry the Flow or guess a rebase resolution. Do not run `git worktree list` merely to rediscover a retained path.

A cleanup warning does not undo successful integration. Report a cleanup warning from a successful Flow as-is. Do not investigate it unless the user asks or cleanup is part of acceptance.

## Ordinary delegation

Use `delegate_task` for a single bounded task, independent parallel tasks, or dependent chain work that is not a Flow. Give each entry its objective, exact scope and exclusions, relevant context and constraints, expected deliverable, and focused validation. Choose `modelClass` according to the delegation tool's guidance. A direct `model` replaces only the selected route's model. The route keeps its thinking level. Keep integration and cross-cutting decisions in Main.

### Optional evidence loop for implementation

Use this caller-managed loop only when the caller or repository policy explicitly requires judgment review. It is not required for every ordinary implementation.

After implementation and focused validation, launch `delegate_task` with `role: "reviewer"` to select the effective `reviewer` Role. A same-named user Role remains effective. The task packet must state:

- the read-only scope;
- the exact acceptance criteria;
- exact candidate evidence visible from the Reviewer's working directory and the supplied validation evidence;
- the exact output contract: return `PASS` alone on approval, or findings only.

Do not launch the Reviewer unless it can see the actual candidate. For an isolated implementation candidate, use `delegate_flow` instead of composing an ordinary review against Main's unchanged checkout.

Empty Reviewer output is a failure. Retry only when explicit caller policy requires one; otherwise surface the failure and block completion. If that retry is also empty, surface the second empty result and block completion.

If the initial review returns findings, repair them together. Run one focused validation of the repaired inputs before one focused re-review. Its task packet must restate the read-only scope, exact output contract, original findings, original acceptance criteria, exact repaired-candidate evidence, and validation evidence.

Only `PASS` completes the loop. Focused re-review findings block completion and must be surfaced. Do not start another repair/review round.

Do not layer this loop onto `delegate_flow`. Flow already owns exact review evidence, exact `PASS` approval, validation replay, one repair continuation, and no automatic retry.
