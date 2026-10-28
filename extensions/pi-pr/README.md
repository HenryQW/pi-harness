# `@henryqw/pi-pr`

See the current-branch pull request in the Pi footer. Run `/pr` to select its next step, including a merge that you confirm. Ask the agent for local commits, pull request (PR) publication, or one explicit base update when you do not want full repair or merge authority.

## Install

```bash
pi install npm:@henryqw/pi-pr
```

Requires an authenticated GitHub.com or GitHub Enterprise checkout. Run `gh auth login`, then check with `gh auth status`. For Enterprise, use `gh auth login --hostname <host>`.

CI repair requires `gh api --help` to list `--allow-escape-sequences`. Upgrade `gh` if that flag is missing.

## Works with

| Package | Relationship | Purpose |
| --- | --- | --- |
| [`@henryqw/pi-footer`](https://pi.henry.wang/extensions/pi-footer) | Improves | Shows the PR footer status in the shared footer. |
| [`@henryqw/pi-herdr`](https://pi.henry.wang/packages/pi-herdr) | Required | Provides the Herdr CLI client for workspace renaming. |
| [`@henryqw/pi-process`](https://pi.henry.wang/packages/pi-process) | Required | Runs child processes with limits. |

Workspace renaming is optional and requires Herdr 0.9.3 or later. Other functions work outside Herdr.

## Use

Run `/pr` in your checkout. It reads fresh evidence and continues until a blocker, external input, a wait limit, or merge confirmation.

Commands are for you; tools and skills are for the agent.

| Surface | Type | Purpose |
| --- | --- | --- |
| `/pr` | command | Select and do the PR next step. Accepts no arguments. |
| `pi_git_commit` | tool | Inspect and commit scoped local changes. Never pushes. |
| `pi_git_pr` | tool | Create or publish a PR, or do one explicitly ordered base update. Never merges the PR. |
| `pi_pr_create` | tool | Run guarded PR creation steps. |
| `pi_pr_fix_ci` | tool | Repair failed GitHub Actions. |
| `pi_pr_merge` | tool | Merge a ready named pull request after you confirm. |
| `pi_pr_publish_work` | tool | Publish scoped local work. |
| `pi_pr_status` | tool | Check the readiness of a named pull request. |
| `pi_pr_sweep` | tool | Triage feedback and publish fixes. |
| `pi_pr_update_branch` | tool | Update against the pinned base and publish. |
| `git_conflict` | tool | List, show, and resolve Git conflict blocks. Never stages files. |
| `git-commit` | skill | Make scoped Conventional Commits. |
| `git-pr` | skill | Create, publish, or update the base with scoped permission. |
| `update-from-main` | skill | Merge exact fetched `origin/main` with a Python helper. |
| `pi-pr-comment-sweep` | skill | Assess PR feedback items. |
| `pi-pr-create` | skill | Create a PR. |
| `pi-pr-fix-ci` | skill | Repair failed GitHub Actions. |
| `pi-pr-publish-work` | skill | Publish local changes. |
| `pi-pr-update-branch` | skill | Resolve conflicts or required base updates. |
| Footer | ui | Show a linked PR number and its lifecycle or condition. |
| Widget | ui | Show a PR next-step widget hint or temporary PR routing widget status. |

Only `/pr` and `pi_git_pr` authorize the `pi_pr_*` workflow helpers, for one invocation in the current session and worktree. `pi_pr_status` and `pi_pr_merge` are not workflow helpers; see [Named pull requests](#named-pull-requests). Direct calls cannot grant authority. Only the model can call these tools, one action at a time; Codemode scripts and other tools cannot call them. They remain available with `codemode.mode` set to `only`. Cancellation does not return workflow guidance to the editor.

### Local commits and publication

Ask the agent to commit scoped work or create/update a PR. See [git-commit arguments and checks](./skills/git-commit/SKILL.md) and [git-pr arguments and consent](./skills/git-pr/SKILL.md).

Local commits require an existing commit and an attached branch. They never fetch, push, amend, bypass hooks, or change Git configuration. Unrelated staging, partial staging, `.context/`, and common secret filenames block commits. Filename checks cannot detect every secret: the agent must inspect content and ownership. Hooks run normally.

| Tool call | Result |
| --- | --- |
| `pi_git_commit` `{ action: "inspect", target: "<local-ref-or-OID>" }` | Returns `inspectionId`, `head`, `targetOid`, `mergeBase`, and `paths`. |
| `pi_git_commit` `{ action: "commit", inspectionId, ownedPaths, message }` | Returns `head` and consumes the inspection. Inspect again for another group. Subjects have at most 72 characters. |
| `pi_git_pr` `{ scope?: "publication", base?: "<exact-base-ref>", allowUpstream?: true }` | Returns `nextStep` and can include a proven `url`, `blocker`, or `handoff`. With `handoff`, end the turn and do not guess run IDs. |

The default `pi_git_pr` scope is `publication`. It permits creation, local publication, and sync onto the PR head, not the base. It stops before feedback, CI repair, base updates, waiting, or merging. Existing PR bases, titles, and bodies do not change.

For an explicit conflict/base-update order, the agent calls `pi_git_pr` with `{ scope: "update-branch" }`. An optional `base` must match the current PR. Do not supply `allowUpstream`. This scope permits bounded refresh, one base update and its checked publication, then stops. It cannot create, link, sync local history, publish unrelated work, sweep feedback, repair CI, or merge the PR. It needs a configured, open, non-draft current PR and clean local state at the published head, or matching verified update recovery.

To delegate publication, delegate before a workflow starts. Pass the authorized work scope, base intent, and repository-local upstream consent, not a parent `runId`. The child calls `pi_git_pr` and follows its own same-session skill handoff.

Run identifiers (IDs) are session-local. An active parent workflow stays parent-owned; parent and child must not publish concurrently. A foreign or stale run ID stops the call; it does not start a new workflow.

A run that ended at ordinary settlement in this session can use a fresh entry within the original still-valid scoped authorization. This includes publication after an incomplete `/pr` run if the original instruction already permits that work; no new approval is needed. Failure or cancellation requires result and journal inspection first. Fresh entries never bypass recovery or replay uncertain actions. After `prepare`, continue the route steps; preparation is not completion.

Direct workers must keep their required JSON completion object, with the PR URL in `answer`, instead of a plain URL.

An explicit `base` must match the existing PR base or configured/default creation base. Another creation base needs permission for repository-local `gh-merge-base`. Inferred targets need specific upstream consent through `allowUpstream: true` for one invocation, never global configuration permission.

### Standalone merge from main

[update-from-main](./skills/update-from-main/SKILL.md) requires Python 3.9 or newer and Git with `fetch --porcelain`. It fetches, then **merges** the exact fetched `origin/main` OID without pushing. This differs from the guarded PR branch update, which can rebase or merge and then publish.

The helper retains backups of tracked, untracked, and colliding ignored files. Retained backups block their owning worktree; unowned legacy backups block every worktree. Follow the linked skill for exact-OID restoration, interrupted runs, legacy backup adoption, and recovery completion. Verify restored bytes and staging before explicitly requesting completion. Never drop a backup or repeat an uncertain operation automatically. Removing a worktree removes ownership refs, not stash entries.

### Conflict blocks

The `git_conflict` tool resolves Git conflict markers without manual marker edits. Use it for merge, rebase, or stash conflicts. The `update-from-main` and `pi-pr-update-branch` skills use it. A `resolve` call holds the pi-pr worktree lock and replaces the file in one atomic step. When a `.gitattributes` file differs from `HEAD` or is untracked, the tool requires Git 2.40 or newer.

| Tool call | Result |
| --- | --- |
| `git_conflict` `{ action: "list", path? }` | Returns unmerged paths with numbered blocks, `id`, and line ranges. Without `path`, it returns at most 100 paths. |
| `git_conflict` `{ action: "show", path, block }` | Returns the `ours`, `base`, and `theirs` sides of one block. |
| `git_conflict` `{ action: "resolve", path, resolutions }` | Replaces at most 256 blocks of one file. Each resolution has `block`, `id`, and `side`. Returns the remaining blocks. |

A `side` is `@ours`, `@theirs`, `@both` (ours, then theirs), or `@base`. `@base` needs diff3 or zdiff3 markers (`|||||||`). To get them, set `merge.conflictStyle` to `zdiff3` or `diff3` before the merge. Without them, `@base` fails with an error.

Before it writes, the tool reads the file again and compares each block `id`. The `id` changes when the block text or its start line changes. If a block changed, the tool writes nothing and returns an error. Block numbers change after each resolve, so use the returned blocks. The tool does not stage files: run `git add` yourself. The `show` action limits each side to 300 lines or 16 KiB.

The tool reads the `conflict-marker-size` attribute for the marker width. It changes only UTF-8 text files of 8 MiB or less. Each side of a block must match the related Git index stage.

Some files show a `note` and no blocks. These include binary and larger files, files deleted or renamed on one side, and files whose merge attributes are unmerged or differ from `HEAD`. Files with a binary or custom merge driver (also from `merge.default`), submodules, and symlinks also show a `note`. Markers out of sequence, an unclosed block, or a marker line that is also in a merge side give a `note`. The tool does not guess block limits. Resolve these files as a whole.

### Named pull requests

A named pull request is one pull request in the `origin` repository, addressed by number. Use these tools when one session manages pull requests from other worktrees. They read only GitHub and the remote configuration, and they never change the local checkout. They do not list pull requests.

| Tool call | Result |
| --- | --- |
| `pi_pr_status` `{ number }` | Returns `verdict` (`ready`, `wait`, or `block`), `reasons`, `number`, `url`, `lifecycle`, `baseRef`, full `headOid`, `mergeable`, `mergeStateStatus`, `reviewDecision`, `failingChecks`, `pendingChecks`, `codex`, and `unresolvedThreads`. A ruleset bypass adds `bypass`. |
| `pi_pr_merge` `{ number, headOid }` | Returns `merged: true` with `headOid` and `mergeMethod`, or `merged: false` with `reason` and the fresh `status`. |

The merge bar uses these reasons:

- `block`: the PR is not open, is a draft, has a conflict, or needs a base update.
- `block`: CI failed, a reviewer requested changes, or a required review is missing.
- `block`: unresolved Codex P0/P1 threads remain. `unresolvedThreads.blocking` counts them. `unresolvedThreads.other` counts the other unresolved threads, which do not block.
- `wait`: mergeability stays unknown after three re-reads five seconds apart, CI is running, or the Codex review of the current head did not finish.
- `block`: the merge policy is not clean and no wait reason applies.
- `ready` through a ruleset bypass: see [Ruleset bypass](#ruleset-bypass).

Any block reason gives `block`. If no block reason applies, any wait reason gives `wait`. If no reason applies, the verdict is `ready`. `codex` is `disabled` unless `codexReview` is `true`; then the [Codex review gate](#codex-review-gate) rules apply.

`pi_pr_merge` checks readiness again. It refuses unless the verdict is `ready` and the live head equals `headOid`. Without an interactive UI, it refuses and the PR stays unchanged. Otherwise, it asks `Merge PR #<number>?` with the URL, the short head OID, the base ref, `mergeMethod`, and any ruleset bypass. If you decline, the PR stays unchanged. After you confirm, it checks readiness, PR identity, head, base OID, and the bypass again, then merges the exact head through GitHub.

`pi_pr_merge` does not do the local merge safety checks of `/pr`, because your checkout is not the PR branch. It does not delete branches or worktrees, enable automatic merging, or use a merge queue.

For a manager workflow, each worker agent checks its own PR with `pi_pr_status` and reports the verdict and `headOid`. The manager session checks the PR again with `pi_pr_status`. Then it calls `pi_pr_merge` with that `headOid`, and you confirm in the manager's own pane.

### Ruleset bypass

A pending required review or a `BLOCKED` merge policy can block the PR when no other block reason applies. Then the tools read the rulesets and the classic branch protection of the base branch. They give `ready` with `bypass` only when all of these conditions are true:

- Classic branch protection is disabled for the base branch. If it applies, the PR stays blocked, because this check does not bypass it.
- Every ruleset with a merge rule lets the current user bypass it. Rulesets with only `creation`, `deletion`, or `non_fast_forward` rules do not apply to a merge.
- The rulesets contain only `pull_request`, `required_status_checks`, and `required_linear_history` merge rules. Any other rule type blocks, because the tools cannot verify it.
- Each check that these rulesets require passed on the exact head. A missing or running check gives `wait`, and a failed check gives `block`.
- Every ruleset allows the configured `mergeMethod`. Required linear history does not allow `merge`.

If all these conditions are true but a wait reason, such as a running Codex review, also applies, the verdict is `wait`.

Required checks are read for the exact head. If a required check sets an integration ID, the check run app must match it. A commit status cannot satisfy a check with a set integration ID. The confirmation names the bypassed ruleset IDs. GitHub enforces the bypass when the merge occurs.

## Flow

![Flowchart showing /pr linking an inferred open PR before draft handling, repeating discovery, and choosing the next safe route](./docs/pr-routing.svg)

| Condition | `/pr` next step |
| --- | --- |
| No current-branch pull request; ahead commits or ordinary pending work | Create against `branch.<branch>.gh-merge-base` or the validated `origin` default branch. Includes untracked files; stays silent on the base branch. |
| One inferred open PR, including a draft | Link its exact remote ref, then verify identity, destination, and head again. A draft stops after linking. |
| Matching, verified branch-update or sweep recovery | Resume before local publication. |
| Local HEAD behind, or clean divergent commits | Fast-forward or rebase onto the PR head. Overlapping uncommitted work or conflicts stop with the original HEAD. Never push, stash, or reset. |
| Intended pending or ahead work | Commit owned paths, validate, then publish. On divergence, commit first, sync onto the PR head, then validate and publish. |
| Unknown mergeability | Re-read at most three times, five seconds apart. Then stop; run `/pr` again. |
| Confirmed conflict or policy-required base update | Rebase linear history, or merge the pinned base into merge-containing history. Validate, then publish with an exact lease. Unclear resolutions stop. |
| Failed GitHub Actions job | Inspect evidence, fix, validate, and publish. Other failed checks block. |
| Changes requested, unresolved threads, or new feedback | Assess feedback and fix scoped issues. Leave blocked threads open. |
| Running CI or required Codex review; no other blocker | Wait with `ciPollSeconds` and shared `ciWaitMinutes`, then select from fresh evidence. Running CI blocks merging, not repairs. |
| Configured draft, closed, merged, or required human review | Report without changes. Human-review waits never poll. |
| Merge-ready | Ask for confirmation with PR number, URL, short head OID, base ref, and `mergeMethod`. Declining or no UI leaves the PR unchanged. |

Creation permits fork heads on the same GitHub host and source. Other fork relationships, published refs without PRs, multiple candidate remotes/PRs, and unsafe push configuration block creation. Creation does not merge, rebase, or change the base branch. Configured PR targets retain their upstream settings.

### Feedback sweeps

Sweeps assess standalone comments and review bodies before waiting or merging. GitHub cannot resolve these items. Bot conversation comments do not start sweeps; bot reviews and review threads do.

Scoped fixes need no second approval. No edits means no commit. For fixed threads, replies contain only the full fixing commit hash; non-actionable threads get a one-sentence rebuttal. The sweep verifies replies, then resolves threads, including outdated ones. New actionable feedback after publication waits for the next cycle.

See [sweep guidance](./skills/pi-pr-comment-sweep/SKILL.md) for feedback changes, bot body-only edits, commit reconciliation, validation, and verified resolution.

### Codex review gate

With `codexReview: true`, the current-head Codex review must finish before merge confirmation. Codex reviews each push. `/pr` reads reactions and the `chatgpt-codex-connector` bot's summary comment. Completion requires all three conditions:

- No EYES (👀) reaction from the bot.
- The latest `Code Review` row shows `Completed`.
- That row's SHA matches the start of the current PR head OID.

A THUMBS_UP (👍) reaction alone, an older reviewed head, or an unreadable summary keeps the gate waiting. The gate does not post comments. At the shared wait limit, it reports `still waiting for the Codex review of the current head`; run `/pr` again later.

Unresolved P0/P1 threads start a sweep. If they remain after that invocation's sweep, `/pr` reports `unresolved Codex P0/P1 findings block the merge prompt` and stops.

When Codex review is the only blocker, the footer shows `Codex review pending`. Background display uses the last `/pr` configuration; it omits Codex status before the first `/pr`.

### Footer, widget, and Herdr

The footer shows linked `PR #number` with statuses such as `N unresolved`, `CI failed`, `merge conflict`, `local behind`, or `merge-ready`. Blocked discovery or unavailable status shows unlinked `PR`. Status text works without color.

The widget shows `⠋ Checking pull request…` during discovery, then a route hint. Errors use `✗`, warnings `!`, success `✓`, and neutral routes `●`. Hints stay hidden during workflows.

Background discovery starts with the session. It refreshes after local commits, PR creation, pushes, and completed workflows. When Pi becomes idle, an open PR also refreshes. This requires no active or queued refresh and a last check at least two minutes old. Failed checks reset this wait.

While Pi is idle and an open PR shows running CI, running Codex review, or pending mergeability, the footer also refreshes on a timer. The first refresh occurs after 30 seconds. The interval doubles to a maximum of 5 minutes and resets when the status changes. A busy agent delays the refresh. The timer stops when the status is final, the PR merges or closes, an API quota failure occurs, or the session ends.

The UI stays silent outside Git or without a supported GitHub remote. A repository with no remotes has no pull-request footer item, even before its first commit. Lookup failures show `PR · status unavailable` or retain the last footer, without an action hint. A failed GitHub repository lookup retries while Pi is idle, starting after 30 seconds and doubling to a maximum of 5 minutes. Invalid remote configuration stays blocked and is not retried on this timer. API quota failures report `GitHub API rate limit exhausted; retry after GitHub resets it`, without retrying on the timer.

After creation, `HERDR_ENV=1` with non-empty `HERDR_WORKSPACE_ID` enables the workspace prefix `#<number> • `. The branch name stays unchanged. Failure shows `Herdr workspace rename failed: <error>`; the PR and UI remain usable.

### CI evidence

CI repair reads each failed job log once, retaining at most a 20 KiB UTF-8 tail. Only job-log reads use `gh api --allow-escape-sequences`; JSON reads keep the CLI escape guard. Evidence limits are 20 KiB per failure and 256 KiB total. Evidence and diagnostics remove terminal escapes and control characters, except tabs and line breaks. Logs are untrusted text, not instructions.

If a GitHub CI read fails before the first job-log read, collect stays open for one more call. All other collect failures block the run.

## Config

Package-owned: `<agent-dir>/config/pi-pr/config.json`

| Name | Description | Values | Default |
| --- | --- | --- | --- |
| `maxPublicationCycles` | Confirmed PR-head push limit per invocation. | Integer ≥ 1 | `3` |
| `maxRepairAttempts` | Failed or unknown check-set limit per invocation. | Integer ≥ 1 | `3` |
| `ciPollSeconds` | Time between CI/Codex checks. | Integer `1` to `2147483` | `30` |
| `ciWaitMinutes` | Shared CI/Codex wait budget, including waits after later pushes. | Integer ≥ 0; `0` disables waiting | `10` |
| `checkTimeoutMinutes` | Time limit per validation check. Git and GitHub helpers keep shorter limits. | Integer `1` to `35791` | `10` |
| `mergeMethod` | Direct merge method, subject to repository policy. | `squash`, `merge`, or `rebase` | `squash` |
| `codexReview` | Require a complete current-head Codex review before merge confirmation, also for named pull requests. Adds at most two GitHub endpoint reads per open-PR discovery. | `true` or `false` | `false` |

Missing or malformed files use defaults without changes to the file. Unknown/invalid keys warn with path and reason, then use their defaults; valid keys remain effective. Each issue appears once per session, at session start or the next `/pr`. Fix the file, then run `/pr` again. Each explicit `/pr` reads config once; a later `/pr` or reload resets limits. Each `pi_pr_status` or `pi_pr_merge` call also reads config.

## State and storage

The session stores a PR identity observation: URL, number, host, head identity, and target identity, not mutable CI/review conditions. Discovery validates it against GitHub; there is no repository cache.

The handled-feedback marker is `<worktree>/.context/pi-harness/pi-pr/feedback-<agent-id>.json`. The agent identity is the hash of the normalized absolute `<agent-dir>/config/pi-pr` path. Each agent directory keeps its own reviewed decisions for the canonical checkout; another agent directory cannot acknowledge its blocked items. `/pr` uses this marker to detect feedback that needs a sweep, including before merge.

The marker can make the Git worktree dirty, which blocks clean-worktree operations, including `/pr` merge and sweep publication. The extension does not change ignore rules. Choose and manage any Git exclusion yourself; inspect state before you share or stage it. Removing the worktree removes this marker.

Mutation locks retain their original scope: one canonical checkout and one agent directory. Before finalization writes the marker, it checks fresh feedback against the sweep's reviewed snapshot and thread state. Changed feedback stops finalization and preserves recovery. Resume and refresh through the existing sweep workflow; new or changed items need review. Blocked items remain outside the marker fingerprint, so they still require attention before merge.

The marker must be untracked: tracked or staged repository content, including files in checked-out submodules, cannot acknowledge feedback. The extension preserves tracked markers and reports an error before it reads or writes them. Inspect the file and arrange its removal from version control before you use a local marker; the extension never changes tracking or ignore rules.

State directory components must not be symbolic links; the marker must be a regular file without extra hard links. Unsafe paths remain unchanged and produce an error. These checks do not protect against a hostile same-user process that swaps paths during use.

Private recovery uses `<agent-dir>/config/pi-pr/sweep/<worktree-id>/state.json` and `<agent-dir>/config/pi-pr/update-branch/`. Run `/pr` to resume matching verified recovery. Mismatched or malformed records remain unchanged and block routing. Never delete them to force continuation.

### Migration to version 11

This cutover is manual. There is no legacy-path fallback. Stop all old Pi sessions before you copy the marker, and do not start them again after the copy. Complete active sweeps or retain their recovery records in the agent directory for verified recovery after the cutover.

If you also use pi-deps, stop its old copied hook and wait for detached installs. Follow its version 4 migration before you upgrade or reinstall the hook.

Repeat this procedure in each worktree, with `AGENT_DIR` set to the absolute agent directory used by the old session. The default is `$HOME/.pi/agent`; an old session can use a different `PI_CODING_AGENT_DIR`.

Repeat for every agent directory that has a marker for that worktree; each gets a separate destination. Keep the same agent-directory path when you restart Pi. A different path selects a different marker. Never overwrite a destination. Missing a marker can cause a repeat sweep. Preserve malformed markers and investigate them; they block routing.

The copy leaves the old marker unchanged and does not preserve broad legacy permissions. In `set -euC`, `-e` stops on failure, `-u` rejects unset variables, and `-C` prevents file replacement. `umask 077` removes group and other access; `mkdir -m` sets the directory mode. In the tests, `-e` checks existence, `-L` checks symbolic links, `-f` checks regular files, and `-d` checks directories.

```bash
AGENT_DIR="$HOME/.pi/agent" # Change this if the old session used another agent directory.
(
  set -euC
  umask 077
  root=$(git rev-parse --show-toplevel)
  root=$(cd "$root" && pwd -P)
  id=$(node -e 'process.stdout.write(require("node:crypto").createHash("sha256").update(process.argv[1]).digest("hex"))' "$root")
  agent_id=$(node -e 'process.stdout.write(require("node:crypto").createHash("sha256").update(require("node:path").resolve(process.argv[1], "config", "pi-pr")).digest("hex"))' "$AGENT_DIR")
  old="$AGENT_DIR/config/pi-pr/feedback/$id.json"
  new="$root/.context/pi-harness/pi-pr/feedback-$agent_id.json"
  if [ -e "$old" ] || [ -L "$old" ]; then
    if [ -L "$old" ] || [ ! -f "$old" ]; then
      echo "Unsafe source: $old" >&2; exit 1
    fi
    for dir in "$root/.context" "$root/.context/pi-harness" "$(dirname "$new")"; do
      if [ -L "$dir" ] || { [ -e "$dir" ] && [ ! -d "$dir" ]; }; then
        echo "Unsafe directory: $dir" >&2; exit 1
      fi
      if [ ! -d "$dir" ]; then mkdir -m 700 "$dir"; fi
    done
    chmod 700 "$(dirname "$new")"
    if [ -e "$new" ] || [ -L "$new" ]; then
      echo "Destination exists: $new" >&2; exit 1
    fi
    cat "$old" > "$new"
    cmp "$old" "$new"
    echo "Verified: $new"
  else
    echo "No old marker: $old"
  fi
)
```

The commands reject symbolic links. After you verify it, upgrade pi-pr and resume with new Pi sessions only.

[Sweep recovery](./skills/pi-pr-comment-sweep/references/recovery.md) covers manual publication, base movement, committed-scope adoption, legacy records, and interrupted commits or replies. Unrelated or unclear scope blocks publication. Unknown local checks need a later `/pr` and explicit safe-repeat confirmation; this never permits replay of uncertain pushes or GitHub changes.

## Limits and recovery

- After fixing a blocker, run `/pr` again. Resolve ambiguous remotes, unrelated changes, and GitHub blockers first. Unsupported remotes produce a warning without changes.
- `/pr` starts only on request. It never opens a browser, runs `/done` or `/sweep`, enables automatic merging, or uses a merge queue.
- Check sets stay fixed and run once per HEAD per invocation. Repairs must change HEAD, not drop checks. Timeout errors name the command and limit.
- Failed/unknown check sets consume repair budget; confirmed PR-head movements consume publication cycles. Duplicate observations, unchanged heads, and failed pushes do not consume publication cycles.
- Limits survive continuation and recovery. Exhausted publication budgets still permit published-sweep cleanup and readiness/merge checks. Wait exhaustion reports `still waiting for CI` or `still waiting for the Codex review`. A later `/pr` waits again.
- Concurrent updates block publication: pushes revalidate their destination and use exact OID leases. Pushes exclude tags, even with `push.followTags=true`. Never replay an uncertain commit or push before checking its outcome.
- Preflight changes can select another route at most twice without resetting budgets. Changed authority, dirty/divergent work, unreconciled recovery, or uncertain outcomes stop continuation. Repeated completed routes on the same head also stop.
- [Branch-update guidance](./skills/pi-pr-update-branch/SKILL.md) explains base advancement and changed authority during conflicts. [CI-fix guidance](./skills/pi-pr-fix-ci/SKILL.md) explains preflight changes. Base movement during or after evidence collection blocks CI repair; never reuse stale evidence.
- Verified branch updates can resume through `/pr` or the authorized `update-branch` scope. Pending, unverified updates need manual recovery after restart. Merge-containing history uses a merge with the original head as first parent and the pinned base as second parent. Linear history still uses rebase. Other branch refs stay unchanged, even with `rebase.updateRefs=true`.
- A valid conflict context survives idle turns only in its live session. Continuation checks branch, HEAD, exact operation markers, fresh authority, and the original status baseline. Undeclared edits block continuation and abort without clearing a valid context. Correct those edits, then continue the same run. Cancellation, failure, stale operation state, completion, and shutdown clear the context, not the recovery journal. A new launch cannot replace a valid conflict.
- In a merge conflict, `ours` is the PR branch and `theirs` is the base. In a rebase conflict, `ours` is the base with commits already replayed and `theirs` is the replayed PR commit. Main owns conflict decisions, not subagents. An advancing base does not start a second update in the same invocation.
- Every `/pr` merge needs explicit confirmation, clean safe local Git state, and fresh matching authority. A changed PR head during confirmation cancels merging. Active Git operations block merging. `/pr` deletes no branch or worktree.
