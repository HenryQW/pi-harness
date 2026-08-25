/**
 * Index engine: SQLite schema (WAL, external-content trigram FTS5), capped
 * incremental sync from Pi session JSONL files, query sanitize ladder,
 * discovery search with one-hop lineage suppression. No pi runtime imports —
 * pure Node + node:sqlite so it is testable headless.
 */
import { DatabaseSync } from "node:sqlite";
import type { SQLOutputValue } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import type { SearchHit, SessionRow, SyncResult } from "./types.ts";
export const DEFAULT_SYNC_CAP = 50;
/** Hard byte ceiling per session file: larger files are skipped (and retried
 *  behind fresh work) instead of being read whole into memory. */
export const MAX_SESSION_FILE_BYTES = 32 * 1024 * 1024;
/** Hard ceiling for the configured backfillFiles work bound. */
export const MAX_BACKFILL_FILES = DEFAULT_SYNC_CAP * 10;
export const MAX_QUERY_CHARS = 512;
const MAX_TEXT_CHARS = 20000;
const SCAN_LIMIT = 300;
/** Best-ranked candidate retained per session after live-entry filtering. */
const ROWS_PER_FILE = 1;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS session_files (
  path TEXT PRIMARY KEY,
  size INTEGER NOT NULL,
  mtime_ms INTEGER NOT NULL
);
-- Retry markers affect ordering only: unchanged failures move behind fresh work,
-- but remain eligible on every pass once fresh work is drained.
CREATE TABLE IF NOT EXISTS session_failures (
  path TEXT PRIMARY KEY,
  size INTEGER NOT NULL,
  mtime_ms INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sessions (
  path TEXT PRIMARY KEY,
  cwd TEXT,
  name TEXT,
  started_at TEXT,
  preview TEXT,
  parent_session TEXT
);
-- Oversized messages split into head/tail columns: one row per source
-- message keeps AND matching across both retained regions (FTS5 implicit AND
-- spans columns) while phrases and NEAR cannot cross column boundaries, so
-- truncation never manufactures proximity matches over the elided middle.
CREATE TABLE IF NOT EXISTS messages (
  rowid INTEGER PRIMARY KEY,
  path TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  role TEXT NOT NULL,
  timestamp TEXT,
  head TEXT NOT NULL,
  tail TEXT NOT NULL,
  UNIQUE(path, entry_id)
);
CREATE INDEX IF NOT EXISTS messages_path ON messages(path);
CREATE VIRTUAL TABLE IF NOT EXISTS session_fts USING fts5(
  head,
  tail,
  content='messages',
  content_rowid='rowid',
  tokenize='trigram'
);
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO session_fts(rowid, head, tail) VALUES (new.rowid, new.head, new.tail);
END;
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO session_fts(session_fts, rowid, head, tail) VALUES ('delete', old.rowid, old.head, old.tail);
END;
CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
  INSERT INTO session_fts(session_fts, rowid, head, tail) VALUES ('delete', old.rowid, old.head, old.tail);
  INSERT INTO session_fts(rowid, head, tail) VALUES (new.rowid, new.head, new.tail);
END;
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

function openDb(dbPath: string): DatabaseSync {
	fs.mkdirSync(path.dirname(dbPath), { recursive: true });
	let db = new DatabaseSync(dbPath);
	try {
		db.exec("PRAGMA journal_mode = WAL");
		db.exec("PRAGMA busy_timeout = 5000");
		// The index is disposable derived state with no migration path: an
		// incompatible older schema is discarded and rebuilt from scratch.
		const needsRebuild = (table: string, column: string): boolean => {
			const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
			return Boolean(exists) && !db.prepare(`PRAGMA table_info(${table})`).all().some((c: any) => c.name === column);
		};
		const stale = needsRebuild("session_failures", "attempts") || needsRebuild("messages", "head");
		if (stale) {
			db.close();
			for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(dbPath + suffix, { force: true });
			db = new DatabaseSync(dbPath);
			db.exec("PRAGMA journal_mode = WAL");
			db.exec("PRAGMA busy_timeout = 5000");
		}
		// SQLite's LIKE folds ASCII only, missing é/É, Greek, Cyrillic, …; every
		// LIKE below wraps columns in ulower and binds pre-folded operands so
		// both sides case-fold through the same Unicode-aware JS toLowerCase.
		// Registered after any stale-schema reopen so the returned connection
		// always has the function.
		db.function("ulower", (s: SQLOutputValue): string => typeof s === "string" ? s.toLowerCase() : "");
		db.exec(SCHEMA_SQL);
	} catch (err) {
		db.close();
		throw err;
	}
	return db;
}

// --- Parsing ---

interface ParsedMessage {
	entryId: string;
	role: string;
	timestamp: string | null;
	head: string;
	tail: string;
}

interface ParsedFile {
	cwd: string | null;
	name: string | null;
	startedAt: string | null;
	parentSession: string | null;
	preview: string | null;
	messages: ParsedMessage[];
}

/** Middle-out truncation into SEPARATE head/tail index columns: concatenating
 *  them would make boundary terms adjacent and manufacture phrase/proximity
 *  matches across the elided middle. Raw text only — no synthetic notices:
 *  these strings are FTS-indexed, so injected terms would pollute search
 *  results and snippets. */
function truncateRegions(text: string, max = MAX_TEXT_CHARS): { head: string; tail: string } | null {
	if (text.length <= max) return null;
	const kept = max - 1;
	return {
		head: text.slice(0, Math.ceil(kept / 2)),
		tail: text.slice(-Math.floor(kept / 2)),
	};
}

/** Cap an untrusted string at a parse boundary so malformed JSONL cannot
 *  produce unbounded metadata downstream. */
function capStr(value: unknown, max: number): string | null {
	return typeof value === "string" ? value.slice(0, max) : null;
}

function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (block && typeof block === "object" && (block as any).type === "text" && typeof (block as any).text === "string") {
			parts.push((block as any).text);
		}
		// thinking / toolUse / tool_result blocks are skipped entirely
	}
	return parts.join("\n").trim();
}

