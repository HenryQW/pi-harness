---
name: pi-pr-create
description: Prepare and publish the current branch pull request with deterministic package helpers.
---

# Pi PR Create

Use only `pi_pr_create` for base selection, merge, push, upstream, and GitHub work. Do not repeat its Git or GitHub checks with shell tools.

Start with the prompted `prepare` action. It uses the saved branch base: explicit `/pr --base BRANCH`, one `branch.<branch>.gh-merge-base` value, then validated `origin` default. It requires a committed change ahead. Dirty work alone cannot start this route. The base is always `origin`; fork heads must share its GitHub source and host. Apply trailing prompt guidance only to the PR content.

After `prepare`, inspect the returned base and merge-base. Separate and commit coherent pending work. Preserve coherent staging. Exclude `.context/` and unrelated changes. Stop when separation is unsafe.

Use this action order: `prepare`, `merge`, optional `continue`, `push`, then `publish`. On conflict, inspect only returned paths and bounded hunks. Give `continue` every resolved path. Run the smallest relevant validation after the helper verifies the merge.

Give `publish` a concise Conventional Commit title and a body with `Summary` and `Testing`. It validates the exact PR before no-target upstream setup. If that setup fails after publication, retry `publish` with the same title and body. Do not push again or create another PR. Reply only with the validated PR URL.
