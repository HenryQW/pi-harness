/**
 * Shared shapes between the index engine (search-core) and hydration (hydrate).
 * Keep this file types-only.
 */

/** A hydrated message returned by windows/read. */
export interface WindowMessage {
	entryId: string;
	role: string;
	content: string;
	timestamp: string;
	/** True when this message is the anchor of a scroll/discovery window. */
	anchor?: boolean;
}

/** Metadata row for BROWSE mode (served from the index tables, not JSONL). */
export interface SessionRow {
	path: string;
	cwd: string;
	name?: string;
	startedAt?: string;
	preview?: string;
}

/** One FTS discovery hit before hydration. */
export interface SearchHit {
	path: string;
	entryId: string;
	role: string;
	timestamp: string;
	snippet: string;
	/** BM25 rank position (0 = best). */
	rank: number;
	/** Session metadata joined from the sessions table. */
	cwd?: string;
	name?: string;
	startedAt?: string;
}

export interface SyncResult {
	filesProcessed: number;
	messagesIndexed: number;
	filesSkipped: number;
	/** Changed files not yet indexed because the per-call cap was hit. */
	backlogRemaining: number;
}