function parseSessionFile(filePath: string): ParsedFile {
	const seenEntryIds = new Set<string>();
	const parsed: ParsedFile = {
		cwd: null,
		name: null,
		startedAt: null,
		parentSession: null,
		preview: null,
		messages: [],
	};
	// Unreadable file must throw so the sync transaction rolls back instead of
	// wiping previously indexed rows and advancing the watermark over a hole.
	const content = fs.readFileSync(filePath, "utf-8");
	for (const line of content.split("\n")) {
		if (!line.trim()) continue;
		let entry: any;
		try {
			entry = JSON.parse(line);
		} catch {
			continue; // skip malformed lines
		}
		const hasValidId = typeof entry?.id === "string" && entry.id.length > 0 && entry.id.length <= 256
			&& (entry.parentId == null || (typeof entry.parentId === "string" && entry.parentId.length <= 256));
		if (hasValidId) {
			// Hydration is first-wins across every entry type; reserve IDs at the
			// same boundary so discovery can never point at a different duplicate.
			if (seenEntryIds.has(entry.id)) continue;
			seenEntryIds.add(entry.id);
		}
		switch (entry?.type) {
			case "session":
				// Untrusted header strings are capped here so every consumer
				// (browse rows, discovery meta) inherits the bound.
				parsed.cwd = capStr(entry.cwd, 500) ?? parsed.cwd;
				parsed.startedAt = capStr(entry.timestamp, 128) ?? parsed.startedAt;
				parsed.parentSession = capStr(entry.parentSession, 1024) ?? parsed.parentSession;
				break;
			case "session_info":
				if (typeof entry.name === "string") parsed.name = entry.name.slice(0, 500);
				break;
			case "message": {
				const role = entry.message?.role;
				if (role !== "user" && role !== "assistant") break;
				const full = extractText(entry.message.content);
				if (!full) break;
				if (!hasValidId) break;
				if (role === "user" && parsed.preview === null) {
					parsed.preview = full.slice(0, 200);
				}
				const regions = truncateRegions(full);
				parsed.messages.push({
					entryId: entry.id,
					role,
					timestamp: capStr(entry.timestamp, 128),
					head: regions ? regions.head : full,
					tail: regions ? regions.tail : "",
				});
				break;
			}
			// compaction, branch_summary, custom, custom_message, label,
			// session_info (name handled above), model_change, … are skipped
		}
	}
	return parsed;
}

function isJunkEncodedDir(relSegments: string[]): boolean {
	return relSegments.some((seg) => seg.startsWith("--private-tmp-"));
}

