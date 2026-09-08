---
name: pi-subagent-delegated-development
description: Use only when implementation merits delegation for isolation, parallelism, long-running execution, or explicit judgment; then choose Delegate Flow or ordinary delegation.
---

# Delegated Development

Keep a trivial, single-owner, mechanically verifiable edit in Main when its producer and regression assertion are known. Delegate only when isolation, independent parallel work, long-running execution, or explicit judgment materially helps.

You are Main, the planner/orchestrator. Follow the selected tool's guidelines for mode, decomposition, task packets, ownership, validation, and model routing. Do not implement child work, use external model tools, push, publish, or release.

## Before delegation

- Apply repository prohibitions. Resolve conflicts first and copy relevant rules into affected tasks. Include them in `review` only when validation cannot prove compliance. Repository policy overrides generic preservation or migration assumptions. If compatibility is disallowed, require deletion of replaced paths and forbid legacy readers, aliases, adapters, dual schemas, deprecation paths, and fallbacks.
- For a literal UI or copy defect, search the exact quoted text first, then read only its producer and nearby regression assertions. Broaden only when ownership remains unclear.
- Name neighboring behavior that must stay unchanged. Include the exact test name or error when known CI evidence exists; never claim a validation command matches unknown CI.
- A Flow unit must fit one Implementer launch before the configured maximum runtime. Cohesion does not justify combining separately verifiable milestones. Split oversized dependent work into serial one-unit Flows after each milestone integrates, or use ordinary sequencing.

For a known regression, use an exact test-name filter when supported; for Node: `node --test --test-name-pattern "exact test name" test/example.test.ts`. Keep unit validation focused. Run any required broad or cross-unit check once in Main after integration. Do not duplicate checks against the same state. Flow has no post-merge validation.

## Runtime Flow

The runtime owns unit worktrees, Git identity, rebasing, committed-state inspection, declared validation, conditional exact read-only review, fast-forward integration, and cleanup. Validation is authoritative. Without `review`, Flow integrates the exact validated tip. With `review`, it supplies `{base, tip, patchPath}` and requires exactly `PASS`.

Trust the structured Flow outcome. Never edit child worktrees, manage branches, prepare review evidence, reimplement Flow, or integrate manually. After successful integration, do not re-read implementation, tests, manifests, or commit stats merely to confirm it. Check Main's status only for a caller-owned requirement. Do not repeat Flow validation.

For a repairable block, call `delegate_flow_continue` once with guidance specific to the failure. Omit `modelClass` to retain the unit class or frozen Role defaults; supply it only to replace both defaults for that repair. On terminal failure, inspect the exact retained paths reported by Flow, then reslice or recover in Main. Do not retry Flow, guess a rebase resolution, or rediscover a reported path with `git worktree list`.

Report a cleanup warning from a successful Flow as-is. Investigate only when the user asks or cleanup is acceptance.

## Optional ordinary review

Use a caller-managed review only when the caller or repository policy explicitly requires judgment. Never layer it onto Flow.

1. After implementation and focused validation, call `delegate_task` with `role: "reviewer"`; a same-named user Role remains effective.
2. Supply read-only scope, acceptance criteria, validation evidence, visible candidate evidence, and the output contract: `PASS` alone or findings only. If the Reviewer cannot see an isolated candidate, use Flow instead.
3. Empty output fails. Retry only when explicit policy requires it; a second empty result blocks completion.
4. On findings, repair them together, validate once, and re-review once with the original criteria, findings, and repaired evidence. Only `PASS` completes the loop; surface further findings and stop.
