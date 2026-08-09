# `@henryqw/pi-open-in`

Pi extension that adds `/open` and `/set-open-in <command>` for opening current working directory. Default command is `code` (VS Code CLI). You may set it to any command you want.

## Install

```bash
pi install npm:@henryqw/pi-open-in
```

Run `/set-open-in XYZ` to configure `/open`. Then `/open` runs `XYZ <current-working-directory>`. You can invoke `/open` anytime, even while the agent is working.

Command saves to `~/.pi/agent/config/pi-open-in.json`:

```json
{
  "command": "code"
}
```

Remove with:

```bash
pi remove npm:@henryqw/pi-open-in
```

## Development

```bash
npm test
npm run typecheck
npm run pack:check
```
