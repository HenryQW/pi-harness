# `@henryqw/pi-session-recall`

Search past Pi sessions with one `session_search` tool. Its arguments select one of four modes.

It uses local FTS5 and makes zero LLM calls. It returns raw messages only.

## Why

- **Created for**: Recover decisions and context from prior sessions without keeping every transcript in the active prompt.
- **Advantage**: Local FTS5 search gives fast, private recall with zero standing context cost and no model calls.

## Install

```bash
pi install npm:@henryqw/pi-session-recall
```

## Use

BM25 is a text-ranking method. Hydrated results include messages read from saved session files.

| Mode | Call | Result |
| --- | --- | --- |
| Discovery | `query` | BM25-ranked top sessions. The top hit is hydrated with a ±5 message window and first/last-3 bookends. Lower hits include the matched anchor message and metadata. `detail:"full"` hydrates all. |
| Scroll | `sessionId` + `aroundMessageId` | ±`window` messages ([1,20]) around the anchor on its branch. Re-anchor on the last or first message id of the returned window to scroll forward or backward. Across forks, pass the previous response's `branchTip`; `aroundMessageId` only centers the window and must lie on that branch. |
| Read | `sessionId` | The whole session. Large sessions return head 20 + tail 10. Oversized content is bounded to 50k characters and marked with `contentTruncated`. |
| Browse | no args | Recent sessions with path, name, cwd, started date, and preview. |

### Query syntax and indexed text

- Prefer distinctive identifiers, package names, issue numbers, or uncommon terms. Use quoted phrases only when exact wording is known.
- The FTS5 trigram index uses AND for multiple words by default. Use `OR` for breadth, quoted phrases for exact matches, and `NOT` to exclude. Wildcards help only stems ≥3 characters.
- Only user and assistant text is indexed. Thinking blocks and tool output are not searchable.
- For message text over the 20,000-character indexing budget, only the first and last regions are indexed. The middle is omitted. Phrases and `NEAR` cannot cross those regions, but ordinary AND terms can.
- `sessionId` must be a `.jsonl` file under the Pi sessions directory.

### Context and sync

Hits inside the current session's live context are suppressed. Compacted-away or inactive-branch history stays discoverable. Forked sessions collapse into their parent when both match.

Before browse or discovery, lazy index sync can fail while walking the session tree. Results still come from the current index and can be partly updated or stale. Files found before failure may have new content, while rows for files the walk did not reach stay stale.

- A partial walk returns top-level `syncWarning`: `{kind:"incomplete-walk"}`. Indexed-but-unseen paths are never purged in that case.
- A total sync failure returns top-level `syncWarning`: `{kind:"sync-failed", error}` with the capped failure message.
- The warning is omitted after a completed sync.

## State

The extension maintains the derived SQLite search index at `~/.pi/agent/config/pi-session-recall/index.db`.

## Deliberate exclusions

Session directories whose encoded path starts with `--tmp-` or `--private-tmp-` are never indexed. These sessions run from `/tmp` or `/private/tmp`.

Session files over 32 MiB are excluded from indexing and hydration. Discovery cannot newly find them.

READ and SCROLL return an explicit size error. A stale discovery hit from before a file grew returns metadata with empty messages and that error.

## Storage & privacy

This is derived state. Delete it and it rebuilds from your session files.

Everything stays local. Transcripts are read in place, and nothing leaves the machine beyond what tool results already show the model.
