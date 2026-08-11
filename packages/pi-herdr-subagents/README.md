# `@henryqw/pi-herdr-subagents`

Delegate bounded work from Pi Main to one interactive Pi Worker in one Herdr tab.

## Install

```bash
pi install npm:@henryqw/pi-herdr-subagents
```

Run Pi inside Herdr. `delegate_task({ task })` creates one no-focus tab, starts fresh Worker context with Main model, thinking level, cwd, and trust, then returns Worker name, tab ID, Result path, and `herdr tab close` command. Give Worker self-contained task with relevant context, exact paths, constraints, and success criteria.

Worker may ask user questions in its own tab. It stays live until it calls `finish_task({ result })`. Main receives Completion Notice with Result path; read and verify Result before relying on it.

## Configure

Worker Limit defaults to 10 per Main session. Run `/subagent-limit` to set positive integer limit. Config lives at `~/.pi/agent/config/pi-herdr-subagents.json`:

```json
{
  "maxConcurrentWorkers": 10
}
```

Lower limit does not stop live Workers. New delegation rejects at limit; package never queues work.

## Behavior

- Herdr is required. One Main owns only Workers it starts in current session.
- Worker starts with `read`, `bash`, `edit`, `write`, and internal `finish_task`; discovered extensions stay disabled.
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
