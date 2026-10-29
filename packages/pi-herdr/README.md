# `@henryqw/pi-herdr`

Call the Herdr command-line interface (CLI) or Unix socket from Node through one shared package. Extension authors share process handling without copying the list of Herdr commands. Pi users usually install a Herdr companion extension instead.

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
| `requestHerdr` | function | Sends one bounded Unix socket request without retries. |
| `HerdrRequestError` | class | Reports a structured error code and whether dispatch was possible. |
| `checkoutAdmission` | function | Shares process-local checkout ownership through Pi's public event bus. |
| `checkoutKey` | function | Resolves the canonical checkout for admission. |
| `registerCheckoutAdmission` | function | Registers the existing direct-writer policy and returns its ownership hold function. |
| `startPiAgent` | function | Validates and runs the shared `agent start --kind pi --pane ... --` boundary after a shell-readiness probe. |

### Socket requests

```ts
import { requestHerdr } from "@henryqw/pi-herdr";

const result = await requestHerdr("session.snapshot", {}, { signal });
```

`requestHerdr(method, params, options)` uses the inherited `HERDR_SOCKET_PATH`, or an explicit `socketPath`. Requests have unique identities; responses must match. The default timeout is 10000 milliseconds, with an allowed range of 1 to 60000. Request and response limits are 262144 and 1048576 bytes. An optional `AbortSignal` stops the local wait.

Errors expose `code` and `dispatched`. If `dispatched` is true, a mutation can have taken effect despite the error. Cancellation, timeout, or a closed connection is not permission to repeat a mutation. This function never retries. Callers validate method-specific results and own durable recovery. The existing CLI client and named-agent startup are unchanged.

### Checkout admission

`checkoutAdmission(pi)` finds one coordinator through Pi's public event bus. Call `install(pi)` to register tool lifecycle guards. `guard(name, refresh)` installs an awaited recovery check before writes. `reserve(owner, checkout)` returns a release function only when no admitted writer or Main write is active. `restore(owner, checkout)` restores durable ownership; `release(owner)` requires caller-proved completion.

`registerCheckoutAdmission(pi, directCanWrite)` keeps the direct-subagent policy: Main writes can overlap, but direct writers must wait for them and exclude other writes. A returned hold function keeps a direct request admitted beyond its tool result. Consumers must restore durable command ownership before allowing writes after restart. These mechanisms do not intercept external processes or provide a sandbox.

An optional third argument, `directCheckouts(input, ctx)`, returns additional canonical checkout paths for a direct request. Admission reserves the current checkout and the complete selected set together. A conflict in one member blocks the request without a partial reservation. The caller validates repository selection; the hold function releases the set only after caller-proved worker termination.

### `startPiAgent`

On macOS, a shell that starts or runs a prompt hook can lose Enter for a launch command longer than 1024 bytes. The pane then waits forever. To prevent this, the helper first checks `pane process-info`. When the pane shell owns the foreground process group, it runs `pane run <pane> "echo <token>"` and polls `pane read` for up to 20 seconds. The probe passes when the token appears on its own line, with a prompt after it.

The helper skips the probe when the shell does not own the group, so `agent start` reports `agent_pane_busy` for an occupied pane. If the probe fails, the helper returns its result without starting the agent. It retries `agent_pane_busy` up to five tries when the caller's policy permits it, then returns the raw final result.

Callers build Pi-specific arguments and validate responses. Herdr defines the supported commands and response shapes.
