/**
 * Hydration: direct JSONL parsing of Pi session files (never SessionManager.open —
 * it rewrites legacy files), branch-aware windows/bookends, READ head/tail.
 * Pure functions over file paths; no SQLite access.
 */
/// <reference types="node" />
import { readFileSync } from "node:fs";
import type { WindowMessage } from "./types.ts";

export interface WindowResult {
	messages: WindowMessage[];
	messagesBefore: number;
	messagesAfter: number;
	/** Tip of the branch the window was resolved on — pass back as
	 *  aroundMessageId to keep scrolling on this branch across forks. */
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

/** Parse JSONL lines; malformed lines are skipped. Header line (no id) skipped. */
function parseSessionEntries(sessionPath: string): Entry[] {
	const raw = readFileSync(sessionPath, "utf8");
	const entries: Entry[] = [];
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		let obj: unknown;
		try {
			obj = JSON.parse(line);
		} catch {
			continue; // skip malformed line
		}
		const e = obj as Entry;
		if (e && typeof e.id === "string") entries.push(e);
	}
	return entries;
}

/** Leaf = last entry in file order. */
function leafId(entries: Entry[]): string | null {
	return entries.length ? entries[entries.length - 1].id : null;
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
			: (m.content ?? [])
					.filter((p) => p?.type === "text")
					.map((p) => p.text ?? "")
					.join("\n");
	return {
		entryId: e.id,
		role: m.role ?? "",
		content,
		timestamp: e.timestamp ?? "",
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

/** All messages on the anchor's branch, root→tip chronological (bnRnt). */
export function getBranchMessages(
	sessionPath: string,
	anchorEntryId: string,
): WindowMessage[] {
	const entries = parseSessionEntries(sessionPath);
	const entriesById = new Map(entries.map((e) => [e.id, e]));
	const anchor = entriesById.get(anchorEntryId);
	if (!anchor) throw new Error(`anchor entry ${anchorEntryId} not found in ${sessionPath}`);
	if (anchor.type !== "message")
		throw new Error(`anchor entry ${anchorEntryId} is not a message entry`);
	return branchMessages(entriesById, deepestDescendant(entriesById, entries, anchorEntryId));
}

export function getWindow(
	sessionPath: string,
	anchorEntryId: string,
	windowN: number,
): WindowResult {
	const n = Math.max(0, Math.min(50, windowN));
	const entries = parseSessionEntries(sessionPath);
	const entriesById = new Map(entries.map((e) => [e.id, e]));
	const anchor = entriesById.get(anchorEntryId);
	if (!anchor) throw new Error(`anchor entry ${anchorEntryId} not found in ${sessionPath}`);
	if (anchor.type !== "message")
		throw new Error(`anchor entry ${anchorEntryId} is not a message entry`);

	const tip = deepestDescendant(entriesById, entries, anchorEntryId);
	const msgs = branchMessages(entriesById, tip);
	const idx = msgs.findIndex((m) => m.entryId === anchorEntryId);
	const start = Math.max(0, idx - n);
	const end = Math.min(msgs.length - 1, idx + n);
	return {
		messages: msgs.slice(start, end + 1).map((m) =>
			m.entryId === anchorEntryId ? { ...m, anchor: true } : m,
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
	const leaf = leafId(entries);
	if (!leaf) return { messages: [], totalMessages: 0, truncated: false };
	const entriesById = new Map(entries.map((e) => [e.id, e]));
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
