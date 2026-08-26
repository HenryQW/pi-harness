# `@henryqw/pi-herdr-rename`

Give each conversation one short human title across Pi and Herdr while keeping semantic naming for Git branches.

## Why

- **Created for**: Replacing generated labels like `worktree-brave-meadow-4aa8` with human-readable display titles for every conversation.
- **Advantage**: Titles stay natural (≤4 words), map to semantic Git branch names, and are reapplied on resume without another model request.

## Install

```bash
pi install npm:@henryqw/pi-task-models
pi install npm:@henryqw/pi-herdr-rename
```

Requires Pi Coding Agent 0.84.3+.

## With

| Package | Why |
| --- | --- |
| `@henryqw/pi-task-models` | Required. Shared model profiles for title generation. |

## Use

| Surface | Type | Purpose |
| --- | --- | --- |
| `/rename` | command | Generate a display title and semantic branch from up to three recent user/assistant rounds. |

First real user prompt generates a title in the background after Pi expands skill and prompt-template shorthand. It does not delay main reply. Extension-injected prompts, empty prompts, and image-only input are ignored.

Display titles are natural task phrases, preferably three or four words and always at most four words and 20 characters. Model classification stays internal: `refactor: update task logic` displays as `Update task logic` and maps to Git branch `refactor/update-task-logic`.

In a linked worktree, a detached checkout or Herdr `worktree/...` branch is renamed; an existing non-generated branch stays. A generated workspace label such as `worktree-brave-meadow-4aa8` becomes display title; custom workspace names stay. Enclosing Herdr tab updates only when this pane is tab's only pane. Outside Herdr, only Pi session name changes.

Tries assigned profile primary, then fallback, while honoring configured thinking level. Never substitutes current session model. No viable route leaves titles unchanged. Resuming a session created by this version reapplies saved display title and semantic branch without another model request. Older titles receive no migration.

## Config

This package has no package-owned user-editable config. Saved titles in Pi sessions are internal state, not configuration.

| Package-owned file | Required | Fields | Possible values | Default |
| --- | --- | --- | --- | --- |
| — | No | — | — | Built-in behavior |

### Shared task-model config

Model routing uses this companion-owned config, not config owned by `@henryqw/pi-herdr-rename`: `~/.pi/agent/config/pi-task-models.json`.

| Field | Required | Possible values | Default |
| --- | --- | --- | --- |
| `profiles.<selected>.primary.model` | Yes, to generate titles | An available Pi model as `provider/model` | None |
| `profiles.<selected>.primary.thinkingLevel` | Yes, to generate titles | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max` | None |
| `profiles.<selected>.fallback` | No | A `model` and `thinkingLevel` route with the values above; not allowed for `fav` | None |
| `tasks["pi-herdr-rename/rename"]` | No | `fast`, `balanced`, `frontier`, or `fav` | `fast` |

Configure the shared file with `/task-models`; malformed shared config fails visibly and remains unchanged.

## Remove

```bash
pi remove npm:@henryqw/pi-herdr-rename
```

## Development

```bash
npm test --workspace @henryqw/pi-herdr-rename
npm run typecheck --workspace @henryqw/pi-herdr-rename
npm run pack:check --workspace @henryqw/pi-herdr-rename
```