/** Walk result. `complete: false` means the tree could not be fully read
 *  (missing root, readdir/stat failure) — callers must not treat unseen
 *  indexed paths as deleted. */
interface WalkResult {
	files: Map<string, fs.Stats>;
	complete: boolean;
}

function walkJsonlFiles(sessionsDir: string): WalkResult {
	const files = new Map<string, fs.Stats>();
	if (!fs.existsSync(sessionsDir)) return { files, complete: false };
	const stack: { dir: string; rel: string[] }[] = [{ dir: sessionsDir, rel: [] }];
	let complete = true;
	while (stack.length > 0) {
		const { dir, rel } = stack.pop()!;;
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			complete = false;
			continue;
		}
		for (const ent of entries) {
			const full = path.join(dir, ent.name);
			if (ent.isDirectory()) {
				// Junk dirs are pruned before descent so a large ignored tree never
				// costs a walk + per-file stats on every sync pass.
				if (isJunkEncodedDir([...rel, ent.name])) continue;
				stack.push({ dir: full, rel: [...rel, ent.name] });
			} else if (ent.isFile() && ent.name.endsWith(".jsonl")) {
				try {
					files.set(full, fs.statSync(full));
				} catch {
					complete = false; // vanished or became unreadable mid-walk
				}
			}
		}
	}
	return { files, complete };
}

// --- Sync ---

