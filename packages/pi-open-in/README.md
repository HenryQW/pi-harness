# `@henryqw/pi-open-in`

Open the current working directory with a configurable command. Default is `code`.

## Why

- **Created for**: Replacing manually typed editor launcher commands with one configurable action for the working directory.
- **Advantage**: `/open` works while the agent is busy and supports any simple launcher command, defaulting to `code`.
- **Inspired by**: Retyping commands such as `code .` whenever a checkout needed opening.

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

The command is split on whitespace; tokens cannot contain spaces (no quoting). Use a wrapper script for executables in spaced paths.

A missing config file falls back to `code`. An existing file must be a JSON object with exactly one non-empty string `command` property; otherwise `/open` fails with a visible error. The file is never rewritten by this extension except via `/set-open-in`. When the config is invalid, no open URI is offered.

## Remove

```bash
pi remove npm:@henryqw/pi-open-in
```

## Development

```bash
npm test --workspace @henryqw/pi-open-in
npm run typecheck --workspace @henryqw/pi-open-in
npm run pack:check --workspace @henryqw/pi-open-in
```
