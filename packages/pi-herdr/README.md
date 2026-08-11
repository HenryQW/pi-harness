# `@henryqw/pi-herdr`

Shared client for interacting with Herdr from Node.js tools and Pi packages.

This solves common Herdr interaction plumbing: running commands through an injected executor, handling failures consistently, and parsing JSON responses without taking command orchestration away from callers.

```ts
import { createHerdrClient } from "@henryqw/pi-herdr";

const herdr = createHerdrClient((command, args, options) =>
	pi.exec(command, [...args], options));
const response = await herdr.json(["agent", "list"], { cwd: ctx.cwd });
```

`exec` validates string argv and returns raw process result, `run` requires successful exit and returns stdout, and `json` also parses JSON object response. `hasHerdrErrorCode` detects structured CLI errors in stdout or stderr.

Client does not mirror Herdr command catalog or validate command-specific response fields. Callers keep domain checks; Herdr remains source of truth for supported commands and response shapes.

## Development

```bash
npm test --workspace @henryqw/pi-herdr
npm run typecheck --workspace @henryqw/pi-herdr
npm run pack:check --workspace @henryqw/pi-herdr
```
