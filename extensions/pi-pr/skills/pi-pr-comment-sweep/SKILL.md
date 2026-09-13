---
name: pi-pr-comment-sweep
description: Fetch GitHub pull request feedback, assess every item, apply scoped fixes, publish one guarded head, and resolve addressed review threads.
---

# PR Comment Sweep

Use the package-owned comment-sweep workflow. It exposes these closed actions:
`start`, `resume`, `show`, `record`, `publish`, `refresh`, `resolve`, and
`finalize`.

1. Use the `start` or `resume` action supplied by `/pr`. `/pr` checks saved work
   and chooses the action. Do not change it. Direct skill or tool calls cannot
   create route authority; run `/pr` instead. Never replace or delete blocked
   recovery state by hand. See [Sweep recovery](references/recovery.md).
2. Use `show` for one feedback ID at a time. Inspect every conversation
   comment, review, thread, and thread comment. Follow
   [Thread triage](references/thread-triage.md).
3. Classify every item exactly once as `addressed`, `non-actionable`, or
   `blocked`. Give each entry a short note. Use `record` with the complete
   ledger and the exact repository-relative paths this sweep may change.
   `ownedPaths` is required for this initial record.
4. Make judgment calls in the model. Verify claims against the code and its
   callers. Edit only owned paths. Add the smallest useful regression. Commit
   accepted fixes with a scoped Conventional Commit message.
5. Choose one or more existing non-destructive checks that cover the changes.
   Run each on the clean committed `HEAD`. Do not call `publish` unless every
   chosen check passes. Keep the exact commands for finalization.
6. Call `publish`. It captures the validated clean `HEAD`. It skips the push
   when `HEAD` is unchanged. Otherwise it performs one exact-OID push with the
   original lease. Never retry an unknown push.
7. Call `refresh` with the current guard and no ledger. It freezes the complete
   fresh feedback, clears the old ledger, and returns a new guard plus bounded
   IDs and kinds. Status never includes feedback bodies.
8. Use `show` with the new guard for every returned ID. This catches new items
   and edits that kept the same ID. Then call `record` with that guard and one
   complete replacement ledger. Omit `ownedPaths`; the initial ownership stays
   fixed. A stale guard or mismatched coverage fails.
9. Call `resolve` only with addressed, unresolved parent thread IDs. Do not
   resolve a thread classified as non-actionable or blocked. Do not post replies
   unless the user asks.
10. Call `finalize` with the exact projection returned by the post-refresh
   `record` and the same chosen checks. Finalization reruns them, then reloads
   feedback as a later state guard. It succeeds only when PR linkage, content,
   and thread states still match.

The bundled `scripts/pr-feedback.mjs` is a read-only diagnostic CLI. It supports
only `fetch`, `show`, `checks`, and `self-test`. It cannot push or resolve
threads.

Report `PR | addressed | resolved IDs | non-actionable | blocked | checks |
commit | push`.
