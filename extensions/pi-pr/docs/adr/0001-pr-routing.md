# Route `/pr` by current condition

## Decision

`/pr` is one argument-free PR workflow router. It is not a browser opener, workflow menu, or family of action commands. Each invocation reads fresh remote and local state, derives one `PR next step`, and runs it. After a completed route, the invocation rediscovers fresh GitHub state and routes again until a blocker, external input, an exhausted budget, or merge confirmation. A prior mergeability or CI snapshot is never authority for a new head. The footer and widget use the same priority for presentation, but fresh command state is authoritative.

One explicit `/pr` authorizes routine creation, linking, sync, scoped fixes, CI repair, publication, feedback resolution, and CI waits without separate approval dialogs. Asking again after each refresh repeated decisions and impeded completion. Fresh authority, clean or owned-path validation, exact remote leases, saved feedback projections, and no replay of uncertain mutations remain mandatory. Ambiguous ownership or semantic conflicts, failed checks, and unprovable mutation outcomes stop with preserved recovery instead of assumed consent.

The model-callable `pi_git_pr` entry defaults to `scope: "publication"`. An explicit conflict/base-update order permits `scope: "update-branch"`: bounded refresh, one guarded branch update and checked publication, then stop. This scope rejects upstream settings and cannot create, link, sync, publish unrelated work, repair feedback or continuous integration (CI), or merge the pull request (PR). This keeps a base-update order separate from full lifecycle authority.

Each invocation has budgets from `config.json`: `maxPublicationCycles` (default 3) confirmed PR-head pushes, `maxRepairAttempts` (default 3) failed or unknown check sets, and one shared `ciWaitMinutes` (default 10) wait polled every `ciPollSeconds` (default 30). Check sets stay fixed and run once per HEAD. A route that already completed on the same head stops continuation. A later `/pr` resets the budgets.

A configured push target remains the direct discovery authority. When it is absent, discovery enumerates validated remotes for the same branch ref. One exact open PR with the advertised remote OID becomes an inferred target. `/pr` links it, then continues only after fresh discovery confirms the same configured PR. Inferred authority never permits update, sweep, CI-fix, or merge mutations.

Creation is selected only when no validated remote publishes the same ref, `origin` resolves to one safe GitHub destination, and Git push configuration can safely acquire that target. Validated branch configuration or the `origin` default selects the creation base. Ambiguous remotes or PRs, OID mismatch, unsafe link configuration, and a published ref without a PR are explicit blockers. For an existing configured pull request, the first matching condition wins:

1. Merged, closed, or draft: no action.
2. Local HEAD behind the PR head, or clean local commits diverged from it: fast-forward or rebase onto the PR head. Neither step pushes, stashes, or resets; a conflicting rebase is aborted back to the original HEAD.
3. Dirty or ahead local work: commit the owned paths, validate, and publish. Dirty diverged work is committed first, synced onto the PR head, then validated and published.
4. Mergeability that GitHub has not finished computing (`UNKNOWN`): re-read at most three times, five seconds apart, then stop.
5. Confirmed merge conflict or required base update (`BEHIND`): rebase linear history onto the exact pinned base object identifier (OID). If the branch contains merge commits after the fork point, merge the pinned base instead, to preserve earlier resolutions. Publish with one remote-OID force-with-lease push. GitHub reports `BEHIND` only when repository policy requires an up-to-date branch, so it never clears by itself. Ambiguous conflict intent stays with the user.
6. Failed GitHub Actions job: run CI fix. Other failed checks block.
7. Changes requested, unresolved review threads, or new or changed feedback: run the comment sweep.
8. Running CI with no pending human review: wait within the shared budget, then route the fresh state.
9. Pending review or blocked merge policy: no action. Human-review waits never poll.
10. With `codexReview` enabled, a running current-head Codex review: wait within the shared budget.
11. Merge-ready: confirm, then merge directly.

Feedback discovery includes new or changed standalone conversation and review comments; bot conversation comments do not start sweeps. The finalized sweep writes an attention marker after guarded completion, independent of the recoverable sweep file. Malformed recovery and malformed markers remain untouched.

A merge is irreversible and outward-facing, so each merge needs explicit approval. Automatic continuation after a sweep once merged a pull request that the user had not approved. An interactive session shows one native confirmation that names the PR number and URL, the short head OID, the base ref, and `mergeMethod`. A decline reports the PR as merge-ready and ends without error. A session without UI never merges. Confirmation is not readiness authority: after a yes, `/pr` runs fresh discovery, requires the same confirmed PR context, readiness, and no new feedback, and sends the merge with the confirmed `expectedHeadOid`. `/pr` adds no configuration to skip the confirmation.

