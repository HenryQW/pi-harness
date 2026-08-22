# Pi Footer

## Language

**Footer identity**:
Concise repository and branch label identifying current checkout. Generated `worktree/` branch prefix is display noise. When open command is exactly `code`, identity links to current path through safe VS Code URI.
_Avoid_: Working-directory path, worktree path

**Usage line**:
Cumulative session input, output, and estimated cost plus latest cache-hit rate and current context usage, followed by right-aligned active model and thinking level. `off` matches dim model text, active levels follow a distinct green-to-red gradient ending with red `max`, and `ultra` is rainbow when runtime supports it.
_Avoid_: Token counter, status line

**Subscription line**:
Active Codex account slot, remaining seven-day quota, and time until quota-window reset. Seven-day window label is omitted.
_Avoid_: Account balance, rate-limit line
