# `@henryqw/pi-process`

Run one argv-only child process. Limit UTF-8 output and execution time. Cancel the process when necessary.

## Install

```bash
npm install @henryqw/pi-process
```

## Use

```ts
import { spawnBounded } from "@henryqw/pi-process";

const result = await spawnBounded("git", ["status"], { cwd: process.cwd() });
if (result.code !== 0 || result.killed) throw new Error(result.stderr);
```

`spawnBounded` accepts an optional UTF-8 string on stdin. It strictly decodes stdout and stderr. The default timeout is 30 seconds. Pass `timeoutMs: null` for a process without an elapsed-time limit. Cancellation and output limits still apply.

Each output stream has a 64 KiB limit. Set `stdoutTailBytes` to keep only the end of stdout instead of applying the stdout limit. The retained text has complete UTF-8 characters.

On POSIX systems, cancellation and timeout terminate the child process group. Invalid command, argument, and working-directory values cause failure before a child starts.

## API

| Surface | Type | Purpose |
| --- | --- | --- |
| `spawnBounded` | function | Run one bounded argv-only child process. |
| `Exec` | type | Describe the executor call signature. |
| `ExecOptions` | type | Configure cwd, cancellation, timeout, limits, and string stdin. |
| `ExecResult` | type | Return stdout, stderr, exit code, kill state, and tail truncation. |
