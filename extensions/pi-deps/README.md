# `@henryqw/pi-deps`

Start locked Node and uv dependency installs when Git creates a worktree with repository opt-in. Developers can use the same hook with different worktree tools. The hook adds no work to each Pi startup.

## Install

```bash
pi install npm:@henryqw/pi-deps
```

## Use

Run `/deps` in a trusted repository to enable dependency preparation. Create a worktree through Git to run its `post-checkout` hook. Then open Pi in TUI mode in that worktree. Pi shows install progress without command output. Run `/deps` again to disable future dependency preparation.

| Surface | Type | Purpose |
| --- | --- | --- |
| `/deps` | command | For humans: enable or disable preparation for future Git worktrees in this repository. |
| Pi footer status | ui | For humans in TUI mode: show a dim spinner and elapsed time while dependencies install. Clear the status without a message on success. Show a visible error and log path on failure. |

- The shared `post-checkout` hook applies to every worktree in the repository. Run `/deps` from any worktree to enable or disable it.
- The extension never overwrites or removes a hook without this package's marker.
- After you update the package, run `/deps` two times in each repository with repository opt-in. This replaces the copied hook with the current version.

## Flow

![Dependency preparation with synchronous validation and detached installs](./docs/dependency-preparation-flow.svg)

- When the hook runs, worktree creation returns without waiting for dependency installation.
- The hook validates lockfiles synchronously. Conflicting Node lockfiles, `packageManager` mismatches, and unsupported declarations still cause the worktree command to fail immediately.
- A detached installer runs frozen installs in the background.
- A Pi TUI session in the worktree watches install progress. At startup, it does not wait for completion. It shows a dim footer status such as `⠋ deps · installing 12s`. It clears the status without a success message. During its ten-minute wait, it reports failures, including missing executables. RPC, JSON, and print sessions do not show or consume this status.

Node and uv both run when both lockfile types exist.

## State and storage

The installer stores its result in `<worktree gitdir>/pi-deps/status.json`. Command output is in the adjacent `install.log`.

After a Pi TUI session reports the status file, the session removes it. Other worktree tools get the same background install only when they run the Git `post-checkout` hook. Tools that do not run the hook do not prepare dependencies. This includes tools that create detached worktrees without a checkout. Non-Pi consumers must read the status file themselves.

## Limits and recovery

Dependency installation can execute repository-controlled build and install scripts. Enable only repositories that you trust.

- A configured `core.hooksPath` replaces the shared hooks directory. `/deps` refuses to install the hook where Git would ignore or share it.
- Pi Deps examines only Git-root lockfiles.
- The package managers control root npm and uv workspaces. Pi Deps does not scan nested independent projects.
- The installer skips Node installs when `node_modules` exists. It skips only Yarn installs when `.pnp.cjs` exists. It skips uv installs when `.venv` exists.
- `git worktree add --no-checkout` never runs `post-checkout`. These worktrees do not get dependency preparation. `git worktree add --detach` with a checkout does run the hook.
- Installs finish after creation returns. A consumer can use a worktree before dependencies are ready.
- If the status is still `running` after ten minutes, the TUI watcher removes it. The watcher also clears the footer status and shows an error with the log path. This stops only the watcher, not the installer. Examine the adjacent `<worktree gitdir>/pi-deps/install.log` for installer command output and any `pi-deps:` failure message. The log stays available after the watcher removes the status file. If you open Pi again, Pi does not restore a status that the watcher removed.
- When you close Pi, Pi stops its progress watcher and animation. It does not cancel the detached installer or consume its pending result.

The root lockfile selects the manager and command in the table below. A matching `packageManager` declaration selects the same command for all declared versions. The hook does not compare versions with the installed executable.

Explicit `yarn@1.x` declarations fail immediately because the hook does not support Yarn Classic. If only `yarn.lock` exists and there is no `packageManager`, the hook assumes modern Yarn. It runs `--immutable`. If the executable is Yarn Classic, installation fails in the background.

| Manager | Command | Lockfile |
| --- | --- | --- |
| npm | `npm ci` | `package-lock.json`, `npm-shrinkwrap.json` |
| pnpm | `pnpm install --frozen-lockfile` | `pnpm-lock.yaml` |
| Yarn | `yarn install --immutable` | `yarn.lock` (no support for Yarn Classic 1.x) |
| Bun | `bun install --frozen-lockfile` | `bun.lock`, `bun.lockb` |
| uv | `uv sync --locked` | `uv.lock` |
