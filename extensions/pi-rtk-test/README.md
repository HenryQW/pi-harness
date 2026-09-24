# `@henryqw/pi-rtk-test`

Keep noisy `pnpm test` output out of Pi's model context. This extension rewrites supported direct Bash calls through RTK, which reports failures and a compact result instead of the full test log.

## Install

```bash
pi install npm:@henryqw/pi-rtk-test
```

Install Rust Token Killer (`rtk`) on Pi's `PATH`. This extension does not install or update RTK.

```bash
brew install rtk
rtk --version

rtk init -g --agent pi
```

## Use

The rewrite is transparent. Pi changes these direct `pnpm test` Bash calls before Bash runs them:

| Pi command | Bash command |
| --- | --- |
| `pnpm test` | `rtk test pnpm test` |
| `pnpm test -- marker` | `rtk test pnpm test -- marker` |

Leading and trailing whitespace is removed. All other command text stays unchanged.

## Flow

When the extension loads, it runs `rtk test --help` once with a two-second timeout. If RTK responds successfully, supported Bash calls are rewritten as shown above. RTK runs the tests and owns their output and exit status; this extension does not run tests, capture output, or inspect test results.

## Limits and recovery

Only direct bare `pnpm test` commands with optional test arguments are rewritten. These forms are left unchanged:

- `pnpm run test` and `pnpm run-script test`
- Global or workspace options, such as `pnpm --filter pkg test`
- Quoted or indirect programs, such as `"pnpm" test` or `env pnpm test`
- `pnpm test:watch` and unrelated commands
- Newlines, carriage returns, `;`, `|`, `&`, `<`, `>`, backticks, and `$(`
- Every command that begins with `rtk`

For an unsupported form, use `rtk test ...` explicitly. For example, run `rtk test pnpm run test`.

If the startup probe throws, exits nonzero, is killed, or times out, supported `pnpm test` calls are blocked with a message to install RTK and verify `rtk test --help`. Other calls stay unchanged. The package does not warn at startup. After fixing RTK, reload the extension or restart Pi so the probe runs again.
