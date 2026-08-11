# `@henryqw/pi-herdr-subagents`

Delegate bounded work from Pi Main to one interactive Pi Worker in one Herdr tab.

## Install

```bash
pi install npm:@henryqw/pi-herdr-subagents
```

Run Pi inside Herdr. `delegate_task({ task, modelClass? })` creates one no-focus tab and fresh Worker context. Main chooses `fast`, `balanced`, or `frontier` from task complexity; Worker uses configured model plus Main thinking level, cwd, and trust. Omitted `modelClass` uses configured `balanced` model, falling back to Main model for compatibility. Give Worker self-contained task with relevant context, exact paths, constraints, and success criteria.

Worker may ask user questions in its own tab. It stays live until it calls `finish_task({ result })`. Main receives Completion Notice with Result path; read and verify Result before relying on it.

## Configure

Run `/subagent-model`, select `fast`, `balanced`, or `frontier`, then select from Pi's authenticated text-model list. Run command once per model class; package keeps no model catalog.

Worker Limit defaults to 10 per Main session. Run `/subagent-limit` to set positive integer limit. Both commands write `~/.pi/agent/config/pi-herdr-subagents.json`:

```json
{
  "maxConcurrentWorkers": 10,
  "models": {
    "fast": "provider/fast-model",
    "balanced": "provider/balanced-model",
    "frontier": "provider/frontier-model"
  }
}
```

Explicit model classes must be configured and available. Lower limit does not stop live Workers. New delegation rejects at limit; package never queues work.

## Behavior

- Herdr is required. One Main owns only Workers it starts in current session.
- Main chooses Worker Model Class from task complexity: `fast` for simple work, `balanced` for normal work, `frontier` for complex work.
- Worker starts with configured class model, `read`, `bash`, `edit`, `write`, and internal `finish_task`; discovered extensions stay disabled.
- Result files live in system temp storage. Completed files are mode `0600`; package leaves them for OS cleanup.
- Completion Notices are versioned and validated against tracked Result file. Bad, stale, spoofed, or duplicate framing remains ordinary input.
- Main shutdown closes owned Worker tabs best-effort. Main crashes leave tabs and pending Results for manual inspection.
- No queue, timeout, cancellation Result, status tool, transcript sharing, orphan adoption, or automatic retry exists.

Main must not delegate overlapping write work. Result is Worker evidence, not Main verification.

## Development

```bash
npm test --workspace @henryqw/pi-herdr-subagents
npm run typecheck --workspace @henryqw/pi-herdr-subagents
npm run pack:check --workspace @henryqw/pi-herdr-subagents
```
