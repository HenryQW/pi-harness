# `@henryqw/pi-pr`

See the current-branch pull request in the Pi footer, then run `/pr` for its next safe step. It
shows CI, review, merge, and lifecycle status without repeated `gh` commands.

## Install

```bash
pi install npm:@henryqw/pi-pr
```

Requires an authenticated GitHub CLI session (`gh auth login`) and a checkout on GitHub.com or
GitHub Enterprise. Run `gh auth status` to verify authentication.

## Works with

| Package | Relationship | Purpose |
| --- | --- | --- |
| [`@henryqw/pi-footer`](https://pi.henry.wang/extensions/pi-footer) | Improves | Shows current-branch pull-request status in the footer. |
| [`@henryqw/pi-herdr`](https://pi.henry.wang/extensions/pi-herdr) | Improves | Adds the pull-request number to a Herdr workspace label after creation. |
| [`@henryqw/pi-process`](https://pi.henry.wang/packages/pi-process) | Required | Runs bounded child processes used by Git and GitHub workflows. |

## Use

In a GitHub checkout, run `/pr`. It reads fresh pull-request and local state, then runs one route or
explains why action is blocked. The pull-request hostname selects its GitHub API host, and the
extension works outside Herdr.

Commands are for people; tools and skills are for the agent. The extension exposes these interfaces:

| Surface | Type | Purpose |
| --- | --- | --- |
| `/pr [--base BRANCH] [creation instructions]` | command | Discover the current pull request and run its next safe route; base and instructions apply only to creation. |
| `/pr --feedback` | command | Explicitly start or resume the guarded feedback sweep. |
| `pi_pr_create` | tool | Agent-only guarded actions for pull-request creation. |
| `pi_pr_fix_ci` | tool | Agent-only guarded actions for repairing failed GitHub Actions. |
| `pi_pr_sweep` | tool | Agent-only guarded actions for reviewing and resolving feedback. |
| `pi_pr_update_branch` | tool | Agent-only guarded actions for updating a pull-request branch. |
| `pi-pr-comment-sweep` | skill | Agent workflow for triaging feedback and resolving addressed review threads. |
| `pi-pr-create` | skill | Agent workflow for safely creating and publishing a pull request. |
| `pi-pr-fix-ci` | skill | Agent workflow for diagnosing and publishing a scoped CI fix. |
| `pi-pr-update-branch` | skill | Agent workflow for merging the exact base revision into the pull-request branch. |
| `Footer` | ui | Show a linked `PR #number` and one plain-language status. |
| `Widget` | ui | Show one action hint or transient routing status. |
| Confirmation | ui | Ask before linking an inferred branch or squash-merging a pull request. |
| Notification | ui | Report blocked discovery, no-action status, refresh errors, and Herdr rename warnings. |
| `node skills/pi-pr-comment-sweep/scripts/pr-feedback.mjs` | command | Read-only feedback diagnostic CLI; supported commands and arguments are below. |

For creation, put an optional base branch first. For example, run `/pr --base release/2026 Keep the
title concise.` The base is a branch name, not a host or repository. Only creation accepts the base
and remaining guidance; other routes reject them instead of ignoring them. Run `/pr --feedback` to
explicitly start or resume a feedback sweep for actionable conversation comments that do not select
the sweep automatically. It cannot be combined with a base, other options, or instructions.

The footer shows the pull request and status. Actionable widgets omit duplicate identity and status.
Each uses one semantic status icon, a space, and a plain `Run /pr to …` route. `✗` marks errors, `!`
warnings, `✓` success, and `●` accent or neutral routes. In TUI, only the icon uses a theme color.
RPC and non-TUI output use the same plain text without ANSI.

The widget switches to `⠋ Checking pull request…` as soon as `/pr` starts discovery. The braille
spinner animates in TUI mode; RPC receives one plain static line. The footer stays unchanged. The
routing widget clears after route selection and before any prompt, notification, mutation, or
workflow dispatch.

### Feedback snapshots

Run the bundled read-only diagnostic CLI from the installed package directory:

```bash
node skills/pi-pr-comment-sweep/scripts/pr-feedback.mjs fetch [--pr PR] (--out FILE | --json)
node skills/pi-pr-comment-sweep/scripts/pr-feedback.mjs show --snapshot FILE --id ID
node skills/pi-pr-comment-sweep/scripts/pr-feedback.mjs checks [--pr PR] --expected-head SHA
node skills/pi-pr-comment-sweep/scripts/pr-feedback.mjs self-test
```

`fetch` prints a compact feedback index with IDs, kinds, states, authors, locations, and parent IDs
as needed; it does not print comment or review bodies. With `--out`, it atomically replaces `FILE`
as a mode-0600 file but does not change the parent directory's permissions. The saved snapshot still
contains the complete feedback, as does `fetch --json` output. Read one item with `show`.

`show` prints one JSON record with its exact stored body and fields. A thread record includes child
IDs without child bodies; treat it as a container and inspect each `thread_comment` ID directly. Do
not call `show` on the parent only to find children. Show the parent only when it has no child or
when parent-level metadata is needed. Issue independent `show` lookups in one tool-call round. A
nested comment includes only its parent thread's ID, state, and location. Missing, unknown,
duplicate, or ambiguous IDs fail. `show` does not run Git, call GitHub, use the network, or write
files.

`checks` verifies the current pull request and its checks against the supplied full head SHA.
`self-test` checks the bundled CLI's local behavior.

## Flow

Each footer entry is one linked `PR #number` plus one plain-language status: `N unresolved`,
`draft`, `open`, `approved`, `CI running`, `CI failed`, `changes requested`, `base update required`,
`merge conflict`, `merge-ready`, `merged`, or `closed`. Colors support the text; they do not carry
meaning alone.

![Flowchart showing /pr reading fresh GitHub and local state, choosing the first matching condition, and stopping after one route](./docs/pr-routing.svg)

### Routes

| Current condition | `/pr` route |
| --- | --- |
| No current-branch pull request, no published matching ref, safe Git push configuration, and a commit or ordinary pending work | Start pull-request creation. |
| One open pull request inferred from a published matching ref | Confirm the exact `remote/ref`, then link the local branch. |
| Ambiguous or unsafe discovery | Show the blocked reason and do not mutate Git or GitHub. |
| Base update required or merge conflict | Update from the base branch's current target when the tree is clean and local HEAD equals the PR head. |
| GitHub Actions job failed | Run the CI fix workflow when the same local prerequisite holds. |
| External check or commit status failed | Show `CI failed` as a no-action blocker. |
| Changes requested or unresolved review threads | Start or resume the package comment sweep when the same local prerequisite holds. |
| Explicit `/pr --feedback` on an open, configured pull request | Start or resume the sweep when the tree is clean and local HEAD equals the PR head. |
| No-action state | Report the state without taking action. |
| Merge-ready pull request | Ask for final confirmation, recheck fresh state, and squash-merge if confirmed. |

`pi-pr-create` selects its base in this order: the leading `/pr --base BRANCH`, one
`branch.<branch>.gh-merge-base` value, then the default branch of validated `origin`. It captures
the selected base OID and merge-base. Creation requires a commit ahead or ordinary pending work,
including untracked files. A Git operation in progress does not count as pending work. If the
current branch is the selected base, pi-pr stays silent because GitHub cannot create a pull request
from a ref to itself.

The base always comes from validated `origin`. The head may use that repository or a fork with the
same GitHub source. Base and head must use the same GitHub host. Other fork relationships stop
before mutation.

Creation merges the captured base commit before validation and push. It resolves clear conflicts and
stops when the base or conflict intent is ambiguous.

A configured target never changes branch upstream settings. Without a target, the helper pushes the
captured OID to the local branch ref on validated `origin` and fetches its tracking ref. It leaves
upstream unset. It creates or updates and validates the exact PR before setting and verifying
upstream. A failed setup rolls back only unchanged helper-owned settings. If configuration changed
concurrently, it stops without overwriting it. Retrying `publish` resumes setup without another push
or PR mutation.

Without a configured push target, discovery checks validated remotes for the same branch ref. One
exact open PR becomes an inferred target. `/pr` names the exact `remote/ref` and asks before linking
it. The extension revalidates the branch, PR, remote OID, and Git configuration before mutation. It
rolls back its upstream and remote-tracking changes if final verification fails.

Multiple candidate remotes, multiple matching PRs, OID mismatches, and unsafe Git push configuration
block routing. A published ref with no PR also blocks creation. If no candidate ref exists, creation
uses only a validated `origin` destination.

The creation workflow repeats destination, remote OID, PR, and configuration checks immediately
before pushing. It pushes to the saved validated URL, not a mutable remote name. Every push uses the
saved remote OID as an exact lease. Existing refs must also be ancestors of the captured local OID.
A missing ref uses an empty lease as a create-only compare-and-swap.

Each helper workflow receives a random run ID and its first action. The run stays bound to one
session, canonical worktree, route, and fresh authority. Helper calls from another run, session,
worktree, or route fail.

For comment sweeps, `/pr` checks the package recovery file without changing it. It selects `start`
when recovery is absent, and `resume` only when valid recovery matches the fresh route authority.
Invalid recovery stays unchanged and blocks dispatch with its path and reason. One `/pr` inspects all
feedback, proposes fixes and non-actionable reasons, and asks for confirmation before editing. New
sweeps require a clean worktree at the original head for the confirmation prompt and approval write.
Version-one recovery with owned changes can still be approved after a warning and ownership check,
but approval cannot precede those edits. The prompt shows the saved ledger and owned paths; resume
exposes that plan and its approval state. After approval, the sweep commits fixes, validates,
publishes, replies to and resolves eligible review threads. A declined plan can be resumed later.

`/pr --feedback` uses the same discovery, reservation, recovery, and guard checks. It can select the
sweep even when CI failure or merge readiness would otherwise select another route. Without the
flag, route priority stays unchanged. Direct skill or `pi_pr_*` tool calls cannot create route
authority; run `/pr` to reserve a fresh route.

Only one helper run can exist at a time. Most runs expire when the agent settles. A create or
branch-update conflict stays available for one user-guided continuation, then expires after that
continuation settles. Session replacement and shutdown forget the run without aborting or cleaning a
pending merge.

After a `/pr` create workflow settles, the extension waits for a refresh that finds a configured
current PR. Failed or empty discovery leaves one rename pending for a later refresh. A restored
configured PR completes the rename even when GitHub reports it as merged or closed. It then prefixes
the Herdr workspace label with `#<number> • `. It removes repeated leading `#<number> • ` prefixes
and legacy trailing ` · PR #<number>` suffixes before adding one current prefix. The remaining
workspace name must be non-empty. It renames only the workspace, requires `HERDR_ENV=1` and a
non-empty, trimmed `HERDR_WORKSPACE_ID`, and does nothing outside Herdr. Each Herdr command has a
10-second timeout. If Herdr lookup, JSON validation, or rename fails, the PR and normal UI refresh
remain available; the extension warns with `Herdr workspace rename failed: <error>`.

Current-branch discovery reads pull requests associated with the exact push repository ref. It does
not run a global branch search. It finds a fork-head PR whose base is an upstream repository. A
unique historical match uses the exact remote push-ref OID, not local HEAD.

A no-action state includes drafts, merged or closed pull requests, unsupported failed CI, pending
review, and blocked merge policy. Running CI blocks merge but not other mutating workflows. A dirty
tree or mismatched local HEAD also blocks a mutating workflow.

### Route priority

A missing pull request uses creation. For an existing pull request, the first matching condition
wins:

1. Merged, closed, or draft: no action.
2. Base update required or merge conflict. Run only with a clean tree and equal local and PR heads.
3. A failed GitHub Actions job. Apply the same local prerequisite. Other failed checks remain blockers.
4. Changes requested or unresolved review threads. Apply the same local prerequisite.
5. Waiting or local safety block: no action.
6. Merge-ready: allow clean local HEAD equal to or behind the PR head. Confirm, then merge directly.

Ordinary conversation comments do not trigger a route or block a merge. Changes requested and
unresolved review threads can select the package comment sweep. Use `/pr --feedback` when a
conversation comment needs action.

The comment sweep resolves its bundled helper and references from the installed package skill path.
It does not require an external `jq` executable. After publishing, `refresh` freezes the complete
latest feedback and returns only IDs and kinds. Use `show` to inspect every fresh item. New actionable
feedback after publication needs a separate follow-up sweep. A second guarded `record` must cover
that exact snapshot before resolution or finalization and keeps the paths from the initial record.
The helper checks feedback record and byte capacity before posting a commit URL to an addressed
unresolved thread or a reason to a non-actionable one, then resolves it through `gh api graphql`.
Blocked threads and threads with any blocked child stay open. If a reply loses its response, a
matching new comment cannot prove who posted it: recovery stops without replaying or resolving
that thread. Replies change the feedback snapshot, so finalization uses the guard and projection
returned by resolution. Standalone conversation comments and review bodies are assessed, not
resolved. The sweep runs existing non-destructive checks on clean committed `HEAD` before
publishing and reruns them at finalization.

### Refresh

PR discovery starts in the background at session start, so the Pi footer appears before PR status
is ready. On a session switch, the previous status and action hint clear immediately; new ones
appear after discovery. A directory outside a Git worktree stays silent. Other discovery failures
show `PR · status unavailable` and only a generic error.

The footer and widget refresh after local commits, PR creation, pushes, and each dispatched
workflow settles. During creation, intermediate refreshes wait until the workflow settles. They
also refresh after successful delegated tasks. There is no periodic presentation refresh, so
external changes may leave them stale indefinitely. `/pr` cancels any pending presentation lookup
and reads fresh state before routing or acting; it remains authoritative.

The create widget stays hidden on a clean branch with no commit ahead. It appears for a commit ahead
or ordinary pending work. It stays hidden during a Git operation and when the current branch is the
selected base. `/pr` replaces any hint with routing feedback while it selects a route. The feedback
clears before route interaction. A dispatched workflow keeps the widget hidden until the agent
settles. Direct and no-action routes refresh it after completion. A failed command restores the
prior hint and schedules a refresh, except when fresh lookup hits the GitHub API quota: it shows the
sanitized message `GitHub API rate limit exhausted; retry after GitHub resets it` and does not
immediately retry.

Presentation uses route priority, so draft appears before running CI. `/pr` reads fresh state before
routing or merging. The command is authoritative for actions.

## State and storage

The extension records one configured PR identity in the Pi session. It stores only the PR URL,
number, host, head identity, and configured target identity. It does not store lifecycle, CI,
review, merge readiness, or base state. Event-driven refreshes do not add duplicate entries, and no
repository cache file is created.

Normal discovery always runs first. If the configured remote ref was deleted, the footer and `/pr`
may reload the exact observed PR URL. The current host, repository, branch, remote, ref, and local
HEAD must still match the observation. Repository names use case-insensitive GitHub matching. The
GitHub response must match the observed URL, host, repository, head ref, head OID, and PR number.
GitHub supplies fresh mutable state. Invalid session data is ignored. A failed GitHub lookup stops
routing and cannot start PR creation.

Comment sweeps own one versioned recovery file per canonical worktree at
`<agent-dir>/config/pi-pr/sweep/<worktree-id>/state.json`. The file is private, bounded to 1 MiB,
and replaced atomically. It contains the frozen PR authority, original head and lease, complete
feedback, exact ledger, owned paths, and mutation attempts. A missing file allows a fresh `start`; a
valid file matching the fresh route authority allows `resume`. Resume rechecks the canonical
worktree, local changes, PR linkage, and remote head under its lock, and reconciles an attempted
push or thread resolution before issuing a new epoch and run ID. Calls from the old run then fail.

A completed post-publish `refresh` stores the new complete snapshot before any replacement ledger.
Recovery keeps that snapshot in `refresh-pending`, with its new generation and fingerprint; status
exposes only item IDs and kinds. Use `show` with the resumed guard to inspect every frozen item,
then `record` without `ownedPaths` to supply exact complete coverage for that snapshot. Resolution
and finalization stay blocked until this record succeeds. Malformed, oversized, obsolete,
wrong-worktree, or route-mismatched recovery is preserved and blocks dispatch. Never repair, move,
replace, or delete it automatically; report the state path and exact blocker. An unknown mutation is
never replayed. If reconciliation cannot prove its exact result, stop and report the state path and
blocker.

## Limits and recovery

- `/pr` accepts either standalone `--feedback` or creation syntax with leading `--base BRANCH` and
  optional guidance. It rejects unknown or conflicting options. It does not open a browser.
- It does not run `/done` or `/sweep`.
- Presentation refreshes do not auto-triage comments or start a workflow. The package comment sweep
  starts or resumes only when an explicit `/pr` selects it. Ordinary conversation comments require
  `/pr --feedback` unless another review condition selects the sweep.
- It does not enable auto-merge or add a merge queue.
- It does not rebase the local branch, overwrite concurrent remote updates, delete branches, or
  clean up worktrees. Creation uses exact leases plus ancestry checks; an empty lease is only an
  atomic absence check.
- Creation, discovery, and comment-sweep pushes require one unambiguous push URL for the configured
  destination.
- Presentation fetches use that exact push URL and exact advertised OID. They do not use shared
  fetch state.
- A pull request that GitHub reports as behind requires a base update.
- Direct merges always use squash. GitHub rejects the mutation if repository policy does not allow
  it.
- Before merge, `/pr` fetches the exact head OID from the validated push URL without shared fetch
  state.
- A merge, rebase, cherry-pick, revert, or sequencer state blocks direct merge, even when `git
  status` is empty.
- A branch update resolves the base repository ref directly. It stops if that ref moves before merge
  or push.
- Before a comment-sweep push, it revalidates the configured destination, full PR identity, and
  local HEAD. It pushes the captured OID.
- CI repair resolves workflow runs from check-suite IDs. It does not treat HTML details links as
  identity.
- It streams a bounded failed-step log tail and runs one narrow local reproducer before editing.
- Before push, CI repair revalidates the saved destination, open PR, failure evidence, and repair
  HEAD.
- An already-published local HEAD needs no second push.
- Direct merge requires final confirmation and a fresh readiness check.
- After a successful merge, the create widget stays hidden until a new local commit.
- Only authenticated GitHub.com and GitHub Enterprise repositories are supported.
