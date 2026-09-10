---
name: pi-pr-create
description: Prepare and publish the current branch pull request with deterministic package helpers.
---

# Pi PR Create

Use the `pi_pr_create` helper for base, merge, push, upstream, and GitHub mechanics. Do not reproduce its checks or commands with shell tools.

Use the prepared base and merge-base to inspect the live change. Separate pending work into coherent commits. Preserve coherent existing staging. Exclude `.context/` and unrelated changes. Stop when changes cannot be separated safely.

If the helper reports conflicts, inspect only its returned paths and bounded conflict hunks. Resolve only clear intent, then declare the complete resolved path set to the helper. Ask the user when the correct behavior is unclear.

Choose and run the smallest relevant validation after the helper verifies the merge. Stop on failure.

Write a concise Conventional Commit title. Write a body with `Summary` and `Testing` sections that matches the live diff and checks. Give both to the helper only after it has published the captured head. Reply with only the helper's validated pull request URL.
