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
- Successful titles are lowercase, at most five words, and at most 60 characters. The first 1,000 characters of user text are sent to the rename model; prompt content is never logged.
- A successful title updates the Pi session name and current Herdr pane. The enclosing Herdr tab is updated only when the current tab has one pane. Outside Herdr, only the Pi session name changes.
- Resuming a named session reapplies its saved title without another rename-model request. Automatic failures stay quiet and do not change labels; there is no local fallback or retry.

## Manual rename

Run `/rename` to generate a title from up to the three most recent user/assistant rounds. It uses text only, caps each message at 1,000 characters and the complete context at 4,000 characters, and applies the same Pi and Herdr rules. The command warns without changing anything when no user text exists or generation fails. If requests overlap, the latest rename request wins.

## Rename model

Run `/rename-model` to choose an available authenticated text model with Pi's native selector. The default is `openai-codex/gpt-5.6-luna`.

The selection is saved in:

`getAgentDir()/config/pi-herdr-rename.json` (normally `~/.pi/agent/config/pi-herdr-rename.json`)

```json
{
  "model": "provider/model"
}
```

Missing or malformed configuration uses the default. An unavailable configured model is not silently replaced; run `/rename-model` to choose another model.

## Development

```bash
npm test
npm run typecheck
npm run pack:check
```
