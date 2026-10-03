# Pi Cron Context

## Purpose

Run user-authored job prompts on a schedule in fresh Pi sessions while any Pi session with the extension is open, using pi-subagent Roles and pi-task-models routes.

## Domain glossary

- **Job**: one config entry naming a schedule, a Role, a route, a working directory, environment variables, and a prompt. Jobs are authored only by the user.
- **Slot**: one scheduled occurrence; an interval after the anchor for `every`, or a wall-clock time in a zone for `at`.
- **Anchor**: the later of a job's first sighting and its last start. A new job waits for its next slot, and a missed slot yields one catch-up run.
- **Run claim**: the shared-state record that one Pi process owns a job's current run, written before launch so concurrent Pi sessions never fire the same slot twice. A claim older than the hard runtime plus a margin is stale.
- **Run session**: the persisted Pi session file of one run, stored under the extension home.
- **Delivery**: how a finished run reaches the user: a notice, a follow-up message that starts a turn, or nothing for successes.

## Invariants

- Scheduling lives in the Pi process: the tick starts on `session_start` and stops on `session_shutdown`. No daemon.
- Config is read every tick and never rewritten except an explicit Enable or Disable choice in `/cron`, which changes only that job's `enabled` flag.
- Invalid config pauses all jobs with one visible error and preserves the file.
- The Role bounds capability. Direct read-only admission is not applied because job entries are user-authored.
- Route precedence: job `model` and `thinking`, then job `modelClass`, then the Role default, then the `pi-cron/job` Model Task assignment (default `fast`).
- Every run replaces the Role launch's `--no-session` with `--session <run session>`; the child runs through pi-subagent's bounded ephemeral executor with this extension's `limits`.
- Failures always surface in the UI when one exists; `none` silences only successes.

## Owned storage

- Config: `<agent-dir>/config/pi-cron/config.json`
- State: `<agent-dir>/config/pi-cron/state.json` (version 1, strict)
- Run sessions: `<agent-dir>/config/pi-cron/sessions/<job-id>/<timestamp>.jsonl`
