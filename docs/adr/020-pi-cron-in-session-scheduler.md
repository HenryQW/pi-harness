# 020. pi-cron In-Session Scheduler

- **Status:** accepted
- **Date:** 2026-10-03

## Context

Recurring agent work, such as a daily reading digest, needs a schedule, a fresh bounded Pi session per run, per-job model and thinking choices, and a record of each run. The repository already owns Role resolution, launch policy, and a bounded child executor in `@henryqw/pi-subagent`, and shared model routes in `@henryqw/pi-task-models`. A background daemon would add a second process lifecycle, credentials outside Pi, and a new recovery surface.

## Decision

`@henryqw/pi-cron` schedules jobs inside the Pi process. The tick starts on `session_start`, stops on `session_shutdown`, and jobs fire only while some Pi session with the extension is open. A run claim in shared state, taken under a file lock before launch, prevents concurrent Pi sessions from firing the same slot. A new job waits for its next slot and a missed slot produces one catch-up run.

Each run launches a new Pi process through pi-subagent's ephemeral executor with the job's Role, route, working directory, and environment, and persists the session under the extension home. The job entry is user-authored, so any configured Role is allowed; the Role's declared resources remain the capability bound. The job itself stays agent work driven by a prompt file, Role, and Skills; pi-cron contains no job-specific code.

Route precedence is job model and thinking, then job model class, then Role default, then the `pi-cron/job` Model Task. Run limits are owned by pi-cron's own config, not pi-subagent's.

## Consequences

No background process, credential store, or daemon recovery is introduced; the trade-off is that nothing runs while Pi is closed. Job-specific pipelines live in user Skills and Roles outside the repository. A launchd or systemd wrapper around `pi -p` remains a possible later addition without changing the job contract.
