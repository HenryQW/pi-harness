# `@henryqw/pi-herdr`

Run Herdr CLI commands from Node through one thin client. Callers keep orchestration and command-specific checks.

## Install

```bash
npm install @henryqw/pi-herdr
```

## Use

```ts
import { createHerdrClient } from "@henryqw/pi-herdr";

const herdr = createHerdrClient((command, args, options) =>
	pi.exec(command, [...args], options));
const response = await herdr.json(["agent", "list"], { cwd: ctx.cwd });
```

`exec` validates string argv and returns the raw process result. `run` requires a successful exit and returns stdout. `json` also parses a JSON object. `hasHerdrErrorCode` detects structured CLI errors in stdout or stderr.

Client does not mirror the Herdr command catalog. Herdr remains the source of truth for supported commands and response shapes.

## Development

```bash
npm test --workspace @henryqw/pi-herdr
npm run typecheck --workspace @henryqw/pi-herdr
npm run pack:check --workspace @henryqw/pi-herdr
```
