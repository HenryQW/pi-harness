/**
 * Hydration: direct JSONL parsing of Pi session files (never SessionManager.open —
 * it rewrites legacy files), branch-aware windows/bookends, READ head/tail.
 * Pure functions over file paths; no SQLite access.
 */
import type { WindowMessage } from "./types.ts";

// TODO(1B): implement.

export interface WindowResult {
	messages: WindowMessage[];
	messagesBefore: number;
	messagesAfter: number;
}

export function getWindow(
	sessionPath: string,
	anchorEntryId: string,
	windowN: number,
): WindowResult {
	throw new Error("not implemented");
}

export interface ReadResult {
	messages: WindowMessage[];
	totalMessages: number;
	truncated: boolean;
}

export function readSession(
	sessionPath: string,
	head = 20,
	tail = 10,
): ReadResult {
	throw new Error("not implemented");
}
