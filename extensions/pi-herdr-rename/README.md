# `@henryqw/pi-herdr-rename`

Give each Pi conversation a short title, and use it for Herdr labels and generated Git branches.

## Why

- **Created for**: Users who cannot identify conversations from generated workspace labels.
- **Advantage**: One concise title labels Pi and Herdr, maps to Git, and returns on resume without another model call.

## Install

```bash
pi install npm:@henryqw/pi-task-models
pi install npm:@henryqw/pi-herdr-rename
```

Run `/task-models` and configure the `fast` profile. Herdr is required for pane, tab, workspace, and branch updates.

Outside Herdr, the extension still changes the Pi session name.

## With

[`@henryqw/pi-task-models`](https://pi.henry.wang/extensions/pi-task-models) is required for shared title-generation model profiles.

## Use

Send the first real prompt. A title appears in the background without delaying the reply.

Run `/rename` after the task changes. It generates a new display title and semantic branch from up to three recent rounds.

### Trigger

The first real user prompt generates a title in the background after Pi expands skill and prompt-template shorthand. It does not delay the main reply. Extension-injected prompts, empty prompts, and image-only input are ignored.

### Title and branch rules

Display titles are natural task phrases. They are preferably three or four words and always at most four words and 20 characters.

A semantic branch is a Git-safe branch name made from a task type and the display-title words. Model classification stays internal. For example, `refactor: update task logic` displays as `Update task logic` and maps to `refactor/update-task-logic`.

- In a linked worktree, a detached checkout or Herdr `worktree/...` branch is renamed.
- An existing non-generated branch stays.
- A generated workspace label such as `worktree-brave-meadow-4aa8` becomes the display title automatically.
- `/rename` also replaces a custom workspace name.
- The enclosing Herdr tab updates only when this pane is the tab's only pane.
- Outside Herdr, only the Pi session name changes.

### Model choice and resume

The shared [`pi-task-models` config](https://pi.henry.wang/extensions/pi-task-models#config) is at `~/.pi/agent/config/pi-task-models/config.json`. It can explicitly override the local `pi-herdr-rename/rename` declaration, which defaults to `fast`.

The extension tries the assigned profile primary, then fallback, while honoring the configured thinking level. It never substitutes the current session model. A missing shared task-model config warns once at session start; run `/task-models` to configure rename routing. No viable route leaves titles unchanged.

Resuming a session created by this version reapplies the saved display title and semantic branch without another model request. Herdr and Git synchronization failures appear as warnings. Cancellation by a newer rename remains silent.

Older titles receive no migration.
