# `@henryqw/pi-open-in`

Open the current working directory with a configurable command. Default is `code`.

## Install

```bash
pi install npm:@henryqw/pi-open-in
```

## Use

| Surface | Purpose |
| --- | --- |
| `/open` | Run `<command> <current-working-directory>`. Works while the agent is busy. |
| `/set-open-in <command>` | Set the command used by `/open`. |

## Config

`~/.pi/agent/config/pi-open-in.json`

```json
{
  "command": "code"
}
```

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
