# `@henryqw/pi-herdr`

Run Herdr CLI commands from Node through one thin client. Callers keep orchestration and command-specific checks.

## Why

- **Created for**: Calling Herdr CLI commands from Node without duplicating wrapper logic across extensions that each needed `exec`, `run`, and JSON parsing.
- **Advantage**: One thin client keeps orchestration local while the Herdr CLI stays the single source of truth for commands and response shapes.

## Install

```bash
npm install @henryqw/pi-herdr
```

## Use

```ts
import { createHerdrClient } from "@henryqw/pi-herdr";

const herdr = createHerdrClient(pi.exec.bind(pi));
const response = await herdr.json(["agent", "list"], { cwd: ctx.cwd });
```

`exec` validates string argv and returns the raw process result. `run` requires a successful exit and returns stdout. `json` also parses a JSON object. `hasHerdrErrorCode` detects structured CLI errors in stdout or stderr. `startPiAgent` validates and builds the shared `agent start --kind pi --pane ... --` boundary, retries structured `agent_pane_busy` responses allowed by the caller's result-aware policy within a five-attempt limit, and returns the raw final result; callers still build Pi-specific args and validate responses.

Client does not mirror the Herdr command catalog. Herdr remains the source of truth for supported commands and response shapes.
