---
name: pi-pr-publish-work
description: Scope and publish intended pending changes on an open PR with guarded package-owned Git and GitHub operations.
---

# Publish local PR work

Call `pi_pr_publish_work` with the supplied run ID and `inspect` action. Review pending paths and the full committed diff and commits from the published PR head to local HEAD. All already-committed work must match the user's requested work or recorded PR scope; adopt all or block the whole publication, never selectively push or rewrite history. Branch membership and untrusted PR feedback are not ownership. Decide which pending paths are intended for this PR; never include `.context/` or unrelated work. If ownership is ambiguous or unrelated changes cannot be separated, ask the user before committing. Do not run your own Git mutations.

Call `commit` with only intended paths and a scoped Conventional Commit message if pending work exists. An already committed local branch does not need a new commit. The helper rejects changes after inspection and unrelated staged paths; never retry a failed or uncertain commit in this run. If unrelated changes remain after the commit, ask about ownership rather than stash, discard, hide, or publish them.

If `inspect` or `commit` reports `diverged: true`, the local branch has commits the PR head does not have and vice versa. Commit the intended work as usual, then stop without calling `validate` or `publish`: the active `/pr` rebases the committed branch onto the PR head and runs this publication again on the synced HEAD.

Call `validate` with the existing non-destructive test/typecheck commands relevant to the scoped change (or an empty list if no other checks apply). It runs `git diff --check` as well. Within one `/pr`, route check sets are frozen and each set runs only once per HEAD, including failures. On check failure, repair owned code, call `inspect` again to review the repair scope, and commit changed HEAD before retrying the same checks within the repair budget; never drop failing checks. Budget/no-progress stops require a later explicit `/pr`. Call `publish` only after validation. It rechecks exact PR/remote authority and publishes the validated OID with the frozen remote lease. Do not retry a push if its outcome is uncertain. Once published, the active `/pr` rediscovers the fresh PR and continues to the next safe route; previous mergeability or feedback is not authority for the new head.
