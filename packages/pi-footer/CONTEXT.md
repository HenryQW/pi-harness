# Pi Footer

## Language

**Footer identity**:
Concise repository and branch label identifying current checkout. A non-empty `pi-pr` status follows its checkout link, while non-empty statuses from `@henryqw` extensions occupy the right side. Generated `worktree/` branch prefix is display noise. When open command is exactly `code` and Pi reports hyperlink support, identity links to current path through a safe VS Code URI; otherwise it remains plain text.
_Avoid_: Working-directory path, worktree path

**Usage line**:
Cumulative session input, output, and estimated cost, including reported tool usage and finished `pi-subagent` background workflows, plus latest cache-hit rate and current context usage. Right-aligned active model and thinking level follow. `off` matches dim model text, active levels follow a distinct green-to-red gradient ending with red `max`, and `ultra` is rainbow when runtime supports it.
_Avoid_: Token counter, status line

**Agent-work time**:
Cumulative duration Pi spends processing agent runs, counted from `agent_start` through the final idle `agent_settled` and including automatic retries and auto-compaction inside a run. Blocking user-prompt waits, idle waits between runs, and standalone `/compact` are excluded. It occupies the right side of the third footer line, directly beneath the active model.
_Avoid_: Session age, response duration, session time

**Family status**:
Right side of the first footer line, reserved for non-empty statuses from `@henryqw` extensions. `pi-pr` remains beside footer identity instead.
_Avoid_: External extension status, plugin summary, rewritten status

**External status line**:
Left side of the third footer line for every non-empty status from extensions outside `@henryqw`, sorted by status key and preserving producer text, ANSI styling, glyphs, and links.
_Avoid_: Family extension status, rewritten status
