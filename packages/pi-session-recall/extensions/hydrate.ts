/**
 * Hydration: direct JSONL parsing of Pi session files (never SessionManager.open —
 * it rewrites legacy files), branch-aware windows/bookends, READ head/tail.
 * Pure functions over file paths; no SQLite access.
 */
/// <reference types="node" />
import { readTranscriptEntries, type TranscriptEntry } from "./transcript.ts";
import type { WindowMessage } from "./types.ts";

export interface WindowResult {
	messages: WindowMessage[];
	/** Every message on the resolved branch, root→tip chronological. Callers
 *  derive bookends from this instead of re-parsing the transcript. */
	branchMessages: WindowMessage[];
	messagesBefore: number;
	messagesAfter: number;
	/** Tip of the branch the window was resolved on — pass back as branchTip to
	 *  keep scrolling on this branch across forks. May be a non-message entry id. */
	branchTip: string;
}

export interface ReadResult {
	messages: WindowMessage[];
	totalMessages: number;
	truncated: boolean;
}

interface Entry {
	id: string;
	parentId: string | null;
	type: string;
	timestamp?: string;
	message?: {
		role?: string;
		content?: string | Array<{ type?: string; text?: string }>;
	};
}

/** Project a boundary entry onto the shape hydration consumes. Entries without
 *  a validated id pair are dropped (they carry no hydratable position); the
 *  raw data must be a JSON object for any projection beyond id/parentId to
 *  exist at all. */
function toEntry(t: TranscriptEntry): Entry | null {
	if (t.id === undefined) return null;
	if (t.data === null || typeof t.data !== "object") return null;
	const rec = t.data as Record<string, unknown>;
	const message = rec.message !== null && typeof rec.message === "object"
		? (rec.message as Entry["message"])
		: undefined;
	return {
		id: t.id,
		parentId: t.parentId ?? null,
		type: typeof rec.type === "string" ? rec.type : "",
		timestamp: typeof rec.timestamp === "string" ? rec.timestamp : undefined,
		message,
	};
}

/** Parse JSONL lines; malformed lines are skipped and duplicate/invalid ids are
 *  handled by the shared transcript boundary. Entries stream out of the
 *  boundary's generator and only successfully projected ones are pushed. */
function parseSessionEntries(sessionPath: string): Entry[] {
	// The bounded snapshot read (O_NONBLOCK + descriptor validation + fixed-size
	// read) is shared with the index engine; the fd pins the inode so a
	// concurrent append after fstat waits until the next hydration call.
	const entries: Entry[] = [];
	for (const t of readTranscriptEntries(sessionPath)) {
		const projected = toEntry(t);
		if (projected !== null) entries.push(projected);
	}
	return entries;
}

/** Leaf = last entry in file order whose ancestry contains a message; detached
 *  trailing metadata must not hide the transcript.
 *  Linear time: each entry's ancestry verdict is memoized, so every parent
 *  chain segment is traversed once regardless of how many trailing candidates
 *  share ancestry. Cycle handling matches branch(): truncation at the first
 *  revisit means every path node's truncated chain is a suffix of the path,
 *  so one walk's verdict covers all its memoized nodes. */
function leafId(entriesById: Map<string, Entry>, entries: Entry[]): string | null {
	const hasMessageAncestor = new Map<string, boolean>();
	let leaf: string | null = null;
	for (const start of entries) {
		const path: Entry[] = [];
		const onPath = new Set<string>();
		let cur: Entry = start;
		for (;;) {
			const known = hasMessageAncestor.get(cur.id);
			if (known !== undefined) {
				for (const e of path) hasMessageAncestor.set(e.id, known);
				break;
			}
			if (onPath.has(cur.id)) {
				// No message was found before revisiting (we exit on message first).
				for (const e of path) hasMessageAncestor.set(e.id, false);
				break;
			}
			onPath.add(cur.id);
			path.push(cur);
			if (cur.type === "message") {
				// Every node above the first message has one in its ancestry too.
				for (const e of path) hasMessageAncestor.set(e.id, true);
				break;
			}
			const parent = cur.parentId ? entriesById.get(cur.parentId) : undefined;
			if (!parent) {
				for (const e of path) hasMessageAncestor.set(e.id, false);
				break;
			}
			cur = parent;
		}
		if (hasMessageAncestor.get(start.id)) leaf = start.id;
	}
	return leaf;
}

/** Walk parentId chain from entry to root, reversed (root→entry). */
function branch(entriesById: Map<string, Entry>, entryId: string): Entry[] {
	const chain: Entry[] = [];
	let cur: Entry | undefined = entriesById.get(entryId);
	// ponytail: cycle guard for corrupt files — revisit only if real sessions ever contain cycles
	const seen = new Set<string>();
	while (cur && !seen.has(cur.id)) {
		seen.add(cur.id);
		chain.push(cur);
		cur = cur.parentId ? entriesById.get(cur.parentId) : undefined;
	}
	return chain.reverse();
}

