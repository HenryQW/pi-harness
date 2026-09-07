# `@henryqw/pi-pr`

See the current branch pull request in the Pi footer. Use `/pr` to run its next safe step. It shows CI, review, merge, and lifecycle status without repeated `gh` commands.

## Install

```bash
pi install npm:@henryqw/pi-pr
```

Requires an authenticated GitHub CLI session (`gh auth login`) and a checkout on GitHub.com or GitHub Enterprise. Run `gh auth status` to verify authentication.

## Feedback snapshots

`pr-feedback.mjs fetch --out FILE` prints a compact feedback index. The index
includes IDs, kinds, states, authors, locations, and parent IDs as needed. It
does not print comment or review bodies.

The saved snapshot still contains the complete feedback. `fetch --json` also
keeps the complete JSON output. Read one item with
`pr-feedback.mjs show --snapshot FILE --id ID`.

`show` prints one JSON record with its exact stored body and fields. A thread
record includes child IDs without child bodies. A nested comment includes only
its parent thread's ID, state, and location. Missing, unknown, duplicate, or
ambiguous IDs fail. `show` does not run Git, call GitHub, use the network, or
write files.

## Works with

**Requires.** [`@henryqw/pi-herdr`](https://pi.henry.wang/extensions/pi-herdr) is the shared Herdr CLI client. It installs with this package.

**Improves.** [`@henryqw/pi-footer`](https://pi.henry.wang/extensions/pi-footer) shows current-branch pull-request status in the footer.

## Use

Run `/pr` without arguments in a GitHub checkout. It reads the current branch pull request and local state, then runs one route. The PR hostname selects its GitHub API host, and the extension works outside Herdr.

| Surface | Type | Purpose |
| --- | --- | --- |
| `/pr` | command | Run the current pull request's next safe route. |
| Footer | ui | Show a linked `PR #number` and one plain-language status. |
| Widget | ui | Show one actionable icon-prefixed `Run /pr to …` hint. |

The footer already shows the pull request and status. Actionable widgets omit duplicate identity and status. Each uses one semantic status icon, a space, and a plain `Run /pr to …` route. `✗` marks errors, `!` warnings, `✓` success, and `●` accent or neutral routes. In TUI, only the icon uses a theme color. RPC and non-TUI output use the same plain text without ANSI.

## Flow

Each footer entry is one linked `PR #number` plus one plain-language status: `N unresolved`, `draft`, `open`, `approved`, `CI running`, `CI failed`, `changes requested`, `base update required`, `merge conflict`, `merge-ready`, `merged`, or `closed`. Colors support the text; they do not carry meaning alone.

![Flowchart showing /pr reading fresh GitHub and local state, choosing the first matching condition, and stopping after one route](./docs/pr-routing.svg)

### Routes

| Current condition | `/pr` route |
| --- | --- |
| No current-branch pull request, no published matching ref, and safe Git push configuration | Start pull-request creation. |
| One open pull request inferred from a published matching ref | Confirm the exact `remote/ref`, then link the local branch. |
| Ambiguous or unsafe discovery | Show the blocked reason and do not mutate Git or GitHub. |
| Base update required or merge conflict | Update from the base branch's current target when the tree is clean and local HEAD equals the PR head. |
| CI failed | Run the CI fix workflow when the same local prerequisite holds. |
| Changes requested or unresolved review threads | Run the package comment sweep when the same local prerequisite holds. |
| No-action state | Report the state without taking action. |
| Merge-ready pull request | Ask for final confirmation, recheck fresh state, and merge directly if confirmed. |

`pi-pr-create` honors an existing configured push target. Without one, it pushes a captured OID to the local branch ref on `origin` and sets upstream.

Without a configured push target, discovery checks validated remotes for the same branch ref. One exact open PR becomes an inferred target. `/pr` names the exact `remote/ref` and asks before linking it. The extension revalidates the branch, PR, remote OID, and Git configuration before mutation. It rolls back its upstream and remote-tracking changes if final verification fails.

Multiple candidate remotes, multiple matching PRs, OID mismatches, and unsafe Git push configuration block routing. A published ref with no PR also blocks creation. If no candidate ref exists, creation uses only a validated `origin` destination.

The creation workflow repeats destination, remote OID, PR, and configuration checks immediately before pushing. It pushes to the saved validated URL, not a mutable remote name. Every push uses the saved remote OID as an exact lease. Existing refs must also be ancestors of the captured local OID. A missing ref uses an empty lease as a create-only compare-and-swap.

After a `/pr` create workflow settles, the extension waits for a refresh that finds an open current PR. It then prefixes the Herdr workspace label with `#<number> • `.

Failed or empty discovery leaves one rename pending for a later refresh. Closed or merged historical matches do not trigger it.

It removes repeated leading `#<number> • ` prefixes and legacy trailing ` · PR #<number>` suffixes before adding one current prefix. The remaining workspace name must be non-empty. This requires `HERDR_ENV=1` and a non-empty, trimmed `HERDR_WORKSPACE_ID`.

It renames only the workspace. Outside Herdr, it does nothing.

If Herdr lookup, JSON validation, or rename fails, the PR and normal UI refresh remain available. Each Herdr command has a 10-second timeout. The extension warns with `Herdr workspace rename failed: <error>`.

Current-branch discovery matches the exact push repository and ref. It finds a fork-head PR whose base is an upstream repository. A unique historical match uses the exact remote push-ref OID, not local HEAD.

A no-action state includes a draft, merged or closed pull request, running CI, pending review, or blocked merge policy. It also includes a mutating workflow whose tree is dirty or whose local HEAD differs from the PR head.

### Route priority

A missing pull request uses creation. For an existing pull request, the first matching condition wins:

1. Merged, closed, or draft: no action.
2. Base update required or merge conflict. Run only with a clean tree and equal local and PR heads.
3. CI failure. Apply the same local prerequisite.
4. Changes requested or unresolved review threads. Apply the same local prerequisite.
5. Waiting or local safety block: no action.
6. Merge-ready: allow clean local HEAD equal to or behind the PR head. Confirm, then merge directly.

Ordinary conversation comments do not trigger a route or block a merge. Changes requested and unresolved review threads can select the package comment sweep.

The comment sweep resolves its bundled helper and references from the installed package skill path. It does not require an external `jq` executable.

### Refresh

The footer and widget load at session start. A directory outside a Git worktree stays silent and does not start polling. The UI shows `PR · status unavailable` for other discovery failures and reports only a generic error.

They refresh after local commits, PR creation, pushes, and each dispatched workflow settles. They also refresh after any successful delegated task settles. Active Git worktrees poll every 30 seconds. Polling updates presentation only and may be stale.

The create widget stays hidden until the local branch has a commit beyond its creation point. Any displayed widget clears as soon as `/pr` starts. A dispatched workflow keeps it hidden until the agent settles. A direct merge, no-action route, or failed command refreshes the widget when the handler finishes.

Presentation uses route priority, so draft appears before running CI. `/pr` reads fresh state before routing or merging. The command is authoritative for actions.

## Limits and recovery

- `/pr` takes no arguments and does not open a browser.
- It does not run `/done` or `/sweep`.
- Polling does not auto-triage comments or start a workflow. The package comment sweep runs only when an explicit `/pr` selects it.
- It does not enable auto-merge or add a merge queue.
- It does not rebase the local branch, overwrite concurrent remote updates, delete branches, or clean up worktrees. Creation uses exact leases plus ancestry checks; an empty lease is only an atomic absence check.
- Creation, discovery, and comment-sweep pushes require one unambiguous push URL for the configured destination.
- Presentation fetches use that exact push URL and exact advertised OID. They do not use shared fetch state.
- Strict status checks in legacy branch protection or applicable repository rulesets require a base update.
- Applicable ruleset restrictions intersect repository-wide merge methods. An empty intersection stops the workflow.
- Before merge, `/pr` fetches the exact head OID from the validated push URL without shared fetch state.
- A merge, rebase, cherry-pick, revert, or sequencer state blocks direct merge, even when `git status` is empty.
- A branch update resolves the base repository ref directly. It stops if that ref moves before merge or push.
- Before a comment-sweep push, it revalidates the configured destination, full PR identity, and local HEAD. It pushes the captured OID.
- CI repair captures the failed-step log tail and runs one narrow local reproducer before editing.
- An already-published local HEAD needs no second push.
- Direct merge requires final confirmation and a fresh readiness check.
- After a successful merge, the create widget stays hidden until a new local commit.
- Only authenticated GitHub.com and GitHub Enterprise repositories are supported.