export function syncSessions(
	sessionsDir: string,
	dbPath: string,
	opts?: { cap?: number; maxFileBytes?: number },
): SyncResult {
	const requestedCap = opts?.cap ?? DEFAULT_SYNC_CAP;
	const cap = Number.isFinite(requestedCap)
		? Math.max(1, Math.min(MAX_BACKFILL_FILES, Math.floor(requestedCap)))
		: DEFAULT_SYNC_CAP;
	const db = openDb(dbPath);
	try {

	// Junk dirs never reach the walk result: pruned during descent.
	const walk = walkJsonlFiles(sessionsDir);
	const all = [...walk.files];
	const watermarks = new Map(
		(db.prepare("SELECT path, size, mtime_ms FROM session_files").all() as any[]).map((r) => [r.path, r]),
	);
	const failures = new Map(
		(db.prepare("SELECT path, size, mtime_ms, attempts FROM session_failures").all() as any[]).map((r) => [r.path, r]),
	);
	// An incomplete traversal proves nothing about absence: purging here would
	// wipe healthy sessions over a transient readdir/stat failure. Changed/new
	// files already discovered still process normally.
	const discovered = new Set(all.map(([fp]) => fp));
	const deleted = walk.complete ? [...watermarks.keys()].filter((p) => !discovered.has(p)) : [];
	const deletedFailures = walk.complete ? [...failures.keys()].filter((p) => !discovered.has(p)) : [];

	const changed: { path: string; stat: fs.Stats }[] = [];
	for (const [p, stat] of all) {
		const mtimeMs = Math.floor(stat.mtimeMs);
		const wm = watermarks.get(p);
		if (wm && wm.size === stat.size && wm.mtime_ms === mtimeMs) continue;
		changed.push({ path: p, stat });
	}

	// Newest-first, but an unchanged prior failure moves behind untouched work.
	// Among retries, fewest attempts first so one persistent failure cannot
	// monopolize a small cap forever.
	const retryAttempts = (p: string, stat: fs.Stats): number | null => {
		const f = failures.get(p);
		return f && f.size === stat.size && f.mtime_ms === Math.floor(stat.mtimeMs) ? (f.attempts ?? 0) : null;
	};
	changed.sort((a, b) => {
		const aRetry = retryAttempts(a.path, a.stat);
		const bRetry = retryAttempts(b.path, b.stat);
		if (aRetry !== null && bRetry !== null) return aRetry - bRetry || b.stat.mtimeMs - a.stat.mtimeMs;
		if (aRetry !== null) return 1;
		if (bRetry !== null) return -1;
		return b.stat.mtimeMs - a.stat.mtimeMs;
	});
	deleted.sort((a, b) => {
		const ma = watermarks.get(a)!.mtime_ms;
		const mb = watermarks.get(b)!.mtime_ms;
		return mb - ma;
	});

	const delStmt = db.prepare("DELETE FROM messages WHERE path = ?");
	const delSession = db.prepare("DELETE FROM sessions WHERE path = ?");
	const delFile = db.prepare("DELETE FROM session_files WHERE path = ?");
	const delFailure = db.prepare("DELETE FROM session_failures WHERE path = ?");
	const upsertFailure = db.prepare(
		"INSERT INTO session_failures(path, size, mtime_ms, attempts) VALUES (?, ?, ?, 1) ON CONFLICT(path) DO UPDATE SET size=excluded.size, mtime_ms=excluded.mtime_ms, attempts=CASE WHEN size=excluded.size AND mtime_ms=excluded.mtime_ms THEN attempts+1 ELSE 1 END",
	);
	const upsertFile = db.prepare(
		"INSERT INTO session_files(path, size, mtime_ms) VALUES (?, ?, ?) ON CONFLICT(path) DO UPDATE SET size=excluded.size, mtime_ms=excluded.mtime_ms",
	);
	const upsertSession = db.prepare(
		`INSERT INTO sessions(path, cwd, name, started_at, preview, parent_session) VALUES (?, ?, ?, ?, ?, ?)
		 ON CONFLICT(path) DO UPDATE SET cwd=excluded.cwd, name=excluded.name, started_at=excluded.started_at,
		 preview=excluded.preview, parent_session=excluded.parent_session`,
	);
	const insertMsg = db.prepare(
		"INSERT INTO messages(path, entry_id, role, timestamp, head, tail) VALUES (?, ?, ?, ?, ?, ?)",
	);

	// Returns messages indexed for this file.
	const tx = (filePath: string, stat: fs.Stats): number => {
		db.exec("BEGIN");
		try {
			const parsed = parseSessionFile(filePath);
			delStmt.run(filePath);
			upsertSession.run(filePath, parsed.cwd, parsed.name, parsed.startedAt, parsed.preview, parsed.parentSession);
			let count = 0;
			for (const msg of parsed.messages) {
				insertMsg.run(filePath, msg.entryId, msg.role, msg.timestamp, msg.head, msg.tail);
				count++;
			}
			upsertFile.run(filePath, stat.size, Math.floor(stat.mtimeMs));
			delFailure.run(filePath);
			db.exec("COMMIT");
			return count;
		} catch (err) {
			db.exec("ROLLBACK");
			throw err;
		}
	};

	let filesProcessed = 0;
	let messagesIndexed = 0;

	// The cap bounds total indexing attempts per pass, not successes.
	const batch = changed.slice(0, cap);
	for (const { path: p, stat } of batch) {
		try {
			// ponytail: byte-level work bound — skip instead of streaming files that
			// are huge enough to block the event loop; raise the cap or stream the
			// parser if real sessions ever hit it.
			if (stat.size > (opts?.maxFileBytes ?? MAX_SESSION_FILE_BYTES)) throw new Error("session file exceeds size cap");
			messagesIndexed += tx(p, stat);
			filesProcessed++;
		} catch {
			// Keep the file retryable, but put this unchanged fingerprint behind
			// untouched work on the next pass.
			upsertFailure.run(p, stat.size, Math.floor(stat.mtimeMs));
		}
	}

	const deletedRemaining = Math.max(0, deleted.length - cap);
	for (const p of deleted.slice(0, cap)) {
		delStmt.run(p);
		delSession.run(p);
		delFile.run(p);
		delFailure.run(p);
	}
	for (const p of deletedFailures) delFailure.run(p);

	// Attempted failures remain unsynced and therefore remain in the backlog.
	const backlog = changed.length - filesProcessed + deletedRemaining;
	db.prepare("INSERT INTO meta(key, value) VALUES ('backlog', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(backlog));

	return { filesProcessed, messagesIndexed, backlogRemaining: backlog };
	} finally {
		db.close();
	}
}

function getBacklog(db: DatabaseSync): number {
	const row = db.prepare("SELECT value FROM meta WHERE key = 'backlog'").get() as { value: string } | undefined;
	return row ? Number(row.value) : 0;
}

// --- Query sanitize ladder ---

const OPERATOR_RE = /\b(OR|AND|NOT|NEAR)\b/;
const TOKEN_RE = /"([^"]*)"|(\S+)/g;

interface QueryTerm {
	text: string;
	operator: boolean;
	nearDistance: boolean;
}

