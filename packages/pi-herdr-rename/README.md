# `@henryqw/pi-herdr-rename`

Pi extension that gives conversations semantic model-generated titles. It stores each title as Pi session name and renames current Herdr pane. In a linked worktree, it creates a semantic Git branch for detached or Herdr-generated branches, then uses that branch for a generated workspace label; enclosing Herdr tab is renamed only when pane is tab's sole pane. Requires Pi Coding Agent 0.84.2+.

## Install

```bash
pi install npm:@henryqw/pi-task-models
pi install npm:@henryqw/pi-herdr-rename
```

`pi-task-models` loads `/task-models`, which configures the shared model profiles used for title generation.

Remove with:

```bash
pi remove npm:@henryqw/pi-herdr-rename
```

## Behavior

- On the first real, non-empty text prompt in a new session, title generation starts in the background and does not delay the main Pi response. Extension-injected prompts, empty prompts, and image-only input are ignored.
- Successful titles use `type: subject`, lowercase words, and by default at most four words and 40 characters. For example, `fix: extension name` maps to Git branch `fix/extension-name`. First 1,000 characters of user text go to rename model; prompt content is never logged.
- A successful title updates Pi session name and current Herdr pane. In a linked worktree, a detached checkout gets `git switch -c <generated-branch>`; a Herdr-generated `worktree/...` branch gets renamed. Conflicting local refs add numeric suffix such as `-2`. Existing non-generated branch remains unchanged. If workspace label still matches generated default pattern such as `worktree-brave-meadow-4aa8`, it is renamed to semantic branch; custom workspace names stay unchanged. Enclosing Herdr tab updates only when current tab has one pane. Outside Herdr, only Pi session name changes.
- Title generation uses the `pi-herdr-rename/rename` task assignment, which defaults to the `fast` profile. It tries the profile primary route, then its configured fallback when the first route is outside current model scope, unavailable, cannot authenticate, or its request fails. Scoped thinking pins are enforced. It never substitutes the current session model; if no route succeeds, labels stay unchanged and the failure is reported.
- Resuming a named session reapplies the saved title without another model request. A final automatic task-model error shows a warning; other automatic failures stay quiet. Failures do not change labels or retry.

## Manual rename

Run `/rename` to generate a semantic title from up to three most recent user/assistant rounds. It uses text only, caps each message at 1,000 characters and complete context at 2,000 characters, and applies same Pi, Git, and Herdr rules. Animated widget shows `renaming...`, briefly changes to `renamed to <title>`, then disappears. Command warns without changing anything when no user text exists or generation fails. If title-generation requests overlap, latest title request wins.

## Task model profile

Run `/task-models` to configure the `fast` profile's primary route and optional fallback, or assign rename to another shared profile. Until its assigned profile has a viable text route, rename reports the configuration failure and makes no title change. Malformed shared task-model config is reported, left unchanged, and never changes a title.

## Rename limits

Limits live in `getAgentDir()/config/pi-herdr-rename.json` (normally `~/.pi/agent/config/pi-herdr-rename.json`):

```json
{
  "maxWords": 4,
  "maxChars": 40
}
```

`maxWords` must be at least 2 and `maxChars` at least 6; defaults are 4 and 40. Invalid limits use defaults. Model routes and thinking levels belong in `~/.pi/agent/config/pi-task-models.json`.

## Development

```bash
npm test
npm run typecheck
npm run pack:check
```
