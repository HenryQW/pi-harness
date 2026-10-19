# `@henryqw/pi-codegraph`

Prepare a separate [CodeGraph](https://github.com/colbymchenry/codegraph) index for each Git worktree and keep it current while Pi runs. Agents use `codegraph_explore` to get relevant source and call paths.

## Install

```bash
npm install -g @colbymchenry/codegraph
pi install npm:@henryqw/pi-codegraph
```

Put the `codegraph` executable on Pi's `PATH`. Keep Pi's built-in MCP support enabled for automatic index updates. The extension registers its MCP server; no MCP configuration is necessary.

## Works with

| Package | Relationship | Purpose |
| --- | --- | --- |
| [`@colbymchenry/codegraph`](https://github.com/colbymchenry/codegraph) | Required | Builds indexes and answers `codegraph explore` queries. |
| [`@henryqw/pi-footer`](https://pi.henry.wang/extensions/pi-footer) | Improves | Shows index status, setup progress, and direct tool activity. |

## Use

Start `pi` in a linked worktree. If the primary checkout has no index, the TUI asks for indexing consent once per repository. Accept to run `codegraph init --yes` there, then create the worktree index. Alternatively, run this command in the primary checkout yourself:

```bash
codegraph init --yes
```

| Surface | Type | Purpose |
| --- | --- | --- |
| `codegraph_explore` | tool | For agents: returns relevant symbol source grouped by file, with call paths. |
| `pi-codegraph` | mcp server | Runs `codegraph serve --mcp --path <worktree-root>`. Its file watcher updates the index. Its tools are hidden. |
| CodeGraph setup status | ui | Shows users `✓ CG` for indexed, `○ CG` for missing, or a dim spinner with elapsed setup time. Errors include recovery instructions. |

`codegraph_explore` accepts `query`, optional `maxFiles` (default 12), and optional `projectPath` (default: Pi's working directory). It runs `codegraph explore --path <projectPath> --max-files <maxFiles> <query>` and returns unchanged output. A command error or runtime above 120 seconds fails the tool call and shows the end of the error output.

Works with `codemode`, including `codemode.mode` set to `only`. Scripts call `tools.codegraph_explore({ query })` and receive a string.

## Flow

Setup starts with Pi, not when Git creates a worktree. In the TUI, setup runs in the background. RPC, print, and JSON modes do not ask for consent. RPC waits for setup before it can accept an answer.

If you decline or press Escape, the extension writes `pi-codegraph-declined` in the Git common directory. Delete that file to permit another consent request. Automatic worktree setup requires a primary index. The extension does not initialize non-Git directories or offer to index bare repositories.

Each checkout has a separate index. Once ready, the MCP file watcher updates it, including uncommitted edits and changes in the primary checkout. Sessions share one CodeGraph daemon per checkout. It stops five minutes after the last session closes.

### Index status

During setup, the footer shows a dim status such as `⠋ CG · indexing 8s`. It shows `waiting for index` while another session initializes the index. Only the TUI animates the spinner. Setup ends with the indexed or missing badge, without a success notice. Non-Git directories have no badge.

Missing prerequisites and setup failures remain visible as `! CG: prerequisites missing` or `! CG: setup failed`. Each has a theme-colored `!` icon and a notice with recovery instructions. With `pi-footer`, status stays on the third line. Direct `codegraph_explore` calls temporarily show `● CG`.

Creating, resuming, or forking a session waits for active initialization without interrupting it. Quitting or reloading Pi cancels setup. Interrupted setup requires explicit lock recovery.

## State and storage

Each checkout owns `.codegraph/codegraph.db`. The extension can read other indexes to prepare it, but does not change them. It writes `pi-codegraph-init.lock` in the worktree's Git metadata and `pi-codegraph-declined` in the Git common directory.

To create a worktree index, the extension copies a complete index of the same repository that the installed CodeGraph version built. It picks the index with the fewest changed files compared to the worktree `HEAD`. During the copy, it holds the source writer lock `.codegraph/codegraph.lock` and skips a source that another writer locks. It then runs `codegraph sync <worktree-root>`.

The extension accepts a copied index only when `codegraph status --json` exits with code 0 and reports `index.state:"complete"` and `index.reindexRecommended:false`. Otherwise, it deletes the copy and tries the next index. If no index is usable, it runs `codegraph init --yes <worktree-root>`.

The extension does not add ignore rules, delete indexes, or prune worktrees. Add `.codegraph/` to your ignore rules if necessary. Pi Subagent retains ignored files to prevent data loss, so indexed worker worktrees can require manual cleanup.

## Limits and recovery

If the startup check `codegraph --version` fails, Pi warns, reports `prerequisites missing`, and skips setup. Install or fix the executable, then restart Pi or run `/reload`. The extension never installs prerequisites automatically.

Failed or interrupted initialization keeps `pi-codegraph-init.lock` to block use of a partial database. To recover:

1. Make sure that no initializer runs.
2. Run `codegraph index` from the affected worktree root, not a nested directory or another checkout.
3. After success, use `rmdir` to remove the lock directory at the path in the error message.
4. Run `/reload`.

For example:

```bash
cd /path/to/affected-worktree-root && codegraph index && rmdir /path/to/pi-codegraph-init.lock
```

For a primary-checkout failure, use the primary checkout and its lock. The error shows both paths.

Do not remove an active lock or run manual `codegraph init` commands during initialization. The lock does not control manual commands. Existing indexes without an extension-owned lock receive no health check.

Only Git worktree-root indexes in the default `.codegraph` directory are supported. Nested monorepo indexes do not initialize automatically. Keep the primary checkout indexed for automatic opt-in detection.

Each daemon uses approximately 230 MB of memory. With MCP disabled, for example through `--no-mcp`, indexes become stale. Run `codegraph sync` in the checkout to update its index. An `mcp.json` server named `pi-codegraph` replaces the extension's server.
