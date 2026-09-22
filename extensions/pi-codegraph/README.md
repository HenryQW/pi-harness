# pi-codegraph

Get a separate CodeGraph index when you start Pi in a new Git worktree. The package also supplies a lazy CodeGraph MCP server through **pi-mcp-adapter**, including the explore tool. It does not implement an MCP client or edit your MCP configuration.

## Install

Requirements: Pi 0.87.x, Node.js 22.19 or newer, Git, the `codegraph` CLI on `PATH`, and **pi-mcp-adapter 2.36.x or newer within 2.x installed and enabled in Pi**.

```sh
npm install -g @colbymchenry/codegraph
pi install npm:pi-mcp-adapter
pi install npm:@henryqw/pi-codegraph
```

Installing an npm peer dependency alone does not enable the adapter's Pi extension. Install both packages with Pi, then restart Pi or run `/reload`.

Opt a repository in by building its first index in the **primary checkout**:

```sh
cd /path/to/primary-checkout
codegraph init --yes
```

After that, launch `pi` in any linked worktree. The extension initializes when Pi starts, not when Git creates the worktree.

## What happens

- A missing worktree index is built only when the primary checkout already has `.codegraph/codegraph.db`.
- Launching from a subdirectory still initializes the worktree root. Each worktree keeps its own `.codegraph`; databases are never copied or shared between branches.
- Existing indexes are left alone. CodeGraph owns synchronization when its MCP server runs.
- Non-Git directories and repositories without a primary index are not initialized. A first index always requires your explicit `codegraph init`.
- Pi shows initialization or waiting status. Initialization has a ten-minute timeout; concurrent sessions wait up to five minutes for the same worktree's initializer.
- The adapter server is `henryqw_pi-codegraph__codegraph`. It discovers tools lazily and exposes `codegraph_explore` directly without an extra package prefix. Other CodeGraph tools remain available through `mcp`. On a cold connection, CodeGraph may require an explicit `projectPath`; pass the worktree root when its tool schema requests it.

The MCP definition uses the adapter's native `pi.mcp` package discovery. Install this **package**, not just its extension `.ts` file. Loading a single file with `pi -e` does not discover its MCP manifest. When using the whole local harness as a Pi package, its server is instead `henryqw_pi-harness__codegraph`; do not install both forms together.

## Failures and limits

At startup, the extension checks for a loaded adapter and runs `codegraph --version`, even when an index already exists. If either prerequisite is unavailable, Pi warns with the installation command for each missing prerequisite and skips setup without creating a lock. Headless sessions print the same warning to stderr. A broken or timed-out CLI check includes its failure details; if CodeGraph is already installed, check Pi's `PATH`. Restart Pi or run `/reload` after fixing the prerequisites.

The `codegraph` executable must be available to both Pi and its MCP child process. The package never installs either prerequisite automatically.

Initialization uses an exclusive `pi-codegraph-init.lock` directory inside the worktree's Git metadata. Failed or interrupted initialization keeps this lock so a partial database is not accepted on the next launch. Errors include the exact worktree and lock paths. To recover:

1. Confirm no initializer is still running.
2. Inspect the failed index and run `codegraph index` in that worktree.
3. Only after indexing succeeds, remove the reported empty lock directory with `rmdir`, then run `/reload`.

Do not remove an active lock. Existing indexes without an extension-owned lock are not health-checked. The lock coordinates this extension's sessions, not manual `codegraph init` commands or unrelated clients; avoid running those during initialization. A setup error does not remove files or change adapter configuration.

Only Git worktree-root indexes and the default `.codegraph` directory are supported. An alternate `CODEGRAPH_DIR` is rejected. Nested monorepo indexes are not initialized automatically. The primary checkout must remain present and indexed for automatic opt-in detection.

The extension does not add ignore rules, delete indexes, or prune worktrees. Add `.codegraph/` to your own ignore rules if needed. Pi Subagent conservatively treats ignored files as retained work: an indexed worker worktree may require manual cleanup. This package does not weaken those data-loss safeguards.

## Existing MCP configuration

If you already configured a `codegraph` server manually, remove that entry after confirming the package server works. Keeping both can expose duplicate servers/tools. The extension does not change your MCP configuration.
