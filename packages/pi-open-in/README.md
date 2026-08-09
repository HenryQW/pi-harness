# `@henryqw/pi-open-in`

Pi extension that adds `/open` and `/set-open-in <command>` for opening current working directory.

## Install

```bash
pi install npm:@henryqw/pi-open-in
```

Run `/set-open-in codex` to configure `/open`. Then `/open` runs `codex <current-working-directory>`.

Command saves to `~/.pi/agent/config/pi-open-in.json`:

```json
{
  "command": "cursor"
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
