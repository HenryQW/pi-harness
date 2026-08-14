# `@henryqw/pi-herdr-rename`

Pi extension that gives conversations semantic model-generated titles. It stores each title as Pi session name and renames current Herdr pane. In a linked worktree, it creates a semantic Git branch for detached or Herdr-generated branches, then uses that branch for a generated workspace label; enclosing Herdr tab is renamed only when pane is tab's sole pane.

## Install

```bash
pi install npm:@henryqw/pi-herdr-rename
```

Remove with:

```bash
pi remove npm:@henryqw/pi-herdr-rename
```

## Behavior

- On the first real, non-empty text prompt in a new session, title generation starts in the background and does not delay the main Pi response. Extension-injected prompts, empty prompts, and image-only input are ignored.
- Successful titles use `type: subject`, lowercase words, and by default at most four words and 40 characters. For example, `fix: extension name` maps to Git branch `fix/extension-name`. First 1,000 characters of user text go to rename model; prompt content is never logged.
- A successful title updates Pi session name and current Herdr pane. In a linked worktree, a detached checkout gets `git switch -c <generated-branch>`; a Herdr-generated `worktree/...` branch gets renamed. Conflicting local refs add numeric suffix such as `-2`. Existing non-generated branch remains unchanged. If workspace label still matches generated default pattern such as `worktree-brave-meadow-4aa8`, it is renamed to semantic branch; custom workspace names stay unchanged. Enclosing Herdr tab updates only when current tab has one pane. Outside Herdr, only Pi session name changes.
- Resuming a named session reapplies saved title without another rename-model request. Automatic rename-model errors show a warning; other automatic failures stay quiet. Failures do not change labels, fall back locally, or retry.

## Manual rename

Run `/rename` to generate a semantic title from up to three most recent user/assistant rounds. It uses text only, caps each message at 1,000 characters and complete context at 4,000 characters, and applies same Pi, Git, and Herdr rules. Animated widget shows `renaming...`, briefly changes to `renamed to <title>`, then disappears. Command warns without changing anything when no user text exists or generation fails. If title-generation requests overlap, latest title request wins.

## Rename model

Run `/rename-model` to choose the model from Pi's available authenticated text models. Until a valid selection is saved, every session start prompts you to run the command and title generation remains disabled.

The selection is saved in:

`getAgentDir()/config/pi-herdr-rename.json` (normally `~/.pi/agent/config/pi-herdr-rename.json`)

```json
{
  "model": "provider/model",
  "maxWords": 4,
  "maxChars": 40
}
```

`maxWords` must be at least 2 and `maxChars` at least 6; defaults are 4 and 40. Invalid limits use defaults. Missing, malformed, or unavailable model selection never falls back to another model.

## Development

```bash
npm test
npm run typecheck
npm run pack:check
```
