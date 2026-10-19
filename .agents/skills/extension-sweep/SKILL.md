---
name: extension-sweep
description: Use when asked to find and apply optimization opportunities, remove low-value tests, or simplify and correct READMEs, ADRs, and diagrams across this repository's extensions and packages.
---

# Extension Sweep

A sweep has three independent tracks: **optimize**, **prune tests**, and **docs**. Do only the tracks that the user asks for. Each track is discover, verify in Main, decide, then implement. Worker findings are claims, not facts.

## Discover

Delegate read-only scouts in parallel, one for each size group. Measure groups first, for example by source and test line counts for each `extensions/*` and `packages/*` directory. The usual groups are pi-subagent; pi-pr; pi-herdr-tools with pi-session-recall and pi-memory; then all small extensions with patterns that they share.

Give each scout exact criteria, a finding limit (8–12), `file:line` evidence, a concrete change, an effect estimate, a risk, and a word cap (600–700). Without a cap, scouts can fail to persist a final answer. If a scout fails, start a fresh scout with a smaller scope; `continueFrom` needs a finished final turn.

Optimize criteria: per-turn or per-render work (hooks, footer renders, timers), full rereads or reparses of growing files, quadratic loops, duplicate subprocesses or sequential independent network calls, repeated text in tool descriptions, `promptGuidelines`, per-turn injections, or skills, dead code, and duplication of `packages/*`.

Test criteria: (a) static mapping or literal mirror of source, (b) a type, framework, or stdlib guarantee, (c) duplicate coverage (name the test that covers it), (d) an implementation detail with no regression risk, (e) an impossible state. Never flag failure, recovery, security, data-loss, untrusted-input, concurrency, or boundary tests.

## Verify in Main

Read every cited range yourself before you report it. For each finding, keep it, downgrade it, or reject it.

- Confirm call frequency: for example, a 2 s widget timer, every footer render, every `before_agent_start`, or once for each command.
- Measure when cost is uncertain. Run against a copy (for example, copy the session-recall `index.db` to a temp directory); never against live state.
- Check real sizes before you accept "unbounded" claims. A theoretical limit with small real configuration is low value.
- Check Pi runtime facts in installed `dist/`, not from memory (for example, `session-manager.js` appends `JSON.stringify(entry) + "\n"` in one call).
- Keep a test that is the only coverage of an observable behavior, even if it asserts a literal.
- Ask the user about real tradeoffs. Do not choose silently (for example, removing a wait that protects a plugin race).

Report a ranked table with the evidence and the verdict for each finding. Mark which items you did not verify.

## Implement

Before you bump versions, sync with `origin/main` (`update-from-main`).

Use one isolated graph with one `changeset` task for each package. Each task includes its patch bump in `package.json`. Tasks must not run `pnpm install` or edit `pnpm-lock.yaml`; workspace versions are not in the lockfile. Task checks: `pnpm --filter <pkg> run test` and `typecheck`. Final checks: `pnpm run typecheck`, `check:package-versions`, `docs:validate`, `git diff --check origin/main` (`pnpm test` is added).

Stage each candidate as it becomes ready, after you read its diff. Use `revise` for regressions in memory, complexity, or semantics; do not accept them. During validation, run one frontier reviewer on the combined diff. Verify each finding, and fix accepted ones in Main after promotion. Examples: a public export must not return a shared mutable cache; an incremental parser must keep the full-parse results.

Prune tests in Main when the change is small. Test files are not in any `files` allowlist, so pruning needs no version bump. Confirm with `check:package-versions`.

## Docs

Follow the root `AGENTS.md` README rules, [the README template](../../../extensions/README-template.md), and [the diagram guide](../../../docs/diagram-style.md).

- Correct claims against code: commands, config, guards, order of steps, terms in `CONTEXT.md`, and ADR links and index.
- Remove retired migration text, setup repeated across READMEs, guidance that its owning doc already covers, prose that only repeats a linked diagram, and published files that leak local paths.
- Retire or merge superseded ADRs, and update every link to them.
- Diagrams: the HTML file is the source of truth. Check every label against source code. Export the SVG with the `diagram-design` helpers (`scripts/export_svg.py`, `scripts/self_check.py`, and `scripts/verify-geometry.py` from its repository root). Set the SVG `width` and `height` to the `viewBox` values. Delete unlinked diagrams. Add `docs` to the package `files`, then verify with `npm pack --dry-run`.
- If extension dependencies change, update `docs/extension-dependencies.{html,svg}` and the root README alt text.

Each published README or file change needs a patch bump. Run `docs:validate`, `check:package-versions`, and `git diff --check`. Use a frontier review of changed diagram labels against code.

## Publish

Before you push, run the root checks on the exact head. In the PR body, list each change with its reason, the checks with their results, rejected findings with the reason, and every package that releases.
