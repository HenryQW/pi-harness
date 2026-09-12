# Pi PR

Pi PR observes the current-branch pull request and routes the user to its single highest-priority next step. The footer and PR next-step widget use the same route; `/pr` reads fresh state before acting. It supports authenticated GitHub.com and GitHub Enterprise repositories. Each PR hostname selects its GitHub API host.

## Language

**Current-branch pull request**:
The one GitHub pull request proven to match the Pi session's current branch. A configured target proves it directly. A unique inferred target proves it from a validated remote ref, repository, and exact OID.
_Avoid_: Repository PR list, PR dashboard

**Configured PR target**:
The current branch's explicit Git push destination. It names one validated remote, repository, host, ref, and remote OID.
_Avoid_: Upstream guess, default remote

**PR identity observation**:
A session entry that remembers only a configured pull request's stable identity. It stores the PR URL, number, host, head identity, and configured target identity. Normal discovery may reload that URL after the configured remote ref is deleted. The current target and local HEAD must still match. GitHub remains authoritative for mutable state. Invalid identity or a failed GitHub load never enables PR creation.
_Avoid_: Pull request cache, worktree cache, mutable PR snapshot

**Inferred PR target**:
One exact PR target discovered when the branch has no configured push destination. It must be the only validated remote publishing the same branch ref, and its PR head must match the remote OID. It has presentation authority but no mutation authority until the user confirms linking.
_Avoid_: Guessed upstream, automatic link

**PR discovery blocker**:
A deterministic reason that PR discovery cannot safely select creation, linking, or another workflow. Examples include ambiguous remotes or PRs, an OID mismatch, a published branch without a PR, and unsafe Git configuration.
_Avoid_: No PR, transient lookup failure

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

**PR helper run**:
One random in-memory run ID bound to the current session generation, canonical worktree, selected route, and fresh route authority. Only one run may exist. Most runs end at agent settlement. An exact create or branch-update conflict may survive for one user-guided continuation. Session replacement and shutdown forget the run without changing a pending merge.
_Avoid_: Reusable token, serialized authority, global workflow context

**PR next-step widget**:
A compact one-line action hint tells the user which highest-priority workflow `/pr` will run. It omits identity and status already shown in the footer. It prefixes the plain `Run /pr to …` text with `✗` for errors, `!` for warnings, `✓` for success, or `●` for accent and neutral routes. In TUI, only the icon uses a theme color; RPC and non-TUI receive the same plain line without ANSI. The creation widget stays absent on a newly created local branch until that branch gains a commit. Other widgets are absent when no workflow is available.
_Avoid_: Workflow menu, multiple actions

**PR routing widget**:
A transient one-line `Checking pull request…` status replaces the next-step widget while `/pr` performs fresh discovery. TUI uses an animated, width-bounded braille spinner. RPC receives the plain first frame without ANSI. The footer remains visible. The widget clears as soon as route derivation finishes and before any route interaction or action. Concurrent commands show it while any invocation is still routing. Session replacement and shutdown stop its timer.
_Avoid_: Model working indicator, modal, routing result

**PR workflow routing**:
`/pr` derives one next step from fresh remote and local state. Creation alone accepts a leading branch-only `--base <branch>`. It parses that value before discovery, and discovery uses it only if it selects creation. Remaining creation text goes to the bundled skill as guidance. Every other route rejects a base or prose instead of ignoring it. A unique open inferred target selects confirmed branch linking. A true absence selects creation only after validating `origin`, proving no remote publishes the same ref, and finding a committed change ahead of the selected base. A discovery blocker selects no mutation. For a configured pull request, lifecycle and draft no-action states come first, followed by required base update or conflict, CI failure, PR feedback, waiting or local blockers, and merge readiness. Branch update, comment sweep, and CI fix run only with a clean tree and local HEAD equal to the PR head. A failed local prerequisite stops routing instead of falling through. Direct merge keeps its clean equal-or-behind rule. `/pr` reserves one helper run after discovery and before sending the package skill. The skill prompt receives its run ID, first action, and creation-only guidance. `/pr` does not open a browser, invoke `/done` or `/sweep`, or continue automatically into another workflow.
_Avoid_: PR browser command, workflow menu, workflow chain

