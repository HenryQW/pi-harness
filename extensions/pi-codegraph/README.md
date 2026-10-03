# `@henryqw/pi-codegraph`

Get a separate [CodeGraph](https://github.com/colbymchenry/codegraph) index when you start Pi in a new Git worktree, and let agents explore the indexed code with the `codegraph_explore` tool.

## Install

```bash
npm install -g @colbymchenry/codegraph
pi install npm:@henryqw/pi-codegraph
```

Requires only the `codegraph` executable on Pi's `PATH`. No MCP server or MCP configuration is needed.

## Works with

| Package | Relationship | Purpose |
| --- | --- | --- |
| [`@colbymchenry/codegraph`](https://github.com/colbymchenry/codegraph) | Required | Builds the indexes and answers `codegraph explore` queries. |
| [`@henryqw/pi-footer`](https://pi.henry.wang/extensions/pi-footer) | Improves | Shows CodeGraph index status, quiet setup progress, and direct tool activity when loaded. |

## Use

From the primary checkout, initialize CodeGraph once:

```bash
codegraph init --yes
```

Then launch `pi` in a linked worktree. When the primary checkout has an index, pi-codegraph initializes a separate worktree index.

| Surface | Type | Purpose |
| --- | --- | --- |
| `codegraph_explore` | tool | Lets agents explore the indexed code. It returns the source of the relevant symbols grouped by file, plus the call path between them. |
| CodeGraph setup status | ui | Shows an icon and `CG`: `✓ CG` when indexed, `○ CG` when missing, or a dim spinner and elapsed time during setup. Setup errors remain visible with recovery instructions. |

`codegraph_explore` takes a `query`, an optional `maxFiles` (default 12), and an optional `projectPath` (defaults to Pi's working directory). It runs `codegraph explore --path <projectPath> --max-files <maxFiles> <query>` and returns the output as-is. If the command exits with an error or runs longer than 120 seconds, the tool call fails and shows the end of CodeGraph's error output.

## Flow

- A missing worktree index is built only when the primary checkout already has `.codegraph/codegraph.db`.
- Initialization happens when Pi launches, not when Git creates the worktree. In TUI mode it runs in the background so the footer and later startup handlers can load.
- Each linked worktree keeps its own `.codegraph`; databases are never copied or shared between branches.
- Non-Git directories and repositories without a primary index are not initialized.
- Setup shows a dim footer status such as `⠋ CG · indexing 8s`, or `waiting for index` when another session holds the initialization lock. Only TUI mode animates the spinner. When setup finishes, the spinner becomes `✓ CG` for an existing or newly created index, or `○ CG` for a Git repository without an index. Non-Git directories show no index badge. There is no success notification.
- Missing prerequisites and setup failures remain visible as `! CG: prerequisites missing` or `! CG: setup failed`, with a theme-colored `!` icon and an actionable notification.
- Creating, resuming, or forking a session waits for in-flight worktree initialization instead of interrupting it. Repeated startup events reuse that initialization. Quitting or reloading Pi cancels the initializer and every Git probe; interrupted initialization keeps the lock for explicit recovery.
- If `pi-footer` is also loaded, it preserves the setup status on its third line and temporarily shows `● CG` during direct `codegraph_explore` calls.

## State and storage

The extension relies on CodeGraph's own state — each worktree maintains its own `.codegraph/codegraph.db`. The extension never copies or shares the database and does not write it directly: it delegates creation to `codegraph init --yes <worktree-root>`. Existing indexes are left alone.

## Limits and recovery

At startup, the extension runs `codegraph --version`. If that fails, Pi warns, reports `prerequisites missing`, and skips setup. Restart Pi or run `/reload` after fixing prerequisites.

Initialization uses an exclusive `pi-codegraph-init.lock` in the worktree's Git metadata. Failed or interrupted initialization keeps the lock so a partial database is not accepted. To recover, first confirm no initializer is running, then run `codegraph index` **from the affected worktree root** (not the primary checkout or a nested directory). Only after it succeeds, remove the lock directory with `rmdir` using the path in the error message, then run `/reload`:

```bash
cd /path/to/affected-worktree-root && codegraph index && rmdir /path/to/pi-codegraph-init.lock
```

The package never installs prerequisites automatically. Only Git worktree-root indexes using the default `.codegraph` directory are supported; nested monorepo indexes are not initialized automatically. The primary checkout must remain indexed for automatic opt-in detection.

Do not remove an active lock. Existing indexes without an extension-owned lock are not health-checked. The lock coordinates this extension's sessions, not manual `codegraph init` commands; avoid running those during initialization.

The extension does not add ignore rules, delete indexes, or prune worktrees — add `.codegraph/` to your own ignore rules if needed. Pi Subagent conservatively treats ignored files as retained work: an indexed worker worktree may require manual cleanup.
