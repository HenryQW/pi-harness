# `@henryqw/pi-open-in`

Open the current working directory with a configurable editor command. The default is `code`.

## Why

- **Created for**: Replace manually typed editor commands with one configurable action for the working directory.
- **Advantage**: `/open` works while the agent is busy and supports any simple editor command, defaulting to `code`.

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

- When the file is missing, the default editor command is `"code"`.
- When the file exists, `command` is required. It must be a non-empty string.
- The command splits on whitespace into an executable and arguments. Tokens cannot contain spaces, and quoting is unsupported. Use a wrapper script for executables in spaced paths.
- An existing file must be a JSON object with exactly one non-empty string `command` property. Otherwise `/open` fails with a visible error and offers no open URI.
- This extension never rewrites the file except through `/set-open-in`.

This package uses no shared config.
