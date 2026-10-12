# `@henryqw/pi-rtk-test`

Keep noisy `pnpm test` output out of Pi's model context. This extension sends supported direct Bash calls through RTK. RTK reports failures and a compact result instead of the full test log.

## Install

```bash
pi install npm:@henryqw/pi-rtk-test
```

Requires Pi 1.1.0 or later in the 1.x series.

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

The extension removes leading and trailing whitespace. All other command text stays unchanged.

## Flow

When the extension loads, it runs `rtk test --help` one time with a two-second timeout. If RTK responds successfully, the extension rewrites supported Bash calls as the table above shows. RTK runs the tests and owns their output and exit status. This extension does not run tests, capture output, or examine test results.

## Limits and recovery

The extension rewrites only direct bare `pnpm test` commands with optional test arguments. It does not change these forms:

- `pnpm run test` and `pnpm run-script test`
- Global or workspace options, such as `pnpm --filter pkg test`
- Quoted or indirect programs, such as `"pnpm" test` or `env pnpm test`
- `pnpm test:watch` and unrelated commands
- Newlines, carriage returns, `;`, `|`, `&`, `<`, `>`, backticks, and `$(`
- Every command that begins with `rtk`

For an unsupported form, use `rtk test ...` explicitly. For example, run `rtk test pnpm run test`.

The startup probe can throw, exit nonzero, be killed, or time out. In these cases, the extension blocks supported `pnpm test` calls. The block message tells you to install RTK and verify `rtk test --help`. Other calls stay unchanged. The package does not warn at startup. After you repair RTK, reload the extension or restart Pi. The probe then runs again.
