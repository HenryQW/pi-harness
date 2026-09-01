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
Argument-free `/pr` derives one next step from fresh remote and local state. A branch without an upstream push target has no current-branch pull request for routing and selects creation. For an existing pull request, lifecycle and draft no-action states come first, followed by required base update or conflict, PR feedback, CI failure, waiting or local blockers, and merge readiness. Branch update, comment sweep, and CI fix run only with a clean tree and local HEAD equal to the PR head. A failed local prerequisite stops routing instead of falling through. Direct merge keeps its clean equal-or-behind rule. `/pr` does not open a browser, invoke `/done` or `/sweep`, or continue automatically into another workflow.
_Avoid_: PR browser command, workflow menu, workflow chain

**PR presentation refresh**:
The footer and widget load at session start and poll every 30 seconds. Polling is presentation only and may be stale. It fetches the exact advertised PR head OID from the sole validated push URL without shared fetch state. `/pr` reads fresh state and is authoritative for actions.
_Avoid_: Polling-driven workflow, cached command state

**PR creation workflow**:
When the current branch has no pull request, `/pr` dispatches bundled `pi-pr-create`. The workflow resolves the base, scopes and commits pending changes, and validates. It pushes a captured OID to the branch's configured push target. Without one, it uses `origin` and the local branch ref, then sets upstream. It creates or updates the PR for that exact head owner and ref.
_Avoid_: Configured-target fallback, symbolic push source, duplicated shell workflow, unscoped automatic commit

**PR branch-update workflow**:
When the current pull request needs a base update or has a merge conflict, `/pr` dispatches bundled `pi-pr-update-branch` only when local HEAD equals the PR head and the worktree is clean. It derives the exact base host and repository from the validated public PR URL. It uses the public base ref and OID fields, merges without rewriting history, resolves clear conflicts, validates, and pushes. It stops when resolution requires a product decision.
_Avoid_: `origin/main`, rebase, force push, automatic stashing

**PR comment-sweep workflow**:
When changes are requested or unresolved review threads exist, `/pr` dispatches the package-owned `pi-pr-comment-sweep` only when local HEAD equals the PR head and the worktree is clean. It resolves its bundled helper and references from the installed package skill path and needs no external `jq` executable. Before pushing, it revalidates the configured remote and ref, sole push URL, repository and host, full PR identity, and local HEAD. It pushes the captured OID without retry or fallback. It accepts the PR head already equal to local HEAD; otherwise the snapshot head must remain unchanged. Ordinary conversation comments do not select it, and presentation polling never starts it.
_Avoid_: `/sweep`, automatic comment triage, ordinary-comment routing

**PR CI-fix workflow**:
When CI has failed, `/pr` dispatches the package-owned `pi-pr-fix-ci` only when local HEAD equals the PR head and the worktree is clean. Running CI, pending review, and blocked merge policy remain no-action states.
_Avoid_: CI watcher, automatic retry, rerun loop

**PR merge workflow**:
When the current pull request is merge-ready, `/pr` asks for final yes-or-no confirmation, revalidates readiness, and merges directly. It allows a clean local HEAD equal to or behind the PR head. An in-progress merge, rebase, cherry-pick, revert, or sequencer operation is not clean, even when status is empty. The readiness check fetches the exact PR head OID from the validated push URL without shared fetch state. Repository-wide methods are intersected with every applicable ruleset restriction. Selection uses the sole effective method, then squash, then an allowed viewer default. It does not enable auto-merge or a merge queue, rebase the local branch, force-push, delete branches, or clean up worktrees.
_Avoid_: Merge skill, unconfirmed merge, auto-merge, branch cleanup, worktree completion
