# `@henryqw/pi-herdr`

Call the Herdr CLI from Node through one thin client while keeping orchestration in the owning extension.

This package is an extension-author library. Pi users normally install a Herdr companion extension instead.

## Why

- **Created for**: Extension authors building Herdr-aware Pi features.
- **Advantage**: Share process handling without copying Herdr's command catalog into a second API.

## Install

```bash
npm install @henryqw/pi-herdr
```

Install the Herdr CLI and make `herdr` available on the calling process's `PATH`.

For ready-to-use Pi workflows, see [`@henryqw/pi-herdr-clone`](https://pi.henry.wang/extensions/pi-herdr-clone).

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
