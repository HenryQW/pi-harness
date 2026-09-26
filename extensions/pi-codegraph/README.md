# `@henryqw/pi-codegraph`

Get a separate [CodeGraph](https://github.com/colbymchenry/codegraph) index when you start Pi in a new Git worktree. Use CodeGraph's explore tool through pi-mcp-adapter from Pi.

## Install

```bash
npm install -g @colbymchenry/codegraph
pi install npm:pi-mcp-adapter
pi install npm:@henryqw/pi-codegraph
```

Requires the `codegraph` CLI on `PATH` and [pi-mcp-adapter](https://github.com/nicobailon/pi-mcp-adapter).

## Works with

| Package | Relationship | Purpose |
| --- | --- | --- |
| [`@colbymchenry/codegraph`](https://github.com/colbymchenry/codegraph) | Required | Builds the indexes and serves CodeGraph tools over MCP. |
| [`@henryqw/pi-footer`](https://pi.henry.wang/extensions/pi-footer) | Improves | Shows a compact CodeGraph index badge and direct tool activity when loaded. |
| [`pi-mcp-adapter`](https://github.com/nicobailon/pi-mcp-adapter) | Required | Connects the MCP server to Pi. |

## Use

From the primary checkout, initialize CodeGraph once:

```bash
codegraph init --yes
```

Then launch `pi` in a linked worktree. When the primary checkout has an index, pi-codegraph initializes a separate worktree index and exposes CodeGraph tools through pi-mcp-adapter.

| Surface | Type | Purpose |
| --- | --- | --- |
| `codegraph_explore` | tool | Lets agents explore the indexed code through CodeGraph. |
| `mcp` | tool | Lets agents call other CodeGraph tools through the `henryqw_pi-codegraph__codegraph` adapter server. |
| CodeGraph setup status | ui | Shows users setup progress and errors, and confirms a new worktree index is ready. |

The adapter discovers tools lazily.

## Flow

- A missing worktree index is built only when the primary checkout already has `.codegraph/codegraph.db`.
- Initialization happens when Pi launches, not when Git creates the worktree.
- Each linked worktree keeps its own `.codegraph`; databases are never copied or shared between branches.
- Non-Git directories and repositories without a primary index are not initialized.
- The extension reports `checking index…` and `indexing…` during setup, `indexed` when a database file exists, `missing` when no index was built, `prerequisites missing` when setup was skipped, and `setup failed` on an error. `indexed` does not guarantee database health.
- If `pi-footer` is also loaded, it places a compact `CG` badge first on its third line: `✓ CG` indexed, `○ CG` missing, `◐ CG` checking or indexing, `! CG` setup problem, or `? CG` unknown state. It temporarily shows `● CG` only during direct `codegraph_explore` calls or `codegraph_*` calls through this package's MCP server, not for every MCP call.

## State and storage

The extension relies on CodeGraph's own state — each worktree maintains its own `.codegraph/codegraph.db`. The extension never copies or shares the database and does not write it directly: it delegates creation to `codegraph init --yes <worktree-root>`. Existing indexes are left alone; CodeGraph owns synchronization when its MCP server runs.

## Limits and recovery

At startup, the extension checks for a loaded adapter and runs `codegraph --version`. If either prerequisite is unavailable, Pi warns, reports `prerequisites missing`, and skips setup. Restart Pi or run `/reload` after fixing prerequisites.

Initialization uses an exclusive `pi-codegraph-init.lock` in the worktree's Git metadata. Failed or interrupted initialization keeps the lock so a partial database is not accepted. To recover, first confirm no initializer is running, then run `codegraph index` **from the affected worktree root** (not the primary checkout or a nested directory). Only after it succeeds, remove the lock directory with `rmdir` using the path in the error message, then run `/reload`:

```bash
cd /path/to/affected-worktree-root && codegraph index && rmdir /path/to/pi-codegraph-init.lock
```

The package never installs prerequisites automatically. The `codegraph` executable must be available to both Pi and its MCP child process. Only Git worktree-root indexes using the default `.codegraph` directory are supported; nested monorepo indexes are not initialized automatically. The primary checkout must remain indexed for automatic opt-in detection.

Do not remove an active lock. Existing indexes without an extension-owned lock are not health-checked. The lock coordinates this extension's sessions, not manual `codegraph init` commands; avoid running those during initialization.

The extension does not add ignore rules, delete indexes, or prune worktrees — add `.codegraph/` to your own ignore rules if needed. Pi Subagent conservatively treats ignored files as retained work: an indexed worker worktree may require manual cleanup.

If you already configured a `codegraph` server manually, remove that entry after confirming the package server works. Keeping both can expose duplicate servers/tools. The extension does not change your MCP configuration.
