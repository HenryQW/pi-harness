# pi-session-search — Context

## Domain

Pull-based cross-session recall for the Pi agent: FTS5 (trigram) search over the corpus of Pi session JSONL trees under `~/.pi/agent/sessions/`, exposed as one LLM tool with four arg-inferred modes (discovery / scroll / read / browse). Zero LLM calls inside the tool; responses are raw messages hydrated from disk.

## Boundary

| Concern | Home |
| --- | --- |
| Push-based curated memory (model-written entries injected every turn) | `@henryqw/pi-memory` |
| Current-session context assembly / compaction | pi core (`buildContextEntries`, compaction entries) |
| This extension | pull-based recall over past transcripts |

Complementary to pi-memory: memory keeps high-signal distillations in-context at standing cost; search reaches everything that was never distilled, at zero standing cost.

## Key decisions

- **Derived disposable index** (`~/.pi/agent/config/pi-session-search/index.db`): rebuild = delete file + rescan. No migrations, no recovery machinery — unlike Hermes, whose FTS lives inside a migrated live DB.
- **Single trigram-tokenizer external-content FTS5 table**: CJK substring + English token search in one table; <3-char terms degrade to LIKE automatically.
- **No `SessionManager.open()`**: it can rewrite legacy-versioned foreign files in place. Hydration parses JSONL directly with pure functions; leaf = last entry in file order.
- **No `message_end` hooks**: pi emits the event before writing the JSONL entry. Sync happens lazily at tool call plus a capped fire-and-forget backfill at `session_start`.
- **Entry-level current-session guard only**: hits on the live branch are suppressed; same-file content outside the live branch stays discoverable.
- **One-hop lineage suppression** (fork/clone only): pi `/new` creates files with no lineage link, so Hermes-style chain resolution would be dead code here.
- **Query sanitize ladder**: quote-terms default → operator pass-through → quoted retry → OR-expand → LIKE, because raw LLM queries crash FTS5 parsers.

Known ceiling: whole-file `readFileSync` per hydration call (fine for local corpora); frecency boosting deferred until starvation evidence.
