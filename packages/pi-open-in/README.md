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

`~/.pi/agent/config/pi-open-in/config.json`

```json
{
  "command": "code"
}
```

- A missing file sends one session-start warning and uses the default command, `"code"`.
- Reads do not create or write the config home.
- When the file exists, `command` is required. It must be a non-empty string.
- The command splits on whitespace into an executable and arguments. Tokens cannot contain spaces, and quoting is unsupported. Use a wrapper script for executables in spaced paths.
- An existing file must be a JSON object with exactly one non-empty string `command` property. Otherwise `/open` fails with a visible error and offers no open URI.
- Malformed files remain unchanged.
- Only `/set-open-in` writes the file. Its write is atomic.

## Owner API

Consumers use the owner API instead of reading this file.

```ts
import { loadOpenInConfig } from "@henryqw/pi-open-in/open-uri";

const { source, value } = loadOpenInConfig();
```

`source` is `"missing"` or `"file"`. `value.command` is validated.
Pass an agent directory to `loadOpenInConfig(agentDir)` when needed.

This extension owns command validation. `@henryqw/pi-config-store` owns the config home and storage.
