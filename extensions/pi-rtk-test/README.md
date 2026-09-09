# `@henryqw/pi-rtk-test`

Use RTK for direct `pnpm test` Bash tool calls from Pi.

## Requirements

- Install `rtk` and its Pi agent hook.

This package does not install or update RTK:

```bash
brew install rtk
rtk --version
rtk init -g --agent pi
```

## Install

```bash
pi install npm:@henryqw/pi-rtk-test
```

RTK's own Pi extension is optional.

## What it rewrites

The rewrite is transparent. Pi changes these direct commands before Bash runs them:

| Pi command | Bash command |
| --- | --- |
| `pnpm test` | `rtk test pnpm test` |
| `pnpm test -- marker` | `rtk test pnpm test -- marker` |

Leading and trailing whitespace is removed. All other command text stays unchanged.

Only direct bare `pnpm test` commands with optional test arguments work. The package leaves these forms unchanged:

- `pnpm run test` and `pnpm run-script test`
- Global or workspace options, such as `pnpm --filter pkg test`
- Quoted or indirect programs, such as `"pnpm" test` or `env pnpm test`
- `pnpm test:watch` and unrelated commands
- Newlines, carriage returns, `;`, `|`, `&`, `<`, `>`, backticks, and `$(`
- Every command that begins with `rtk`

For an unsupported form, use `rtk test ...` explicitly. For example, run `rtk test pnpm run test`.

## When RTK is unavailable

At startup, the package runs `rtk test --help` once.
It blocks supported `pnpm test` calls if the probe throws, exits nonzero, is killed, or times out.

The block tells you to install RTK and verify `rtk test --help`. Other calls stay unchanged. The package does not warn at startup.

## Execution and exit status

This package does not run tests, capture output, or inspect test results. After a rewrite, RTK runs the command and owns its output and exit status.
