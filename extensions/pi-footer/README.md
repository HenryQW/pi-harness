# `@henryqw/pi-footer`

Keep checkout identity, model usage, elapsed agent work, and extension status visible while you work in Pi. Open the current Pi working directory with `/open`, using VS Code by default or another configured command. The footer and open commands can be enabled independently.

![Pi footer showing repository, pull request, quota, usage, model, and extension status](./example.png)

## Install

```bash
pi install npm:@henryqw/pi-footer
```

Requires Pi 1.1.0 or later in the 1.x series.

Version 3 replaces `@henryqw/pi-open-in`. If you have it installed, remove it before upgrading to prevent duplicate `/open` and `/set-open-in` commands:

```bash
pi remove npm:@henryqw/pi-open-in
pi install npm:@henryqw/pi-footer
```

For project-local installs, use `--local` on both commands. Remove manually configured paths to the old package as well, then restart Pi. The existing open-command config stays at `config/pi-open-in/config.json`; do not move it.

Both entry points load by default. To use `/open` without the custom footer, use Pi's native package resource filter in `settings.json`:

```json
{
  "packages": [
    {
      "source": "npm:@henryqw/pi-footer",
      "extensions": ["extensions/open.ts"]
    }
  ]
}
```

Select `extensions/footer.ts` instead for only the footer, or use `pi config` to toggle either resource. No package activation config is needed.

## Works with

