# pi-session-recall — Context

## Domain

Pull-based cross-session recall for the Pi agent: FTS5 (trigram) search over the corpus of Pi session JSONL trees under `~/.pi/agent/sessions/`, exposed as one LLM tool with four arg-inferred modes (discovery / scroll / read / browse) and one explicit pattern-miner preparation operation. Zero LLM calls run inside the tool; responses hydrate selected messages directly from disk. The bundled `pi-session-pattern-miner` skill uses one bounded preparation call to find independently repeated work and prefer deterministic scripts over model-authored procedures.

## Boundary

| Concern | Home |
| --- | --- |
| Push-based curated memory (model-written entries injected every turn) | `@henryqw/pi-memory` |
| Current-session context assembly / compaction | pi core (`buildContextEntries`, compaction entries) |
| This extension | pull-based recall over past transcripts |

Complementary to pi-memory: memory keeps high-signal distillations in context. Session recall leaves transcripts out of every-turn context, but its active tool registration has standing prompt cost. Adaptive discovery and pattern preparation return only user and assistant text. Explicit full discovery, READ, and SCROLL preserve tool-result access, and returned content enters active model context.

## Key decisions

- **Derived disposable index** (`~/.pi/agent/config/pi-session-recall/index.db`): rebuild = delete file + rescan. No migrations, no recovery machinery — unlike Hermes, whose FTS lives inside a migrated live DB.
- **Single trigram-tokenizer external-content FTS5 table**: CJK substring + English token search in one table; <3-char terms degrade to LIKE automatically.
- **No `SessionManager.open()`**: it can rewrite legacy-versioned foreign files in place. Hydration parses JSONL directly with pure functions; leaf = last entry in file order.
- **No `message_end` hooks**: pi emits the event before writing the JSONL entry. Sync happens lazily at tool call plus a capped fire-and-forget backfill at `session_start`; the cap bounds attempts. Failure fingerprints affect retry order only: unchanged failures remain retryable but move behind untouched work so a persistent error cannot starve the backlog. Duplicate message ids are malformed input and use first-wins parsing consistently.
- **Entry-level current-session guard only**: hits on the live branch are suppressed; same-file content outside the live branch stays discoverable.
- **One-hop lineage suppression** (fork/clone only): pi `/new` creates files with no lineage link, so Hermes-style chain resolution would be dead code here.
- **Query sanitize ladder**: quote-terms default → operator pass-through → quoted retry → OR-expand → LIKE, because raw LLM queries crash FTS5 parsers.
- **Bounded trust boundary and output**: JSONL metadata is capped while parsing, indexed text contains only source text, and the complete serialized tool result is limited to 50,000 characters.
- **Prepared mining corpus**: one operation performs one lazy sync, excludes the current file, filters by indexed `cwd` before limiting, and collapses one-hop lineages. Safe hydration isolates per-file failures and never returns thinking or tool-result content. Envelope, sync, inventory counts, and all selected citation metadata take priority over fairly allocated transcript content.
- **Repository inventory authority**: the integrated inventory uses Git-visible files and Pi's effective skill registry. It reports package scripts, executables, skills, and instruction paths without another tree scanner or capability catalog. Preparation bounds its serialized inventory to 10,000 characters with deterministic omission counts.
- **Evidence-gated pattern mining**: the bundled skill treats equal lineages as one source and requires two independent examples. It preserves requested topics as candidates, verifies the owning automation after clustering, and abstains when ownership cannot be verified.
- **Display-only tail preview**: the interactive renderer mirrors Pi's built-in tool output behavior—five trailing visual lines when collapsed and the full bounded result when expanded. Model-visible content is unchanged.

Known ceiling: one bounded whole-file snapshot per hydration call (fine for local corpora); frecency boosting deferred until starvation evidence.
