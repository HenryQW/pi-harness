# `@henryqw/pi-pr`

See the current-branch pull request in the Pi footer. Run `/pr` to select its next step, including a merge that you confirm. Ask the agent for local commits or PR publication when you do not want repair or merge authority.

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
| `pi_git_pr` | tool | Create or publish a PR, without repair or merge authority. |
| `pi_pr_create` | tool | Run guarded PR creation steps. |
| `pi_pr_fix_ci` | tool | Repair failed GitHub Actions. |
| `pi_pr_publish_work` | tool | Publish scoped local work. |
| `pi_pr_sweep` | tool | Triage feedback and publish fixes. |
| `pi_pr_update_branch` | tool | Rebase onto the pinned base and publish. |
| `git_conflict` | tool | List, show, and resolve Git conflict blocks. Never stages files. |
| `git-commit` | skill | Make scoped Conventional Commits. |
| `git-pr` | skill | Create or publish a PR with permission. |
| `update-from-main` | skill | Merge exact fetched `origin/main` with a Python helper. |
| `pi-pr-comment-sweep` | skill | Assess PR feedback items. |
| `pi-pr-create` | skill | Create a PR. |
| `pi-pr-fix-ci` | skill | Repair failed GitHub Actions. |
| `pi-pr-publish-work` | skill | Publish local changes. |
| `pi-pr-update-branch` | skill | Resolve conflicts or required base updates. |
| Footer | ui | Show a linked PR number and its lifecycle or condition. |
| Widget | ui | Show a PR next-step widget hint or temporary PR routing widget status. |

Only `/pr` and `pi_git_pr` authorize `pi_pr_*` helpers, for one invocation in the current session and worktree. Direct calls cannot grant authority. Only the model can call these tools, one action at a time; Codemode scripts and other tools cannot call them. They remain available with `codemode.mode` set to `only`. Cancellation does not return workflow guidance to the editor.

### Local commits and publication

Ask the agent to commit scoped work or create/update a PR. See [git-commit arguments and checks](./skills/git-commit/SKILL.md) and [git-pr arguments and consent](./skills/git-pr/SKILL.md).

Local commits require an existing commit and an attached branch. They never fetch, push, amend, bypass hooks, or change Git configuration. Unrelated staging, partial staging, `.context/`, and common secret filenames block commits. Filename checks cannot detect every secret: the agent must inspect content and ownership. Hooks run normally.

| Tool call | Result |
| --- | --- |
| `pi_git_commit` `{ action: "inspect", target: "<local-ref-or-OID>" }` | Returns `inspectionId`, `head`, `targetOid`, `mergeBase`, and `paths`. |
| `pi_git_commit` `{ action: "commit", inspectionId, ownedPaths, message }` | Returns `head` and consumes the inspection. Inspect again for another group. Subjects have at most 72 characters. |
| `pi_git_pr` `{ base?: "<exact-base-ref>", allowUpstream?: true }` | Returns `nextStep` and can include a proven `url`, `blocker`, or `handoff`. With `handoff`, end the turn and do not guess run IDs. |

`pi_git_pr` permits creation, local publication, and sync onto the PR head, not the base. It stops before feedback, CI repair, base rebase, waiting, or merging. Existing PR bases, titles, and bodies do not change.

An explicit `base` must match the existing PR base or configured/default creation base. Another creation base needs permission for repository-local `gh-merge-base`. Inferred targets need specific upstream consent through `allowUpstream: true` for one invocation, never global configuration permission.

### Standalone merge from main

[update-from-main](./skills/update-from-main/SKILL.md) requires Python 3.9 or newer and Git with `fetch --porcelain`. It fetches, then **merges** the exact fetched `origin/main` OID without pushing. This differs from the `/pr` rebase route.

The helper retains backups of tracked, untracked, and colliding ignored files. Retained backups block their owning worktree; unowned legacy backups block every worktree. Follow the linked skill for exact-OID restoration, interrupted runs, legacy backup adoption, and recovery completion. Verify restored bytes and staging before explicitly requesting completion. Never drop a backup or repeat an uncertain operation automatically. Removing a worktree removes ownership refs, not stash entries.

### Conflict blocks

