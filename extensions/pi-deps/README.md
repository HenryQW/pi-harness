# `@henryqw/pi-deps`

Start locked Node and uv dependency installs when Git creates a worktree in an opted-in repository. See [the hook design decision](./docs/adr/0001-prepare-dependencies-at-worktree-creation.md).

## Install

```bash
pi install npm:@henryqw/pi-deps
```

## Use

Run `/deps` in a trusted repository. Create a worktree through Git, then open Pi there in TUI mode to see install progress.

| Surface | Type | Purpose |
| --- | --- | --- |
| `/deps` | command | For humans: enable or disable dependency preparation for future worktrees. Works from any worktree in the repository. |
| Pi footer status | ui | For TUI users: show a dim spinner and elapsed install time, without command output. Success clears it silently; failures show errors and log paths. |

The shared `post-checkout` hook applies to every worktree. The extension never overwrites or removes hooks without its marker.

For the version 4 cutover, use [the migration steps](#migration-to-version-4). A package update does not replace an installed hook. For later updates, run `/deps` twice in each opted-in repository to replace it.

## Flow

![Dependency preparation with validation, an install-needed decision, and selected detached installs](./docs/dependency-preparation-flow.svg)

Synchronous lockfile validation immediately fails the worktree command for conflicting Node lockfiles, mismatched `packageManager`, and unsupported declarations.

After validation, detached frozen installs run. Node and uv both run when both lockfile types exist. Worktree creation and Pi startup do not wait: dependencies can still be unavailable when you use the worktree.

Only tools that run `post-checkout` prepare dependencies. `git worktree add --no-checkout` does not; `git worktree add --detach` with checkout does.

## State and storage

Results go to `<worktree>/.context/pi-harness/pi-deps/status.json`; command output goes to adjacent `install.log`. Non-Pi consumers must use these paths too.

The first Pi TUI session to report a completed result removes the status file. RPC, JSON, and print sessions neither show nor consume it. The state directory uses mode `0700`; status and log files use mode `0600` (owner access only).

These files can make the Git worktree dirty. If `.context/` is not ignored, pi-subagent and `/pr` clean-worktree checks can fail. Configure a Git exclusion if you use those workflows. The installer log can contain sensitive output. Inspect it before you share or stage it; the extension does not change ignore rules.

### Migration to version 4

This cutover is manual. There is no legacy-path fallback. Repeat these steps for each opted-in repository and each of its worktrees:

1. Stop new worktree creation. In the old Pi version, run `/deps` once to disable its copied shared hook. Check that Pi reports it disabled. Stop all old Pi sessions and other old hooks that write this state. Wait for every detached install to finish. Check processes and logs: a `running` status can remain after a failed process.
2. From each worktree, copy and verify the old status and log. This leaves the old files in place and refuses an existing destination. If it stops, inspect both paths and resolve the conflict manually; do not overwrite or delete malformed files.

The commands reject symbolic links and create private copies, not copies of legacy permissions. In `set -euC`, `-e` stops on failure, `-u` rejects unset variables, and `-C` prevents file replacement. `umask 077` removes group and other access; `mkdir -m` sets the directory mode. In the tests, `-e` checks existence, `-L` checks symbolic links, `-f` checks regular files, and `-d` checks directories.

```bash
(
  set -euC
  umask 077
  root=$(git rev-parse --show-toplevel)
  old=$(git rev-parse --path-format=absolute --git-dir)/pi-deps
  new="$root/.context/pi-harness/pi-deps"
  for file in status.json install.log; do
    if [ -e "$old/$file" ] || [ -L "$old/$file" ]; then
      if [ -L "$old/$file" ] || [ ! -f "$old/$file" ]; then
        echo "Unsafe source: $old/$file" >&2; exit 1
      fi
      for dir in "$root/.context" "$root/.context/pi-harness" "$new"; do
        if [ -L "$dir" ] || { [ -e "$dir" ] && [ ! -d "$dir" ]; }; then
          echo "Unsafe directory: $dir" >&2; exit 1
        fi
        if [ ! -d "$dir" ]; then mkdir -m 700 "$dir"; fi
      done
      chmod 700 "$new"
      if [ -e "$new/$file" ] || [ -L "$new/$file" ]; then
        echo "Destination exists: $new/$file" >&2; exit 1
      fi
      cat "$old/$file" > "$new/$file"
      cmp "$old/$file" "$new/$file"
      echo "Verified: $new/$file"
    fi
  done
)
```

3. Update every non-Pi status/log consumer to the new paths. Upgrade the package. In one new Pi session per opted-in repository, run `/deps` once to install the new copied hook. Confirm that Pi reports it enabled before you resume worktree creation. Do not run an old hook or old Pi session after the copy.

## Limits and recovery

Dependency installation can execute repository-controlled build and install scripts. Enable only repositories that you trust.

`/deps` refuses a configured `core.hooksPath` that replaces the shared hooks directory, where Git could ignore or share the hook.

Only Git-root lockfiles count. Package managers handle root npm and uv workspaces; Pi Deps does not scan nested independent projects.

| Existing path | Install skipped |
| --- | --- |
| `node_modules` | Node |
| `.pnp.cjs` | Yarn only |
| `.venv` | uv |

After ten minutes, the TUI watcher stops waiting, clears the footer, and reports the log path. It preserves a pending status so that a late installer result is not lost. It stops watching, not the installer. Open Pi again to read the result. If an installer stopped without a result, confirm that no install process remains. Then remove `<worktree>/.context/pi-harness/pi-deps/status.json`.

Closing Pi stops its watcher and animation, but does not cancel the installer or consume its pending result.

For failures, including missing executables, examine `<worktree>/.context/pi-harness/pi-deps/install.log` for command output and `pi-deps:` messages. The log remains after status removal. Invalid status is preserved for inspection; the hook refuses to replace it. State path components must be real directories; status and log paths must be regular files without extra hard links. Unsafe paths remain unchanged and produce an error. These checks do not protect against a hostile same-user process that swaps paths during use.

### Package managers

The root lockfile selects the command. A matching `packageManager` uses that command for all declared versions; the hook does not compare installed executable versions.

Explicit `yarn@1.x` fails immediately. With only `yarn.lock` and no `packageManager`, the hook assumes modern Yarn; a Yarn Classic executable fails in the background.

| Manager | Command | Lockfile |
| --- | --- | --- |
| npm | `npm ci` | `package-lock.json`, `npm-shrinkwrap.json` |
| pnpm | `pnpm install --frozen-lockfile` | `pnpm-lock.yaml` |
| Yarn | `yarn install --immutable` | `yarn.lock` (no support for Yarn Classic 1.x) |
| Bun | `bun install --frozen-lockfile` | `bun.lock`, `bun.lockb` |
| uv | `uv sync --locked` | `uv.lock` |
