# @henryqw/pi-codegraph

Get a separate [CodeGraph](https://github.com/colbymchenry/codegraph) index when you start Pi in a new Git worktree. Use CodeGraph's explore tool through pi-mcp-adapter from Pi.

## Install

```bash
npm install -g @colbymchenry/codegraph
pi install npm:pi-mcp-adapter
pi install npm:@henryqw/pi-codegraph
```

Requires `codegraph` CLI on `PATH`, and [pi-mcp-adapter](https://github.com/nicobailon/pi-mcp-adapter).

## Use

From the primary checkout, initialize CodeGraph once:

```bash
codegraph init --yes
```

Then launch `pi` in a linked worktree. The adapter server is `henryqw_pi-codegraph__codegraph`. It discovers tools lazily; other CodeGraph tools remain available through `mcp`.

## Flow

- A missing worktree index is built only when the primary checkout already has `.codegraph/codegraph.db`.
- Initialization happens when Pi launches, not when Git creates the worktree.
- Each linked worktree keeps its own `.codegraph`; databases are never copied or shared between branches.
- Non-Git directories and repositories without a primary index are not initialized.
- When loaded, the extension reports whether the local index is `indexed`, `missing`, or `indexing…` through Pi's status channel. The `pi-footer` extension places a compact `CG` badge first on its third line and temporarily shows `● CG` during direct CodeGraph tool calls.

## State and storage

The extension relies on CodeGraph's own state — each worktree maintains its own `.codegraph/codegraph.db`. The extension never copies, shares, or modifies this database. Existing indexes are left alone; CodeGraph owns synchronization when its MCP server runs.

## Limits and recovery

At startup, the extension checks for a loaded adapter and runs `codegraph --version`. If either prerequisite is unavailable, Pi warns, reports `prerequisites missing`, and skips setup. Restart Pi or run `/reload` after fixing prerequisites.

Initialization uses an exclusive `pi-codegraph-init.lock` in the worktree's Git metadata. Failed or interrupted initialization keeps the lock so a partial database is not accepted. To recover: remove the lock directory with `rmdir` only after `codegraph index` succeeds, then run `/reload`.

The package never installs prerequisites automatically. The `codegraph` executable must be available to both Pi and its MCP child process. Only Git worktree-root indexes using the default `.codegraph` directory are supported; nested monorepo indexes are not initialized automatically. The primary checkout must remain indexed for automatic opt-in detection.

Do not remove an active lock. Existing indexes without an extension-owned lock are not health-checked. The lock coordinates this extension's sessions, not manual `codegraph init` commands; avoid running those during initialization.

The extension does not add ignore rules, delete indexes, or prune worktrees — add `.codegraph/` to your own ignore rules if needed. Pi Subagent conservatively treats ignored files as retained work: an indexed worker worktree may require manual cleanup.

If you already configured a `codegraph` server manually, remove that entry after confirming the package server works. Keeping both can expose duplicate servers/tools. The extension does not change your MCP configuration.
