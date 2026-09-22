# @henryqw/pi-codegraph

Get a separate [CodeGraph](https://github.com/colbymchenry/codegraph) index when you start Pi in a new Git worktree. Use CodeGraph's explore tool through pi-mcp-adapter from Pi.

## Install

```bash
pi install npm:@henryqw/pi-codegraph
```

```bash
npm install -g @colbymchenry/codegraph
pi install npm:pi-mcp-adapter
pi install npm:@henryqw/pi-codegraph
```

Requires `codegraph` CLI on `PATH`, and [pi-mcp-adapter](https://github.com/nicobailon/pi-mcp-adapter).

## Use

Launch `pi` in a linked worktree after initializing CodeGraph in the primary checkout with `codegraph init --yes`. The adapter server is `henryqw_pi-codegraph__codegraph`. It discovers tools lazily; other CodeGraph tools remain available through `mcp`.

## Flow

- A missing worktree index is built only when the primary checkout already has `.codegraph/codegraph.db`.
- Initialization happens when Pi launches, not when Git creates the worktree.
- Each linked worktree keeps its own `.codegraph`; databases are never copied or shared between branches.
- Non-Git directories and repositories without a primary index are not initialized.

## State and storage

The extension relies on CodeGraph's own state — each worktree maintains its own `.codegraph/codegraph.db`. The extension never copies, shares, or modifies this database. Existing indexes are left alone; CodeGraph owns synchronization when its MCP server runs.

## Limits and recovery

At startup, the extension checks for a loaded adapter and runs `codegraph --version`. If either prerequisite is unavailable, Pi warns and skips setup. Restart Pi or run `/reload` after fixing prerequisites.

Initialization uses an exclusive `pi-codegraph-init.lock` in the worktree's Git metadata. Failed or interrupted initialization keeps the lock so a partial database is not accepted. To recover: remove the lock directory with `rmdir` only after `codegraph index` succeeds, then run `/reload`.

The package never installs prerequisites automatically. The `codegraph` executable must be available to both Pi and its MCP child process. An alternate `CODEGRAPH_DIR` is not supported. The extension does not add ignore rules, delete indexes, or prune worktrees — add `.codegraph/` to your own ignore rules if needed. Pi Subagent and Pi Orchestrator conservatively treat ignored files as retained work.

If you already configured a `codegraph` server manually, remove that entry after confirming the package server works.
