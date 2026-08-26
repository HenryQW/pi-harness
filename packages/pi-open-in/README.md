# `@henryqw/pi-open-in`

Open the current working directory with a configurable command. Default is `code`.

## Why

- **Created for**: Replacing manually typed editor launcher commands with one configurable action for the working directory.
- **Advantage**: `/open` works while the agent is busy and supports any simple launcher command, defaulting to `code`.

## Install

```bash
pi install npm:@henryqw/pi-open-in
```

## Use

| Surface | Type | Purpose |
| --- | --- | --- |
| `/open` | command | Run `<command> <current-working-directory>`. Works while the agent is busy. |
| `/set-open-in` | command | Set the command used by `/open`. |

## Config

`~/.pi/agent/config/pi-open-in.json`

```json
{
  "command": "code"
}
```

| Field | Required | Possible values | Default (missing file) |
| --- | --- | --- | --- |
| `command` | Yes when the file exists | Non-empty string, split on whitespace into executable plus arguments; tokens cannot contain spaces (no quoting) — use a wrapper script for executables in spaced paths | `"code"` |

An existing file must be a JSON object with exactly one non-empty string `command` property; otherwise `/open` fails with a visible error and no open URI is offered. The file is never rewritten by this extension except via `/set-open-in`. This package uses no shared config.
