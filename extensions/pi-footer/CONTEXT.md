# Pi Footer

The package owns the footer and open commands as independently selectable Pi resources: `extensions/footer.ts` and `extensions/open.ts`. It replaces `@henryqw/pi-open-in` without changing its config home. The public owner API is `@henryqw/pi-footer/open-uri`.

## Language

**Footer identity**:
Concise repository and branch label identifying current checkout. Actionable local Git state follows the branch in brackets and stays hidden when clean and synchronized. It shows active operations, conflicts, staged, unstaged, and untracked path counts, upstream divergence, and detached HEAD. A non-empty `pi-pr` pull-request status follows footer identity; CodeGraph appears separately on the third line. Generated `worktree/` branch prefix is display noise. When the open command executable is `code`, including a missing config that silently defaults to `code`, and Pi reports hyperlink support, identity links to current path through a safe VS Code URI. The `-n` and `--new-window` flags make that link open a new window; otherwise unsupported executables render as plain text.
_Avoid_: Checkout identity, working-directory path, worktree path, clean badge, remote fetch

**Usage line**:
Cumulative session input, output, and estimated cost, including reported tool usage and finished `pi-subagent` background workflows, plus latest cache-hit rate and current context usage. Right-aligned active model and thinking level follow. `off` matches dim model text, active levels follow a distinct green-to-red gradient ending with red `max`, and `ultra` is rainbow when runtime supports it.
_Avoid_: Token counter, status line

**Agent-work time**:
Cumulative duration Pi spends processing agent runs, counted from `agent_start` through the final idle `agent_settled` and including automatic retries and auto-compaction inside a run. Blocking user-prompt waits, idle waits between runs, and standalone `/compact` are excluded. It occupies the right side of the third footer line, directly beneath the active model.
_Avoid_: Session age, response duration, session time

**Family status**:
Right side of the first footer line, reserved only for the non-empty `pi-multi-codex` quota status. `pi-pr` remains beside footer identity, and CodeGraph is shown separately on the third line.
_Avoid_: External extension status, plugin summary, rewritten status

**External status line**:
Left side of the third footer line for every non-empty status from extensions outside `@henryqw`, sorted by status key and preserving producer text, ANSI styling, glyphs, and links.
_Avoid_: Family extension status, rewritten status

**Footer color configuration**:
User config at `getAgentDir()/config/pi-footer/config.json` that maps footer-owned color roles to theme tokens, concrete colors, or ANSI indices. The footer reads it once per session start and never rewrites it. A missing file or missing role keeps the built-in color. At each session start, an unknown key, an unknown role, or an invalid color warns with its path and reason; only that role falls back to its built-in color. A malformed file falls back to built-in colors for every role. It does not control the thinking-level gradient or external extension status colors.
_Avoid_: style config, theme override, per-metric styling

**Open command**:
The `/open` Pi command that launches configured command for current working directory.
_Avoid_: editor command, project opener

**Open command configuration**:
User config at `getAgentDir()/config/pi-open-in/config.json` selecting executable launched by `/open`; `/set-open-in <command>` updates it. A missing file silently defaults to `code` without being created. An unknown key, an invalid `command`, or a malformed file warns once per session, at session start or the next `/open`, and `command` falls back to `code` without touching the file. The footer and `/open` both report it at session start, and pi-config-store's shared record shows each issue once, also with footer-only activation; footer renders read it but never notify. Command string is split on whitespace; tokens with spaces unsupported.
_Avoid_: project config, editor preference

**Current working directory**:
Pi session path passed to configured command by `/open`.
_Avoid_: process directory, repository root

**Open URI**:
Safe editor URI derived only when the open command executable is `code`, with or without flags; maps current working directory to `vscode://file/...`. The `-n` and `--new-window` flags map to the VS Code protocol's `windowId=_blank` query. Arbitrary configured commands cannot become OSC 8 links.
_Avoid_: command link, shell URI