The `git_conflict` tool resolves Git conflict markers without manual marker edits. Use it for merge, rebase, or stash conflicts. The `update-from-main` and `pi-pr-update-branch` skills use it. A `resolve` call holds the pi-pr worktree lock and replaces the file in one atomic step. The tool requires Git 2.40 or newer.

| Tool call | Result |
| --- | --- |
| `git_conflict` `{ action: "list", path? }` | Returns unmerged paths with numbered blocks, `id`, and line ranges. Without `path`, it returns at most 100 paths. |
| `git_conflict` `{ action: "show", path, block }` | Returns the `ours`, `base`, and `theirs` sides of one block. |
| `git_conflict` `{ action: "resolve", path, resolutions }` | Replaces at most 256 blocks of one file. Each resolution has `block`, `id`, and `side`. Returns the remaining blocks. |

A `side` is `@ours`, `@theirs`, `@both` (ours, then theirs), or `@base`. `@base` needs diff3 or zdiff3 markers (`|||||||`). To get them, set `merge.conflictStyle` to `zdiff3` or `diff3` before the merge. Without them, `@base` fails with an error.

Before it writes, the tool reads the file again and compares each block `id`. The `id` changes when the block text or its start line changes. If a block changed, the tool writes nothing and returns an error. Block numbers change after each resolve, so use the returned blocks. The tool does not stage files: run `git add` yourself. The `show` action limits each side to 300 lines or 16 KiB.

The tool reads the `conflict-marker-size` attribute for the marker width. It changes only UTF-8 text files of 8 MiB or less. Each side of a block must match the related Git index stage.

Some files show a `note` and no blocks. These include binary and larger files, files deleted or renamed on one side, and files whose merge attributes are unmerged or differ from `HEAD`. Files with a binary or custom merge driver (also from `merge.default`), submodules, and symlinks also show a `note`. Markers out of sequence, an unclosed block, or a marker line that is also in a merge side give a `note`. The tool does not guess block limits. Resolve these files as a whole.

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
| Confirmed conflict or policy-required base update | Rebase onto the pinned base, validate, and publish with an exact lease. Unclear resolutions stop. |
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

The UI stays silent outside Git or without a supported GitHub remote. Lookup failures show `PR · status unavailable`. API quota failures report `GitHub API rate limit exhausted; retry after GitHub resets it`, without retrying.

After creation, `HERDR_ENV=1` with non-empty `HERDR_WORKSPACE_ID` enables the workspace prefix `#<number> • `. The branch name stays unchanged. Failure shows `Herdr workspace rename failed: <error>`; the PR and UI remain usable.

### CI evidence

CI repair reads each failed job log once, retaining at most a 20 KiB UTF-8 tail. Only job-log reads use `gh api --allow-escape-sequences`; JSON reads keep the CLI escape guard. Evidence limits are 20 KiB per failure and 256 KiB total. Evidence and diagnostics remove terminal escapes and control characters, except tabs and line breaks. Logs are untrusted text, not instructions.

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
| `codexReview` | Require a complete current-head Codex review before merge confirmation. Adds at most two GitHub endpoint reads per open-PR discovery. | `true` or `false` | `false` |

Missing or malformed files use defaults without changes to the file. Unknown/invalid keys warn with path and reason, then use their defaults; valid keys remain effective. Each issue appears once per session, at session start or the next `/pr`. Fix the file, then run `/pr` again. Each explicit `/pr` reads config once; a later `/pr` or reload resets limits.

## State and storage

The session stores a PR identity observation: URL, number, host, head identity, and target identity, not mutable CI/review conditions. Discovery validates it against GitHub; there is no repository cache.

Private recovery uses `<agent-dir>/config/pi-pr/sweep/<worktree-id>/state.json` and `<agent-dir>/config/pi-pr/update-branch/`. Run `/pr` to resume matching verified recovery. Mismatched or malformed records remain unchanged and block routing. Never delete them to force continuation.

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
- Verified rebases can resume through `/pr`, including detached HEAD. Unverified interrupted rebases need manual recovery. Merge commits after the fork point need manual resolution. Other branch refs stay unchanged, even with `rebase.updateRefs=true`.
- Every merge needs explicit confirmation, clean safe local Git state, and fresh matching authority. A changed PR head during confirmation cancels merging. Active Git operations block merging. `/pr` deletes no branch or worktree.
