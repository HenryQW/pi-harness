# `@henryqw/pi-session-recall`

FTS5 search over past Pi sessions: single `session_search` tool with four arg-inferred modes, zero LLM calls, raw messages only.

## Why

- **Created for**: Pi users who need to recover decisions and context from prior sessions without keeping every transcript in the active prompt.
- **Advantage**: Local FTS5 search gives fast, private recall with zero standing context cost and no model calls.

## Install

```bash
pi install npm:@henryqw/pi-session-recall
```

## Use

| Surface | Type | Purpose |
| --- | --- | --- |
| `session_search` | tool | Search past sessions or inspect one: discovery (`query`), scroll (`sessionId` + `aroundMessageId`), read (`sessionId`), browse (no args) |

**Discovery** — BM25-ranked top sessions; top hit hydrated with a ±5 message window and first/last-3 bookends; lower hits carry the matched anchor message plus metadata (`detail:"full"` hydrates all).

**Scroll** — ±`window` messages ([1,20]) around the anchor on its branch; scroll forward/backward by re-anchoring on the last/first message id of the returned window. Across forks, pass the previous response's `branchTip` to select the branch — `aroundMessageId` only centers the window and must lie on that branch.

**Read** — whole session; head 20 + tail 10 when large, with oversized content bounded to 50k characters and flagged by `contentTruncated`.

**Browse** — recent sessions: path, name, cwd, started date, preview.

Query syntax: FTS5 over a trigram index — multi-word = AND by default, `OR` for breadth, quoted phrases for exact match, `NOT` to exclude. Wildcards only help stems ≥3 chars. Only user/assistant text is indexed; thinking blocks and tool output are not searchable. For message text over the 20,000-character indexing budget, only first/last regions are indexed and the middle is omitted; phrases and `NEAR` cannot cross those regions, but ordinary AND terms can. `sessionId` must be a `.jsonl` file under the Pi sessions directory.

Hits inside the current session's live context are suppressed; compacted-away or inactive-branch history stays discoverable. Forked sessions collapse into their parent when both match.

## Config

This package has no package-specific user-editable config file.

| Field | Required | Possible values | Default |
| --- | --- | --- | --- |
| No package-owned config file | No fields | No possible values | Built-in behavior/defaults |

## State

| Path | Purpose |
| --- | --- |
| `~/.pi/agent/config/pi-session-recall/index.db` | Derived SQLite search index, maintained by the extension. |

## Deliberate exclusions

Session directories whose encoded path starts with `--tmp-` or `--private-tmp-` (sessions run from `/tmp` or `/private/tmp`) are never indexed. Session files over 32 MiB are excluded from indexing and hydration: discovery cannot newly find them; READ/SCROLL return an explicit size error, while a stale discovery hit retained from before the file grew is returned as metadata with empty messages and that error.

## Storage & privacy

The SQLite index lives at `~/.pi/agent/config/pi-session-recall/index.db`. It is derived state: delete it and it rebuilds from your session files. Everything stays local — transcripts are read in place and nothing leaves the machine beyond what tool results already show the model.

## Remove

```bash
pi remove npm:@henryqw/pi-session-recall
```

Delete `~/.pi/agent/config/pi-session-recall/` to reclaim index disk space.

## Development

```bash
npm test --workspace @henryqw/pi-session-recall
npm run typecheck --workspace @henryqw/pi-session-recall
npm run pack:check --workspace @henryqw/pi-session-recall
```