| Package | Relationship | Purpose |
| --- | --- | --- |
| [`@henryqw/pi-codegraph`](https://pi.henry.wang/extensions/pi-codegraph) | Improves | Shows CodeGraph index status, quiet setup progress, and direct tool activity when loaded. |
| [`@henryqw/pi-config-store`](https://pi.henry.wang/extensions/pi-config-store) | Required | Owns config-home resolution and storage. |
| [`@henryqw/pi-multi-codex`](https://pi.henry.wang/extensions/pi-multi-codex) | Improves | Adds active Codex subscription quota and reset status. |
| [`@henryqw/pi-pr`](https://pi.henry.wang/extensions/pi-pr) | Improves | Adds current-branch pull-request status. |

## Use

After installing, start a Pi TUI session to see checkout, usage, model, thinking, and extension statuses. Run `/open` to open the current working directory in VS Code by default; it also works while the agent is busy.

| Surface | Type | Purpose |
| --- | --- | --- |
| Footer | ui | Shows checkout identity, usage, model, elapsed agent work, and extension statuses. |
| `/open` | command | Opens the current working directory with the configured command. |
| `/set-open-in <command>` | command | Sets the command used by `/open`. |

Run `/set-open-in <command>` to choose another command, such as `cursor --reuse-window`. `/open` runs `<command> <current-working-directory>`.

```text
pi-harness · clear-field-f8d2 [+2 ~3 ?1 ↑2] · PR #123 · approved    Codex #1 · 50% · 7d 1d 1h 22m
↑ 12.4k · ↓ 2.1k · ↺ 84.3% · ⚡ 87.4 t/s · $ 0.127 · ◔ 36.8%    gpt-5.6-luna • high
✓ CG · ●  🐴 ponytail: ⚡ FULL                                          ◷ 12m 34s
```

- The first line shows the repository, branch, Git state, and `pi-pr` pull request status beside the checkout identity. The `pi-multi-codex` quota status, when non-empty, occupies the right side. Linked-worktree branches drop the generated `worktree/` prefix.
- The second line shows cumulative input tokens, output tokens, latest cache-hit rate, and tokens per second for the most recent assistant response. The rate is timed from the response's first streamed content to its last, so request latency, time to first token, and provider work after the stream ends (such as Claude bridge shutting down Claude Code) are excluded. A response that arrives without streamed content, or all at once, shows `—`. It also shows estimated cost and context usage. Totals include reported tool usage and finished `pi-subagent` background workflows. The active model and thinking level are right-aligned. Under a virtual model, the physical model and thinking level of the latest successful response follow an arrow, for example `auto • high → gpt-5.6-luna • medium`, matching Pi's built-in footer.
- The third line shows CodeGraph's icon and `CG` first: `✓ CG` when indexed, `○ CG` when a Git repository has no index, or a dim spinner and elapsed time such as `⠋ CG · indexing 8s` during setup. Non-Git directories show no index badge. Other extension statuses follow, such as `⠋ deps · installing 12s`; dependency preparation statuses disappear when work completes. Persistent CodeGraph failures retain their theme-colored `!` icon and meaningful text. During direct `codegraph_explore` calls, `● CG` temporarily replaces the CodeGraph status, which returns when the call finishes. A middle dot separates statuses; cumulative agent-work time stays on the right, beneath the active model.

Git badges appear only when action is needed:

| Badge | Meaning |
| --- | --- |
| `+2` | Two staged paths |
| `~3` | Three unstaged tracked paths |
| `?N` | `N` untracked porcelain status entries |
| `!1` | One unresolved path |
| `↑2` | Two commits ahead of the upstream branch |
| `↓1` | One commit behind the upstream branch |

`?N` counts porcelain status entries. In `--untracked-files=normal` mode, Git may collapse a whole untracked directory to one entry.

Active operations appear first, such as `REBASE 3/7`, `MERGING`, or `CHERRY-PICKING`. Detached HEAD uses the short commit form `@a1b2c3d`.

The extension reads local Git data with `git status --porcelain=v2 --branch --untracked-files=normal`. It refreshes after each agent run and branch change. It does not make an LLM call or fetch a remote. Ahead and behind counts use the last fetched upstream state.

Unavailable values render as `—` without a misleading percent sign.

`off` uses the same dim grey as the model name. Active levels use an ANSI-256 gradient: green `minimal`, yellow-green `low`, lime `medium`, yellow `high`, orange `xhigh`, and red `max`.

`ultra` renders as a rainbow when the active Pi runtime supplies that thinking level. Unsupported levels never appear.

Only the non-empty `pi-multi-codex` quota status occupies the right side of the first line. The `pi-pr` pull-request status stays beside checkout identity, and CodeGraph index status, setup progress, or tool activity appears separately on the third line.

Statuses from other extensions, including Ponytail and `pi-rewind`, share the left side of the third line. They are sorted by key; colors, links, glyphs, and interior spacing are preserved. Leading and trailing whitespace is trimmed, line breaks become spaces, and long statuses may be clipped to fit the footer. Only direct `codegraph_explore` tool calls trigger the `● CG` badge; CodeGraph queries made from inside scripted tools are not shown.

## Config

Package-owned: `~/.pi/agent/config/pi-open-in/config.json` (under `getAgentDir()` when overridden). The retained `pi-open-in` home belongs to the open commands now shipped here.

| Name | Description | Values | Default |
| --- | --- | --- | --- |
| `command` | Command run by `/open`; required when the file exists. | Non-empty string. | `"code"` |

A missing file silently uses the default command, `code`. An invalid existing file makes `/open` fail visibly and remains unchanged; see Limits and recovery. `/open` reads the config on every run. Only `/set-open-in` writes the file, atomically. Reads do not create or write the config home.

## API

Consumers should use the owner API instead of reading the config file directly. Replace imports from `@henryqw/pi-open-in/open-uri` with `@henryqw/pi-footer/open-uri`:

```ts
import { loadOpenInConfig } from "@henryqw/pi-footer/open-uri";

const { source, value } = loadOpenInConfig();
```

These exports serve package consumers; the commands in Use are the Pi interfaces.

| Surface | Type | Purpose |
| --- | --- | --- |
| `default` (`openInExtension(pi)`) | function | Registers the open commands with Pi, without the footer. |
| `OpenInConfig` | type | Describes the configured command. |
| `loadOpenInConfig(agentDir?)` | function | Reads and validates the owner config. |
| `configuredOpenUri(path)` | function | Returns a safe VS Code URI for a supported command. |

`loadOpenInConfig` returns `source` as `"missing"` or `"file"`; `value.command` is validated. Pass an agent directory when needed.

`configuredOpenUri(path)` works when the executable is `code`. With `code -n` or `code --new-window`, it adds `windowId=_blank` so the link opens in a new window. It returns `undefined` for other commands or invalid config. `@henryqw/pi-config-store` owns the config home and storage.

## Limits and recovery

The open command splits on whitespace into an executable and arguments. Tokens cannot contain spaces, and quoting is unsupported. Use a wrapper script for executables in spaced paths.

An existing config file must be a JSON object with exactly one non-empty string `command` property. Otherwise `/open` fails with a visible error, offers no open URI, and leaves the malformed file unchanged. If the configured command exits unsuccessfully, Pi reports its error output or exit code; fix the command and run `/open` again.

When the configured executable is `code` and Pi reports hyperlink support, the accent-colored checkout name links to the current path. The link opens a new window for `code -n` or `code --new-window`. A missing config silently uses `code`. Other executables and terminals with hyperlinks disabled render plain text.

Pi handles the custom URI in its default fullscreen TUI. Use normal primary click. Regular TUI (`"tuiMode": "regular"` or `--tui-mode regular`) delegates OSC 8 activation to the terminal, so the link works only where the terminal opens custom URI schemes.

Ghostty uses `Cmd+click` but may not open custom URI schemes.
