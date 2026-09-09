---
name: pi-pr-comment-sweep
description: Fetch GitHub pull request feedback, assess every item, apply scoped fixes, publish one guarded head, and resolve addressed review threads.
---

# PR Comment Sweep

Use the package-owned comment-sweep workflow. It exposes these closed actions:
`start`, `resume`, `show`, `record`, `publish`, `refresh`, `resolve`, and
`finalize`.

1. Call `start` for a fresh current-branch pull request. Call `resume` only for
   saved work. Never replace or delete blocked recovery state by hand. See
   [Sweep recovery](references/recovery.md).
2. Use `show` for one feedback ID at a time. Inspect every conversation
   comment, review, thread, and thread comment. Follow
   [Thread triage](references/thread-triage.md).
3. Classify every item exactly once as `addressed`, `non-actionable`, or
   `blocked`. Give each entry a short note. Use `record` with the complete
   ledger and the exact repository-relative paths this sweep may change.
4. Make judgment calls in the model. Verify claims against the code and its
   callers. Edit only owned paths. Add the smallest useful regression. Commit
   accepted fixes with a scoped Conventional Commit message.
5. Call `publish`. It captures a clean `HEAD`. It skips the push when `HEAD` is
   unchanged. Otherwise it performs one exact-OID push with the original lease.
   Never retry an unknown push.
6. Call `refresh` with a replacement ledger that covers the complete fresh
   feedback set exactly once. Inspect new or changed items with `show` before
   supplying that ledger.
7. Call `resolve` only with addressed, unresolved parent thread IDs. Do not
   resolve a thread classified as non-actionable or blocked. Do not post replies
   unless the user asks.
8. Call `finalize` with the exact projection returned by `refresh` and the
   chosen existing checks. Finalization reloads feedback after the checks. It
   succeeds only when PR linkage, content, and thread states still match.

The bundled `scripts/pr-feedback.mjs` is a read-only diagnostic CLI. It supports
only `fetch`, `show`, `checks`, and `self-test`. It cannot push or resolve
threads.

Report `PR | addressed | resolved IDs | non-actionable | blocked | checks |
commit | push`.
