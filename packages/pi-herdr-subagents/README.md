# `@henryqw/pi-herdr-subagents`

Delegate bounded work from Pi Main to one interactive Pi Subagent in its own visible Herdr pane. Each task stays observable instead of hiding inside an opaque subagent session: inspect live work, answer questions, and see failures in its Herdr tab. Inspired by Codex Desktop's visible parallel-agent workflow.

## Install

```bash
pi install npm:@henryqw/pi-herdr-subagents
```

Run Pi inside Herdr. `delegate_task({ task, modelClass? })` creates one no-focus tab and fresh Subagent context. Main chooses `fast`, `balanced`, or `frontier` from task complexity; Subagent uses configured model and thinking level, plus Main cwd and trust. Omitted `modelClass` uses configured `balanced` while its route remains available, otherwise Main model and thinking level for compatibility. Give Subagent self-contained task with relevant context, exact paths, constraints, and success criteria.

Subagent may ask user questions in its own tab. It stays live until it calls `finish_task({ result })`. Main receives Completion Notice with Result path; read and verify Result before relying on it.

## Status widget

Pi TUI shows live Subagents above editor. Name is first task word:

```text
⠸ coder • 100k • gpt-5.6-sol • max • 1m 5s
✓ coder • 100k • gpt-5.6-sol • max • 1m 8s
! reviewer • 100k • gpt-5.6-terra • xhigh • 5m 27s
```

Spinner marks live work. Green `✓` marks completed Result. Red `!` marks terminal error or abort. Manually closing live tab removes its row within one second. Terminal tabs stay open for inspection and do not count against Subagent Limit. Run `/subagent-widget clear` to close terminal tabs and remove rows; failed tab close keeps row visible.

## Delegate efficiently

Classify every Delegated Task and pass the lowest `modelClass` likely to finish correctly in one attempt. Split independent work between Subagents, but keep tightly coupled steps together and never delegate overlapping writes. Keep prompts self-contained but token-efficient: include only relevant context, exact paths, constraints, and success criteria; request a concise Result.

| Model class | Use for | Examples |
| --- | --- | --- |
| `fast` | Low-ambiguity, narrow, mechanical, or read-only work | Find symbol references; summarize one file; apply a small repetitive edit |
| `balanced` | Normal engineering work with clear scope and several steps | Fix a bounded bug and test it; review a focused diff; implement a clear multi-file feature |
| `frontier` | High-ambiguity, high-risk, or system-wide reasoning | Diagnose a subtle concurrency bug; design a cross-package migration; analyze security-sensitive architecture |

Do not delegate tiny work when handoff costs more context than doing it in Main. Do not use `frontier` by default; failed cheap attempts also waste tokens, so route by actual complexity rather than price alone.

## Result format

For normal completion, package prompt requires `finish_task({ result })` once. `result` must be concise Markdown with exact headings; use `none` for empty sections:

```md
## Outcome
Added Result-format contract.

## Files
- `packages/pi-herdr-subagents/README.md`

## Validation
- `npm test --workspace @henryqw/pi-herdr-subagents`

## Risks
- None.
```

## Task recipes

Copy a shape, replace brackets, then route by actual complexity. Completion contract handles Result format; Main still reads and verifies Result.

| Role | Start class | Task shape |
| --- | --- | --- |
| Scout | `fast` | `Read-only scout [paths] for [question]. Do not edit. Return findings with exact paths/lines, relevant constraints, and risks.` |
| Plan | `balanced` | `Read-only plan [goal] in [paths]. Do not edit. Return ordered steps, expected files, validation commands, and assumptions.` |
| Review | `balanced` | `Read-only review [diff or paths] against [acceptance criteria]. Do not edit. Return only actionable findings with severity and exact path/line; say no findings when none.` |
| Implement | `balanced` | `Implement [goal] in [paths]. Do not change outside scope. Run [validation commands]. Return outcome and risks.` |

## Configure

Run `/subagent-model`, select `fast`, `balanced`, or `frontier`, select from Pi's authenticated text-model list, then select one thinking level supported by that model. Run command once per model class; package keeps no model or thinking-level catalog.

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

Explicit model classes must be configured and reject when configured model or thinking level becomes unavailable. Implicit `balanced` routing falls back to Main in either case. Lower limit does not stop live Subagents. New delegation rejects at limit; package never queues work.

## Why Herdr panes?

Subagents run as separate Pi processes in Herdr panes, not opaque in-process sessions. Herdr keeps each Delegated Task visible and interactive while Main tracks completion through its Result file. Main still verifies all claimed work.

## Behavior

- Herdr is required. One Main owns only Subagents it starts in current session.
- Main chooses Subagent Model Class from task complexity: `fast` for simple work, `balanced` for normal work, `frontier` for complex work.
- Subagent starts with configured class model and thinking level, `read`, `bash`, `edit`, `write`, and internal `finish_task`; discovered extensions stay disabled.
- Result files live in system temp storage. Completed files are mode `0600`; package leaves them for OS cleanup.
- Completion Notices are versioned and validated against tracked Result file. Bad, stale, spoofed, or duplicate framing remains ordinary input.
- Valid Completion Notice releases Subagent Limit capacity and leaves terminal tab open for inspection; `/subagent-widget clear` closes terminal tabs.
- Manually closing live Subagent tab removes its widget row and frees capacity within one second.
- Main shutdown closes owned Subagent tabs best-effort. Main crashes leave tabs and pending Results for manual inspection.
- No queue, timeout, cancellation Result, status tool, transcript sharing, orphan adoption, or automatic retry exists.

Main must not delegate overlapping write work. Result is Subagent evidence, not Main verification.

## Development

```bash
npm test --workspace @henryqw/pi-herdr-subagents
npm run typecheck --workspace @henryqw/pi-herdr-subagents
npm run pack:check --workspace @henryqw/pi-herdr-subagents
```
