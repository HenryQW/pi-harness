# `@henryqw/pi-herdr-tools`

Clone conversations, hand off tasks, and ask side questions in Herdr. Name conversations and finish worktrees with explicit safety checks.

## Install

```sh
pi install npm:@henryqw/pi-task-models
pi install npm:@henryqw/pi-herdr-tools
```

Use Herdr 0.9.3 or later in a Herdr-managed Pi pane. Outside Herdr, rename changes only the Pi session title.

Before titles or side questions, configure `fast` in `/task-models`. It must not show `not configured`.

### Migration

Replace the retired packages before restarting Pi:

```sh
pi install npm:@henryqw/pi-herdr-tools
pi remove npm:@henryqw/pi-herdr-btw
pi remove npm:@henryqw/pi-herdr-clone
pi remove npm:@henryqw/pi-herdr-rename
# Only if the older standalone completion package is still installed:
pi remove npm:@henryqw/pi-herdr-done
```

Remove only installed sources and manually configured entry-point paths. Add `--local` for project-local installs. Old and new packages register duplicate commands. The harness installer removes retired personal npm sources only after successful replacement installation.

No migration: commands, safety behavior, task identifiers, `pi-herdr-rename/title` entries, BTW payload flags, pending deliveries, and config paths remain compatible. Features are not separately selectable.

## Works with

