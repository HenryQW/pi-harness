# `@henryqw/pi-deps`

Start locked Node and uv dependency installs whenever Git creates a worktree for an opted-in repository. Developers using several worktree tools get one shared hook without adding work to every Pi startup.

## Install

```bash
pi install npm:@henryqw/pi-deps
```

## Use

Run `/deps` in a trusted repository to enable preparation. Create a worktree through Git so its `post-checkout` hook runs, then open Pi in TUI mode there to see install progress and the result. Run `/deps` again to disable future preparation.

| Surface | Type | Purpose |
| --- | --- | --- |
| `/deps` | command | For humans: enable or disable preparation for future Git worktrees in this repository. |
| Pi worktree status widget | ui | For humans in TUI mode: show background install progress and its result in a prepared worktree. |

- The shared `post-checkout` hook applies to every worktree in the repository; run `/deps` from any worktree to toggle it.
- Hooks without this package's marker are never overwritten or removed.
- After updating the package, run `/deps` twice in each opted-in repository. This replaces the copied hook with the current version.

## Flow

![Dependency preparation with synchronous validation and detached installs](./docs/dependency-preparation-flow.svg)

- Worktree creation returns without waiting for dependency installation when the hook runs.
- The hook validates lockfiles synchronously. Conflicting Node lockfiles, `packageManager` mismatches, and unsupported declarations still fail the worktree command fast.
- A detached installer runs frozen installs in the background.
- A Pi TUI session in the worktree shows a widget while installing without waiting for completion at startup. It auto-dismisses success after five seconds and keeps failures visible, including missing executables. RPC, JSON, and print sessions do not show or consume this status.

Node and uv both run when both lockfile types exist.

## State and storage

The installer stores its result in `<worktree gitdir>/pi-deps/status.json`. Command output is in the adjacent `install.log`.

The status file is removed once a Pi TUI session reports it. Other tools that create worktrees get the same background install only when they invoke Git's `post-checkout` hook; tools that do not run the hook, including those that create detached worktrees without a checkout, do not prepare dependencies. Non-Pi consumers must read the status file themselves.

## Limits and recovery

Dependency installation may execute repository-controlled build and install scripts. Enable only repositories you trust.

- A configured `core.hooksPath` replaces the shared hooks directory. `/deps` refuses instead of installing where Git would ignore or share the hook.
- Only Git-root lockfiles are inspected.
- Root npm and uv workspaces remain package-manager concerns. Nested independent projects are not scanned.
- Already-present `node_modules` skips Node installs; `.pnp.cjs` skips Yarn installs only; `.venv` skips uv installs.
- Worktrees created with `git worktree add --no-checkout` never run `post-checkout`, so they are not prepared. `git worktree add --detach` with a checkout does run the hook.
- Installs finish after creation returns. A consumer may use a worktree before dependencies are ready.

The root lockfile selects the manager and command below. A matching `packageManager` declaration selects the same command regardless of its declared version; versions are not checked against the installed executable. Explicit `yarn@1.x` declarations fail fast because Yarn Classic is unsupported. With only `yarn.lock` and no `packageManager`, the hook assumes modern Yarn and runs `--immutable`; if the executable is Yarn Classic, installation fails in the background.

| Manager | Command | Lockfile |
| --- | --- | --- |
| npm | `npm ci` | `package-lock.json`, `npm-shrinkwrap.json` |
| pnpm | `pnpm install --frozen-lockfile` | `pnpm-lock.yaml` |
| Yarn | `yarn install --immutable` | `yarn.lock` (Yarn Classic 1.x is not supported) |
| Bun | `bun install --frozen-lockfile` | `bun.lock`, `bun.lockb` |
| uv | `uv sync --locked` | `uv.lock` |
