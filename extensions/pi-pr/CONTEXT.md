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
The single highest-priority user-authorized workflow derived from the current lifecycle and conditions. One `/pr` invocation authorizes guarded steps through fresh rediscovery, stopping for external input, ambiguity, failed checks, an uncertain mutation, a repeated route, or merge. Direct merge needs fresh readiness, not a second confirmation.
_Avoid_: Automatic remediation, PR action, workflow chain

**PR helper run**:
One random in-memory run ID bound to the current session generation, canonical worktree, selected route, and fresh route authority. Only one run may exist. Most runs end at agent settlement. An exact branch-update conflict may survive for one user-guided continuation. Session replacement and shutdown forget the run without changing a pending rebase.
_Avoid_: Reusable token, serialized authority, global workflow context

**PR next-step widget**:
A compact one-line action hint tells the user which highest-priority workflow `/pr` will run. It omits identity and status already shown in the footer. It prefixes the plain `Run /pr to …` text with `✗` for errors, `!` for warnings, `✓` for success, or `●` for accent and neutral routes. In TUI, only the icon uses a theme color; RPC and non-TUI receive the same plain line without ANSI. The creation widget stays absent on a clean new local branch. It appears after a commit or for ordinary pending work, including untracked files. It stays absent during a Git operation and when head and base are the same ref. Other widgets are absent when no workflow is available.
_Avoid_: Workflow menu, multiple actions

**PR routing widget**:
A transient one-line `Checking pull request…` status replaces the next-step widget while `/pr` performs fresh discovery. TUI uses an animated, width-bounded braille spinner. RPC receives the plain first frame without ANSI. The footer remains visible. The widget clears as soon as route derivation finishes and before any route interaction or action. Concurrent commands show it while any invocation is still routing. Session replacement and shutdown stop its timer.
_Avoid_: Model working indicator, modal, routing result

**PR workflow routing**:
`/pr` is flagless. A fresh discovery chooses creation on a validated unpublished branch with committed or ordinary pending work, links one exact inferred target and rediscovers the same configured PR before continuing, or routes a configured open PR. A dirty tree or ahead local HEAD selects scoped local publication first. Confirmed conflicts select a pinned-base rebase only for a clean, equal head; a behind base alone does not authorize rebase. Failed GitHub Actions CI, review changes, and unresolved threads select their guarded workflows. Before waiting or merge, `/pr` compares a complete fresh feedback snapshot against the last finalized sweep marker so new standalone comments and review bodies select triage automatically. Merged, closed, and draft PRs are no-action. The helper run is bound to the session and canonical worktree; one `/pr` continues after a completed helper action. After each published mutation the invocation reads fresh GitHub mergeability, feedback, and CI. Direct merge requires fresh readiness and an exact expected head.
_Avoid_: User-facing `/pr` flags, stale mergeability, unsolicited conflict resolution

**PR presentation refresh**:
The footer and widget load once at session start and refresh after local commits, PR creation, pushes, dispatched workflow settlement, and successful delegated-task settlement. No periodic presentation refresh runs, so external changes may leave the footer and widget stale indefinitely. A session outside a Git worktree stays silent. The routing widget replaces any action hint when `/pr` starts and clears when route derivation finishes. A creation workflow defers intermediate refreshes until agent settlement, so its push-before-PR transition stays hidden. Other dispatched workflows keep the widget hidden until settlement; direct and no-action routes refresh it after the handler finishes. Command errors restore the prior hint and schedule a refresh, except a fresh GitHub API quota failure, which shows the sanitized `GitHub API rate limit exhausted; retry after GitHub resets it` message and does not immediately retry. After a successful merge, a missing current-branch pull request does not show the create widget until a new local commit. Presentation and `/pr` share fresh discovery plus session identity rehydration. `/pr` reads fresh state and is authoritative for actions.
_Avoid_: Periodic presentation polling, polling-driven workflow, cached command state

**PR creation workflow**:
Preparation chooses one `branch.<branch>.gh-merge-base` or the validated `origin` default branch and pins its OID. The package helper inspects pending work and commits only explicitly selected paths; ambiguous or unrelated work stops the route for an ownership decision. Clean verification pins local HEAD without merging or rebasing merely because base advanced. Relevant validation precedes the exact-OID, exact-lease push. Creation/publishing preserves existing post-push retry and upstream recovery boundaries.
_Avoid_: Creation-time merge, user-facing base flags, shell-driven Git mutation

**PR conflict rebase workflow**:
Only a confirmed conflict routes to the package branch helper with clean equal local and PR heads. It pins and fetches the exact base OID, rebases, returns bounded conflict paths and retains one guided continuation. Semantic conflict decisions require a user. The verified head is published once with an exact remote lease; uncertain outcomes cannot be replayed. The active invocation reads fresh mergeability and feedback.
_Avoid_: Rebase on BEHIND alone, automatic stashing, unleased force push

**PR feedback sweep workflow**:
Fresh routing finds new/edited standalone feedback as well as changes-requested reviews and unresolved threads. A marker written only after successful finalization records the last complete assessed generation; malformed markers are preserved and block attention lookup. Existing canonical-worktree sweep recovery retains version-one semantics and post-publication base OID drift recovery: refresh alone rebinds the base after confirming repository, ref, and exact published head. A clean original HEAD and an exact owned-path ledger precede edits for new sweeps. After publication, refresh retains unchanged decisions, blocks new or edited actionable feedback for a later fix cycle, and binds a saved projection to the latest complete generation. The helper selects eligible threads, verifies replies by returned ID, and never replays uncertain mutations without proof.
_Avoid_: Silent loss of standalone comments, unscoped comment edits, recovery deletion on malformed data

**PR local publication workflow**:
For a configured open PR with dirty or ahead local work, the package-owned helper freezes identity, lease, HEAD, and exact status. The model selects intended paths and a commit message; the helper rejects unrelated staged paths, commits only reviewed paths, validates clean work and descendant HEAD, and pushes an exact captured OID with a frozen lease once. Unrelated or ambiguous work stops the route for a user decision.
_Avoid_: Stash, reset, mutable symbolic push, replaying an uncertain push

**PR CI-fix workflow**:
When a diagnosable GitHub Actions job has failed, `/pr` dispatches the package-owned `pi-pr-fix-ci` only when local HEAD equals the PR head and the worktree is clean. Other failed checks and commit statuses remain visible no-action blockers. The helper resolves check-suite, workflow-run, attempt, and job IDs through GitHub API fields; HTML details links never establish identity. It streams bounded log tails and revalidates its saved destination, open PR, failure evidence, and repair HEAD directly before one exact-OID push.
_Avoid_: CI watcher, automatic retry, rerun loop

**PR merge workflow**:
When the current pull request is merge-ready, `/pr` revalidates readiness and squash-merges directly without another approval dialog. It allows a clean local HEAD equal to or behind the PR head. An in-progress merge, rebase, cherry-pick, revert, or sequencer operation is not clean, even when status is empty. The readiness check fetches the exact PR head OID from the validated push URL without shared fetch state. GitHub remains responsible for rejecting a squash merge that repository policy does not allow. The workflow does not enable auto-merge or a merge queue, rebase the local branch, force-push, delete branches, or clean up worktrees.
_Avoid_: Merge skill, unchecked merge, auto-merge, branch cleanup, worktree completion
