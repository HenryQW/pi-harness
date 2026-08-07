# `@henryqw/pi-auto-compact`

Pi extension that compacts context before it reaches 50% of current model context, then resumes current task.

## Install

```bash
pi install npm:@henryqw/pi-auto-compact
```

Restart Pi after installation. Remove with:

```bash
pi remove npm:@henryqw/pi-auto-compact
```

## Behavior

- Checks `turn_start`, tool-call `turn_end`, `context`, and resumed/forked `session_start`.
- Uses Pi's default `ctx.compact()` summary and session persistence.
- Keeps newest 15% as temporary emergency context while compaction runs.
- Sends a follow-up message after compaction so task execution continues.
- Uses fixed 50% threshold; no configuration needed.

`ctx.compact()` aborts current low-level run. Extension starts new run after compaction with the current task resume message.

## Development

```bash
npm test
npm run pack:check
npm run test:live
```

`test:live` uses real Pi plus authenticated model access. It sets a temporary 12K context window, sends a large prompt, and verifies compaction, automatic resume, persisted resume message, and assistant response. Set `PI_AUTO_COMPACT_AUTH_FILE` when auth is not at `~/.pi/agent/auth.json`.
