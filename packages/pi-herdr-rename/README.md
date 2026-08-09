# `@henryqw/pi-herdr-rename`

Pi extension that gives conversations short, model-generated chat titles. It stores the title as the Pi session name and renames the current Herdr pane; the enclosing Herdr tab is renamed only when that pane is the tab's sole pane.

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
- Successful titles are lowercase and, by default, at most four words and 40 characters. The first 1,000 characters of user text are sent to the rename model; prompt content is never logged.
- A successful title updates the Pi session name and current Herdr pane. The enclosing Herdr tab is updated only when the current tab has one pane. Outside Herdr, only the Pi session name changes.
- Resuming a named session reapplies its saved title without another rename-model request. Automatic rename-model errors show a warning; other automatic failures stay quiet. Failures do not change labels, fall back locally, or retry.

## Manual rename

Run `/rename` to generate a title from up to the three most recent user/assistant rounds. It uses text only, caps each message at 1,000 characters and the complete context at 4,000 characters, and applies the same Pi and Herdr rules. An animated widget shows `renaming...`, briefly changes to `renamed to <title>`, then disappears. The command warns without changing anything when no user text exists or generation fails. If requests overlap, the latest rename request wins.

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

`maxWords` and `maxChars` accept positive integers and default to 4 and 40. Invalid limits use their defaults. Missing, malformed, or unavailable model selection never falls back to another model.

## Development

```bash
npm test
npm run typecheck
npm run pack:check
```
