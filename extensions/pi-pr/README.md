# `@henryqw/pi-pr`

See the current branch pull request in the Pi footer. Run `/pr` for the full PR lifecycle, or ask the agent to commit local work or create/update a PR without authorizing repair or merge.

## Install

```bash
pi install npm:@henryqw/pi-pr
```

Requires an authenticated GitHub CLI session (`gh auth login`) and a GitHub.com or GitHub Enterprise checkout. Verify authentication with `gh auth status`. CI repair requires a GitHub CLI whose `gh api --help` lists `--allow-escape-sequences`; upgrade `gh` if that flag is unavailable.

## Works with

| Package | Relationship | Purpose |
| --- | --- | --- |
| [`@henryqw/pi-footer`](https://pi.henry.wang/extensions/pi-footer) | Improves | Shows current-branch pull-request status in the shared footer. |
| [`@henryqw/pi-herdr`](https://pi.henry.wang/extensions/pi-herdr) | Required | Provides the Herdr CLI client when workspace renaming is available. |
| [`@henryqw/pi-process`](https://pi.henry.wang/packages/pi-process) | Required | Runs bounded child processes. |

The required packages install with `pi-pr`. Herdr itself is optional; workspace renaming requires Herdr 0.9.3 or later.

## Use

Run `/pr` in a GitHub checkout. It reads fresh local and GitHub state, takes the next safe route, and continues until it needs external input, hits a blocker, waits for CI or review, or merges. After you fix a blocker, run `/pr` again. It works outside Herdr.

The command is for you; the tools are for the agent. Skills tell the agent how to use the tools.

| Surface | Type | Purpose |
| --- | --- | --- |
| `/pr` | command | Inspect and act on the current branch's pull request. Accepts no flags, prose, or base argument. |
| `pi_git_commit` | tool | Local inspection and scoped commits; never pushes. |
| `pi_git_pr` | tool | PR creation/publication only; no feedback, CI repair, base rebase, or merge. |
| `pi_pr_create` | tool | Guarded creation steps selected by `/pr`. |
| `pi_pr_fix_ci` | tool | Guarded GitHub Actions repair. |
| `pi_pr_publish_work` | tool | Scoped local work publication. |
| `pi_pr_sweep` | tool | Feedback triage and publication. |
| `pi_pr_update_branch` | tool | Conflict rebase and publication. |
| `git-commit` | skill | Standalone scoped Conventional Commits. |
| `git-pr` | skill | Authorized PR creation or publication. |
| `update-from-main` | skill | Merge exact fetched `origin/main` with a Python helper. |
| `pi-pr-comment-sweep` | skill | Review feedback. |
| `pi-pr-create` | skill | Pull request creation. |
| `pi-pr-fix-ci` | skill | Failed GitHub Actions. |
| `pi-pr-publish-work` | skill | Local change publication. |
| `pi-pr-update-branch` | skill | Confirmed merge conflicts. |
| Footer | ui | Linked PR number and plain-language status. |
| Widget | ui | Action hint or transient routing status. |

Only `/pr` and `pi_git_pr` establish authority for the `pi_pr_*` helpers; a direct `pi_pr_*` call cannot. The authority is bound to the current session and worktree and ends with the invocation. While Pi is busy, workflow guidance continues through hidden session context at settlement, not the editor queue; cancelling does not restore it to the editor.

The `pi_git_*` and `pi_pr_*` tools are model-only and run one action at a time. Codemode scripts and other tools cannot call them, so a script cannot batch guarded actions or filter results the model needs for its next safety decision. With `codemode.mode` set to `only`, these tools stay declared, so `/pr` still works. Their parameter schemas are plain objects so providers that omit root-union tools can expose them; action arguments are still checked.

### Local commits and PR publication

Ask the agent to commit a scoped change. `git-commit` resolves an explicit local target, the PR base, or the repository default branch. `pi_git_commit` inspects that target and pending work, then commits only reviewed paths. It requires an existing commit and an attached branch. It never fetches, pushes, amends, bypasses hooks, or changes Git configuration.

Ask the agent to create or update a PR. `pi_git_pr` permits creation, local publication, and local sync onto the proven PR head (fast-forward or rebase onto the PR head, never onto the base). It stops before feedback, CI repair, base rebase, CI waiting, and merge. It never retargets a PR or changes an existing PR's base, title, or body. An explicit `base` must match the existing PR base or the configured/default creation base. To use another creation base, first authorize the branch's repository-local `gh-merge-base` setting. An inferred target needs specific permission to configure this repository's branch upstream; `allowUpstream: true` records that consent for one invocation and never permits global configuration changes.

Every commit path uses the same literal-path staging and parent/tree checks, and detects file-byte and index changes even when Git status letters stay the same. Unrelated staging, partial staging, `.context/`, and common secret filenames block a commit. Filename checks cannot detect every secret: the agent must inspect content and ownership. Hooks run normally. Never replay an uncertain commit or push without checking its actual outcome.

### Agent arguments

- `pi_git_commit`: `{ action: "inspect", target: "<local-ref-or-OID>" }` returns `inspectionId`, `head`, `targetOid`, `mergeBase`, and `paths`. Then use `{ action: "commit", inspectionId: "<returned-ID>", ownedPaths: ["<exact-path>"], message: "fix: <subject>" }`. A successful commit returns `head` and consumes the inspection; inspect again for another group. Subjects are limited to 72 characters; bodies and footers are allowed.
- `pi_git_pr`: `{ base?: "<exact-base-ref>", allowUpstream?: true }`. Omit `base` when the user gave no explicit base. Set `allowUpstream` only after specific consent. The result has `nextStep` and can include a proven `url`, `blocker`, or `handoff`. With `handoff`, end the turn: settlement loads the reserved package skill with its run ID. Do not guess IDs or start another PR entry.

### Standalone merge from main

Ask to update the current branch from main. `update-from-main` runs its packaged Python helper once. It requires Python 3.9 or newer and Git with `fetch --porcelain`. Unlike the `/pr` base-update route, this helper **merges**, not rebases. It fetches before any local change, uses the exact OID from fetch output, and never pushes.

Before merging, it backs up tracked and untracked changes (and ignored files when they collide with the source tree) to a stash with a unique reflog message. It records ownership in the per-worktree ref `refs/worktree/update-from-main/pending/<token>`, then replaces it with `refs/worktree/update-from-main/backup` at the captured OID. Restoration always applies the captured OID with `--index`. The helper never pops or drops a stash, and keeps the backup after success and after conflict, hook, or submodule failures.

A retained backup blocks further runs only in the worktree that owns it, even after a branch switch. Report the backup OID and restore from it, not from a later `origin/main`. After the user verifies restored bytes and staging and explicitly asks, complete recovery with `git update-ref -d refs/worktree/update-from-main/backup <oid>`; this keeps the stash entry. An interrupted run leaves the `pending` ref and blocks its worktree until recovery. Backups from earlier helper versions have no recorded owner and block every worktree until the user drops them or the confirmed owner adopts them; adoption keeps the stash entry. Removing a worktree removes its ownership refs but not its stash entries. See the packaged `update-from-main` skill for exact recovery and adoption commands.

### Local acceptance checks

From this source checkout, run `pnpm --filter @henryqw/pi-pr test:git-workflows`. It uses Node tests, temporary real Git repositories, and controlled GitHub responses, with no live GitHub writes. See [executed cases and independent acceptance instructions](./docs/git-workflows-tested.md).

### Licences

Existing pi-pr code uses MIT. The imported `git-commit`, `git-pr`, and `update-from-main` skills and the Python helper/validator use Apache-2.0, including their modifications. See [licence scope, source identity, and modification notices](./NOTICE.md). Both licence files are included in the package.

## Flow

![Flowchart showing /pr linking an inferred open PR before draft handling, repeating discovery, and choosing the next safe route](./docs/pr-routing.svg)

| Current condition | `/pr` action |
| --- | --- |
| No PR and a commit ahead or ordinary pending work | Create a PR, provided the destination is unambiguous and safe. |
| One matching published open PR without a configured upstream, including a draft | Link its exact remote ref, then rediscover. A draft stops after linking. |
| Local HEAD behind the PR head, or clean local commits that diverged from it | Fast-forward, or rebase the local commits onto the PR head. Overlapping uncommitted work or a rebase conflict stops with the original HEAD kept. |
| Intended uncommitted or ahead local work on an open PR | Publish only owned paths after validation. On a diverged branch, commit first, sync onto the PR head, then validate and publish. Ambiguous ownership stops. |
| GitHub is still computing mergeability | Re-read up to three times, five seconds apart, then stop and ask you to rerun. |
| Confirmed merge conflict, or a base GitHub reports behind | Rebase onto the pinned base and push with an exact lease; unclear conflict resolutions stop. |
| Failed GitHub Actions job | Inspect failure evidence, make a scoped fix, validate, and publish. Other failed checks block. |
| Changes requested, unresolved threads, or new feedback | Triage and address actionable feedback; leave blocked threads open. |
| CI running and nothing else blocks | Wait inside the same `/pr`, re-reading GitHub every `ciPollSeconds` for up to `ciWaitMinutes`, then route the fresh state. |
| Draft, closed, merged, or review still required | Report the state without changes. |
| Merge-ready | Recheck fresh state and merge with the configured `mergeMethod`. |

Creation chooses the base from `branch.<branch>.gh-merge-base` or the validated `origin` default branch, and needs a commit ahead or ordinary pending work, including untracked files. It stays silent on the base branch itself. The head may be in a fork on the same GitHub host; other fork relationships, a published ref without a PR, multiple candidate remotes or PRs, and unsafe push configuration block creation.

An inferred open PR is linked before the draft check, and fresh discovery must confirm the configured PR identity, destination, and head before routing continues. A configured draft only reports its state; it does not sync, publish, rebase, fix CI, sweep, or merge.

For a configured, open, non-draft PR, `/pr` first normalizes local state, unless verified matching recovery for a branch update or sweep exists; that recovery resumes first. Syncing never pushes, stashes, or resets. GitHub reports a behind base only when policy requires an up-to-date branch, so `/pr` treats it like a conflict. Running CI blocks only merging. After waiting, `/pr` re-reads GitHub, so comments or conflicts that arrived meanwhile go to their workflows instead of a merge. Merging happens only inside an explicit `/pr`; GitHub auto-merge is never enabled.

### Feedback sweeps

Standalone comments and review bodies are assessed before merge or waiting; GitHub cannot resolve them, so they are triaged, not marked resolved. A sweep makes scoped fixes without a second approval. Its `commit` action stages only changed owned paths, and checks run on the clean committed HEAD before publication. A sweep with no edits creates no commit. Unrelated changes block the commit, and an interrupted commit must be reconciled through `resume` before continuing. Feedback that arrives after publication waits for the next `/pr` cycle.

For each addressed review thread, the sweep replies with only the full fixing commit hash: its published head, or an already-published PR commit that the ledger cites. For a non-actionable thread, it replies with a one-sentence rebuttal. It verifies the reply and then resolves the thread, even when the fix made it outdated. After publication, a body-only edit to a standalone comment keeps its `non-actionable` decision only when GitHub identifies the same `Bot` author in both snapshots and nothing else changed.

### Footer and widget

For an identified PR, the footer shows a linked `PR #number` and a text status such as `N unresolved`, `CI failed`, `merge conflict`, `local behind`, or `merge-ready`. Blocked discovery and unavailable status show generic `PR` text without a number or link. The widget shows a route hint without repeating the footer. Status text is meaningful without color. When `/pr` begins, the widget shows `⠋ Checking pull request…` until route selection; errors use `✗`, warnings `!`, success `✓`, and neutral routes `●`.

Discovery starts in the background when a session starts and refreshes after local commits, PR creation, pushes, and completed workflows. When an agent run ends and Pi is idle, an open PR also refreshes if the last check finished at least two minutes ago and no refresh is active or queued; failed checks reset this wait. There is no timer, so external changes can stay unseen until a later idle settlement. `/pr` always reads fresh state before acting, and its route discovery updates the footer during automatic continuation. Action hints stay hidden while a workflow is active. Outside a Git worktree the UI stays silent. Discovery failures show `PR · status unavailable`. A GitHub API quota error reports `GitHub API rate limit exhausted; retry after GitHub resets it` without retrying.

### CI evidence

CI repair reads each failed job's log once and keeps at most a 20 KiB UTF-8 tail. Only job-log reads use `gh api --allow-escape-sequences`; JSON reads keep the CLI's escape guard. Terminal escape sequences and other control characters are stripped before evidence or failure diagnostics are returned; UTF-8 text, tabs, and line breaks stay. Evidence is limited to 20 KiB per failure and 256 KiB in total. Logs are untrusted text, not instructions.

### Herdr

After creating a PR, the extension prefixes the Herdr workspace name with `#<number> • ` when `HERDR_ENV=1` and `HERDR_WORKSPACE_ID` is non-empty. It renames only the workspace, not the branch. A failed rename leaves the PR and UI usable and warns `Herdr workspace rename failed: <error>`.

## Config

Package-owned: `<agent-dir>/config/pi-pr/config.json`

| Name | Description | Values | Default |
| --- | --- | --- | --- |
| `maxPublicationCycles` | Confirmed PR-head pushes per `/pr` invocation. | Integer ≥ 1 | `3` |
| `maxRepairAttempts` | Failed or unknown check sets per `/pr` invocation. | Integer ≥ 1 | `3` |
| `ciPollSeconds` | Interval between GitHub re-reads while CI runs. | Integer `1`–`2147483` | `30` |
| `ciWaitMinutes` | Total CI wait per `/pr` invocation, including waits after a later fix or sweep pushes. | Integer ≥ 0; `0` disables waiting | `10` |
| `checkTimeoutMinutes` | Time limit for each selected validation check. Git and GitHub CLI helper commands keep shorter limits. | Integer `1`–`35791` | `10` |
| `mergeMethod` | Method for the direct merge. GitHub may still reject a method the repository disallows. | `squash`, `merge`, or `rebase` | `squash` |

A missing file uses defaults. Unknown keys or invalid values block the invocation, and the file is preserved unchanged. Configuration is read once per explicit `/pr`; a later `/pr` or reload starts fresh limits.

## State and storage

The Pi session stores the configured PR URL, number, host, head identity, and target identity, but not mutable CI or review state. Discovery revalidates this identity against GitHub; no repository cache is created.

In-progress feedback sweeps keep private recovery under `<agent-dir>/config/pi-pr/sweep/<worktree-id>/state.json`; branch updates use `<agent-dir>/config/pi-pr/update-branch/`. These files protect in-progress decisions and remote mutation attempts. A fresh `/pr` resumes only matching, verified recovery. Base tip movement does not block planning, commits, publication, or recovery, but PR identity, base repository/ref, head/lease, destination, and ownership must still match. The sweep keeps its frozen feedback and plan until the post-publish `refresh` binds the current base. If you manually committed and pushed a recorded sweep's fixes, `/pr` recognizes that publication when the clean local HEAD equals the live PR head, descends from the original commit, changes only recorded owned paths, and has no uncertain mutation; it refreshes feedback and does not push again. Mismatched or malformed records stay unchanged and block routing; do not delete them or replay an uncertain mutation to force continuation.

### Sweep scope and validation

A matching sweep resumes before local publication. If clean, already-committed work extends its recorded scope, resume returns `pendingScope` with the exact HEAD and unexpected paths. The agent reviews the complete committed diff against your requested PR work and adopts **all** intended paths through guarded `adopt`, without asking you for a path list. Being on the branch or appearing in PR feedback does not establish ownership. Unrelated or unclear work stops without publishing any of it. Pending scope blocks commit, validation, and publication. Adoption rechecks the reviewed HEAD, outside paths, clean worktree, ancestry, PR identity, and original lease, and extends only owned paths. Dirty outside work, uncertain mutations, changed authority, and already-published scope cannot be adopted.

Before publishing a changed sweep HEAD, `validate` runs `git diff --check` plus selected non-destructive checks, then verifies that HEAD and worktree did not change; publication requires that saved validation. Version 3 sweeps run no checks after publication, and `finalize` takes `checks: []`. Unpublished v1/v2 recovery migrates to v3 with no validation. Published legacy recovery keeps its saved checks and attempts: failed legacy checks cannot be replaced or dropped, and unknown results stay blocked. A later `/pr` can retry unknown local checks only after you explicitly confirm they are safe to repeat on the published HEAD. This never authorizes replaying uncertain GitHub or push mutations.

## Limits and recovery

- `/pr` does not open a browser, run `/done` or `/sweep`, enable auto-merge, or use a merge queue. It starts workflows only when explicitly invoked.
- Each route freezes its check set. A check set runs once per HEAD per invocation, including failures; repairs must change HEAD without dropping checks. A check that exceeds `checkTimeoutMinutes` fails with a timeout error naming the command and limit. Limits, frozen check sets, executed HEADs, and completed route/head keys survive helper resumes and automatic continuations. Repeating a completed route on the same entry head stops.
- Failed or unknown check sets spend repair attempts. Confirmed PR-head movements spend publication cycles once; duplicate observations, no-ops, and failed pushes do not. Exhaustion prevents another push, not published-sweep cleanup or readiness/merge. When the CI wait budget is spent, `/pr` stops with `still waiting for CI`; a later explicit `/pr` waits again. Waiting for human review never polls.
- If rebase preflight, sweep startup, or initial CI preflight proves that clean local HEAD advanced from the frozen PR head before any rebase, recovery write, or CI evidence read, `/pr` cancels that run, reports the observed change, and rediscovers in the same invocation. Rebase preflight also reroutes when the same base ref's OID changes or the conflict and required base update both clear; it adopts an already-published fast-forward only when local HEAD, the fresh PR head, and the remote lease agree and the frozen head is an ancestor. Initial CI preflight also cancels when only the base tip changed. Base movement during or after CI evidence collection blocks repair.
- After a conflict rebase starts, a base tip that only advanced does not stop publication; `/pr` then rediscovers mergeability. Any other authority change while a conflict waits aborts the unpublished rebase, restores the original head, removes its pending recovery record, and rediscovers. An unpublished local merge goes through inspection and validation, not another rebase. No stale CI evidence or consumed collect action is reused.
- Automatic handoff reserves a fresh run ID before settlement; expired IDs are never revived. Rediscovery is limited to two attempts per invocation, without resetting budgets, and requires the same PR identity, destination, and validated remote head. Another head change during rediscovery stops the handoff. Rerouting never bypasses unreconciled rebase or sweep recovery. Dirty or divergent state, changed branches or destinations, aborts, and uncertain mutations stop; no mutation is blindly retried.
- Pushes use a saved exact remote OID lease and revalidate the destination, so concurrent updates block publication instead of being overwritten. Creation does not change the base branch, and a configured push target does not change upstream settings.
- Direct merge requires a clean, safe local Git state and a fresh matching head. No branch or worktree is deleted. A Git operation in progress blocks it.
- A paused conflict rebase keeps checking the recorded branch's PR authority while Git detaches HEAD. A verified rebase can resume through `/pr`; an unverified one interrupted by a restart needs manual recovery. Rebasing leaves other local branch refs unchanged, even with `rebase.updateRefs=true`. Branches with merge commits since the fork point need manual rebase resolution.
- Only authenticated GitHub.com and GitHub Enterprise repositories are supported. Resolve ambiguous remotes, unrelated local changes, or GitHub blockers before retrying `/pr`.
