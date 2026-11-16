# Pi Cron

Pi Cron schedules user-authored prompts in fresh Pi sessions. Jobs run only while a Pi session with this extension is open.

## Language

**Job**:
A user-authored task with a schedule, Role, prompt, working directory, and optional model and environment choices.

**Slot**:
One scheduled occurrence of a job: an interval after its anchor or a daily wall-clock time in a time zone.

**Anchor**:
The later of a job's first sighting and its last start. A new job waits for a slot after this time.

**Catch-up run**:
One run for missed scheduled work. Multiple missed slots do not create a backlog of runs.

**Run claim**:
Ownership of one job run across open Pi sessions. Its fixed expiry comes from the runtime limit admitted for that run, not later config changes.

**Run session**:
The saved Pi conversation for one job run. A failure before session creation has no run session.

**Delivery**:
How a finished run reaches the user: a notice, a conversation follow-up, or silence on success. A delivery failure does not change the saved run outcome.