| Package | Relationship | Purpose |
| --- | --- | --- |
| [`@henryqw/pi-herdr`](https://pi.henry.wang/extensions/pi-herdr) | Required | Herdr CLI access. |
| [`@henryqw/pi-memory`](https://pi.henry.wang/extensions/pi-memory) | Improves | Keeps Main-only memory and dream advice out of side threads. |
| [`@henryqw/pi-task-models`](https://pi.henry.wang/extensions/pi-task-models) | Required | Model profiles for titles and side threads. |

## Use

Run `/clone-tab`; the original session stays active. Commands and prompts are for humans; tools are for agents.

| Surface | Type | Purpose |
| --- | --- | --- |
| `/clone-tab` | command | Clone into a new tab in the current workspace. |
| `/clone-worktree` | command | Clone into a new Git worktree workspace. |
| `/handoff-worktree <issue>` | prompt | Prepare a task for `herdr_handoff`. |
| `herdr_handoff` | tool | Start a separate task from local `main`, without changing focus. |
| `/done [-f]` | command | Remove the worktree and close its workspace tabs. `--force` aliases `-f`. |
| `/btw [<question...>]` | command | Open a side pane with an optional editable draft. |
| `/btw ask <question...>` | command | Ask a question starting with a subcommand name. |
| `/btw config [option value]` | command | Show values or `reset` defaults. Set `auto-submit` to `on`/`off`, `tools` to `inherit`/`all`/`read-only`/`none`, or `split` to `right`/`down`. |
| `/btw merge [<prompt...>]` | command | Queue a merge request. Without a prompt, open the editor. In Main, check pending deliveries. |
| `/btw help` | command | Show command grammar. |
| BTW capability widget | ui | Show `tool-free`, `read-only`, `tool-enabled`, or context-load errors with recovery steps. |
| `/rename` | command | Generate a title from up to five recent user messages. |
| Rename progress and result widgets | ui | Show `renaming...`, then `renamed to <title>` for two seconds on success. |
| First real user prompt | ui | Start titles in new, untitled conversations. |
| `pi-herdr-rename/rename` | model task | Title model profile. |
| `pi-herdr-btw/btw` | model task | Side-thread model profile. |
| Dialog blocked status | ui | Show `Input required` in Herdr during interactive TUI dialogs. |

### Clones

Both commands require `HERDR_ENV=1` and `HERDR_PANE_ID`. Pane, session-path, and leaf validation precedes target creation. Clones contain the root-to-current-leaf path, excluding sibling branches and still-streaming assistant output. Unsaved sessions use live state. Clones need no configuration.

![Clone launch and recovery boundaries.](./docs/clone-flow.svg)

Clone tabs keep the current working directory. Worktree clones use the new checkout. Pi starts with `--session <absolute-clone-file>`; only successful launches change focus.

Worktree creation uses `herdr worktree create --workspace <current-workspace> --no-focus`, or the repository's parent workspace when already in a linked worktree. Herdr creates missing branches from `HEAD`, with checkouts under `worktrees.directory` in grouped workspaces. Clones and handoffs use an extra unfocused tab if a layout plugin such as `herdr-plus` occupies the root pane.

### Worktree handoff

Run `/handoff-worktree Fix the flaky login test`. The agent collects missing facts, asking one question only for an unclear repository, outcome, or critical constraint. It sends a self-contained prompt, not the conversation, and reports without waiting for completion.

The tool registers only with `HERDR_ENV=1`. It also requires `HERDR_PANE_ID`, local `main`, and matching Git repositories for the current directory and pane workspace.

All parameters must be non-empty strings:

| Parameter | Requirement |
| --- | --- |
| `branch` | New branch; must not exist. |
| `label` | Workspace label. |
| `agentName` | Unique agent name matching `^[a-z][a-z0-9_-]{0,31}$`. |
| `prompt` | Self-contained task prompt. |

After validation, the tool runs `herdr worktree create --workspace <parent> --branch <branch> --base main --label <label> --no-focus`. It starts Pi without session arguments. It submits `herdr agent prompt <agentName> <prompt> --wait --until working --timeout 30000`, with the prompt as one argument, not a shell command or file. The result includes workspace ID, tab, pane, branch, checkout path, and agent name.

### Side questions

With a conversation open, run `/btw Why is this test failing?`, then submit the draft. Exact first words `ask`, `config`, `merge`, and `help` select subcommands; other input is a question.

The side-thread model receives Main's fixed, compaction-aware context snapshot. Enabled tools can change shared files. Select `read-only` or `none` to prevent changes. Shorten Main's context if it exceeds the side-thread context limit.

![Side-thread merge delivery.](./docs/btw-merge-sequence.svg)

Run `/btw merge Apply the smallest safe fix` after the answer. The merge request contains user and assistant text, without tool payloads. Herdr focuses Main and closes the side pane. Pending delivery survives shutdown until consumption or 24-hour stale cleanup. Once idle and authenticated, Main appends the transcript without starting a turn, then submits the prompt.

### Titles

Automatic titles ignore extension-injected, empty, and image-only prompts. Expanded skill and prompt-template text starts background generation without delaying the reply. English, sentence-case display titles usually have two or three words; limits are four words and 20 characters.

Herdr updates the pane and sole-pane tab. Linked worktrees get semantic branches only for detached checkouts or generated `worktree/...` branches; other branches remain unchanged. For example, `Update task logic` gives `refactor/update-task-logic`. Generated worktree labels change automatically; manual `/rename` can replace custom workspace names.

### Dialog status

Status requires Herdr's installed Pi integration, `~/.pi/agent/extensions/herdr-agent-state.ts`. Select, confirm, input, editor, and custom dialogs from any package count; RPC, JSON, and print modes do not. No dialog title or content goes to Herdr.

Status clears on answer, cancellation, failure, `/reload`, session switch, or exit. Reload can hide dialogs; late events cannot restore status. Nested dialogs count as one block. Other status owners, including `@henryqw/pi-ask-question`, remain independent.

## Flow

### Worktree completion

![Worktree removal and primary-checkout update.](./docs/done-flow.svg)

`/done` requires `HERDR_ENV=1`, `HERDR_WORKSPACE_ID`, and `HERDR_TAB_ID`. Commit or discard changes, then confirm removal; declining changes nothing. Normal and forced completion wait for idle Pi.

Normal removal rejects dirty worktrees and checkout use by other workspaces. Close listed tabs and retry; labels identify them, or IDs without labels. Primary-checkout tabs do not block removal or updates.

**`/done -f` skips confirmation and cross-workspace checks. It passes `--force` to Git, can permanently delete uncommitted work, and can leave other workspaces' tabs pointing at a removed checkout.**

Cleanup runs `git worktree remove <checkout>`, closes other tabs in the current workspace, then updates a non-bare primary checkout with `git pull --ff-only`. The current tab closes last, even if the update fails. Tabs in other workspaces do not close.

## Config

Package-owned: `~/.pi/agent/config/pi-herdr-btw/config.json`

| Name | Description | Values | Default |
| --- | --- | --- | --- |
| `autoSubmit` | Submit the draft automatically; otherwise, keep it editable. | Boolean. | `false` |
| `tools` | Tools available in the side pane. | `inherit` (Main's active tools), `all`, `read-only` (built-in read-only tools), or `none`. | `inherit` |
| `split` | Side-pane placement. | `right` or `down`. | `right` |

File and fields are optional. Launch reports unknown keys and invalid values, using field defaults; malformed files use all defaults. `/btw` continues without changing the file. `/btw config show` prints effective values. Updates fail until you correct issues or run `/btw config reset`. Reset reports issues, then replaces the file with defaults.

### Model profiles

`@henryqw/pi-task-models` owns `~/.pi/agent/config/pi-task-models/config.json`. Both tasks default to `fast`; `tasks` assignments override it. Missing config or profiles warn once per session. Issues, including unknown keys and malformed JSON, report once per session at startup or before route resolution. Correct them with `/task-models`.

Side threads select the first authenticated viable route before launch. Titles use the primary route, then fallback, with configured thinking; they never substitute the current session model. An invalid title gets one repair request before fallback. Without a viable route, titles remain unchanged.

## State and storage

Clones are separate session files in the Pi-selected session directory. Saved `pi-herdr-rename/title` entries restore display titles and semantic branches without another model request. Older titles get no migration.

## Limits and recovery

| Failure | Recovery |
| --- | --- |
| Definite clone-tab creation failure | The clone file is removed. Cleanup errors name any remaining file. |
| Worktree creation or pre-launch extra-tab failure | No clone session exists yet. |
| Killed or incomplete worktree creation | Partial workspace state can remain. Inspect returned IDs with `herdr workspace list`. |
| Incomplete tab response | Inspect known IDs before cleanup. Clone tabs retain the session path; worktree clones retain the worktree without a clone session. |
| Agent start requested | An ambiguous launch retains targets and session files. Inspect reported IDs. |
| Clone focus failure | Pi already started. Focus its tab manually. |
| Handoff validation failure | No worktree exists. Correct the reported requirement. |
| Handoff cancellation | Before creation, nothing remains. After creation, reported resources remain; later launch or delivery steps stop. |
| Handoff start or prompt failure | Resources remain. Errors identify worktree, branch, workspace, tab, pane, and agent. No automatic cleanup occurs. |
| `agent_blocked` or `agent_prompt_stalled` | Prompt delivery failed. Inspect the agent before retrying. |

Timed-out prompts can still arrive. Check `herdr agent get` and `herdr agent read`; resend with `herdr agent prompt` only if absent. Alternatively, run `/done` in the new worktree. Remove personal `handoff-worktree.md` copies to resolve package-prompt name collisions.

After a failed primary update, the removed worktree stays removed. Correct primary-checkout changes or divergence, then run `git -C <primary-checkout> pull --ff-only`.

`/rename` warns without user text. For Herdr or Git synchronization warnings, correct the problem and retry `/rename`. Newer renames silently cancel older requests.
