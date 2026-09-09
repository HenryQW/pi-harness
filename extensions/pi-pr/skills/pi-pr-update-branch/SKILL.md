---
name: pi-pr-update-branch
description: Update the current pull-request branch with the exact revision of its base using the package helper.
---

# Pi PR Update Branch

Use the `pi_pr_update_branch` helper for all Git and GitHub mechanics. Do not reproduce its checks or commands with shell tools.

Call its available action. If it reports conflicts, inspect only the returned paths and bounded conflict hunks. Resolve only clear intent. Preserve compatible changes from both sides. Regenerate derived files after their source conflicts are resolved.

If a conflict requires a product, API, data, or migration decision, leave it pending and ask the user. Otherwise, give the helper the complete declared path set for continuation.

After the helper verifies the merge, choose and run the smallest relevant validation. Report a validation failure instead of publishing. When validation passes, ask the helper to publish the verified head.
