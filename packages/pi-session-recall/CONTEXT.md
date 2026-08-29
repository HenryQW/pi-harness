# pi-session-recall — Context

## Domain

Pull-based cross-session recall for the Pi agent: FTS5 (trigram) search over the corpus of Pi session JSONL trees under `~/.pi/agent/sessions/`, exposed as one LLM tool with four arg-inferred modes (discovery / scroll / read / browse). Zero LLM calls inside the tool; responses are raw messages hydrated from disk. The bundled `pi-session-pattern-miner` skill uses that tool to find independently repeated work and prefer deterministic scripts over model-authored procedures.

## Boundary

| Concern | Home |
| --- | --- |
| Push-based curated memory (model-written entries injected every turn) | `@henryqw/pi-memory` |
| Current-session context assembly / compaction | pi core (`buildContextEntries`, compaction entries) |
| This extension | pull-based recall over past transcripts |

Complementary to pi-memory: memory keeps high-signal distillations in-context at standing cost; search reaches everything that was never distilled, at zero standing cost.

## Key decisions

- **Derived disposable index** (`~/.pi/agent/config/pi-session-recall/index.db`): rebuild = delete file + rescan. No migrations, no recovery machinery — unlike Hermes, whose FTS lives inside a migrated live DB.
- **Single trigram-tokenizer external-content FTS5 table**: CJK substring + English token search in one table; <3-char terms degrade to LIKE automatically.
- **No `SessionManager.open()`**: it can rewrite legacy-versioned foreign files in place. Hydration parses JSONL directly with pure functions; leaf = last entry in file order.
- **No `message_end` hooks**: pi emits the event before writing the JSONL entry. Sync happens lazily at tool call plus a capped fire-and-forget backfill at `session_start`; the cap bounds attempts. Failure fingerprints affect retry order only: unchanged failures remain retryable but move behind untouched work so a persistent error cannot starve the backlog. Duplicate message ids are malformed input and use first-wins parsing consistently.
- **Entry-level current-session guard only**: hits on the live branch are suppressed; same-file content outside the live branch stays discoverable.
- **One-hop lineage suppression** (fork/clone only): pi `/new` creates files with no lineage link, so Hermes-style chain resolution would be dead code here.
- **Query sanitize ladder**: quote-terms default → operator pass-through → quoted retry → OR-expand → LIKE, because raw LLM queries crash FTS5 parsers.
- **Bounded trust boundary and output**: JSONL metadata is capped while parsing, indexed text contains only source text, and the complete serialized tool result is limited to 50,000 characters.
- **Evidence-gated pattern mining**: the bundled skill requires two independent sessions, verifies current automation before proposing changes, and separates deterministic scripts from judgment-heavy skills. It reports sampling limits because browse is capped and discovery is query-driven.
- **Display-only tail preview**: the interactive renderer mirrors Pi's built-in tool output behavior—five trailing visual lines when collapsed and the full bounded result when expanded. Model-visible content is unchanged.

Known ceiling: whole-file `readFileSync` per hydration call (fine for local corpora); frecency boosting deferred until starvation evidence.
