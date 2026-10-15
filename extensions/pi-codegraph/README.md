# `@henryqw/pi-codegraph`

When you start Pi in a new Git worktree, you get a separate [CodeGraph](https://github.com/colbymchenry/codegraph) index in seconds. CodeGraph keeps the index current while Pi runs. Agents can then explore the indexed code with the `codegraph_explore` tool.

## Install

```bash
npm install -g @colbymchenry/codegraph
pi install npm:@henryqw/pi-codegraph
```

Requires Pi 1.1.0 or later in the 1.x series and the `codegraph` executable on Pi's `PATH`. You do not need MCP configuration. The extension registers the CodeGraph MCP server itself. Pi's built-in MCP support must stay enabled, because the server keeps the index current.

## Works with

| Package | Relationship | Purpose |
| --- | --- | --- |
| [`@colbymchenry/codegraph`](https://github.com/colbymchenry/codegraph) | Required | Builds the indexes and answers `codegraph explore` queries. |
| [`@henryqw/pi-footer`](https://pi.henry.wang/extensions/pi-footer) | Improves | Shows CodeGraph index status, quiet setup progress, and direct tool activity when loaded. |

## Use

Start `pi` in a linked worktree. If the primary checkout has no index, Pi asks one time if it can index the repository. If you accept, pi-codegraph runs `codegraph init --yes` in the primary checkout, then creates the worktree index. You can also initialize the primary checkout yourself:

```bash
codegraph init --yes
```

| Surface | Type | Purpose |
| --- | --- | --- |
| `codegraph_explore` | tool | Lets agents explore the indexed code. It returns the source of the relevant symbols grouped by file, plus the call path between them. |
| `pi-codegraph` | MCP server | Runs `codegraph serve --mcp --path <worktree-root>`. Its file watcher updates the index when files change. Its tools are hidden. |
| CodeGraph setup status | ui | Shows an icon and `CG`: `✓ CG` when indexed, `○ CG` when missing, or a dim spinner and elapsed time during setup. Setup errors remain visible with recovery instructions. |

`codegraph_explore` takes a `query`, an optional `maxFiles` (default 12), and an optional `projectPath` (defaults to Pi's working directory). It runs `codegraph explore --path <projectPath> --max-files <maxFiles> <query>` and returns the output as-is. If the command exits with an error or runs for more than 120 seconds, the tool call fails. The tool call then shows the end of the CodeGraph error output.

The tool works the same with Pi's `codemode`, including `codemode.mode` set to `only`. Scripts call `tools.codegraph_explore({ query })` and receive the CodeGraph text output as a string, because the tool declares no `outputSchema`. Scripts can split, search, or slice that text before they print a summary. Only the script output goes to the model. Thus, print the full string when the model needs the complete source.

## Flow

- The extension builds a missing worktree index only when the primary checkout has `.codegraph/codegraph.db`. If the primary checkout has no index, the TUI or RPC client asks one time for each repository. If you decline, the extension writes `pi-codegraph-declined` in the Git common directory and does not ask again. Remove that file to be asked again. Without a UI, the extension does not ask.
- Initialization occurs when Pi starts, not when Git creates the worktree. In TUI mode, it runs in the background. Thus, the footer and later startup handlers can load.
- Each linked worktree keeps its own `.codegraph`. The extension never shares a database between worktrees.
- To make setup fast, the extension copies one existing index of the same repository, then runs `codegraph sync`. Sync parses again only the files that are different. The result is the same as a full `codegraph init`. The extension selects the index whose indexed commit has the fewest changed files compared to the worktree `HEAD`. It uses only a complete index that the installed CodeGraph version built. If no index is usable, it runs `codegraph init --yes`.
- When the index of the current checkout is ready, the extension registers the hidden `pi-codegraph` MCP server. Pi starts it. The CodeGraph file watcher then syncs each file change, including uncommitted edits. This applies to the primary checkout too. CodeGraph shares one daemon for each checkout between sessions. The daemon stops 5 minutes after the last session closes.
- The extension does not initialize non-Git directories or repositories without a primary index.
- Setup shows a dim footer status such as `⠋ CG · indexing 8s`. When another session holds the initialization lock, it shows `waiting for index`. Only TUI mode animates the spinner. When setup finishes, the spinner changes to `✓ CG` for an existing or new index. For a Git repository without an index, it changes to `○ CG`. Non-Git directories show no index badge. There is no success notification.
- Missing prerequisites and setup failures stay visible as `! CG: prerequisites missing` or `! CG: setup failed`. Each has a theme-colored `!` icon and an actionable notification.
- When you create, resume, or fork a session, Pi waits for the active worktree initialization and does not interrupt it. Repeated startup events use that same initialization. When you quit or reload Pi, the extension cancels the initializer and all Git probes. An interrupted initialization keeps the lock for explicit recovery.
- If `pi-footer` is also loaded, it keeps the setup status on its third line. During direct `codegraph_explore` calls, it temporarily shows `● CG`.

## State and storage

The extension uses the CodeGraph state. Each worktree keeps its own `.codegraph/codegraph.db`. To create a new index, the extension makes a SQLite online backup of an existing index into the new worktree, then runs `codegraph sync <worktree-root>`. Without a usable index, it runs `codegraph init --yes <worktree-root>`. The extension reads other indexes but does not change them. The CodeGraph MCP server updates the index of the current checkout. The extension writes only its lock and the `pi-codegraph-declined` file in the Git metadata.

## Limits and recovery

At startup, the extension runs `codegraph --version`. If that fails, Pi shows a warning, reports `prerequisites missing`, and skips setup. After you fix the prerequisites, restart Pi or run `/reload`.

Initialization uses an exclusive `pi-codegraph-init.lock` in the Git metadata of the worktree. A failed or interrupted initialization keeps the lock, so that the extension does not accept a partial database. To recover, do these steps. First, make sure that no initializer runs. Then run `codegraph index` **from the affected worktree root** (not the primary checkout or a nested directory). Only after it succeeds, remove the lock directory with `rmdir`. Use the path in the error message. Then run `/reload`:

```bash
cd /path/to/affected-worktree-root && codegraph index && rmdir /path/to/pi-codegraph-init.lock
```

The initialization of the primary checkout uses the same procedure with the `pi-codegraph-init.lock` of the primary checkout. If it fails, run `codegraph index` in the primary checkout, remove that lock, then run `/reload`. The error message shows both paths. The extension does not offer to index a bare repository.

The package never installs prerequisites automatically. The package supports only Git worktree-root indexes that use the default `.codegraph` directory. It does not automatically initialize nested monorepo indexes. For automatic opt-in detection, the primary checkout must stay indexed.

Each CodeGraph daemon uses approximately 230 MB of memory. If Pi's MCP support is disabled (for example with `--no-mcp`), the server does not start and indexes become stale. Run `codegraph sync` in the checkout to update its index. If your `mcp.json` has a server named `pi-codegraph`, that server replaces the server of the extension.

Do not remove an active lock. The extension does not do a health check of existing indexes without an extension-owned lock. The lock controls the sessions of this extension, not manual `codegraph init` commands. Do not run those commands during initialization.

The extension does not add ignore rules, delete indexes, or prune worktrees. If necessary, add `.codegraph/` to your own ignore rules. Pi Subagent conservatively treats ignored files as retained work. Thus, an indexed worker worktree can require manual cleanup.
