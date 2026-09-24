# `@henryqw/pi-herdr-rename`

Give each conversation one short Pi title that can also label its Herdr location and Git branch. Titles are generated in the background and restored on resume without another model call.

## Install

```bash
pi install npm:@henryqw/pi-task-models
pi install npm:@henryqw/pi-herdr-rename
```

Run `/task-models` and configure the `fast` profile. Open `/task-models` again and verify that `fast` no longer says `not configured`.

## Works with

| Package | Relationship | Purpose |
| --- | --- | --- |
| [`@henryqw/pi-task-models`](https://pi.henry.wang/extensions/pi-task-models) | Required | Provides shared title-generation model profiles. |

## Use

In a new, untitled conversation, send the first real prompt. Pi generates a title in the background without delaying the reply.

| Surface | Type | Purpose |
| --- | --- | --- |
| First real user prompt | ui | In a new, untitled conversation, starts title generation once the expanded prompt is ready. |
| `pi-herdr-rename/rename` | model task | Title-generation route; users configure its profile through `/task-models`. |
| `/rename` | command | For people: generate a new title from up to five recent user messages. |

## Flow

### Trigger

In a new, untitled session, the first real user prompt generates a title in the background after Pi expands skill and prompt-template shorthand. It does not delay the main reply. Extension-injected prompts, empty prompts, and image-only input are ignored.

### Title and branch rules

A semantic branch is a Git-safe branch name made from a task type and the display-title words. Model classification stays internal. For example, `refactor: update task logic` displays as `Update task logic` and maps to `refactor/update-task-logic`.

- In a linked worktree, a detached checkout or Herdr `worktree/...` branch is renamed. An existing non-generated branch stays.
- A linked worktree's generated workspace label, such as `worktree-brave-meadow-4aa8`, becomes the display title automatically. A manual `/rename` can also replace a custom workspace name.
- The pane is renamed in Herdr. The enclosing tab updates only when this pane is the tab's only pane.
- Outside Herdr, only the Pi session name changes. Herdr is required for pane, tab, workspace, and linked-worktree branch updates.

### Model route

The task `pi-herdr-rename/rename` defaults to the `fast` profile. The shared [`pi-task-models` config](https://pi.henry.wang/extensions/pi-task-models#config) at `~/.pi/agent/config/pi-task-models/config.json` can explicitly override that assignment.

The extension tries the assigned profile's primary route, then its fallback, while honoring the configured thinking level. It never substitutes the current session model.

## State and storage

The Pi session stores each generated display title and semantic branch in a `pi-herdr-rename/title` session entry. When resuming a session created by this version, the extension reapplies the saved title and branch without another model request.

## Limits and recovery

Display titles are natural task phrases, preferably three or four words, and always at most four words and 20 characters.

A missing shared task-model config warns once at session start. Run `/task-models` to configure rename routing. No viable route leaves titles unchanged. `/rename` warns if the session has no user text to rename.

Herdr and Git synchronization failures appear as warnings. Fix the reported issue, then run `/rename` to try again. Cancellation by a newer rename remains silent. Older titles receive no migration.
