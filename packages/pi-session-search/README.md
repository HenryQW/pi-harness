# @henryqw/pi-session-search

FTS5 search over past Pi sessions: single `session_search` tool with four arg-inferred modes, zero LLM calls, raw messages only.

## Install

```bash
pi install npm:@henryqw/pi-session-search
```

## Use

| Call shape | Args | Returns |
| --- | --- | --- |
| **Discovery** | `query` (+ optional `limit`, `detail`) | Top N sessions ranked by BM25; top hit hydrated with a ±5 message window and first/last-3 bookends; lower hits anchor + metadata (`detail:"full"` hydrates all) |
| **Scroll** | `sessionId` + `aroundMessageId` (+ `window`, [1,20]) | ±N messages around the anchor on its branch |
| **Read** | `sessionId` | Whole session; head 20 + tail 10 when large |
| **Browse** | *(none)* | Recent sessions: path, name, cwd, started date, preview |

Scroll forward/backward by re-anchoring on the last/first message id of the returned window.

### Query syntax

FTS5 over a trigram index: multi-word = AND by default, `OR` for breadth, quoted phrases for exact match, `NOT` to exclude. Wildcards only help for stems ≥3 chars. Only user/assistant text is indexed (thinking blocks and tool output are not searchable).

## How it works

- A SQLite FTS5 index (trigram tokenizer — handles CJK substring and English tokens alike) lives at `~/.pi/agent/pi-session-search/index.db`. It is derived state: delete it and it rebuilds from your session files.
- Sync runs capped at `session_start` and lazily on each search call, newest files first.
- Hits inside the current session's live context are suppressed; compacted-away or inactive-branch history stays discoverable.
- Forked sessions are collapsed into their parent when both match (one hop).

## Config

`~/.pi/agent/config/pi-session-search.json`

```json
{
  "backfillFiles": 50
}
```

- `backfillFiles`: max session files indexed per sync pass (default 50). Malformed config is ignored with a warning and never rewritten.

## Storage & privacy

Everything stays local: the index under `~/.pi/agent/pi-session-search/`, transcripts read in place. Nothing is sent anywhere by this extension beyond what the model already receives through tool results.

## Development

```bash
npm run typecheck
npm test
```

See [CONTEXT.md](CONTEXT.md) for design decisions and boundaries.
