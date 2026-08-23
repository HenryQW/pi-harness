/**
 * Index engine: SQLite schema (WAL, external-content trigram FTS5), capped
 * incremental sync from Pi session JSONL files, query sanitize ladder,
 * discovery search with one-hop lineage suppression. No pi runtime imports —
 * pure Node + better-sqlite3 so it is testable headless.
 */
import BetterSqlite3 from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import type { SearchHit, SessionRow, SyncResult } from "./types.ts";

export const DEFAULT_SYNC_CAP = 50;
export const MAX_QUERY_CHARS = 512;
const MAX_TEXT_CHARS = 20000;
const SCAN_LIMIT = 300;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS session_files (
  path TEXT PRIMARY KEY,
  size INTEGER NOT NULL,
  mtime_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  path TEXT PRIMARY KEY,
  cwd TEXT,
  name TEXT,
  started_at TEXT,
  preview TEXT,
  parent_session TEXT
);
CREATE TABLE IF NOT EXISTS messages (
  rowid INTEGER PRIMARY KEY,
  path TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  role TEXT NOT NULL,
  timestamp TEXT,
  text TEXT NOT NULL,
  UNIQUE(path, entry_id)
);
CREATE INDEX IF NOT EXISTS messages_path ON messages(path);
CREATE VIRTUAL TABLE IF NOT EXISTS session_fts USING fts5(
  text,
  content='messages',
  content_rowid='rowid',
  tokenize='trigram'
);
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO session_fts(rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO session_fts(session_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
END;
CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
  INSERT INTO session_fts(session_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
  INSERT INTO session_fts(rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

function openDb(dbPath: string): BetterSqlite3.Database {
	fs.mkdirSync(path.dirname(dbPath), { recursive: true });
	const db = new BetterSqlite3(dbPath);
	db.pragma("journal_mode = WAL");
	db.pragma("busy_timeout = 5000");
	db.exec(SCHEMA_SQL);
	return db;
}

// --- Parsing ---

interface ParsedMessage {
	entryId: string;
	role: string;
	timestamp: string | null;
	text: string;
}

interface ParsedFile {
	cwd: string | null;
	name: string | null;
	startedAt: string | null;
	parentSession: string | null;
	preview: string | null;
	messages: ParsedMessage[];
}

/** Middle-out truncation keeping head and tail. */
function truncateText(text: string, max = MAX_TEXT_CHARS): string {
	if (text.length <= max) return text;
	const notice = `\n... (truncated, ${text.length} chars total)\n`;
	const kept = Math.max(0, max - notice.length);
	const head = Math.ceil(kept / 2);
	const tail = Math.floor(kept / 2);
	return `${text.slice(0, head)}${notice}${tail > 0 ? text.slice(-tail) : ""}`;
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
	const parsed: ParsedFile = {
		cwd: null,
		name: null,
		startedAt: null,
		parentSession: null,
		preview: null,
		messages: [],
	};
	let content: string;
	try {
		content = fs.readFileSync(filePath, "utf-8");
	} catch {
		return parsed;
	}
	for (const line of content.split("\n")) {
		if (!line.trim()) continue;
		let entry: any;
		try {
			entry = JSON.parse(line);
		} catch {
			continue; // skip malformed lines
		}
		switch (entry?.type) {
			case "session":
				parsed.cwd = typeof entry.cwd === "string" ? entry.cwd : parsed.cwd;
				parsed.startedAt = typeof entry.timestamp === "string" ? entry.timestamp : parsed.startedAt;
				parsed.parentSession = typeof entry.parentSession === "string" ? entry.parentSession : parsed.parentSession;
				break;
			case "session_info":
				if (typeof entry.name === "string") parsed.name = entry.name;
				break;
			case "message": {
				const role = entry.message?.role;
				if (role !== "user" && role !== "assistant") break;
				const text = truncateText(extractText(entry.message.content));
				if (!text) break;
				if (role === "user" && parsed.preview === null) {
					parsed.preview = text.slice(0, 200);
				}
				parsed.messages.push({
					entryId: String(entry.id ?? ""),
					role,
					timestamp: typeof entry.timestamp === "string" ? entry.timestamp : null,
					text,
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

function isJunkCwd(cwd: string | null): boolean {
	if (!cwd) return false;
	const resolved = path.resolve(cwd);
	return resolved.startsWith("/private/tmp/") || resolved.startsWith("/tmp/");
}

function walkJsonlFiles(sessionsDir: string): Map<string, fs.Stats> {
	const found = new Map<string, fs.Stats>();
	if (!fs.existsSync(sessionsDir)) return found;
	const stack = [sessionsDir];
	while (stack.length > 0) {
		const dir = stack.pop()!;
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const ent of entries) {
			const full = path.join(dir, ent.name);
			if (ent.isDirectory()) {
				stack.push(full);
			} else if (ent.isFile() && ent.name.endsWith(".jsonl")) {
				try {
					found.set(full, fs.statSync(full));
				} catch {
					/* vanished mid-walk */
				}
			}
		}
	}
	return found;
}

// --- Sync ---

export function syncSessions(
	sessionsDir: string,
	dbPath: string,
	opts?: { cap?: number },
): SyncResult {
	const cap = opts?.cap ?? DEFAULT_SYNC_CAP;
	const db = openDb(dbPath);

	// Junk dirs are excluded from the walk entirely.
	const all = [...walkJsonlFiles(sessionsDir)].filter(([p]) => !isJunkEncodedDir(path.relative(sessionsDir, p).split(path.sep)));

	const watermarks = new Map(
		(db.prepare("SELECT path, size, mtime_ms FROM session_files").all() as any[]).map((r) => [r.path, r]),
	);

	const deleted = [...watermarks.keys()].filter((p) => !all.some(([fp]) => fp === p));
	const changed: { path: string; stat: fs.Stats }[] = [];
	for (const [p, stat] of all) {
		const wm = watermarks.get(p);
		if (wm && wm.size === stat.size && wm.mtime_ms === Math.floor(stat.mtimeMs)) continue;
		changed.push({ path: p, stat });
	}

	// Newest-first: crash-recovery priority.
	changed.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
	deleted.sort((a, b) => {
		const ma = watermarks.get(a)!.mtime_ms;
		const mb = watermarks.get(b)!.mtime_ms;
		return mb - ma;
	});

	const delStmt = db.prepare("DELETE FROM messages WHERE path = ?");
	const delSession = db.prepare("DELETE FROM sessions WHERE path = ?");
	const delFile = db.prepare("DELETE FROM session_files WHERE path = ?");
	const upsertFile = db.prepare(
		"INSERT INTO session_files(path, size, mtime_ms) VALUES (?, ?, ?) ON CONFLICT(path) DO UPDATE SET size=excluded.size, mtime_ms=excluded.mtime_ms",
	);
	const upsertSession = db.prepare(
		`INSERT INTO sessions(path, cwd, name, started_at, preview, parent_session) VALUES (?, ?, ?, ?, ?, ?)
		 ON CONFLICT(path) DO UPDATE SET cwd=excluded.cwd, name=excluded.name, started_at=excluded.started_at,
		 preview=excluded.preview, parent_session=excluded.parent_session`,
	);
	const insertMsg = db.prepare(
		"INSERT INTO messages(path, entry_id, role, timestamp, text) VALUES (?, ?, ?, ?, ?)",
	);

	const tx = db.transaction((filePath: string, stat: fs.Stats) => {
		const parsed = parseSessionFile(filePath);
		delStmt.run(filePath);
		upsertSession.run(filePath, parsed.cwd, parsed.name, parsed.startedAt, parsed.preview, parsed.parentSession);
		let count = 0;
		for (const msg of parsed.messages) {
			insertMsg.run(filePath, msg.entryId, msg.role, msg.timestamp, msg.text);
			count++;
		}
		upsertFile.run(filePath, stat.size, Math.floor(stat.mtimeMs));
		return { count, junk: isJunkCwd(parsed.cwd) };
	});

	let filesProcessed = 0;
	let messagesIndexed = 0;
	let filesSkipped = 0;

	for (const { path: p, stat } of changed.slice(0, cap)) {
		const res = tx(p, stat);
		if (res.junk) {
			// Watermarked so we don't re-parse junk every sync; rows already removed.
			filesSkipped++;
		} else {
			filesProcessed++;
			messagesIndexed += res.count;
		}
	}
	const changedRemaining = Math.max(0, changed.length - cap);

	let purged = 0;
	for (const p of deleted.slice(0, cap)) {
		delStmt.run(p);
		delSession.run(p);
		delFile.run(p);
		purged++;
	}
	const deletedRemaining = Math.max(0, deleted.length - cap);

	const backlog = changedRemaining + deletedRemaining;
	db.prepare("INSERT INTO meta(key, value) VALUES ('backlog', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(backlog));
	db.close();

	return { filesProcessed, messagesIndexed, filesSkipped, backlogRemaining: backlog };
}

function getBacklog(db: BetterSqlite3.Database): number {
	const row = db.prepare("SELECT value FROM meta WHERE key = 'backlog'").get() as { value: string } | undefined;
	return row ? Number(row.value) : 0;
}

// --- Query sanitize ladder ---

const OPERATOR_RE = /\b(OR|AND|NOT|NEAR)\b/;
const TOKEN_RE = /"([^"]*)"|(\S+)/g;

function collectTerms(query: string): string[] {
	const terms: string[] = [];
	for (const m of query.matchAll(TOKEN_RE)) {
		const raw = m[1] ?? m[2] ?? "";
		if (raw) terms.push(raw);
	}
	return terms;
}

function quoteTerms(terms: string[], sep: string): string {
	return terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(sep);
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

	const terms = collectTerms(query);
	if (terms.every((t) => t.replace(/"/g, "").length < 3)) {
		return { ftsCandidates: [], forceLike: true };
	}

	const natural = quoteTerms(terms, " ");
	const orExpanded = terms.length > 1 ? quoteTerms(terms, " OR ") : null;

	if (!OPERATOR_RE.test(query)) {
		// Quoted form cannot fail to parse; OR-expand only as breadth fallback.
		return { ftsCandidates: orExpanded ? [natural, orExpanded] : [natural], forceLike: false };
	}
	// Explicit operators: raw first, then recovery paths.
	const candidates = [query, natural];
	if (orExpanded) candidates.push(orExpanded);
	return { ftsCandidates: candidates, forceLike: false };
}

function likePattern(term: string): string {
	return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

// --- Search ---

export interface SearchOptions {
	limit?: number;
	/** Entry ids on the current session's live branch — hits here are skipped. */
	currentLiveEntryIds?: Set<string>;
	/** Path of the current session file. */
	currentSessionPath?: string;
}

const BASE_SELECT = `
SELECT m.path, m.entry_id, m.role, m.timestamp, m.rowid,
       snippet(session_fts, 0, '[', ']', '…', 16) AS snip
FROM session_fts JOIN messages m ON m.rowid = session_fts.rowid
WHERE session_fts MATCH ?
ORDER BY rank
LIMIT ${SCAN_LIMIT}`;

export function searchIndex(
	dbPath: string,
	query: string,
	opts?: SearchOptions,
): { hits: SearchHit[]; backlogRemaining: number } {
	const limit = opts?.limit ?? 3;
	const db = openDb(dbPath);
	try {
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
		}
		let rows: Omit<RawRow, "snip">[] = [];
		let usedLike = plan.forceLike;

		if (!plan.forceLike) {
			for (const cand of plan.ftsCandidates) {
				try {
					rows = db.prepare(BASE_SELECT).all(cand) as any;
					usedLike = false;
					break;
				} catch (err: any) {
					// Last candidate exhausted → LIKE fallback below.
					if (cand === plan.ftsCandidates[plan.ftsCandidates.length - 1]) usedLike = true;
				}
			}
		}

		if (usedLike) {
			const terms = collectTerms(query.trim().slice(0, MAX_QUERY_CHARS)).map((t) => t.replace(/"/g, ""));
			if (terms.length === 0) return { hits: [], backlogRemaining: getBacklog(db) };
			const where = terms.map(() => "text LIKE ? ESCAPE '\\'").join(" AND ");
			rows = db
				.prepare(`SELECT path, entry_id, role, timestamp FROM messages WHERE ${where} ORDER BY rowid DESC LIMIT ${SCAN_LIMIT}`)
				.all(...terms.map(likePattern)) as any;
		}

		// Current-session guard + one-hop lineage suppression + per-file dedup.
		const hitPaths = new Set(rows.map((r) => r.path));
		const parentOf = new Map<string, string | null>();
		const stmtParent = db.prepare("SELECT parent_session FROM sessions WHERE path = ?");
		for (const p of hitPaths) {
			const row = stmtParent.get(p) as { parent_session: string | null } | undefined;
			parentOf.set(p, row?.parent_session ?? null);
		}

		const seenFiles = new Set<string>();
		const hits: SearchHit[] = [];
		let rankCounter = 0;
		for (const r of rows as RawRow[]) {
			// Entry-level guard only: same-file hits outside the live branch
			// (compacted away / inactive branch) stay discoverable per spec.
			if (opts?.currentLiveEntryIds?.has(r.entry_id)) continue;

			// One hop: drop child hits when the named parent itself has hits.
			const parent = parentOf.get(r.path);
			if (parent && hitPaths.has(parent)) continue;

			if (seenFiles.has(r.path)) continue;
			seenFiles.add(r.path);
			hits.push({
				path: r.path,
				entryId: r.entry_id,
				role: r.role,
				timestamp: r.timestamp ?? "",
				snippet: r.snip ?? "",
				rank: rankCounter++,
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
		return rows.map((r) => ({ path: r.path, cwd: r.cwd ?? "", name: r.name ?? undefined, startedAt: r.startedAt ?? undefined, preview: r.preview ?? undefined }));
	} finally {
		db.close();
	}
}
