# `@henryqw/pi-rtk-test`

Keep long `pnpm test` output out of Pi's model context. Supported direct Bash calls use RTK, which reports failures and a short result instead of the full log.

## Install

```bash
pi install npm:@henryqw/pi-rtk-test
```

Install Rust Token Killer (`rtk`) on Pi's `PATH`; this extension never installs or updates it.

```bash
brew install rtk
rtk --version

rtk init -g --agent pi
```

## Use

Keep your commands unchanged. Pi rewrites these direct Bash calls before execution:

| Pi command | Bash command |
| --- | --- |
| `pnpm test` | `rtk test pnpm test` |
| `pnpm test -- marker` | `rtk test pnpm test -- marker` |

Only leading and trailing whitespace is removed. RTK runs tests and controls output and exit status; this extension never captures output or examines results.

## Limits and recovery

Only bare `pnpm test` with optional test arguments is supported. These forms stay unchanged:

- `pnpm run test` and `pnpm run-script test`
- Global or workspace options, such as `pnpm --filter pkg test`
- Quoted or indirect programs: `"pnpm" test`, `env pnpm test`
- `pnpm test:watch` and unrelated commands
- Newlines, carriage returns, `;`, `|`, `&`, `<`, `>`, backticks, and `$(`
- Commands starting with `rtk`

Use `rtk test ...` explicitly for unsupported forms, for example `rtk test pnpm run test`.

At load, `rtk test --help` runs once with a two-second timeout. A thrown error, nonzero exit, kill signal, or timeout blocks supported calls without a startup warning. Other calls stay unchanged. The block message says:

```text
RTK is unavailable. Install RTK and verify `rtk test --help`.
```

Repair RTK, then reload the extension or restart Pi to repeat the probe.
