# `@henryqw/pi-herdr-rename`

Give each conversation one short human title across Pi and Herdr. Use meaningful Git branch names too.

## Why

- **Created for**: Replace generated labels like `worktree-brave-meadow-4aa8` with human-readable display titles for every conversation.
- **Advantage**: Titles stay natural (≤4 words), map to semantic Git branch names, and reapply on resume without another model request.

## Install

```bash
pi install npm:@henryqw/pi-task-models
pi install npm:@henryqw/pi-herdr-rename
```

## With

`@henryqw/pi-task-models` is required for shared title-generation model profiles.

## Use

Use `/rename` to generate a display title and semantic branch from up to three recent user/assistant rounds.

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

The shared [`pi-task-models` config](../pi-task-models#config) is at `~/.pi/agent/config/pi-task-models/config.json`. It can explicitly override the local `pi-herdr-rename/rename` declaration, which defaults to `fast`.

The extension tries the assigned profile primary, then fallback, while honoring the configured thinking level. It never substitutes the current session model. A missing shared task-model config warns once at session start; run `/task-models` to configure rename routing. No viable route leaves titles unchanged.

Resuming a session created by this version reapplies the saved display title and semantic branch without another model request. Herdr and Git synchronization failures appear as warnings. Cancellation by a newer rename remains silent.

Older titles receive no migration.
