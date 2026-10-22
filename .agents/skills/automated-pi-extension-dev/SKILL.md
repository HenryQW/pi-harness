---
name: automated-pi-extension-dev
description: Use when Main leads a batch of extension changes in this repository through worker agents, with one Herdr worktree and one pull request per extension, and Main reviews, merges after user confirmation, and finishes each worktree.
---

# Automated Pi Extension Development

Main is the manager. Main owns scope, decisions, review, merge, and cleanup. Workers own implementation, their pull request, and its feedback. The user answers only in Main's pane.

Requirements: Herdr, `gh` with access to the repository, `jq`, and `@henryqw/pi-pr` 10.5.0 or later for `pi_pr_status` and `pi_pr_merge`.

## 1. Plan

1. Delegate broad discovery to read-only scouts in parallel, one for each area. Verify their main claims in code before you report them.
2. Get the user's decisions: which units to build, and the home package of each unit. Use the package `CONTEXT.md` files and `CONTEXT-MAP.md` to choose homes. A home must own the responsibility; do not stretch a definition (for example, a worktree handoff is not delegation).
3. Save the plan in `.context/plan.md`. Before launch, delegate one frontier reviewer to review the plan from first principles: real problem, existing coverage, Pi API mechanism (verify in the installed Pi `dist/` and `.d.ts`), home, smallest version, failure modes, and release cost.
4. Order units in dependency layers. A unit that proves a shared mechanism (for example a boundary rule) goes in an earlier layer than units that copy it. Every handoff starts from local `main`, so launch a layer only after its prerequisites merge and local `main` is updated.

## 2. Launch

1. Fast-forward the primary checkout's `main` to `origin/main`. `herdr_handoff` creates each worktree from local `main`.
2. Start one `herdr_handoff` for each extension. The prompt must be self-contained and state:
   - Why, the requirements, and the verified Pi API facts with file and line.
   - Process: load `pi-extension-workbench`, follow `AGENTS.md`, apply the version bump, run the root checks that the change can affect. For a new package, include the new-package steps and the npm `E404` check.
   - Rules: never merge; never post `@codex review`; never mention any other agent harness or fork by name; report only to Main's pane (`$HERDR_PANE_ID` of Main).
   - The worker loop in section 3, copied in full.
3. Record each agent, branch, pane, and pull request in `.context/progress.md`.

## 3. Worker loop

Copy this into each handoff prompt, with Main's pane ID:

> After each push, call `pi_pr_status` with your PR number every 2 to 3 minutes. Address every Codex comment, P2 included: fix it and reply with the full commit hash, or reply with a one-sentence rebuttal, then resolve the thread. On `block` from failed checks, unresolved threads, or a conflict, fix the cause and push. On `block` that code cannot fix (closed, draft, required human review, or repository policy), report the reasons to Main and stop. On `wait`, keep waiting. When the verdict is `ready` with no unresolved threads, send one message: `herdr agent prompt <Main pane> "READY #<PR> <full head oid> checks: <what you ran>"`. Then stop and wait for Main.

## 4. Main on READY

1. Fetch the exact head: `git fetch origin +pull/<N>/head:refs/review/pr-<N>`.
2. Review the change since the last head that you reviewed. Review a small delta yourself. For a new package, a large delta, or many Codex-driven changes, delegate one frontier `reviewer` with criteria and exact refs. Verify each finding in code before you send it.
3. Send findings with `herdr agent prompt <worker pane> "..."`: priority, evidence, and the smallest fix. Make design decisions yourself when they stay inside the user's decisions; ask the user only for scope or policy changes.
4. When the review passes, call `pi_pr_status`. Then call `pi_pr_merge` with the exact `headOid`. The user confirms in Main's pane.
   - Merge bar: Codex finished the current head, and no thread of any priority is unresolved. If `unresolvedThreads.other` is not zero, send the PR back to the worker.
   - If Codex shows `running` for a long time and the change since the last Codex-reviewed head is trivial, ask the user whether to merge without that review. `pi_pr_merge` refuses a `wait` verdict. If the user agrees, call `pi_pr_status` again immediately before the merge and continue only when Codex is the only wait reason and the base is `main`. Then run `gh pr merge <N> --match-head-commit <oid>` with the flag for the configured `mergeMethod` (`--squash` in this repository). Add `--admin` only when the ruleset's approval rule is the remaining requirement, because self-authored pull requests cannot get that approval; `--admin` also skips every other requirement, so the fresh status read is the only check.
5. After the merge, tell the worker that its work is complete with `herdr agent prompt --wait --until idle --until done <worker pane> "..."`, so the worker turn ends first. Then finish its worktree yourself: `.agents/skills/automated-pi-extension-dev/scripts/finish-worktree.sh <workspace> <PR>`. The script refuses unless the PR is merged into the primary checkout's branch, the checkout is clean and at the merged head, no agent in the workspace is working, and no pane in another workspace uses the checkout.

## 5. Conflicts and follow-ups

- When `main` moves under a pull request, tell its worker to rebase onto `origin/main`, keep both changes, run `pnpm run versions:rebump` for version and lockfile conflicts (it keeps the branch's bump level on the new base), run the checks again, and push with `--force-with-lease`.
- For findings on a merged pull request, start a new handoff from fresh `main` for a follow-up pull request. Do not reopen the merged branch.

## 6. Close the batch

1. Delegate one frontier review of the combined change on `main` (`<batch base>..origin/main`): cross-package interactions, load-order independence, repository consistency, and forbidden names. Also review each pull request that was merged without a Main review.
2. Fix findings with follow-up handoffs through the same loop.
3. Report the packages that release, and list new packages that need npm first publication (see [the first-publication checklist](../../../docs/releasing.md#first-publication-checklist)). CI cannot publish a new package.

## Lessons

- Workers can send a message to the wrong pane. Give Main's pane ID in every prompt.
- Correctness must not depend on extension load order. Pi does not document an order. Prefer events that fire after all handlers, such as `agent_settled`, to boundary handlers that yield to earlier handlers.
- A long Codex `running` state can stall without end. Do not post `@codex review`; ask the user.
- The guarded publish validator in pi-pr limits command output. If `pnpm test` exceeds it, publish with package-scoped checks; CI runs the full test.
- Codex-driven refusals can grow a tool fast. Review each large Codex-driven delta for refusals that also trigger on ordinary input.
