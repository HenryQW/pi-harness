---
name: pi-pr-update-branch
description: Update a PR branch with a confirmed conflict or required base update against the pinned base, then publish with the package helper.
---

# Pi PR Branch Update

Use only `pi_pr_update_branch` for Git and GitHub mechanics. This pull request (PR) route requires a fresh confirmed conflict or a required base update. Main owns conflict decisions; do not send them to subagents.

Call the prompted `rebase` action. The action name stays unchanged: it rebases linear history, but merges the pinned base when the branch contains merge commits after the fork point. This preserves earlier merge resolutions. The helper records pending recovery before mutation and uses the exact base object identifier (OID).

If the result is `kind: "stale"`, report the reason and finish without retrying or calling `publish`. Pre-mutation drift permits bounded fresh routing in the same invocation. If the result also has `aborted: true`, the helper restored the original head after authority changed during a conflict. That attempted update ends; do not start another update automatically.

For `kind: "conflict"`, use the returned `strategy`:

- `merge`: `ours` is the PR branch; `theirs` is the pinned base.
- `rebase`: `ours` is the pinned base with commits already replayed; `theirs` is the PR commit being replayed.

Call `git_conflict` with `{ "action": "list" }`, then `show` only blocks in the returned paths. Never grep for markers or edit marker lines by hand. Resolve the blocks of one file in one `resolve` call, with each block number and identifier (ID). Use `@ours`, `@theirs`, `@both` (ours then theirs), or `@base` (diff3 or zdiff3 markers only). The limit is 256 blocks per call; continue with the returned `remaining` blocks. For a combined edit, resolve to `@both`, then edit the joined lines. If a block changed, nothing was written: call `list` again.

A path with a `note` instead of blocks needs a whole-file decision. Stop and ask the user; do not pass it to `continue`. Preserve compatible work from both sides. Ask the user if the resolution needs a product, interface, data, or migration decision. Otherwise, call `continue` with the complete declared path set. More than one replayed commit can conflict: repeat until verified.

A valid conflict context stays in the same live session across idle turns. Use its existing `runId`; a new launch cannot replace it. Continuation checks branch, HEAD, exact operation markers, fresh authority, and the original status baseline. Undeclared edits block continuation and abort without clearing a valid context. Correct those edits, then continue the same run. A base that only advanced does not invalidate the pinned update. Cancellation, failure, stale operation state, completion, or session shutdown clears the live context. After restart, pending recovery blocks automatic replay; inspect it manually. Never delete a journal to force a retry.

After verification, continue in the same run. Run the smallest relevant non-destructive checks. Report failures instead of publishing. Call `publish` once after checks pass. It publishes only the verified exact OID with the original remote lease. Never replay a push with an uncertain outcome. With `scope: "update-branch"`, publication ends the invocation. With `/pr`, fresh routing can continue to other permitted steps, but cannot start a second base update in that invocation.
