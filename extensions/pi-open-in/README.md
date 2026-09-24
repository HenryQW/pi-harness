# `@henryqw/pi-open-in`

Open the current Pi working directory with one command, using VS Code by default or another configured command. `/open` works while the agent is busy.

## Install

```bash
pi install npm:@henryqw/pi-open-in
```

## Works with

| Package | Relationship | Purpose |
| --- | --- | --- |
| [`@henryqw/pi-config-store`](https://github.com/HenryQW/pi-harness/tree/main/packages/pi-config-store) | Required | Owns config-home resolution and storage. |

## Use

Run `/open` to open the current Pi working directory in VS Code by default.

| Surface | Type | Purpose |
| --- | --- | --- |
| `/open` | command | Opens the current working directory with the configured command. |
| `/set-open-in <command>` | command | Sets the command used by `/open`. |

Run `/set-open-in <command>` to choose another command, such as `cursor --reuse-window`. `/open` runs `<command> <current-working-directory>`.

## Config

Package-owned: `~/.pi/agent/config/pi-open-in/config.json`

| Name | Description | Values | Default |
| --- | --- | --- | --- |
| `command` | Command run by `/open`; required when the file exists. | Non-empty string. | `"code"` |

A missing file silently uses the default command, `code`. An invalid existing file makes `/open` fail visibly and remains unchanged; see Limits and recovery. `/open` reads the config on every run. Only `/set-open-in` writes the file, atomically. Reads do not create or write the config home.

## API

Consumers should use the owner API instead of reading the config file directly.

```ts
import { loadOpenInConfig } from "@henryqw/pi-open-in/open-uri";

const { source, value } = loadOpenInConfig();
```

These exports serve package consumers; the commands in Use are the Pi interfaces.

| Surface | Type | Purpose |
| --- | --- | --- |
| `default` (`openInExtension(pi)`) | function | Registers the extension's commands with Pi. |
| `OpenInConfig` | type | Describes the configured command. |
| `loadOpenInConfig(agentDir?)` | function | Reads and validates the owner config. |
| `configuredOpenUri(path)` | function | Returns a safe VS Code URI for a supported command. |

`loadOpenInConfig` returns `source` as `"missing"` or `"file"`; `value.command` is validated. Pass an agent directory when needed.

`configuredOpenUri(path)` works when the executable is `code`. With `code -n` or `code --new-window`, it adds `windowId=_blank` so the link opens in a new window. It returns `undefined` for other commands or invalid config. `@henryqw/pi-config-store` owns the config home and storage.

## Limits and recovery

The command splits on whitespace into an executable and arguments. Tokens cannot contain spaces, and quoting is unsupported. Use a wrapper script for executables in spaced paths.

An existing file must be a JSON object with exactly one non-empty string `command` property. Otherwise `/open` fails with a visible error, offers no open URI, and leaves the malformed file unchanged. If the configured command exits unsuccessfully, Pi reports its error output or exit code; fix the command and run `/open` again.
