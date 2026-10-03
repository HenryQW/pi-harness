# Pi Cron Context

## Purpose

Run user-authored job prompts on a schedule in fresh Pi sessions while any Pi session with the extension is open, using pi-subagent Roles and pi-task-models routes.

## Domain glossary

- **Job**: one config entry naming a schedule, a Role, a route, a working directory, environment variables, and a prompt. Jobs are authored only by the user.
- **Slot**: one scheduled occurrence; an interval after the anchor for `every`, or a wall-clock time in a zone for `at`.
- **Anchor**: the later of a job's first sighting and its last start. A new job waits for its next slot, and a missed slot yields one catch-up run.
- **Run claim**: ownership of a job's current run, preventing concurrent Pi sessions from firing the same slot twice. Its expiration deadline is fixed from the runtime limit at admission plus a margin; later limit changes cannot shorten it.
- **Run session**: the persisted Pi session file of one run, stored under the extension home.
- **Delivery**: how a finished run reaches the user: a notice, a follow-up message that starts a turn, or nothing for successes.

## Invariants

- Scheduling lives in the Pi process: the tick starts on `session_start` and stops on `session_shutdown`. No daemon.
- Config is read every tick and never rewritten except an explicit Enable or Disable choice in `/cron`, which changes only that job's `enabled` flag.
- Invalid config pauses all jobs with one visible error and preserves the file.
- The Role bounds capability. Direct read-only admission is not applied because job entries are user-authored.
- Route precedence: job `model` and `thinking`, then job `modelClass`, then the Role default, then the `pi-cron/job` Model Task assignment (default `fast`).
- Local admission precedes shared claiming: busy manual requests do not queue; scheduled jobs are reconsidered later. Each run captures its original session's abort signal before asynchronous preparation.
- State validates all nested records, skips no-op writes, and refuses replacements above its 1 MiB read limit. Only matching owner/start identities can finish a claim or deliver a result.
- Every run replaces the Role launch's `--no-session` with `--session <run session>`; the child runs through pi-subagent's bounded ephemeral executor with this extension's `limits`.
- Failures surface while a session UI is active; `none` silences only successes. Delivery failure does not change a run's outcome, and shutdown suppresses delivery without discarding the result.

## Owned storage

- Config: `<agent-dir>/config/pi-cron/config.json`
- State: `<agent-dir>/config/pi-cron/state.json` (version 1, strict)
- Run sessions: `<agent-dir>/config/pi-cron/sessions/<job-id>/<timestamp>.jsonl`; recorded only when a file was created. Pre-launch failures have no session path.
