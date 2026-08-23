# Pi Footer

## Language

**Footer identity**:
Concise repository and branch label identifying current checkout. A non-empty `pi-pr` status follows its clickable checkout link. Generated `worktree/` branch prefix is display noise. When open command is exactly `code`, identity links to current path through safe VS Code URI.
_Avoid_: Working-directory path, worktree path

**Usage line**:
Cumulative session input, output, and estimated cost plus latest cache-hit rate and current context usage, followed by right-aligned active model and thinking level. `off` matches dim model text, active levels follow a distinct green-to-red gradient ending with red `max`, and `ultra` is rainbow when runtime supports it.
_Avoid_: Token counter, status line

**Family status line**:
Third footer line, reserved for non-empty statuses from `@henryqw` extensions. `pi-pr` belongs with footer identity instead.
_Avoid_: External extension status, plugin summary, rewritten status

**External status line**:
Fourth footer line for every non-empty status from extensions outside `@henryqw`, sorted by status key and preserving producer text, ANSI styling, glyphs, and links. It remains fourth even when family status line is empty.
_Avoid_: Family extension status, rewritten status
