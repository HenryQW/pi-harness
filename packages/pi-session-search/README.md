# `@henryqw/pi-session-search`

FTS5 search over past Pi sessions: single `session_search` tool with four arg-inferred modes, zero LLM calls, raw messages only.

## Install

```bash
pi install npm:@henryqw/pi-session-search
```

## Use

| Surface | Type | Purpose |
| --- | --- | --- |
| `session_search` | tool | Search past sessions or inspect one: discovery (`query`), scroll (`sessionId` + `aroundMessageId`), read (`sessionId`), browse (no args) |

**Discovery** — BM25-ranked top sessions; top hit hydrated with a ±5 message window and first/last-3 bookends; lower hits carry the matched anchor message plus metadata (`detail:"full"` hydrates all).

**Scroll** — ±`window` messages ([1,20]) around the anchor on its branch; scroll forward/backward by re-anchoring on the last/first message id of the returned window.

**Read** — whole session; head 20 + tail 10 when large.

**Browse** — recent sessions: path, name, cwd, started date, preview.

Query syntax: FTS5 over a trigram index — multi-word = AND by default, `OR` for breadth, quoted phrases for exact match, `NOT` to exclude. Wildcards only help stems ≥3 chars. Only user/assistant text is indexed; thinking blocks and tool output are not searchable. `sessionId` must be a `.jsonl` file under the Pi sessions directory.

Hits inside the current session's live context are suppressed; compacted-away or inactive-branch history stays discoverable. Forked sessions collapse into their parent when both match.

## Config

`~/.pi/agent/config/pi-session-search/pi-session-search.json`

```json
{
  "backfillFiles": 50
}
```

- `backfillFiles`: max session files indexed per sync pass (default 50). Malformed config is ignored with a warning and never rewritten.

## Storage & privacy

The SQLite index lives at `~/.pi/agent/config/pi-session-search/index.db`. It is derived state: delete it and it rebuilds from your session files. Everything stays local — transcripts are read in place and nothing leaves the machine beyond what tool results already show the model.

## Remove

```bash
pi remove npm:@henryqw/pi-session-search
```

Delete `~/.pi/agent/config/pi-session-search/` to reclaim index disk space.

## Development

```bash
npm test --workspace @henryqw/pi-session-search
npm run typecheck --workspace @henryqw/pi-session-search
npm run pack:check --workspace @henryqw/pi-session-search
```

See [CONTEXT.md](CONTEXT.md) for design decisions and boundaries.
