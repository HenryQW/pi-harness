# `@henryqw/pi-memory`

Keep durable preferences and cross-project facts across Pi sessions in size-limited Markdown stores.

Inspired by [Hermes Agent](https://github.com/NousResearch/hermes-agent) and its bounded `MEMORY.md`/`USER.md` cross-session memory pattern.

## Install

```bash
pi install npm:@henryqw/pi-ask-question
pi install npm:@henryqw/pi-task-models
pi install npm:@henryqw/pi-memory
```

Configure `balanced` in `/task-models`.

## Works with

| Package | Relationship | Purpose |
| --- | --- | --- |
| [`@henryqw/pi-ask-question`](https://pi.henry.wang/extensions/pi-ask-question) | Required | Provides validated conflict prompts. |
| [`@henryqw/pi-herdr-tools`](https://pi.henry.wang/extensions/pi-herdr-tools) | Improves | Marks side-thread children to exclude parent-only memory injection and dream advice. |
| [`@henryqw/pi-task-models`](https://pi.henry.wang/extensions/pi-task-models) | Required | Provides routes for candidate review, `/remember` preparation, and `/dream` promotion. |

## Use

Run `/remember I prefer concise release notes.` Pi proposes and reviews an entry, then saves it to `USER.md` or asks about conflicts. Confirm the entry in `~/.pi/agent/config/pi-memory/memory/USER.md`, or your configured `directory`.

| Surface | Type | Purpose |
| --- | --- | --- |
| `/remember <instruction>` | command | For humans: request compact durable memory. |
| `/memory-review` | command | For humans: review pending candidates for the current repository or starting directory. |
| `/dream` | command | For humans: promote invariant memory instructions into agent-global `SYSTEM.md`, or `APPEND_SYSTEM.md` when `SYSTEM.md` is absent. |
| `memory` | tool | For agents: add, replace, remove, or batch-edit entries. |
| `pi-memory/reviewCandidate` | model task | For humans: assign a profile in `/task-models`. The task reviews additions. |
| `pi-memory/prepareCandidate` | model task | For humans: assign a profile in `/task-models`. The task proposes a `/remember` entry and target, or declines. |
| `pi-memory/promoteEntries` | model task | For humans: assign a profile in `/task-models`. The task proposes one guarded `/dream` promotion. |

## Flow

### Candidate review

`pi-memory/reviewCandidate` independently reviews single adds and batches containing adds. It defaults to `balanced`, tries configured Pi registry primary then fallback routes, and never substitutes the session model. Only verified, size-limited JavaScript Object Notation (JSON) evidence is accepted.

![/remember prepares a candidate before preflight. The memory tool enters preflight directly. Adds need review; exact duplicates skip it. Replace/remove go directly to locked storage. Session snapshots stay fixed.](./docs/memory-architecture.svg)

Review sends live agent-global `SYSTEM.md`, `MEMORY.md`, and `USER.md` snapshots to the configured model. Initially missing `SYSTEM.md` counts as empty. Unreadable, oversized, or over-cap sources block review. Restore a SYSTEM file that disappears after review proved it present.

Conflict-free additions save immediately. Exact duplicate single adds and duplicate-only add batches are idempotent and skip review.

Automatic conflicts enter a private, durable review inbox. They never open a dialog, even after the response ends. The tool returns `queued: true`, `saved: false`: the candidate is in the inbox, not in `MEMORY.md` or `USER.md`. The agent must continue its response without a retry or a question.

### Review inbox

Run `/memory-review` in an idle interactive terminal. The command reviews this group's candidates in arrival order. It reads live sources and runs candidate review again before it shows each complete mutation. Approval applies the complete mutation, not selected parts of a batch.

For a single add with one same-store conflict, the command offers replacement, discard, and merge when the reviewer supplies an exact merge. A merge or replacement gets another review, and overlap with the entry it replaces is expected because the same write removes that text. A conflict with any other source blocks that write, names the evidence, and retains the candidate. Other non-SYSTEM conflicts can use **Save complete mutation**. SYSTEM conflicts offer only discard or deferral; candidate review never edits `SYSTEM.md`.

**Review later** is selected by default. Press Esc to stop and retain the candidate. Use Page Up, Page Down, Home, and End to read long mutations; approval controls stay visible.

Discard removes the candidate without a memory write. Approval removes it only after the memory write succeeds. Changed sources, cancellation, invalid review output, and write failures retain the candidate. A saved mutation with a failed inbox removal is reported separately; inspect live memory before another review.

A count-only widget shows pending candidates for the current group and is hidden at zero. It contains no candidate text. A short reminder appears after each response while candidates remain. Non-terminal modes receive plain-text reminders; they cannot approve candidates.

Pi checks the inbox file every 250 milliseconds to detect other sessions' writes, file creation, replacement, and removal. The check stops at session shutdown or replacement without stopping other sessions' listeners. If the check cannot start or the inbox cannot be read, Pi reports the problem. Counts also refresh after responses and review commands.

Linked Git worktrees share the canonical common Git directory as their group. Outside Git, the group is the canonical session starting directory, not a later shell directory. Session changes select the new group's count. Restart, cancellation, and shutdown do not delete inbox candidates. Each item also records the memory directory; review stops if that directory no longer matches the active configuration. Restore that configuration before review.

The inbox is `~/.pi/agent/config/pi-memory/review-inbox.json`, outside the possibly synced memory directory. Locked updates preserve concurrent additions and removals. New files use mode `0600`; the containing directory uses mode `0700`. On Windows, access follows the operating system's permission rules.

The complete inbox has a 65,536-byte limit. A full, malformed, or unwritable inbox rejects additions without a partial batch or a false success message. Existing candidates stay intact. Review pending items to free space; preserve a damaged inbox before repair.

### `/remember` and queued work

![Automatic conflicts enter a durable group inbox. Only /memory-review opens their approval questions. Busy remember requests wait for settlement; restart clears those requests, not the inbox.](./docs/remember-queue-flow.svg)

`/remember` uses bounded `pi-memory/prepareCandidate` proposals: one exact entry and target, or a decline for unsuitable, project-specific, temporary, or trivial content. It requires the configured `balanced` route, unchanged sources, and candidate review. It never sends open-ended instructions to the session agent.

An explicit `/remember` can ask about a conflict immediately. Custom answers do not apply changes. Busy responses queue trimmed remember requests until settlement, then process them in arrival order while idle. Results and failures use notifications, not new agent turns.

Cancellation, shutdown, reload, and session replacement clear these temporary requests. They do not clear the durable inbox. A cancelled explicit request is not saved to the inbox; issue `/remember` again if needed.

`/remember` rejects writes if another response starts, the session shuts down or changes, or the model changes during review. Non-interactive conflicts remain unwritten. This also applies without a cancellation signal; retry in the current session.

### `/dream`

Pi recommends `/dream` for non-empty memory with no recorded dream, or one at least 30 days old. It also recommends it when either store reaches 70% and the last dream was at least 7 days ago.

`/dream` requires an interactive terminal and a configured `balanced` route. It selects agent-global `~/.pi/agent/SYSTEM.md` when that file exists. When `SYSTEM.md` is absent, it selects `~/.pi/agent/APPEND_SYSTEM.md`. It can create the append file after approval. Append rules keep Pi's default prompt; `/dream` never creates a partial `SYSTEM.md` that replaces those defaults.

An unreadable, oversized, or symlink target stops the command. An invalid `SYSTEM.md` does not cause a fallback to the append file. Prompt edits take effect in a new session. A trusted project's `.pi/APPEND_SYSTEM.md` overrides the agent-global append file; the two files do not combine.

`/dream` shows `Dream running…` in Pi's bordered loading widget, as `/rename` does, before it reads files or requests a model proposal. The status clears when the command ends, is cancelled, or the session or model changes.

`pi-memory/promoteEntries` proposes one exact edit to the selected prompt file and the whole memory entries it represents. The approval screen fits the current terminal size. It names the selected file and shows the reason, exact edit with line numbers, and all entries to remove from each store. Approval states whether it will create or update the prompt file.

Use Page Up and Page Down to scroll; Home and End go to the start and end. The approval controls stay visible. If the terminal is too small, enlarge it or press Esc to reject.

Use Up and Down to select a control, then Enter to confirm. `Reject` is selected by default. Select `Approve` to proceed; `Reject` or Esc changes nothing.

After approval, pi-memory checks the target selection, file state, contents, and both stores. Concurrent creation of `SYSTEM.md` or the selected append file stops the command, as do deletion and source changes. It writes the selected prompt first, then removes entries. A failed prompt write removes nothing. If removal fails, run `/dream` again to reconcile; the timestamp does not advance. Successful runs record time in `~/.pi/agent/config/pi-memory/dream.json`.

Commands stop before writes when Pi supplies a cancellation signal that aborts. Idle Pi can supply no signal. After a prompt edit saves, entry removal continues even on cancellation, so a retry can reconcile it.

### Per-turn memory check

The current agent decides what qualifies for memory. Each turn's check asks it to save durable user identity, preferences, and corrections to `target=user`. Stable cross-project environment and workflow facts use `target=memory`.

Use the tool immediately for qualifying facts. Inferred habits need two independent signals from the conversation or existing profile. Skip repository facts, task-local behavior, progress, and temporary preferences.

## Config

Package-owned: `~/.pi/agent/config/pi-memory/config.json`. You write this file; pi-memory never writes it. It reads config at session start; restart the session after changes.

| Name | Description | Values | Default |
| --- | --- | --- | --- |
| `directory` | Folder for both stores. | Non-empty absolute path without control characters. | `~/.pi/agent/config/pi-memory/memory` |
| `memoryCharLimit` | Character cap for `MEMORY.md`. | Safe integer from 1 to 100000. | `8800` |
| `userCharLimit` | Character cap for `USER.md`. | Safe integer from 1 to 100000. | `5500` |

For the shared rules, see [Config files](https://pi.henry.wang/overview#config-files). Results for pi-memory:

| Problem | Result |
| --- | --- |
| Invalid `directory`, including `directroy` without `directory` | Disable persistent memory; never substitute the default directory. |
| File problem, such as malformed JSON | Disable persistent memory. |

Fix invalid config, then start a new session.

## State and storage

| Store | Scope |
| --- | --- |
| `MEMORY.md` | Cross-project agent notes. Put repository facts in repository docs. |
| `USER.md` | User profile. |
| `review-inbox.json` | Private global review inbox, divided by repository or session starting directory. |

The two Markdown stores hold entries separated by `§`. Each session captures both stores once; later edits change live memory, not the injected session snapshot.

pi-memory tracks stores proven present during the session, including invalid UTF-8, oversized, and symlinked files. If one disappears, writes stop until restoration. Unconfirmed paths can be repaired and created normally; new sessions reset presence tracking. Inspect live state at `<directory>/MEMORY.md` and `<directory>/USER.md`.

Backups and the lock file stay outside `directory`, under `~/.pi/agent/config/pi-memory/backups/`. Before rewriting an existing store, pi-memory overwrites its matching `MEMORY.md.bak` or `USER.md.bak` with the previous contents. Failed writes can also update backups; first writes to missing stores create none. Backups are not versioned history.

You can use iCloud Drive or an Obsidian-synced folder as `directory`. Sync only carries files; pi-memory owns their format and does not merge remote changes.

## Limits and recovery

Cloud-synced files can be read outside Pi. Before using shared or synced storage, read [ADR 006: pi-memory global store threat model](https://github.com/HenryQW/pi-harness/blob/main/docs/adr/006-pi-memory-global-store-threat-model.md).

Writes over a store cap fail with current usage. Consolidate with one batch that removes or shortens stale entries and adds new content; only final size counts. Batches allow at most 100 operations; complete serialized mutations allow at most 1,000,000 UTF-8 bytes. Both limits apply before source reads or review; violations write nothing.

External edits or sync can exceed caps; snapshots omit overflow and warn. Startup lists at most three unexpected regular filenames, stopping on the fourth with `at least four unexpected files`. Only `MEMORY.md` and `USER.md` load. Reconcile or remove unexpected files.

### Restore a backup

Never copy backups over live or damaged stores:

1. Stop all Pi sessions and other writers using `directory`. Pause cloud sync. Keep them stopped during restoration.
2. Preserve the damaged file in a recovery folder outside `directory` and the backup folder. Verify that copy. Move the damaged file out of `directory`; do not delete it or overwrite the backup.
3. Inspect the matching `MEMORY.md.bak` or `USER.md.bak` for wanted entries, valid UTF-8, `§` delimiters, and the configured character cap. Stop if it is missing or damaged; backups provide no older versions.
4. Copy the checked backup to the vacant `<directory>/MEMORY.md` or `<directory>/USER.md` as a regular file, not a symlink. Preserve restrictive permissions, especially for `USER.md`.
5. Start one new Pi session. Confirm initialization without store warnings. Inspect the restored file and new snapshot before writing; old sessions cannot validate restored state.
6. Check for remote changes that could replace the restored file. Only then resume other writers and sync.
