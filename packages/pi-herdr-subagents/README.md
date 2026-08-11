# `@henryqw/pi-herdr-subagents`

Delegate bounded work from Pi Main to one interactive Pi Subagent in one Herdr tab.

## Install

```bash
pi install npm:@henryqw/pi-herdr-subagents
```

Run Pi inside Herdr. `delegate_task({ task, modelClass? })` creates one no-focus tab and fresh Subagent context. Main chooses `fast`, `balanced`, or `frontier` from task complexity; Subagent uses configured model and thinking level, plus Main cwd and trust. Omitted `modelClass` uses configured `balanced`, falling back to Main model and thinking level for compatibility. Give Subagent self-contained task with relevant context, exact paths, constraints, and success criteria.

Subagent may ask user questions in its own tab. It stays live until it calls `finish_task({ result })`. Main receives Completion Notice with Result path; read and verify Result before relying on it.

## Configure

Run `/subagent-model`, select `fast`, `balanced`, or `frontier`, select from Pi's authenticated text-model list, then select one thinking level supported by that model. Run command once per model class; package keeps no model catalog.

Subagent Limit defaults to 10 per Main session. Run `/subagent-limit` to set positive integer limit. Both commands write `~/.pi/agent/config/pi-herdr-subagents.json`:

```json
{
  "maxConcurrentSubagents": 10,
  "models": {
    "fast": { "model": "provider/fast-model", "thinkingLevel": "off" },
    "balanced": { "model": "provider/balanced-model", "thinkingLevel": "medium" },
    "frontier": { "model": "provider/frontier-model", "thinkingLevel": "max" }
  }
}
```

Explicit model classes must be configured; configured model and thinking level must remain available. Lower limit does not stop live Subagents. New delegation rejects at limit; package never queues work.

## Behavior

- Herdr is required. One Main owns only Subagents it starts in current session.
- Main chooses Subagent Model Class from task complexity: `fast` for simple work, `balanced` for normal work, `frontier` for complex work.
- Subagent starts with configured class model and thinking level, `read`, `bash`, `edit`, `write`, and internal `finish_task`; discovered extensions stay disabled.
- Result files live in system temp storage. Completed files are mode `0600`; package leaves them for OS cleanup.
- Completion Notices are versioned and validated against tracked Result file. Bad, stale, spoofed, or duplicate framing remains ordinary input.
- Main shutdown closes owned Subagent tabs best-effort. Main crashes leave tabs and pending Results for manual inspection.
- No queue, timeout, cancellation Result, status tool, transcript sharing, orphan adoption, or automatic retry exists.

Main must not delegate overlapping write work. Result is Subagent evidence, not Main verification.

## Development

```bash
npm test --workspace @henryqw/pi-herdr-subagents
npm run typecheck --workspace @henryqw/pi-herdr-subagents
npm run pack:check --workspace @henryqw/pi-herdr-subagents
```
