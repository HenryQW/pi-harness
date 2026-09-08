# `@henryqw/pi-session-recall`

Find decisions and context in past Pi sessions through a local FTS5 index.

Saved transcripts are not injected on every turn. The active tool registration still adds standing prompt cost through its schema, descriptions, and guideline. Returned content enters active model context.

The bundled `pi-session-pattern-miner` skill finds repeated work that may deserve automation.

## Install

```bash
pi install npm:@henryqw/pi-session-recall
```

## Use

Start discovery with a distinctive query:

```json
{ "query": "database migration rollback" }
```

`session_search` returns ranked sessions. The top result includes nearby messages and session bookends.

Use IDs from that result to ask for more context:

```json
{
  "sessionId": "<returned sessionId>",
  "aroundMessageId": "<returned message entryId>",
  "window": 10
}
```

The follow-up returns up to ten messages before and after that anchor on the selected branch.

| Surface | Type | Purpose |
| --- | --- | --- |
| `session_search` | tool | Search past sessions or inspect one. |
| `pi-session-pattern-miner` | skill | Find repeated work and choose the smallest useful automation. |

BM25 is a text-ranking method. Hydrated results include messages read from saved session files.

| Mode | Call | Result |
| --- | --- | --- |
| Discovery | `query` | BM25-ranked top sessions. Adaptive retrieval uses user and assistant text for windows, bookends, anchors, and counts. It omits tool-result messages and sets `toolResultsOmitted:true` when it removes one. Lower hits still include their indexed anchor. Use `detail:"full"` to hydrate every hit with tool-result messages included. |
| Scroll | `sessionId` + `aroundMessageId` | Raw message roles, including tool results, within ±`window` ([1,20]) of the anchor. Re-anchor on the last or first message ID to scroll. Across forks, pass the previous response's `branchTip`; `aroundMessageId` only centers the window and must lie on that branch. |
| Read | `sessionId` | Raw message roles, including tool results, from the session. Large sessions return head 20 + tail 10. Oversized content is bounded to 50k characters and marked with `contentTruncated`. |
| Browse | no args | Recent sessions with path, name, cwd, started date, and preview. |

In the interactive TUI, the collapsed tool block shows the last five visual lines and the earlier-line count. Press `Ctrl+O` to expand the full bounded response. The model always receives the complete tool result.

### Skills

Run `/skill:pi-session-pattern-miner` to find repeated workflows in past sessions. It requires evidence from two independent sessions and checks for existing automation. It prefers a fixed script when model judgment is not needed.

## Flow

Search makes no model calls.

### Query and index

- Prefer distinctive identifiers, package names, issue numbers, or uncommon terms. Use quoted phrases only when exact wording is known.
- The FTS5 trigram index uses AND for multiple words by default. Use `OR` for breadth, quoted phrases for exact matches, and `NOT` to exclude. Wildcards help only stems at least three characters long.
- Only user and assistant text is indexed. Thinking blocks and tool output are not searchable.
- For message text over the 20,000-character indexing budget, only the first and last regions are indexed. The middle is omitted. Phrases and `NEAR` cannot cross those regions, but ordinary AND terms can.
- `sessionId` must be a `.jsonl` file under the Pi sessions directory.

### Context and sync

Hits inside the current session's live context are suppressed. Compacted-away or inactive-branch history stays discoverable. Forked sessions collapse into their parent when both match.

Before browse or discovery, the extension lazily syncs the index from the session tree.

### Retrieval safety

Adaptive discovery leaves tool-result messages out of returned context. Use `detail:"full"`, READ, or SCROLL when you explicitly need them.

Historical tool output may contain secrets or other sensitive data. Raw retrieval places that output in active model context.

## State and storage

The extension maintains the derived SQLite search index at `~/.pi/agent/config/pi-session-recall/index.db`.

This is derived state. Delete it and it rebuilds from your session files.

The index and transcript reads stay local. Transcripts are read in place. Returned content follows the data path of your configured model provider.

## Roll back

Pin the previous release:

```bash
pi install npm:@henryqw/pi-session-recall@1.0.3
```

No index migration or cleanup is needed.

## Limits and recovery

Lazy index sync can fail while walking the session tree. Results still come from the current index and can be partly updated or stale. Files found before failure may have new content, while rows for files the walk did not reach stay stale.

- A partial walk returns top-level `syncWarning`: `{kind:"incomplete-walk"}`. Indexed-but-unseen paths are never purged in that case.
- A total sync failure returns top-level `syncWarning`: `{kind:"sync-failed", error}` with the capped failure message.
- The warning is omitted after a completed sync.

Session directories whose encoded path starts with `--tmp-` or `--private-tmp-` are never indexed. These sessions run from `/tmp` or `/private/tmp`.

Session files over 32 MiB are excluded from indexing and hydration. Discovery cannot newly find them.

READ and SCROLL return an explicit size error. A stale discovery hit from before a file grew returns metadata with empty messages and that error.
