---
name: pi-pr-update-branch
description: Rebase a confirmed merge-conflicting PR branch onto the exact pinned base OID with the package helper.
---

# Pi PR Conflict Rebase

Use only `pi_pr_update_branch` for Git and GitHub mechanics. This route is available only for a freshly confirmed merge conflict, **not** simply because the base is behind.

Call the prompted `rebase` action. It fetches the pinned base OID and starts a rebase. If it reports conflicts, inspect only the returned paths and bounded hunks. Resolve only unambiguous intent, preserving compatible work from both sides. If resolution requires a product, API, data, or migration decision, stop and ask the user; never invent one. Otherwise, give `continue` the complete declared path set. More than one commit may conflict: repeat until verified.

After the helper verifies the rebased branch, run the smallest relevant non-destructive validation. Report failures instead of publishing. Call `publish` once after checks pass. It force-pushes only the verified exact OID with the frozen remote lease; never replay a push whose outcome is uncertain. After a successful publish, the active `/pr` rediscovers fresh GitHub mergeability and feedback for the new head; never infer it from the pre-rebase state.
