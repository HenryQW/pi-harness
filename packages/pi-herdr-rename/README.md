# `@henryqw/pi-herdr-rename`

Give each conversation a short semantic title: Pi session name, current Herdr pane, and a Git branch when the checkout is still generated.

## Install

```bash
pi install npm:@henryqw/pi-task-models
pi install npm:@henryqw/pi-herdr-rename
```

`pi-task-models` provides `/task-models` for the rename routes. Requires Pi Coding Agent 0.84.2+.

## Use

| Surface | Purpose |
| --- | --- |
| first real user prompt | Generate a title in the background. Does not delay the main reply. |
| `/rename` | Generate a title from up to three recent user/assistant rounds. |
| `/task-models` | Configure the `pi-herdr-rename/rename` profile (default `fast`). |

Successful titles use `type: subject`, lowercase words, and by default at most four words and 40 characters. Example: `fix: extension name` → Git branch `fix/extension-name`.

In a linked worktree, a detached checkout or Herdr `worktree/...` branch is renamed; an existing non-generated branch stays. A generated workspace label such as `worktree-brave-meadow-4aa8` becomes the semantic branch; custom workspace names stay. The enclosing Herdr tab updates only when this pane is the tab's only pane. Outside Herdr, only the Pi session name changes.

Tries the assigned profile primary, then fallback. Never substitutes the current session model. No viable route leaves titles unchanged. Resuming a named session reapplies the saved title without another model request.

## Config

`~/.pi/agent/config/pi-herdr-rename.json`

```json
{
  "maxWords": 4,
  "maxChars": 40
}
```

`maxWords` must be at least 2 and `maxChars` at least 6; defaults are 4 and 40. Invalid limits use defaults. Model routes live in `~/.pi/agent/config/pi-task-models.json`. Malformed shared task-model config is reported, left unchanged, and never changes a title.

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
