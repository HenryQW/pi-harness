# `@henryqw/pi-herdr`

Call the Herdr CLI from Node through one thin client. Extension authors share process handling without copying Herdr's command catalog. Pi users normally install a Herdr companion extension instead.

## Install

```bash
npm install @henryqw/pi-herdr
```

Install the Herdr CLI and make `herdr` available on the calling process's `PATH`. Run `herdr --version` to verify it.

## Use

Create a client and run a command. The client returns the parsed response.

```ts
import { createHerdrClient } from "@henryqw/pi-herdr";

const herdr = createHerdrClient(pi.exec.bind(pi));
const response = await herdr.json(["agent", "list"], { cwd: ctx.cwd });
```

For a ready-to-use Pi workflow, see [`@henryqw/pi-herdr-tools`](https://pi.henry.wang/extensions/pi-herdr-tools).

## API

| Surface | Type | Purpose |
| --- | --- | --- |
| `exec` | function | Validates string argv and returns the raw process result. |
| `run` | function | Requires a successful exit and returns stdout. |
| `json` | function | Requires a successful exit and parses a JSON object. |
| `hasHerdrErrorCode` | function | Detects structured CLI errors in stdout or stderr. |
| `startPiAgent` | function | Validates and builds the shared `agent start --kind pi --pane ... --` boundary. Before each start it runs `pane run <pane> "echo <token>"` and waits up to 20 seconds with `pane wait-output` for that token as its own output line, which proves the shell is reading commands. Without this, a launch command longer than 1024 bytes sent to a pane whose shell is still starting loses its Enter on macOS and the pane waits forever. A failed probe is returned as the result without starting the agent. It retries structured `agent_pane_busy` responses allowed by the caller's result-aware policy, with a five-attempt limit, and returns the raw final result. |

Callers build Pi-specific arguments and validate responses. The client does not mirror the Herdr command catalog. Herdr remains the source of truth for supported commands and response shapes.
