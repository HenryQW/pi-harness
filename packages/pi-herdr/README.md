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
| `startPiAgent` | function | Validates and builds the shared `agent start --kind pi --pane ... --` boundary. Before each start, it checks `pane process-info`. The pane shell must still own the foreground process group. It runs `pane run <pane> "echo <token>"`. It then polls `pane read` for up to 20 seconds. The token must appear as its own output line, with a prompt after it. This proves that the shell is reading input. Without this check, a shell on macOS can lose Enter for a launch command longer than 1024 bytes. This occurs while the shell starts or runs a prompt hook. The pane then waits forever. The helper does not probe an occupied pane, so `agent start` still reports `agent_pane_busy`. If the probe fails, the helper returns its result without starting the agent. It retries structured `agent_pane_busy` responses when the caller's result-aware policy permits it. The limit is five tries. It returns the raw final result. |

Callers build Pi-specific arguments and validate responses. The Herdr Client does not copy the list of Herdr commands. Herdr defines the supported commands and response shapes.
