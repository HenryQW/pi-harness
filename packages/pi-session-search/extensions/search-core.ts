/**
 * Index engine: SQLite schema (WAL, external-content trigram FTS5), capped
 * incremental sync from Pi session JSONL files, query sanitize ladder,
 * discovery search with one-hop lineage suppression. No pi runtime imports —
 * pure Node + better-sqlite3 so it is testable headless.
 */
import type { SearchHit, SessionRow, SyncResult } from "./types.ts";

// TODO(1A): implement.

export const DEFAULT_SYNC_CAP = 50;
export const MAX_QUERY_CHARS = 512;

export function syncSessions(
	sessionsDir: string,
	dbPath: string,
	opts?: { cap?: number },
): SyncResult {
	throw new Error("not implemented");
}

export interface SearchOptions {
	limit?: number;
	/** Entry ids on the current session's live branch — hits here are skipped. */
	currentLiveEntryIds?: Set<string>;
	/** Path of the current session file. */
	currentSessionPath?: string;
}

export function searchIndex(
	dbPath: string,
	query: string,
	opts?: SearchOptions,
): { hits: SearchHit[]; backlogRemaining: number } {
	throw new Error("not implemented");
}

export function getSessionRows(dbPath: string, limit: number): SessionRow[] {
	throw new Error("not implemented");
}