/** Deepest entry in file order whose ancestry contains tipId (tipId itself if none). */
function deepestDescendant(
	entriesById: Map<string, Entry>,
	entries: Entry[],
	anchorId: string,
): string {
	const onBranch = new Set([anchorId]);
	let tip = anchorId;
	for (const e of entries) {
		if (e.parentId && onBranch.has(e.parentId)) {
			onBranch.add(e.id);
			tip = e.id;
		}
	}
	return tip;
}

function toWindowMessage(e: Entry): WindowMessage {
	const m = e.message ?? {};
	const content =
		typeof m.content === "string"
			? m.content
			: Array.isArray(m.content)
				? m.content
						.filter((p) => p?.type === "text" && typeof p.text === "string")
						.map((p) => p.text)
						.join("\n")
				: "";
	return {
		entryId: e.id,
		role: typeof m.role === "string" ? m.role.slice(0, 32) : "",
		content,
		timestamp: typeof e.timestamp === "string" ? e.timestamp.slice(0, 128) : "",
	};
}

/** Active-branch messages for a given tip, root→tip chronological. */
function branchMessages(
	entriesById: Map<string, Entry>,
	tipId: string,
): WindowMessage[] {
	return branch(entriesById, tipId)
		.filter((e) => e.type === "message")
		.map(toWindowMessage);
}

/** Resolve a scroll cursor to a message: the cursor itself when it is a
 *  message, otherwise its nearest message ancestor. Throws when the cursor is
 *  unknown or has no message ancestor. */
function resolveMessageCursor(
	entriesById: Map<string, Entry>,
	anchorEntryId: string,
): Entry {
	const anchor = entriesById.get(anchorEntryId);
	if (!anchor) throw new Error(`anchor entry ${anchorEntryId} not found in session`);
	let cur: Entry | undefined = anchor;
	const seen = new Set<string>();
	while (cur && cur.type !== "message" && !seen.has(cur.id)) {
		seen.add(cur.id);
		cur = cur.parentId ? entriesById.get(cur.parentId) : undefined;
	}
	if (!cur || cur.type !== "message") throw new Error(`anchor entry ${anchorEntryId} has no message ancestor`);
	return cur;
}

export function getWindow(
	sessionPath: string,
	anchorEntryId: string,
	windowN: number,
	opts?: { branchTip?: string },
): WindowResult {
	const n = Math.max(0, Math.min(50, windowN));
	const entries = parseSessionEntries(sessionPath);
	const entriesById = new Map(entries.map((e) => [e.id, e]));
	// A non-message branch-tip cursor centers on its nearest message ancestor;
	// the non-message tip itself stays branchTip so scrolling remains on branch.
	const messageAnchor = resolveMessageCursor(entriesById, anchorEntryId);
	const anchorEntryIdMsg = messageAnchor.id;

	let tip: string;
	if (opts?.branchTip) {
		// Explicit branch selection: resolve the branch from its tip (deepest
		// descendant), independent of where the window centers.
		resolveMessageCursor(entriesById, opts.branchTip); // unknown tip → throw
		tip = deepestDescendant(entriesById, entries, opts.branchTip);
		if (!branch(entriesById, tip).some((e) => e.id === messageAnchor.id)) {
			throw new Error(`anchor entry ${anchorEntryId} is not on branch ${opts.branchTip}`);
		}
	} else {
		tip = deepestDescendant(entriesById, entries, anchorEntryId);
	}
	const msgs = branchMessages(entriesById, tip);
	const idx = msgs.findIndex((m) => m.entryId === anchorEntryIdMsg);
	const start = Math.max(0, idx - n);
	const end = Math.min(msgs.length - 1, idx + n);
	return {
		branchMessages: msgs,
		messages: msgs.slice(start, end + 1).map((m) =>
			m.entryId === anchorEntryIdMsg ? { ...m, anchor: true } : m,
		),
		messagesBefore: idx,
		messagesAfter: msgs.length - 1 - idx,
		branchTip: tip,
	};
}

export function readSession(
	sessionPath: string,
	head = 20,
	tail = 10,
): ReadResult {
	const entries = parseSessionEntries(sessionPath);
	const entriesById = new Map(entries.map((e) => [e.id, e]));
	const leaf = leafId(entriesById, entries);
	if (!leaf) return { messages: [], totalMessages: 0, truncated: false };
	const msgs = branchMessages(entriesById, leaf);
	if (msgs.length > head + tail) {
		return {
			messages: [...msgs.slice(0, head), ...msgs.slice(-tail)],
			totalMessages: msgs.length,
			truncated: true,
		};
	}
	return { messages: msgs, totalMessages: msgs.length, truncated: false };
}