**PR presentation refresh**:
The footer and widget load at session start, refresh after local commits, PR creation, pushes, dispatched workflow settlement, and successful delegated-task settlement, and poll every 30 seconds. A session outside a Git worktree stays silent and does not poll. The routing widget replaces any action hint when `/pr` starts and clears when route derivation finishes. A creation workflow defers intermediate refreshes until agent settlement, so its push-before-PR transition stays hidden. Other dispatched workflows keep the widget hidden until settlement; direct and no-action routes refresh it after the handler finishes. Command errors restore the prior hint and schedule a refresh. After a successful merge, a missing current-branch pull request does not show the create widget until a new local commit. Presentation and `/pr` share fresh discovery plus session identity rehydration. Polling is presentation only and may be stale. `/pr` reads fresh state and is authoritative for actions.
_Avoid_: Polling-driven workflow, cached command state

**PR creation workflow**:
When discovery proves that the current branch has no pull request, no published same-name ref, safe push configuration, and a committed change ahead, `/pr` dispatches bundled `pi-pr-create`. The optional branch base stays private in the helper run. Shared inspection selects it in this order: explicit branch, one `branch.<branch>.gh-merge-base` value, then the validated `origin` default branch. It represents equal head and base refs as expected creation ineligibility: discovery returns no action with zero commits ahead, while mutation preflight still rejects the same-ref request. For distinct refs, preflight captures the branch, HEAD, base OID, and merge-base. A dirty tree with zero commits ahead does not select creation. The base is always validated `origin`; the head can be that repository or a fork with the same GitHub source and host. Other fork relationships stop. The workflow repeats PR absence, remote OID, destination, base drift, and configuration checks before mutation. It pushes a captured OID to the saved validated URL with an exact remote-OID lease and requires existing refs to be ancestors. Without a target, it uses validated `origin` and the local branch ref with an atomic create-only lease and fetches the tracking ref without setting upstream. It creates or updates and validates the exact PR first, then sets and verifies upstream. A failed upstream setup rolls back only unchanged helper-owned configuration. A retry does not push again or duplicate the PR. A configured target never alters upstream.
_Avoid_: Creation after ambiguous discovery, same-ref discovery failure, configured-target fallback, symbolic push source, duplicated shell workflow, unscoped automatic commit

**PR branch-update workflow**:
When the current pull request needs a base update or has a merge conflict, `/pr` dispatches bundled `pi-pr-update-branch` only when local HEAD equals the PR head and the worktree is clean. The run calls deterministic merge, continuation, and publish helper methods directly. The helper derives the exact base host and repository from the validated public PR URL. It resolves the current target of the base repository ref, pins that OID, and stops if the ref moves before merge or push. It merges without rewriting history, resolves clear conflicts, validates, and pushes. It stops when resolution requires a product decision.
_Avoid_: PR base snapshot OID, `origin/main`, rebase, force push, automatic stashing

**PR comment-sweep workflow**:
When changes are requested or unresolved review threads exist, `/pr` dispatches the package-owned `pi-pr-comment-sweep` only when local HEAD equals the PR head and the worktree is clean. It resolves its bundled helper and references from the installed package skill path and needs no external `jq` executable. Before pushing, it revalidates the configured remote and ref, sole push URL, repository and host, full PR identity, and local HEAD. It pushes the captured OID without retry or fallback. It accepts the PR head already equal to local HEAD; otherwise the snapshot head must remain unchanged. After publishing, refresh first freezes a complete fresh feedback generation and exposes only IDs and kinds. `show` reads items from that generation. A second guarded record must cover the exact frozen set before resolution or finalization; it cannot change the initial owned paths. Ordinary conversation comments do not select it, and presentation polling never starts it.
_Avoid_: `/sweep`, automatic comment triage, ordinary-comment routing, ledger acceptance during feedback reload

**PR CI-fix workflow**:
When a diagnosable GitHub Actions job has failed, `/pr` dispatches the package-owned `pi-pr-fix-ci` only when local HEAD equals the PR head and the worktree is clean. Other failed checks and commit statuses remain visible no-action blockers. The helper streams bounded log tails and revalidates its saved destination, open PR, failure evidence, and repair HEAD directly before one exact-OID push.
_Avoid_: CI watcher, automatic retry, rerun loop

**PR merge workflow**:
When the current pull request is merge-ready, `/pr` asks for final yes-or-no confirmation, revalidates readiness, and squash-merges directly. It allows a clean local HEAD equal to or behind the PR head. An in-progress merge, rebase, cherry-pick, revert, or sequencer operation is not clean, even when status is empty. The readiness check fetches the exact PR head OID from the validated push URL without shared fetch state. GitHub remains responsible for rejecting a squash merge that repository policy does not allow. The workflow does not enable auto-merge or a merge queue, rebase the local branch, force-push, delete branches, or clean up worktrees.
_Avoid_: Merge skill, unconfirmed merge, auto-merge, branch cleanup, worktree completion
