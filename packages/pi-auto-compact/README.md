# `@henryqw/pi-auto-compact`

Pi extension that compacts context before it reaches 50% of current model context, then resumes current task. Requires Pi Coding Agent 0.80.7+.

## Install

```bash
pi install npm:@henryqw/pi-auto-compact
```

Disable Pi's built-in auto-compaction in `~/.pi/agent/settings.json`:

```json
{
  "compaction": {
    "enabled": false
  }
}
```

Restart Pi after installation or settings changes. Trusted project settings in `.pi/settings.json` must not override `compaction.enabled` back to `true`. Manual `/compact` remains available.

Remove with:

```bash
pi remove npm:@henryqw/pi-auto-compact
```

## Configure

Run `/auto-compact`, then enter threshold percentage. Config lives in `~/.pi/agent/config/pi-auto-compact.json`:

```json
{
  "autoCompactThreshold": 50,
  "compactionModel": "openai-codex/gpt-5.6-terra"
}
```

`compactionModel` is optional and must name Pi-known `provider/model`; omit it to compact with current session model. Threshold must be at least 25% and below 100%; lower values are not meaningful. Missing config defaults to 50%. Restart or `/reload` after manual edits; command changes apply immediately.

## Behavior

- Refuses activation with an error when Pi's effective `compaction.enabled` setting is not `false`; competing automatic compactors can start duplicate summaries.
- Checks `turn_start`, tool-call `turn_end`, `agent_end`, `context`, and resumed/forked `session_start`.
- Uses Pi's native summary and session persistence; optional `compactionModel` runs automatic summaries with selected model. Manual `/compact` keeps using current session model.
- Falls back to current session model when configured compaction model is unavailable, cannot authenticate, or fails.
- Keeps newest 15% as temporary emergency context while compaction runs.
- Sends a follow-up message after mid-task compaction so task execution continues; final-answer compaction stays idle.
- Compacts above configured `autoCompactThreshold` percentage (50% by default).

`ctx.compact()` aborts current low-level run. Extension hides that empty internal abort message, then starts new run with current task resume message. Other aborts and provider errors remain visible.

## Development

```bash
npm test
npm run pack:check
npm run test:live
```

`test:live` uses real Pi plus authenticated model access. It disables Pi's built-in auto-compaction, sets a temporary 12K context window, sends a large prompt, and verifies extension compaction, automatic resume, persisted resume message, and assistant response. Set `PI_AUTO_COMPACT_AUTH_FILE` when auth is not at `~/.pi/agent/auth.json`.
