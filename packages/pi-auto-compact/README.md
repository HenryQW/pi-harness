# `@henryqw/pi-auto-compact`

Pi extension that compacts context before it reaches 50% of current model context, then resumes current task. Requires Pi Coding Agent 0.84.2+.

## Install

```bash
pi install npm:@henryqw/pi-task-models
pi install npm:@henryqw/pi-auto-compact
```

`pi-task-models` loads `/task-models`, which configures the shared model profiles used by automatic compaction.

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

Run `/auto-compact` to set the compaction threshold. Run `/task-models` to configure the shared primary and optional fallback routes. The `pi-auto-compact/autoCompact` task defaults to the `fast` profile.

Threshold config lives in `~/.pi/agent/config/pi-auto-compact.json`:

```json
{
  "autoCompactThreshold": 50
}
```

Threshold must be at least 25% and below 100%; lower values are not meaningful. Missing config defaults to 50%. Model routes belong in `~/.pi/agent/config/pi-task-models.json`; menu changes apply immediately.

## Behavior

- Refuses activation with an error when Pi's effective `compaction.enabled` setting is not `false`; competing automatic compactors can start duplicate summaries.
- Checks `turn_start`, tool-call `turn_end`, `agent_end`, `context`, and resumed/forked `session_start`.
- Uses the assigned task profile's primary route, then its configured fallback when a route is outside current model scope, unavailable, cannot authenticate, or its summary request fails. Scoped thinking pins are enforced. If neither route works, Pi's current session model still performs automatic compaction. Malformed shared task-model config is reported and left unchanged. Manual `/compact` always stays native.
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
