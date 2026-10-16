# Pi PR

Pi PR identifies the current-branch pull request and selects its highest-priority next step. Local commit and PR publication tools provide narrower authority than the user-run PR command.

## Language

### Identity and state

**Current-branch pull request**:
The one GitHub pull request proven to match the current branch through a validated configured or uniquely inferred target.
_Avoid_: Repository PR list, PR dashboard

**Configured PR target**:
The current branch's Git push destination, with a validated remote, repository, host, ref, and remote commit identity.
_Avoid_: Upstream guess, default remote

**Inferred PR target**:
The unique validated remote target publishing the same branch ref and exact PR head. It permits display, not changes, until the user permits upstream linking.
_Avoid_: Guessed upstream, automatic link

**PR identity observation**:
A remembered configured PR identity that can locate the same PR after its remote ref is deleted. It does not replace GitHub as authority for current state.
_Avoid_: Pull request cache, mutable PR snapshot

**PR discovery blocker**:
A known ambiguity or unsafe condition that prevents safe PR selection or creation, distinct from a failed lookup.
_Avoid_: No PR, transient lookup failure

**PR lifecycle**:
Whether a pull request is `open`, `merged`, or `closed`.
_Avoid_: PR state, PR condition

**PR condition**:
An independently observed fact about an open PR, such as draft status, base update need, conflict, feedback, CI outcome, or review and merge policy. Several conditions can exist together.
_Avoid_: PR state, lifecycle

**PR feedback item**:
A conversation comment, review body, inline review comment, or reply that may need attention, excluding mechanical CI status output. New standalone feedback can require triage without itself being a merge blocker.
_Avoid_: Comment or unresolved thread as a name for all feedback

**Merge-ready pull request**:
An open, non-draft PR with safe clean local state and no remaining publication, conflict, base-update, feedback, CI, review, or merge-policy blocker. Readiness does not authorize a merge.
_Avoid_: No failures, no comments, approved PR

### Authority and presentation

**PR next step**:
The highest-priority permitted workflow derived from fresh PR and local state, subject to the authority of the entry point.
_Avoid_: Automatic remediation, PR action

**PR helper run**:
One temporary workflow authority bound to a session, worktree, selected route, and verified PR state. It is not permission to reuse a helper after that authority ends.
_Avoid_: Reusable token, serialized authority, global workflow context

**PR workflow routing**:
Selection of the next permitted workflow from fresh evidence after each completed step, stopping for blockers, uncertain outcomes, external input, or a merge decision.
_Avoid_: User-facing `/pr` flags, stale mergeability

**PR footer status**:
The linked PR number and its highest-priority lifecycle or condition.
_Avoid_: PR summary, review dashboard, glyph stack

**PR next-step widget**:
A single action hint for the workflow that the PR command would select, separate from PR identity and status.
_Avoid_: Workflow menu, multiple actions

**PR routing widget**:
A temporary status shown while the PR command obtains fresh discovery, not the result of that discovery.
_Avoid_: Model working indicator, modal, routing result

**PR presentation refresh**:
An update to footer and widget evidence after session or work events. Displayed evidence is not authority for a later change.
_Avoid_: Periodic presentation polling, cached command state

### Workflows

**PR creation workflow**:
Creation of a PR from scoped local work against a selected, pinned base. It includes validation and exact-head publication, not a base merge or rebase.
_Avoid_: Creation-time merge, user-facing base flags

**PR local sync workflow**:
A local fast-forward or rebase onto the exact PR head to reconcile behind or diverged local commits. It does not push, stash, or reset.
_Avoid_: Automatic stashing, reset to remote, publishing from sync

**PR local publication workflow**:
Scoped commits, validation, and publication of owned local work to an existing PR with verified identity and remote lease. Unrelated work and uncertain publication outcomes stop the workflow.
_Avoid_: Stash, reset, mutable symbolic push, replaying an uncertain push

**PR branch update workflow**:
A rebase onto the pinned PR base for a confirmed conflict or required base update, followed by checked publication. It is distinct from local sync onto the PR head.
_Avoid_: Rebase on a merely stale base GitHub still calls clean, unleased force push

**PR feedback sweep workflow**:
Assessment of a complete feedback snapshot, scoped fixes where needed, and verified replies and thread resolution. Saved progress separates completed decisions from new or changed feedback.
_Avoid_: Silent loss of standalone comments, unscoped comment edits

**PR CI-fix workflow**:
Evidence-based repair of a failed GitHub Actions job on the exact PR head, with validation before publication. Other failed checks can block without qualifying for this workflow.
_Avoid_: Unbounded CI watcher, automatic retry, rerun loop

**PR merge workflow**:
A merge of the exact confirmed PR head after explicit user confirmation and a fresh readiness check. It does not enable auto-merge or include branch or worktree cleanup.
_Avoid_: Unchecked merge, auto-merge, branch cleanup, worktree completion
