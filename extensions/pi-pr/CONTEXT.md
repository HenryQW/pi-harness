# Pi PR

Pi PR observes the current branch pull request and routes the user to its single highest-priority next step.

## Language

**Current-branch pull request**:
The GitHub pull request associated with the Pi session's current branch, if one exists.
_Avoid_: Repository PR list, PR dashboard

**PR footer status**:
One linked pull request number and one plain-language lifecycle or condition shown through Pi's extension status line. It uses the same priority as PR workflow routing.
_Avoid_: PR summary, review dashboard, glyph stack

**PR lifecycle**:
Whether a pull request is `open`, `merged`, or `closed`.
_Avoid_: PR state, PR condition

**PR condition**:
An independently observable fact about an open pull request, such as draft status, required base update, merge conflict, review feedback, CI outcome, or policy readiness. Several conditions may coexist.
_Avoid_: PR state, lifecycle

**PR feedback item**:
A conversation comment, review body, inline review comment, or reply that may require attention. Feedback includes human and review-bot authors but excludes mechanical CI status output. Only changes requested and unresolved review threads objectively block merging; ordinary conversation has no addressed state.
_Avoid_: Comment, unresolved thread

**Merge-ready pull request**:
An open, non-draft pull request with a clean worktree and no unpublished or divergent local commits. Mergeability, required reviews, review threads, CI, and branch policy all permit merging.
_Avoid_: No failures, no comments, approved PR

**PR next step**:
The single highest-priority user-authorized workflow derived from the current lifecycle and conditions. One `/pr` invocation runs at most one next step, then stops.
_Avoid_: Automatic remediation, PR action, workflow chain

**PR next-step hint**:
One widget sentence tells the user which highest-priority workflow `/pr` will run, such as `Run /pr to resolve merge conflict`. The hint is absent when no workflow is available.
_Avoid_: `/pr` arguments, workflow menu, multiple actions

**PR workflow routing**:
Argument-free `/pr` derives one next step from fresh remote and local state. Priority is required base update or conflict, review feedback, CI failure, waiting, then merge readiness; it does not open a browser or continue automatically into another workflow.
_Avoid_: PR browser command, workflow menu, workflow chain

**PR creation workflow**:
When current branch has no pull request, `/pr` dispatches bundled `pi-pr-create` skill. Skill follows Git PR workflow: resolve base, scope and commit pending changes, validate, push, then create or update PR with derived title/body.
_Avoid_: Duplicated shell workflow, unscoped automatic commit

**PR branch-update workflow**:
When the current pull request conflicts with or must catch up to its base, `/pr` dispatches bundled `pi-pr-update-branch`. The workflow requires a clean worktree, fetches and merges the exact pull request base revision without rewriting history, resolves clear conflicts, validates, and pushes. It stops when resolution requires a product decision.
_Avoid_: `origin/main`, rebase, force push, automatic stashing

**PR merge workflow**:
When the current pull request is merge-ready, `/pr` asks for final yes-or-no confirmation, revalidates readiness, and merges directly. It uses the sole repository-allowed merge method, or squash when several methods are allowed, without deleting branches or cleaning up the workspace.
_Avoid_: Merge skill, unconfirmed merge, auto-merge, branch cleanup, worktree completion
