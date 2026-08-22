# Pi Footer

## Language

**Footer identity**:
Concise repository and branch label identifying current checkout. A non-empty `pi-pr` status follows its clickable checkout link. Generated `worktree/` branch prefix is display noise. When open command is exactly `code`, identity links to current path through safe VS Code URI.
_Avoid_: Working-directory path, worktree path

**Usage line**:
Cumulative session input, output, and estimated cost plus latest cache-hit rate and current context usage, followed by right-aligned active model and thinking level. `off` matches dim model text, active levels follow a distinct green-to-red gradient ending with red `max`, and `ultra` is rainbow when runtime supports it.
_Avoid_: Token counter, status line

**Extension status line**:
Every non-empty status except `pi-pr`, sorted by status key and preserving producer text, ANSI styling, glyphs, and links. `pi-pr` belongs with footer identity.
_Avoid_: Plugin summary, rewritten status
