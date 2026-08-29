# `@henryqw/pi-herdr`

Run Herdr CLI commands from Node through one thin client. Callers keep orchestration and command-specific checks.

## Why

- **Created for**: Call Herdr CLI commands from Node without duplicating wrapper logic across extensions.
- **Advantage**: One thin client keeps orchestration local. The Herdr CLI remains the source of truth for commands and response shapes.

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

| API | Result |
| --- | --- |
| `exec` | Validates string argv and returns the raw process result. |
| `run` | Requires a successful exit and returns stdout. |
| `json` | Requires a successful exit and parses a JSON object. |
| `hasHerdrErrorCode` | Detects structured CLI errors in stdout or stderr. |
| `startPiAgent` | Validates and builds the shared `agent start --kind pi --pane ... --` boundary. It retries structured `agent_pane_busy` responses allowed by the caller's result-aware policy, with a five-attempt limit, and returns the raw final result. |

Callers build Pi-specific arguments and validate responses. The client does not mirror the Herdr command catalog. Herdr remains the source of truth for supported commands and response shapes.
