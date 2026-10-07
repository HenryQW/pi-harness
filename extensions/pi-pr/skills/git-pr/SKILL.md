---
name: git-pr
description: Use pi-pr's guarded /pr workflow to create or update the current branch GitHub pull request. Check explicit base intent and current-PR authority before routing.
---

# git-pr

Use the existing `/pr` command. Do not push with shell tools, call `gh pr create`, edit PR metadata, or call a route helper without its reserved run ID. The package has one PR mutation workflow, not a second skill implementation.

## Base and current PR

- An existing, proven current-branch PR owns its base. If the user supplies a different base, stop and report the mismatch. Do not retarget it or create a duplicate.
- For a new PR, `/pr` selects one `branch.<branch>.gh-merge-base` value, then the validated `origin` default branch. An explicit base from the old skill is not a `/pr` argument. Compare it with that selection before routing. If it differs, stop and ask the user to set the branch's repository-local `gh-merge-base` explicitly, then run `/pr`. Never write this setting silently or change global Git configuration.
- Do not infer a base from the branch name, pick the first remote/PR, or use an unbounded branch-name PR search. `/pr` establishes PR identity from the validated destination, repository, ref, and exact OID. Ambiguity and a published branch with no proven PR remain blockers.

## Handoff

Tell the user to run `/pr` when this skill is called outside an authorized `/pr` invocation. A skill or shell command cannot create the required session-local authority. Do not send a shell `/pr` or pretend that `sendUserMessage` executes extension commands.

Explain the contract before handoff: `/pr` is the full PR lifecycle, not a create-only command. It can commit scoped work, validate, publish, address feedback, repair CI, and merge when ready. A request only to create a PR does not silently authorize that broader lifecycle. The user must invoke `/pr` for it. If a run is already active, follow its package skill and run ID; do not start another invocation.

Creation and local publication use guarded `inspect` and `commit` actions. Preserve unrelated staging and never include secrets or `.context/`. Stop for unclear ownership. Validation, exact-OID pushes, leases, PR reuse, and uncertain-outcome recovery belong to the package helpers. The old skill's independent `origin` push and metadata update path is removed. Existing PRs are reused by exact authority; their title/body are not automatically rewritten.

Report the validated PR URL and any blocker or lifecycle result. Do not claim success from a shell push or from stale discovery.