function collectQueryTerms(query: string): QueryTerm[] {
	const terms: QueryTerm[] = [];
	let depth = 0;
	let pendingNear = false;
	let nearDepth = 0;
	let afterNearComma = false;
	for (const match of spaceParensOutsideQuotes(query).matchAll(TOKEN_RE)) {
		const phrase = match[1];
		let raw = phrase ?? match[2] ?? "";
		if (phrase === undefined && raw === "(") {
			depth++;
			if (pendingNear) {
				nearDepth = depth;
				pendingNear = false;
			}
			continue;
		}
		if (phrase === undefined && raw === ")") {
			if (depth === nearDepth) {
				nearDepth = 0;
				afterNearComma = false;
			}
			depth = Math.max(0, depth - 1);
			continue;
		}
		const hasNearComma = phrase === undefined && nearDepth > 0 && raw.endsWith(",");
		// An attached distance like `NEAR(Go Rust,10)` has no standalone comma
		// token; split it so the numeric tail is recognized as the distance.
		let attachedDistance: string | undefined;
		if (!hasNearComma && phrase === undefined && nearDepth > 0) {
			const attached = /^(.+),(\d+)$/.exec(raw);
			if (attached) {
				raw = attached[1];
				attachedDistance = attached[2];
			}
		}
		// Unmatched quote delimiters are malformed syntax, not searchable text.
		const text = phrase ?? raw.replace(/^[.,!?;:()]+|[.,!?;:()]+$/g, "").replace(/"/g, "");
		if (text) {
			const operator = phrase === undefined && /^(?:OR|AND|NOT|NEAR)$/.test(text);
			const nearDistance = nearDepth > 0 && afterNearComma && /^\d+$/.test(text);
			terms.push({ text, operator, nearDistance });
			if (operator && text === "NEAR") pendingNear = true;
		}
		if (attachedDistance !== undefined) terms.push({ text: attachedDistance, operator: false, nearDistance: true });
		if (hasNearComma) afterNearComma = true;
	}
	return terms;
}

function collectTerms(query: string): string[] {
	return collectQueryTerms(query).filter((term) => !term.nearDistance).map((term) => term.text);
}

function quoteTerm(t: string): string {
	// Trailing * is FTS5 prefix syntax; the quote must close before it
	// ("deploy"*), never wrap it ("deploy*" = literal asterisk).
	if (t.endsWith("*")) return `"${t.slice(0, -1).replace(/"/g, '""')}"*`;
	return `"${t.replace(/"/g, '""')}"`;
}

function quoteTerms(terms: string[], sep: string): string {
	return terms.map(quoteTerm).join(sep);
}

export interface FtsQueryPlan {
	/** Candidate FTS5 MATCH expressions in try order. */
	ftsCandidates: string[];
	/** When true, fall back to SQL LIKE (also forced when every term < 3 chars). */
	forceLike: boolean;
}

/**
 * Sanitize ladder: trim + 512 cap; implicit-AND quoting when no explicit
 * FTS5 operator; raw pass-through otherwise; recovery candidates are the
 * fully-quoted form, then OR-expansion; LIKE covers everything else.
 */
export function buildFtsQueryPlan(rawQuery: string): FtsQueryPlan {
	let query = rawQuery.trim();
	if (query.length > MAX_QUERY_CHARS) query = query.slice(0, MAX_QUERY_CHARS);
	if (!query) return { ftsCandidates: [], forceLike: false };

	const queryTerms = collectQueryTerms(query);
	const hasOperator = OPERATOR_RE.test(query);
	// Short terms vanish under trigram MATCH — for natural-language queries
	// (AND semantics) that silently breaks the query. Explicit-operator queries
	// route there too (`Go OR Rust` silently drops the Go side); the boolean
	// LIKE fallback preserves their AND/OR/NOT semantics.
	if (
		queryTerms.some(
			(term) => !term.operator && !term.nearDistance && [...term.text.replace(/["()*]/g, "")].length < 3,
		)
	) {
		return { ftsCandidates: [], forceLike: true };
	}

	const operandTexts = queryTerms.filter((term) => !term.operator && !term.nearDistance).map((term) => term.text);
	// Recovery operands exclude syntax operators so a malformed query can never
	// broaden into matches on AND/OR/NOT/NEAR themselves.
	const natural = quoteTerms(operandTexts, " ");
	const orExpanded = operandTexts.length > 1 ? quoteTerms(operandTexts, " OR ") : null;

	if (!hasOperator) {
		// Quoted form cannot fail to parse; OR-expand only as breadth fallback.
		return { ftsCandidates: orExpanded ? [natural, orExpanded] : [natural], forceLike: false };
	}
	// Explicit operators: raw first, then recovery paths.
	const candidates = [query, natural];
	if (orExpanded) candidates.push(orExpanded);
	return { ftsCandidates: candidates, forceLike: false };
}

function normalizeLikeTerm(term: string): string {
	// Trailing * is FTS5 prefix syntax; in LIKE it folds into the % suffix
	// ("deploy*" must match "deployment", not a literal asterisk).
	return term.endsWith("*") ? term.slice(0, -1) : term;
}

function likePattern(term: string): string {
	// Fold here too: escaping is unaffected because % _ \ have no case variants.
	return `%${term.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

// --- Boolean LIKE fallback ---
// Parameterized translation of simple AND/OR/NOT queries to SQL LIKE so short
// operands (trigram floor) keep boolean semantics. Unsupported/malformed
// expressions return null and the caller uses plain AND-of-terms — user input
// only ever reaches SQL as a bound parameter.

function likeClause(term: string): { clause: string; params: string[] } | null {
	term = normalizeLikeTerm(term);
	if (!term) return null;
	const pattern = likePattern(term);
	return {
		clause: "(ulower(m.head) LIKE ? ESCAPE '\\' OR ulower(m.tail) LIKE ? ESCAPE '\\')",
		params: [pattern, pattern],
	};
}

interface LikeSql {
	where: string;
	params: string[];
}

/** Space out parens that act as grouping syntax while leaving quoted phrases
 *  like "C(ABI)" intact. */
function spaceParensOutsideQuotes(q: string): string {
	let out = "";
	let inQuote = false;
	for (const c of q) {
		if (c === '"') inQuote = !inQuote;
		out += !inQuote && (c === "(" || c === ")") ? ` ${c} ` : c;
	}
	return out;
}

function buildBooleanLikeSql(rawQuery: string): LikeSql | null {
	let query = rawQuery.trim();
	if (!query) return null;
	// Imbalance detection/recovery is quote-aware: parentheses inside quoted
	// operands ("func(") are literals and must survive.
	let depth = 0;
	let inQuote = false;
	for (const c of query) {
		if (c === '"') inQuote = !inQuote;
		else if (!inQuote && c === "(") depth++;
		else if (!inQuote && c === ")" && --depth < 0) break;
	}
	if (depth !== 0) {
		inQuote = false;
		query = [...query].map((c) => {
			if (c === '"') inQuote = !inQuote;
			return !inQuote && (c === "(" || c === ")") ? " " : c;
		}).join("");
	}

	const tokens = [...spaceParensOutsideQuotes(query).matchAll(TOKEN_RE)]
		.map((m) => (m[1] !== undefined ? { phrase: m[1] } : { word: m[2] ?? "" }))
		.filter((t) => (t.phrase !== undefined ? t.phrase !== "" : t.word !== ""));
	const sql: string[] = [];
	const params: string[] = [];
	let expectingOperand = true;
	depth = 0;

	for (const token of tokens) {
		const word = token.word;
		if (word === "(") {
			if (!expectingOperand) sql.push("AND");
			sql.push("(");
			depth++;
			expectingOperand = true;
			continue;
		}
		if (word === ")") {
			if (expectingOperand || depth-- === 0) return null;
			sql.push(")");
			expectingOperand = false;
			continue;
		}
		if (word === "AND" || word === "OR") {
			if (expectingOperand) return null;
			sql.push(word);
			expectingOperand = true;
			continue;
		}
		if (word === "NOT") {
			if (!expectingOperand) sql.push("AND");
			sql.push("NOT");
			expectingOperand = true;
			continue;
		}
		if (word === "NEAR") return null;

		const term = token.phrase ?? word?.replace(/^[.,!?;:]+|[.,!?;:]+$/g, "").replace(/"/g, "") ?? "";
		const clause = likeClause(term);
		if (clause === null) return null;
		if (!expectingOperand) sql.push("AND");
		sql.push(clause.clause);
		params.push(...clause.params);
		expectingOperand = false;
	}

	return expectingOperand || depth !== 0 ? null : { where: sql.join(" "), params };
}

// --- Search ---

export interface SearchOptions {
	limit?: number;
	/** Entry ids on the current session's live branch — hits here are skipped. */
	currentLiveEntryIds?: Set<string>;
	/** Path of the current session file. */
	currentSessionPath?: string;
}

// Live-entry suppression happens INSIDE SQL (before ROW_NUMBER/caps) so
// inactive matches on the current file compete only against each other, and
// there is no pre-partition LIMIT: one verbose session cannot starve others.
// live_filter is a per-connection TEMP table populated from SearchOptions.
const LIVE_FILTER_SQL = `NOT EXISTS (
  SELECT 1 FROM live_filter lf WHERE lf.path = m.path AND lf.entry_id = m.entry_id
)`;
const BASE_SELECT = `
WITH matches AS (
  SELECT m.path, m.entry_id, m.role, m.timestamp, s.cwd, s.name, s.started_at,
         s.parent_session, m.rowid AS rid,
         snippet(session_fts, -1, '[', ']', '…', 16) AS snip,
         bm25(session_fts) AS score
  FROM session_fts JOIN messages m ON m.rowid = session_fts.rowid
  LEFT JOIN sessions s ON s.path = m.path
  WHERE session_fts MATCH ? AND ${LIVE_FILTER_SQL}
), ranked AS (
  SELECT *, ROW_NUMBER() OVER (PARTITION BY path ORDER BY score, rid) AS rn
  FROM matches
)
SELECT path, entry_id, role, timestamp, snip, cwd, name, started_at
FROM ranked r
WHERE rn <= ${ROWS_PER_FILE}
  AND NOT EXISTS (
    SELECT 1 FROM ranked parent
    WHERE parent.path = r.parent_session AND parent.rn <= ${ROWS_PER_FILE}
  )
ORDER BY score, rid
LIMIT ${SCAN_LIMIT}`;

/** Bounded excerpt around the first matched term for the LIKE fallback,
 *  searching head then tail. */
function likeSnippet(head: string, tail: string, terms: string[]): string {
	for (const text of [head, tail]) {
		const lower = text.toLowerCase();
		let at = -1;
		for (const t of terms) {
			const i = lower.indexOf(t.toLowerCase());
			if (i >= 0 && (at < 0 || i < at)) at = i;
		}
		if (at >= 0) {
			const start = Math.max(0, at - 60);
			return `${start > 0 ? "…" : ""}${text.slice(start, start + 120)}…`;
		}
	}
	return head.slice(0, 120);
}

export function searchIndex(
	dbPath: string,
	query: string,
	opts?: SearchOptions,
): { hits: SearchHit[]; backlogRemaining: number } {
	const limit = opts?.limit ?? 3;
	const db = openDb(dbPath);
	try {
		// Per-connection TEMP table of (path, entry_id) pairs to suppress —
		// parameterized, immune to SQLite variable limits. Primary key indexes
		// the correlated NOT EXISTS probe and dedupes inserts.
		db.exec("CREATE TEMP TABLE IF NOT EXISTS live_filter (path TEXT NOT NULL, entry_id TEXT NOT NULL, PRIMARY KEY (path, entry_id))");
		if (opts?.currentSessionPath && opts?.currentLiveEntryIds?.size) {
			const ins = db.prepare("INSERT INTO live_filter(path, entry_id) VALUES (?, ?)");
			db.exec("BEGIN");
			try {
				for (const id of opts.currentLiveEntryIds!) ins.run(opts.currentSessionPath!, id);
				db.exec("COMMIT");
			} catch (err) {
				db.exec("ROLLBACK");
				throw err;
			}
		}

		const plan = buildFtsQueryPlan(query);
		if (plan.ftsCandidates.length === 0 && !plan.forceLike) {
			return { hits: [], backlogRemaining: getBacklog(db) };
		}

		interface RawRow {
			path: string;
			entry_id: string;
			role: string;
			timestamp: string | null;
			snip: string;
			cwd: string | null;
			name: string | null;
			started_at: string | null;
		}
		let rows: Omit<RawRow, "snip">[] = [];
		let usedLike = plan.forceLike;

		if (!plan.forceLike) {
			// Recovery candidates run only after an FTS5 PARSE error. A candidate
			// that parses defines the result even with zero rows (`a AND b` with
			// no co-occurrence stays empty instead of degrading to OR/LIKE).
			let parseFailed = false;
			for (const cand of plan.ftsCandidates) {
				try {
					rows = db.prepare(BASE_SELECT).all(cand) as any;
					// First/raw success defines the result even with zero rows. After a
					// parse error, an empty recovery candidate keeps trying later ones.
					if (!parseFailed || rows.length > 0) {
						usedLike = false;
						break;
					}
					usedLike = true;
				} catch {
					parseFailed = true;
					usedLike = true; // malformed syntax → try next candidate
				}
			}
		}

		if (usedLike) {
			const trimmed = query.trim().slice(0, MAX_QUERY_CHARS);
			// Keep quoted operator words as operands and omit NEAR's optional numeric
			// distance; only unquoted syntax tokens are excluded.
			const operandTerms = collectQueryTerms(trimmed)
				.filter((term) => !term.operator && !term.nearDistance)
				.map((term) => normalizeLikeTerm(term.text))
				.filter(Boolean);
			if (operandTerms.length === 0) return { hits: [], backlogRemaining: getBacklog(db) };
			const terms = operandTerms;
			// Snippets anchor on operand terms only — operator words like OR would
			// otherwise match common substrings and hide the real match.
			const snippetTerms = terms;
			// Boolean LIKE preserves simple AND/OR/NOT; unsupported shapes degrade
			// to AND-of-terms. Both forms are fully parameterized.
			const bool = buildBooleanLikeSql(trimmed);
			const where = bool?.where ?? terms.map(() => "(ulower(m.head) LIKE ? ESCAPE '\\' OR ulower(m.tail) LIKE ? ESCAPE '\\')").join(" AND ");
			const params = bool?.params ?? terms.flatMap((t) => [likePattern(t), likePattern(t)]);
			rows = db.prepare(`WITH ranked AS (
			            SELECT m.path, m.entry_id, m.role, m.timestamp, m.head, m.tail, s.cwd, s.name, s.started_at,
			                   s.parent_session,
			                   ROW_NUMBER() OVER (PARTITION BY m.path ORDER BY m.rowid DESC) AS rn,
			                   COUNT(*) OVER (PARTITION BY m.path) AS matches
			             FROM messages m LEFT JOIN sessions s ON s.path = m.path
			             WHERE ${where} AND ${LIVE_FILTER_SQL}
			            )
			            SELECT path, entry_id, role, timestamp, head, tail, cwd, name, started_at
			            FROM ranked r
			            WHERE rn <= ${ROWS_PER_FILE}
			              AND NOT EXISTS (
			                SELECT 1 FROM ranked parent
			                WHERE parent.path = r.parent_session AND parent.rn <= ${ROWS_PER_FILE}
			              )
			            ORDER BY matches DESC, started_at DESC, path
			            LIMIT ${SCAN_LIMIT}`).all(...params) as any;
			for (const r of rows as any[]) r.snip = likeSnippet((r as any).head ?? "", (r as any).tail ?? "", snippetTerms.length > 0 ? snippetTerms : terms);
		}

		// Live-entry and one-hop lineage suppression already happened in SQL,
		// before the scan limit, so fork rows cannot starve unrelated matches.
		const seenFiles = new Set<string>();
		const hits: SearchHit[] = [];
		let rankCounter = 0;
		for (const r of rows as RawRow[]) {
			if (seenFiles.has(r.path)) continue;
			seenFiles.add(r.path);
			hits.push({
				path: r.path,
				entryId: r.entry_id,
				role: r.role,
				timestamp: r.timestamp ?? "",
				snippet: r.snip ?? "",
				rank: rankCounter++,
				cwd: r.cwd ?? undefined,
				name: r.name ?? undefined,
				startedAt: r.started_at ?? undefined,
			});
			if (hits.length >= limit) break;
		}
		return { hits, backlogRemaining: getBacklog(db) };
	} finally {
		db.close();
	}
}

// --- Browse ---

export function getSessionRows(dbPath: string, limit: number): SessionRow[] {
	const db = openDb(dbPath);
	try {
		const rows = db
			.prepare("SELECT path, cwd, name, started_at, preview FROM sessions ORDER BY started_at DESC LIMIT ?")
			.all(limit) as any[];
		return rows.map((r) => ({ path: r.path, cwd: r.cwd ?? "", name: r.name ?? undefined, startedAt: r.started_at ?? undefined, preview: r.preview ?? undefined }));
	} finally {
		db.close();
	}
}
