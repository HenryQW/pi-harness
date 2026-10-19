# `@henryqw/pi-footer`

Keep footer identity, model usage, agent-work time, and extension status visible in Pi. Enable the footer and open commands independently.

![Pi footer showing repository, pull request, quota, usage, model, and extension status](./example.png)

## Install

```bash
pi install npm:@henryqw/pi-footer
```

Both entry points load by default. To select only the open commands, use Pi's resource filter in `settings.json`:

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

Select `extensions/footer.ts` for only the footer, or use `pi config` to toggle either resource.

## Works with

| Package | Relationship | Purpose |
| --- | --- | --- |
| [`@henryqw/pi-codegraph`](https://pi.henry.wang/extensions/pi-codegraph) | Improves | Shows CodeGraph index status, quiet setup progress, and direct tool activity when loaded. |
| [`@henryqw/pi-config-store`](https://pi.henry.wang/extensions/pi-config-store) | Required | Owns config-home resolution and storage. |
| [`@henryqw/pi-multi-codex`](https://pi.henry.wang/extensions/pi-multi-codex) | Improves | Adds active Codex subscription quota and reset status. |
| [`@henryqw/pi-pr`](https://pi.henry.wang/extensions/pi-pr) | Improves | Adds current-branch pull-request status. |

## Use

Start a Pi TUI session to see the footer. Run `/open` to open the current directory in VS Code, even while the agent is busy.

| Surface | Type | Purpose |
| --- | --- | --- |
| Footer | ui | Shows footer identity, usage, model, agent-work time, and extension statuses to the user. |
| `/open` | command | Opens the current directory for the user with the configured command. |
| `/set-open-in <command>` | command | Sets the user's open command, such as `cursor --reuse-window`. |

`/open` runs `<command> <current-working-directory>`.

### Footer lines

| Line | Left | Right |
| --- | --- | --- |
| First | Repository, branch, Git state, and `pi-pr` pull-request status. Linked-worktree branches omit the generated `worktree/` prefix. | Non-empty `pi-multi-codex` family status. |
| Second: usage line | Input and output token totals, latest cache-hit rate, response throughput, estimated cost, and context use. | Active model and thinking level. |
| Third | CodeGraph first, then other extension statuses sorted by key, including Ponytail and `pi-rewind`. | Cumulative agent-work time. |

Token and cost totals include reported tool usage and completed `pi-subagent` background workflows. Response throughput measures output tokens per second from first to last streamed content. It excludes request latency, time to first token, and later provider work, including Claude bridge shutdown. Non-streamed or instantaneous responses show `—`. Other unavailable values show `—` without a percent sign.

Virtual models show the latest successful physical model and thinking level after an arrow: `auto • high → gpt-5.6-luna • medium`.

Thinking colors are dim grey for `off` and the model name, then green `minimal`, yellow-green `low`, lime `medium`, yellow `high`, orange `xhigh`, and red `max`. Active levels use ANSI-256 colors. `ultra` uses a rainbow only when the runtime supports it; unsupported levels do not appear.

For CodeGraph badges, see [`@henryqw/pi-codegraph`](https://pi.henry.wang/extensions/pi-codegraph).

Other dependency statuses, such as `⠋ deps · installing 12s`, disappear after completion. Middle dots separate statuses. The footer preserves colors, links, glyphs, and interior spacing, trims outer whitespace, replaces line breaks with spaces, and shortens long statuses.

### Git state

Badges appear only when action is necessary:

| Badge | Meaning |
| --- | --- |
| `+2` | Two staged paths |
| `~3` | Three unstaged tracked paths |
| `?N` | `N` untracked porcelain status entries; Git can collapse an untracked directory into one entry. |
| `!1` | One unresolved path |
| `↑2` | Two commits ahead of upstream |
| `↓1` | One commit behind upstream |

Active operations appear first: `REBASE 3/7`, `MERGING`, or `CHERRY-PICKING`. Detached HEAD shows a short commit, such as `@a1b2c3d`.

Local Git data comes from `git status --porcelain=v2 --branch --untracked-files=normal` and refreshes after agent runs and branch changes. No model call or remote fetch occurs. Ahead and behind counts use the last fetched upstream state.

## Config

Package-owned paths under `getAgentDir()` (normally `~/.pi/agent`):

- `~/.pi/agent/config/pi-footer/config.json`: footer colors.
- `~/.pi/agent/config/pi-open-in/config.json`: open command.

| Name | Description | Values | Default |
| --- | --- | --- | --- |
| `colors` | Footer-owned colors by role. | Object mapping roles to theme tokens, `#RGB`, `#RRGGBB`, `oklch(...)`, `okhsl(...)`, or ANSI indices `0` to `255`. | Built-in colors. |
| `command` | Command for `/open`. | Non-empty string. | `"code"` |

Colors load at session start; run `/reload` after edits. Missing files or roles keep built-in colors. Unknown keys, unknown roles, and invalid colors produce warnings with the path and reason. Invalid roles use built-in colors independently; malformed files use all built-in colors. The footer never rewrites the file.

### Footer color roles

Every role is optional:

| Role | Surface |
| --- | --- |
| `repository` | Repository name. |
| `branch` | Branch name, with a hyperlink where supported. |
| `gitStatus` | Git badges. |
| `input`, `output`, `cache`, `throughput`, `cost`, `context` | The six usage metrics. |
| `model` | Active and physical models. |
| `runtime` | Agent-work time. |
| `codegraphActive` | Direct-call `● CG` badge. |
| `separator` | Middle dots, bullets, arrows, and truncation ellipsis. |

Theme tokens: `accent`, `dim`, `muted`, `text`, `success`, `warning`, `error`, and `thinkingText`. Colors do not change the thinking gradient or other extensions' status colors.

```json
{
  "colors": {
    "repository": "muted",
    "branch": "accent",
    "gitStatus": "warning",
    "input": "#4ec9b0",
    "output": "#9cdcfe",
    "cache": "#c586c0",
    "throughput": "#dcdcaa",
    "cost": "#ce9178",
    "context": "#89d185",
    "model": "text",
    "runtime": "muted",
    "codegraphActive": "accent",
    "separator": "dim"
  }
}
```

## API

Consumers must use the owner API, not read config directly:

```ts
import { loadOpenInConfig } from "@henryqw/pi-footer/open-uri";

const loaded = loadOpenInConfig();
if (loaded.status === "ok") console.log(loaded.value.command, loaded.issues);
```

| Surface | Type | Purpose |
| --- | --- | --- |
| `default` (`openInExtension(pi)`) | function | Registers open commands without the footer. |
| `OpenInConfig` | type | Describes the command. |
| `loadOpenInConfig(agentDir?)` | function | Reads and validates owner config; accepts an optional agent directory. |
| `configuredOpenUri(path)` | function | Returns a safe VS Code URI for `code`, or `undefined` for other commands. |

`loadOpenInConfig` returns a `@henryqw/pi-config-store` `ConfigLoad`: `status`, `source` (`"missing"` or `"file"`), `issues`, and `value` when `status` is `"ok"`. Invalid `value.command` gives `"code"` and an issue. Neither function shows notifications. `configuredOpenUri(path)` uses `code` for invalid config; `code -n` and `code --new-window` add `windowId=_blank`.

## Limits and recovery

Open commands split on whitespace. Quoting and tokens with spaces are unsupported; use a wrapper script for executable paths with spaces.

`/open` reads config on each run. Missing config silently uses `code`. Only `/set-open-in` writes the file, atomically.

Open config must be a JSON object with one non-empty string `command`. Unknown keys, invalid commands, or malformed files produce warnings at session start or the next `/open`, including footer-only installations. Each issue shows once per session, never during rendering. Invalid commands and malformed files use `code` without changing the file.

Fix config or run `/set-open-in <command>` to replace it; the command reports new issues before replacement. If the command fails, Pi reports its error output or exit code. Fix the command and retry `/open`.

With `code` and Pi hyperlink support, the accent-colored branch name links to the current path. `code -n` and `code --new-window` open a new window. Other executables or disabled hyperlinks give plain text.

Use primary click in Pi's default fullscreen TUI. Regular TUI (`"tuiMode": "regular"` or `--tui-mode regular`) needs terminal support for OSC 8 links and custom URI schemes. Ghostty uses `Cmd+click`, but might not open custom URI schemes.