Current-branch discovery reads the validated head repository ref's GraphQL `associatedPullRequests` connection, without filtering by OID. This avoids global issue search, where valid branch-only queries can exceed GitHub's 1,000-result limit and owner-qualified `head:` values do not work. Discovery then validates every candidate URL, repository, ref, and OID, so a moved or mismatched PR head is a blocker instead of an absent PR. It preserves the sole validated push URL as fetch authority, separate from repository identity. Without an open PR, one historical candidate must match the remote OID. Discovery never falls back to local HEAD when the remote ref is absent.

Linking snapshots existing upstream configuration and the remote-tracking ref. It fetches the exact inferred ref, sets upstream, and verifies that configured discovery resolves the same PR identity and OID. Any final failure rolls back only state still matching the extension's own writes; a concurrent change causes a visible incomplete-rollback failure instead of being overwritten.

When creation is selected, the bundled workflow honors an existing configured push target. It repeats remote-ref, PR, destination, and configuration checks immediately before mutation. It pushes a captured OID to the saved validated URL and exact ref with an exact saved-OID lease after proving an existing ref is its ancestor. Without a target, it uses the validated `origin` and local branch ref with an empty force-with-lease expectation, which atomically fails if the ref appeared concurrently, then sets upstream. The extension, not the creation skill, owns post-discovery Herdr labeling.

## Boundaries

Presentation refreshes never start a workflow, poll, or auto-triage comments. Sessions outside a Git worktree emit no PR error or presentation lookup traffic. Other refresh failures expose a generic unavailable status rather than raw subprocess details. GitHub API quota failures expose only the fixed sanitized recovery message. The router does not open a browser, invoke `/done` or `/sweep`, enable auto-merge or a merge queue, delete branches, or clean up worktrees. GitHub auto-merge stays off because the post-wait re-read must still triage feedback that arrived during the run.

Presentation and merge safety fetch the exact advertised PR head OID from the validated push URL. Fetches use `--no-write-fetch-head` and never read `FETCH_HEAD`. Merge safety resolves Git operation-state paths through Git, so linked worktrees also block in-progress merge, rebase, cherry-pick, revert, and sequencer operations. Passive refresh does not read branch protection, repository rulesets, or merge-method settings. The direct merge uses the configured `mergeMethod` (`squash` by default); GitHub remains the authority on which methods a repository permits.

Branch update derives the exact base host and repository from the validated public PR URL. It uses supported public base ref and OID fields. The comment sweep resolves its helper and references from the effective package skill path. It needs no external `jq` executable. Before pushing, it revalidates the configured destination, full PR identity, and local HEAD. It pushes the captured OID once without fallback. A PR head already equal to local HEAD needs no push. Snapshot head equality remains required when a push is still needed. Each PR hostname selects its GitHub API host. Only authenticated GitHub.com and GitHub Enterprise repositories are supported.

Branch update writes pending recovery before mutation. A new merge must leave a clean branch with exactly two parents: the original head, then the pinned base. Conflict results name the strategy: merge uses `ours` for the PR and `theirs` for the base; rebase reverses those roles. A stale-authority abort must restore the original clean head. Existing version 1 verified recovery records remain valid; pending records never permit replay. A completed or aborted update cannot cause a second update in the same invocation.

Only a valid conflict-awaiting-user context survives repeated idle settlements in one live session. It retains the exact original status baseline. Continuation checks branch, head, exact operation markers, fresh authority, and undeclared edits before staging or abort. A new launch cannot replace that context. Stale operation state clears live authority, but not pending recovery. Failure, cancellation, completion, or shutdown also clears live authority. A process restart cannot reconstruct conflict authority from a pending journal.

Ended session-owned runs receive distinct guidance from foreign or stale identifiers. Ordinary settlement permits a fresh entry under the same still-valid scoped authorization, with full recovery checks. Failure requires outcome inspection first. Neither path transfers a parent or child run or retries uncertain actions. Skills continue after preparation rather than treating preparation as completion.

## Consequences

The public interaction stays small: one command runs the current next steps until a stop condition. Missing configuration no longer implies absence, so creation cannot silently duplicate an existing published PR. Budgets, fixed check sets, and same-head route detection bound each invocation. A successful push is never merge approval. Event-driven presentation can remain stale indefinitely when external state changes without a native refresh event, while `/pr` reads fresh state before acting. Exact-base, exact-lease branch updates and confirmed direct merges keep mutations bounded and observable.
