# `@henryqw/pi-cron`

Run scheduled prompts in fresh Pi sessions while any Pi session with this extension is open. Each job selects its Role, model, and thinking level. Open saved run sessions to inspect results.

## Install

```bash
pi install npm:@henryqw/pi-task-models
pi install npm:@henryqw/pi-subagent
pi install npm:@henryqw/pi-cron
```

Configure the job profiles in `/task-models`. Add a job to the config file below. Run `/cron` to check its next slot.

## Works with

| Package | Relationship | Purpose |
| --- | --- | --- |
| [`@henryqw/pi-subagent`](https://pi.henry.wang/extensions/pi-subagent) | Required | Provides Roles and runs each job with bounded limits. |
| [`@henryqw/pi-task-models`](https://pi.henry.wang/extensions/pi-task-models) | Required | Resolves `modelClass` and explicit model routes. |

## Use

Keep Pi open for the job's next slot, or use `/cron run <job-id>` for an immediate run.

| Surface | Type | Purpose |
| --- | --- | --- |
| `/cron` | command | For users: list jobs, next runs, and last outcomes. In the TUI, run, enable, disable, or show the last result. Otherwise, only list jobs. |
| `/cron run <job-id>` | command | For users: start a job immediately, with the same delivery as scheduled runs. |

Each job runs its prompt as one task in a new Pi process at `cwd`. As with `delegate_task`, its Role selects tools, extensions, Skills, and MCP servers. Any configured Role can run, including one with write access. Limit the prompt and Role tools to the task's needs.

The run inherits the current session environment plus `env`. Open its saved run session with `pi --session <file>`.

## Flow

![An open Pi session runs due jobs with limits and delivers their results.](./docs/cron-flow.svg)

The extension checks jobs at session start and every minute. First sighting sets the anchor; a new job waits for its next slot. Missed slots produce one catch-up run, not a backlog. Open Pi sessions do not run the same job concurrently.

The extension saves the outcome, bounded output summary, and available session path before delivery.

| `notify` value | Delivery |
| --- | --- |
| `notify` | One-line notice with an active session UI. |
| `followUp` | Sends output, including failures, to the current conversation and starts a turn. A synchronous delivery error shows a UI recovery notice; otherwise, no notice. |
| `none` | Silent on success. Failures show only with an active session UI. |

## Config

Package-owned: `~/.pi/agent/config/pi-cron/config.json`

```json
{
  "jobs": [
    {
      "id": "digest",
      "at": "07:30",
      "timezone": "Asia/Hong_Kong",
      "role": "digest",
      "modelClass": "balanced",
      "cwd": "/Users/me/.config/miniflux",
      "promptFile": "/Users/me/.config/miniflux/digest.md"
    }
  ]
}
```

| Name | Description | Values | Default |
| --- | --- | --- | --- |
| `jobs` | Scheduled jobs. | Array of job objects with unique `id`. | No jobs. |
| `jobs[].id` | Job name used in `/cron` and state. | Lowercase letters, digits, and hyphens, up to 64 characters. | — |
| `jobs[].every` | Interval schedule. Exactly one of `every` or `at` is required. | `<n>m`, `<n>h`, or `<n>d` between `1m` and `7d`. | — |
| `jobs[].at` | Daily wall-clock schedule. | `HH:MM` in 24-hour time. | — |
| `jobs[].timezone` | Zone for `at`. Only valid with `at`. | IANA name such as `Asia/Hong_Kong`. | The system time zone. |
| `jobs[].role` | pi-subagent Role to run. | Name of a built-in or user Role. | — |
| `jobs[].modelClass` | Shared task-models profile. Not allowed with `model`. | `fast`, `balanced`, `frontier`, or `fav`. | The Role's `modelClass`, else the `pi-cron/job` task assignment (`fast`). |
| `jobs[].model` | Explicit model. Requires `thinking`. | `provider/model` available in the current session. | — |
| `jobs[].thinking` | Thinking level for `model`. | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. | — |
| `jobs[].cwd` | Working directory of the run. | Absolute path. | — |
| `jobs[].env` | Extra environment variables for the run. | Object of variable name to string. | No extra variables. |
| `jobs[].prompt` | Inline task text. Exactly one of `prompt` or `promptFile` is required. | Non-empty text. | — |
| `jobs[].promptFile` | File whose contents are the task. Read at each run. | Absolute path to a UTF-8 file up to 256 KiB. | — |
| `jobs[].enabled` | Whether the scheduler considers the job. | `true` or `false`. | `true` |
| `jobs[].notify` | How a result reaches you. | `notify`, `followUp`, or `none`. | `notify` |
| `limits.maxTurns` | Provider-turn limit per run. | Safe integer ≥ 1. | `50` |
| `limits.idleMinutes` | Minutes without child activity before the run is stopped. | Positive number; converted milliseconds must be ≤ 2,147,483,647. | `10` |
| `limits.maxMinutes` | Hard runtime cap per run. | Greater than `idleMinutes`; converted milliseconds must be ≤ 2,147,483,647. | `30` |

Edit this file yourself; only `/cron` Enable or Disable changes a job's `enabled` flag. The scheduler rereads config before each run, so edits, disablement, and removal apply without restart. New jobs wait for the next check. Active jobs keep their original definition and limits.

Invalid jobs are ignored without stopping other jobs. Problems include unknown keys, both or neither schedule, unknown time zones, relative paths, invalid routes, and repeated IDs.

Unknown top-level or `limits` keys warn and are ignored. Invalid limits use defaults. If effective `maxMinutes` is not greater than `idleMinutes`, all limits use defaults. Malformed JSON stops all jobs until you fix it.

Warnings include the path and reasons, once per session, with stderr delivery without a UI. The extension never rewrites files for recovery. Enable and Disable cannot write while the file has problems.

Do not store secrets here. Use `env` to point to a private file, or export secrets in the shell that starts Pi.

## State and storage

`~/.pi/agent/config/pi-cron/state.json` stores first sighting, last start, outcome, bounded output summary, session path, and active run state. Deleting it resets anchors; jobs wait for their next slots.

Invalid version 1 state, including malformed job records or run claims, stays unchanged with an error. Repeated state or scheduling errors show once until scheduling succeeds. Writes above 1 MiB fail without replacing readable state. To make space, close Pi and remove inactive job records. Stale runs cannot overwrite replacement outcomes.

`~/.pi/agent/config/pi-cron/sessions/<job-id>/<timestamp>.jsonl` contains each run's prompt and model output. Delete unneeded session files.

## Limits and recovery

There is no background daemon. Each Pi session runs one job at a time. If busy, `/cron run` does not queue; scheduled jobs wait for a later check.

Runs cannot answer questions or approval prompts. Interactive confirmation blocks a Role until idle timeout. Failed or timed-out runs record `failure` with error text. Open the run session if available; pre-launch failures show `Session: none created`. Retry with `/cron run <job-id>`.

Other sessions cannot restart an unfinished job until its original `limits.maxMinutes` plus five minutes have elapsed from its start. Lowering limits does not shorten that wait.

Shutdown aborts preparation and the active child, even if another session starts in the same process. Results still save, but delivery stops. After shutdown or a synchronous delivery error, recover results with `/cron` → Show last run.
