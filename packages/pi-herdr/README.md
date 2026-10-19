# `@henryqw/pi-herdr`

Call the Herdr CLI from Node through one Herdr Client. Extension authors share process handling without copying the list of Herdr commands. Pi users usually install a Herdr companion extension instead.

## Install

```bash
npm install @henryqw/pi-herdr
```

Install the Herdr CLI. Make `herdr` available on the calling process's `PATH`. The client requires Herdr 0.9.3 or later. Run `herdr --version` to verify the version.

## Use

Create a Herdr Client. Run a command. The client returns the parsed response.

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
| `startPiAgent` | function | Validates and runs the shared `agent start --kind pi --pane ... --` boundary after a shell-readiness probe. |

### `startPiAgent`

On macOS, a shell that starts or runs a prompt hook can lose Enter for a launch command longer than 1024 bytes. The pane then waits forever. To prevent this, the helper first checks `pane process-info`. When the pane shell owns the foreground process group, it runs `pane run <pane> "echo <token>"` and polls `pane read` for up to 20 seconds. The probe passes when the token appears on its own line, with a prompt after it.

The helper skips the probe when the shell does not own the group, so `agent start` reports `agent_pane_busy` for an occupied pane. If the probe fails, the helper returns its result without starting the agent. It retries `agent_pane_busy` up to five tries when the caller's policy permits it, then returns the raw final result.

Callers build Pi-specific arguments and validate responses. Herdr defines the supported commands and response shapes.
