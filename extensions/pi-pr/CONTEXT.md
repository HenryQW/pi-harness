# Pi PR

Pi PR observes the current-branch pull request and routes the user to its single highest-priority next step. The footer and PR next-step hint use the same route; `/pr` reads fresh state before acting. It supports authenticated GitHub.com and GitHub Enterprise repositories. Each PR hostname selects its GitHub API host.

## Language

**Current-branch pull request**:
The GitHub pull request associated with the Pi session's current branch and configured push target, if one exists. Discovery matches the exact head repository and ref, including a fork head with an upstream base.
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
A conversation comment, review body, inline review comment, or reply that may require attention. Feedback includes human and review-bot authors but excludes mechanical CI status output. Changes requested and unresolved review threads can trigger routing and block merging. Ordinary conversation comments neither trigger routing nor block merging.
_Avoid_: Comment, unresolved thread

**Merge-ready pull request**:
An open, non-draft pull request with a clean worktree and no unpublished or divergent local commits. No required base update, merge conflict, changes-requested review, unresolved review thread, failed or running CI, pending review, or blocked merge policy remains.
_Avoid_: No failures, no comments, approved PR

**PR next step**:
The single highest-priority user-authorized workflow derived from the current lifecycle and conditions. One `/pr` invocation runs at most one next step, then stops. A direct merge is allowed only after final confirmation.
_Avoid_: Automatic remediation, PR action, workflow chain

**PR next-step hint**:
One widget sentence tells the user which highest-priority workflow `/pr` will run, such as `Run /pr to resolve merge conflict`. The hint is absent when no workflow is available.
_Avoid_: `/pr` arguments, workflow menu, multiple actions

**PR workflow routing**:
Argument-free `/pr` derives one next step from fresh remote and local state. A branch without an upstream push target has no current-branch pull request for routing and selects creation. For an existing pull request, lifecycle and draft no-action states come first, followed by required base update or conflict, PR feedback, CI failure, waiting or local blockers, and merge readiness. It does not open a browser, invoke `/done` or `/sweep`, or continue automatically into another workflow.
_Avoid_: PR browser command, workflow menu, workflow chain

**PR presentation refresh**:
The footer and widget load at session start and poll every 30 seconds. Polling is presentation only and may be stale. `/pr` reads fresh state and is authoritative for actions.
_Avoid_: Polling-driven workflow, cached command state

**PR creation workflow**:
When the current branch has no pull request, `/pr` dispatches bundled `pi-pr-create`. The workflow resolves the base, scopes and commits pending changes, validates, and pushes `HEAD` to `origin`, setting the upstream when absent. It then creates or updates the PR with a derived title and body.
_Avoid_: Duplicated shell workflow, unscoped automatic commit

**PR branch-update workflow**:
When the current pull request needs a base update or has a merge conflict, `/pr` dispatches bundled `pi-pr-update-branch`. The workflow requires a clean worktree, uses the exact pull request base revision, merges without rewriting history, resolves clear conflicts, validates, and pushes. It stops when resolution requires a product decision.
_Avoid_: `origin/main`, rebase, force push, automatic stashing

**PR comment-sweep workflow**:
When changes are requested or unresolved review threads exist, `/pr` dispatches the package-owned `pi-pr-comment-sweep`. It resolves its bundled helper and references from the installed package skill path and needs no external `jq` executable. Its selected push remote must have one unambiguous push URL. Before pushing, it revalidates the full PR identity: number, URL, hostname, base repository/ref/OID, and head repository/ref/OID. Ordinary conversation comments do not select it, and presentation polling never starts it.
_Avoid_: `/sweep`, automatic comment triage, ordinary-comment routing

**PR CI-fix workflow**:
When CI has failed, `/pr` dispatches the package-owned `pi-pr-fix-ci` as one scoped next step. Running CI, pending review, and blocked merge policy remain no-action states.
_Avoid_: CI watcher, automatic retry, rerun loop

**PR merge workflow**:
When the current pull request is merge-ready, `/pr` asks for final yes-or-no confirmation, revalidates readiness, and merges directly. The readiness check validates the PR head repository as the fetch remote, fetches the head, and verifies its OID before merging. It uses the sole repository-allowed merge method, or squash when several methods are allowed. It does not enable auto-merge or a merge queue, rebase the local branch, force-push, delete branches, or clean up worktrees.
_Avoid_: Merge skill, unconfirmed merge, auto-merge, branch cleanup, worktree completion
