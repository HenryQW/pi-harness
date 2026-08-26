/**
 * Neutral JSONL trust boundary for Pi session transcripts: one bounded,
 * descriptor-validated snapshot per read, parsed into entries whose only
 * trusted fields are the validated id/parentId pair. No pi runtime imports —
 * shared by the index engine (search-core) and hydration (hydrate).
 */
import fs from "node:fs";

/** Hard byte ceiling per session file: larger files are skipped (and retried
 *  behind fresh work) instead of being read whole into memory. */
export const MAX_SESSION_FILE_BYTES = 32 * 1024 * 1024;

/** Open the path once, validate that exact descriptor (type + size), and read
 *  only the validated snapshot from it. A concurrent append/replacement between
 *  the walk's stat and this open cannot grow the allocation or the read beyond
 *  maxBytes: the fd pins the inode, and fstat on that fd fixes both bounds.
 *  Deliberately not fs.readFileSync(fd) — that re-reads to EOF unbounded.
 *  Shared with hydration: callers pass their own byte ceiling (both use
 *  MAX_SESSION_FILE_BYTES in production). */
export function readBoundedSnapshot(filePath: string, maxBytes: number): string {
	// O_NONBLOCK keeps a writerless FIFO (regular .jsonl swapped mid-walk) from
	// blocking this open before fstat rejects it; O_NOFOLLOW (absent on Windows)
	// rejects a symlink swapped in after the walk instead of following it.
	const fd = fs.openSync(
		filePath,
		fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | (fs.constants.O_NOFOLLOW ?? 0),
	);
	try {
		const st = fs.fstatSync(fd);
		if (!st.isFile()) throw new Error(`session path is not a regular file: ${filePath}`);
		if (st.size > maxBytes) {
			throw new Error(`session file exceeds ${Math.round(maxBytes / (1024 * 1024))} MiB snapshot limit: ${filePath}`);
		}
		const buf = Buffer.allocUnsafe(st.size);
		let read = 0;
		while (read < buf.length) {
			const n = fs.readSync(fd, buf, read, buf.length - read, read);
			if (n === 0) break; // truncated concurrently after fstat: index what was there
			read += n;
		}
		return buf.toString("utf-8", 0, read);
	} finally {
		fs.closeSync(fd);
	}
}

/** One parseable JSONL line. `data` is the raw parsed JSON value — any JSON
 *  type, never assumed to be an object. `id`/`parentId` exist only when both
 *  passed validation at this boundary; consumers may rely on them without
 *  re-validating. */
export interface TranscriptEntry {
	data: unknown;
	/** Nonempty string ≤256 chars; absent when missing or invalid. */
	id?: string;
	/** null or string ≤256 chars; defined only when `id` is present. */
	parentId?: string | null;
}

/** Validate the id pair exactly as both previous parsers did: a valid entry
 *  needs a usable id AND a nullish-or-valid parentId; anything else is treated
 *  as id-less data (still projected for headers, never hydrated). */
function validateIds(data: unknown): { id: string; parentId: string | null } | undefined {
	const rec = data !== null && typeof data === "object" ? (data as Record<string, unknown>) : undefined;
	const id = rec?.id;
	if (typeof id !== "string" || id.length === 0 || id.length > 256) return undefined;
	const parentId = rec?.parentId;
	if (parentId == null) return { id, parentId: null };
	if (typeof parentId === "string" && parentId.length <= 256) return { id, parentId };
	return undefined;
}

/** Lazily yield one bounded snapshot of `filePath` as JSONL entries in file
 *  order — no materialized entry array, and lines are located by newline
 *  scan rather than splitting the whole snapshot into a string array.
 *  Blank and malformed JSON lines are skipped. The first occurrence of
 *  every valid id is reserved across all entry types; later duplicates are
 *  dropped entirely. Entries without a valid id pair are retained so index
 *  header/session_info projection can still use them — hydration projects to
 *  entries carrying a validated `id`. The snapshot is read once when iteration
 *  starts (fd-pinned descriptor validation still applies); consumers iterate
 *  immediately via for-of. */
export function* readTranscriptEntries(
	filePath: string,
	maxBytes: number = MAX_SESSION_FILE_BYTES,
): Generator<TranscriptEntry> {
	const content = readBoundedSnapshot(filePath, maxBytes);
	const seenIds = new Set<string>();
	let start = 0;
	while (start < content.length) {
		const nl = content.indexOf("\n", start);
		const end = nl === -1 ? content.length : nl;
		const line = content.slice(start, end);
		start = end + 1;
		if (!line.trim()) continue;
		let data: unknown;
		try {
			data = JSON.parse(line);
		} catch {
			continue; // skip malformed lines
		}
		const ids = validateIds(data);
		if (!ids) {
			yield { data };
			continue;
		}
		// Hydration is first-wins across every entry type; reserve IDs here so
		// no consumer can ever point at a different duplicate.
		if (seenIds.has(ids.id)) continue;
		seenIds.add(ids.id);
		yield { data, id: ids.id, parentId: ids.parentId };
	}
}
