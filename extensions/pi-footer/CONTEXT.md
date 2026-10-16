# Pi Footer

Pi Footer shows checkout identity, model usage, work time, and extension status. It also supplies the independently selectable open command.

## Language

**Footer identity**:
The repository and branch label for the current checkout, with local Git conditions that need attention. PR status is separate information beside this identity.
_Avoid_: Checkout identity, working-directory path, clean badge

**Usage line**:
The session's token and cost totals, latest cache-hit rate, response throughput, and current context use, beside the selected model and thinking level. Totals include reported tool usage and completed subagent background work.
_Avoid_: Token counter, status line

**Response throughput**:
Output tokens per second measured from the first streamed content to the last for the latest assistant response. It excludes request latency and work after streaming ends.

**Agent-work time**:
Cumulative time spent in agent runs, including automatic retries and auto-compaction. User-prompt waits, idle time between runs, and standalone manual compaction are excluded.
_Avoid_: Session age, response duration, session time

**Family status**:
The active Codex account's quota status, reserved for the right side of the first footer line.
_Avoid_: External extension status, plugin summary

**External status line**:
The third-line area for CodeGraph and other extension statuses not assigned to the PR or quota positions. It includes both first-party and external extensions.
_Avoid_: rewritten status

**Footer color role**:
A named part of footer-owned text whose color the user can select. It does not control external status colors or the thinking-level gradient.

**Open command**:
The user-selected application command for opening the Pi session's current working directory.
_Avoid_: editor command, project opener

**Open URI**:
An editor link for the current working directory when the open command supports the VS Code URI scheme. An arbitrary shell command is not an Open URI.
_Avoid_: command link, shell URI
