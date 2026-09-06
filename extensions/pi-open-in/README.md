# `@henryqw/pi-open-in`

Open the current Pi working directory in your editor with one command. Move from terminal work while the agent is busy, using VS Code by default or any simple editor command.

## Install

```bash
pi install npm:@henryqw/pi-open-in
```

## Use

Run `/open`. With default settings, VS Code opens the current working directory.

Run `/set-open-in` when you want another command.

| Surface | Type | Purpose |
| --- | --- | --- |
| `/open` | command | Run `<command> <current-working-directory>`. Works while the agent is busy. |
| `/set-open-in` | command | Set the command used by `/open`. |

## Config

`~/.pi/agent/config/pi-open-in/config.json`

```json
{
  "command": "code"
}
```

- A missing file silently uses the default command, `"code"`.
- Reads do not create or write the config home.
- When the file exists, `command` is required. It must be a non-empty string.
- Only `/set-open-in` writes the file. Its write is atomic.

## API

Consumers use the owner API instead of reading this file.

```ts
import { loadOpenInConfig } from "@henryqw/pi-open-in/open-uri";

const { source, value } = loadOpenInConfig();
```

`source` is `"missing"` or `"file"`. `value.command` is validated. Pass an agent directory to `loadOpenInConfig(agentDir)` when needed.

`configuredOpenUri(path)` returns a VS Code URI when the executable is `code`. For `code -n` and `code --new-window`, it adds `windowId=_blank` so the link opens a new window. It returns `undefined` for other commands or invalid config.

This extension owns command validation. `@henryqw/pi-config-store` owns the config home and storage.

## Limits and recovery

The command splits on whitespace into an executable and arguments. Tokens cannot contain spaces, and quoting is unsupported. Use a wrapper script for executables in spaced paths.

An existing file must be a JSON object with exactly one non-empty string `command` property. Otherwise `/open` fails with a visible error and offers no open URI. Malformed files remain unchanged.
