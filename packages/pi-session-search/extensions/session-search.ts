/**
 * pi-session-search entry point: config load, tool registration, mode dispatch.
 */
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { readFileSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
import { DEFAULT_SYNC_CAP, MAX_BACKFILL_FILES, MAX_QUERY_CHARS, getSessionRows, searchIndex, syncSessions } from "./search-core.ts";
import { getBranchMessages, getWindow, readSession } from "./hydrate.ts";
import type { WindowMessage } from "./types.ts";

const configPath = () => join(getAgentDir(), "config", "pi-session-search", "pi-session-search.json");
const dbPath = () => join(getAgentDir(), "config", "pi-session-search", "index.db");
const sessionsDir = () => join(getAgentDir(), "sessions");

const OUTPUT_CHAR_BUDGET = 50_000;

interface Config {
	backfillFiles: number;
}

/** Untrusted JSON: validate, log-and-default on malformed, never rewrite. */
function readConfig(): Config {
	const fallback = { backfillFiles: DEFAULT_SYNC_CAP };
	let raw: string;
	try {
		raw = readFileSync(configPath(), "utf8");
	} catch {
		return fallback; // missing config = defaults
	}
	try {
		const value = JSON.parse(raw);
		if (!value || typeof value !== "object" || Array.isArray(value)) return fallback;
		const cap = (value as Record<string, unknown>).backfillFiles;
		if (cap === undefined) return fallback;
		// Safe integer rejects untrusted magnitudes like 1e100 that would
		// defeat the sync work bound.
		if (typeof cap !== "number" || !Number.isSafeInteger(cap) || cap < 1 || cap > MAX_BACKFILL_FILES) {
			console.error("[pi-session-search] invalid backfillFiles in config; using default");
			return fallback;
		}
		return { backfillFiles: cap };
	} catch {
		console.error("[pi-session-search] malformed config; using default");
		return fallback;
	}
}

function clamp(n: number | undefined, min: number, max: number, dflt: number): number {
	if (typeof n !== "number" || !Number.isFinite(n)) return dflt;
	return Math.max(min, Math.min(max, Math.floor(n)));
}

function truncateContent(msgs: WindowMessage[], maxChars: number): WindowMessage[] {
	return msgs.map((m) =>
		m.content.length > maxChars ? { ...m, content: m.content.slice(0, maxChars) + "…" } : m,
	);
}

/** Binary-search the max uniform per-message content cap whose built result fits
 *  the budget; null when even empty message arrays don't fit. */
function maxFittingCap(maxLen: number, budget: number, build: (cap: number) => unknown): number | null {
	const fits = (cap: number) => JSON.stringify(build(cap)).length <= budget;
	if (!fits(0)) return null;
	let lo = 0;
	for (let hi = maxLen; lo < hi; ) {
		const mid = Math.ceil((lo + hi) / 2);
		if (fits(mid)) lo = mid;
		else hi = mid - 1;
	}
	return lo;
}

/** Build a result bounded to `budget`: largest uniform per-message cap across
 *  every WindowMessage array, or a metadata-only shape when nothing fits.
 *  build(null) must return the metadata-only variant with empty arrays. */
function boundContent(
	build: (cap: number | null) => Record<string, unknown>,
	maxLen: number,
	budget: number,
): Record<string, unknown> {
	const cap = maxFittingCap(maxLen, budget, (c) => build(c));
	return cap === null ? build(null) : { ...build(cap), contentTruncated: true };
}

interface ToolParams {
	query?: string;
	sessionId?: string;
	aroundMessageId?: string;
	branchTip?: string;
	window?: number;
	limit?: number;
	detail?: "adaptive" | "full";
}

const DESCRIPTION = `Search past Pi sessions stored on disk (FTS5-backed over a local SQLite index), or inspect one session in detail. No LLM calls — every shape returns actual messages.

FOUR CALLING SHAPES

  1) DISCOVERY — pass \`query\`:
     session_search(query="auth refactor", limit=3)
     Runs FTS5 search and returns the top N sessions with metadata, match snippet, and messages around each match. Adaptive detail (default): the top-ranked result carries a ±5 message window plus first/last bookend messages; lower-ranked results carry only the anchor message. Pass \`detail="full"\` to hydrate every result fully.

  2) SCROLL — pass \`sessionId\` + \`aroundMessageId\`:
     session_search(sessionId="...", aroundMessageId="e07", window=10)
     Returns ±window messages centered on the anchor (clamped to [1,20]). Use after discovery when you need more context than the default ±5 window. To scroll forward/backward, pass the last/first message entryId of the previous window back as aroundMessageId; messagesBefore/messagesAfter tell you where you are. Across forks, re-anchoring on a shared ancestor can jump branches — pass the previous response's branchTip as the branchTip argument (aroundMessageId only moves the center) to stay on that branch.

  3) READ — pass \`sessionId\` only:
     session_search(sessionId="...")
     Returns the session's active branch (first 20 + last 10 messages when large).

  4) BROWSE — no args:
     session_search()
     Returns recent sessions: name, cwd, start time, first-user-message preview. Use when asked "what was I working on" without a topic.

Mode is inferred from args; precedence: scroll > read > browse > discovery.

FTS5 SYNTAX
  AND is the default — multi-word queries require all terms. Use OR for broader recall (\`alpha OR beta\`), quoted phrases for exact match (\`"docker networking"\`), NOT to exclude (\`python NOT java\`). Wildcards work only as stem expansion of tokens ≥3 chars (trigram tokenizer); very short terms fall back to substring matching. The index covers user/assistant message text only — thinking, tool calls/results are not searchable.`;

export default function (pi: ExtensionAPI): void {
	const config = readConfig();

	// Best-effort sync at startup, deferred so the synchronous walk + SQLite
	// writes never block session start. The lazy in-tool-call sync retries.
	pi.on("session_start", (_event, _ctx) => {
		setTimeout(() => {
			try {
				syncSessions(sessionsDir(), dbPath(), { cap: config.backfillFiles });
			} catch {
				// Index stays stale; next tool call retries.
			}
		}, 0);
	});

	pi.registerTool({
		name: "session_search",
		label: "Session Search",
		description: DESCRIPTION,
		promptSnippet: "Search past Pi sessions for prior decisions and context",
		parameters: Type.Object({
			query: Type.Optional(Type.String({ description: "Search query (discovery). FTS5 syntax supported." })),
			sessionId: Type.Optional(Type.String({ description: "Absolute path of the session file." })),
			aroundMessageId: Type.Optional(Type.String({ description: "Anchor entry id for scroll mode — centers the window (with sessionId)." })),
			branchTip: Type.Optional(Type.String({ description: "Branch tip entry id from a previous response — selects which branch of a forked session to scroll; aroundMessageId must lie on it." })),
			window: Type.Optional(Type.Number({ description: "Scroll window radius, [1,20], default 5." })),
			limit: Type.Optional(Type.Number({ description: "Max results, [1,10], default 3." })),
			detail: Type.Optional(StringEnum(["adaptive", "full"] as const)),
		}),
		async execute(_toolCallId, rawParams: ToolParams, _signal, _onUpdate, ctx) {
			try {
				// LLMs sometimes send numeric ids/queries despite the string schema.
				const params: ToolParams = {
					query: rawParams.query != null ? String(rawParams.query) : undefined,
					sessionId: rawParams.sessionId != null ? String(rawParams.sessionId) : undefined,
					aroundMessageId: rawParams.aroundMessageId != null ? String(rawParams.aroundMessageId) : undefined,
					branchTip: rawParams.branchTip != null ? String(rawParams.branchTip) : undefined,
					window: rawParams.window,
					limit: rawParams.limit,
					detail: rawParams.detail,
				};
				let sessionId = params.sessionId?.trim() || undefined;
				const anchor = params.aroundMessageId?.trim() || undefined;
				if (sessionId) {
					// Trust boundary: canonical target must live under the real
					// sessions dir (realpath defeats symlink escapes).
					try {
						const resolved = realpathSync(sessionId);
						const root = realpathSync(sessionsDir());
						if (!resolved.startsWith(root + sep) || !resolved.endsWith(".jsonl")) {
							return textResult({ success: false, message: "sessionId must be a .jsonl file under the Pi sessions directory" });
						}
						// Rebind to the validated canonical path so downstream reads cannot
						// be redirected by a symlink swapped in after validation (TOCTOU).
						sessionId = resolved;
					} catch {
						return textResult({ success: false, message: `session file not found: ${sessionId}` });
					}
				}

				// --- SCROLL ---
				if (sessionId && anchor) {
					const w = clamp(params.window, 1, 20, 5);
					const branchTip = params.branchTip?.trim() || undefined;
					const win = getWindow(sessionId, anchor, w, branchTip ? { branchTip } : undefined);
					const base = { mode: "scroll", sessionId, branchTip: win.branchTip, messagesBefore: win.messagesBefore, messagesAfter: win.messagesAfter };
					let result: Record<string, unknown> = { ...base, messages: win.messages };
					if (JSON.stringify(result).length > OUTPUT_CHAR_BUDGET && win.messages.length > 0) {
						result = boundContent(
							(cap) => ({ ...base, messages: cap === null ? [] : truncateContent(win.messages, cap), contentTruncated: true }),
							Math.max(...win.messages.map((m) => m.content.length), 0),
							OUTPUT_CHAR_BUDGET,
						);
					}
					return textResult(result);
				}

				// --- READ ---
				if (sessionId) {
					const r = readSession(sessionId);
					let result: Record<string, unknown> = { mode: "read", sessionId, ...r };
					if (JSON.stringify(result).length > OUTPUT_CHAR_BUDGET && r.messages.length > 0) {
						// contentTruncated is character-level truncation, distinct from
						// the message-count `truncated`.
						result = boundContent(
							(cap) => ({
								mode: "read",
								sessionId,
								totalMessages: r.totalMessages,
								truncated: r.truncated,
								messages: cap === null ? [] : truncateContent(r.messages, cap),
								contentTruncated: true,
							}),
							Math.max(...r.messages.map((m) => m.content.length), 0),
							OUTPUT_CHAR_BUDGET,
						);
					}
					return textResult(result);
				}

				// Lazy sync: drains any backlog the capped session_start pass left.
				try {
					syncSessions(sessionsDir(), dbPath(), { cap: config.backfillFiles });
				} catch {
					// Serve from the possibly stale index rather than failing.
				}

				// --- BROWSE ---
				if (!params.query?.trim()) {
					const rows = getSessionRows(dbPath(), clamp(params.limit, 1, 10, 3));
					return textResult({ mode: "browse", sessions: rows });
				}

				// --- DISCOVERY ---
				const limit = clamp(params.limit, 1, 10, 3);
				const full = params.detail === "full";

				// Current-session guard: suppress hits on the live branch.
				let liveIds: Set<string> | undefined;
				let currentSessionPath: string | undefined;
				try {
					currentSessionPath = ctx.sessionManager.getSessionFile();
					liveIds = new Set(
						ctx.sessionManager
							.buildContextEntries()
							.filter((e) => e.type === "message")
							.map((e) => e.id),
					);
				} catch {
					// Guard unavailable → degrade gracefully, no suppression.
				}

				const { hits, backlogRemaining } = searchIndex(dbPath(), params.query, {
					limit,
					currentLiveEntryIds: liveIds,
					currentSessionPath,
				});

				const resultQuery = params.query!.trim().slice(0, MAX_QUERY_CHARS);
				// Reserve the complete response envelope and divide remaining space
				// across hits so the first hydrated result cannot starve later metadata.
				let used = JSON.stringify({ mode: "discovery", query: resultQuery, results: [], backlogRemaining }).length + Math.max(0, hits.length - 1);
				const results = hits.map((hit, index) => {
					const remaining = Math.floor((OUTPUT_CHAR_BUDGET - used) / (hits.length - index));
					const meta = {
						path: hit.path,
						snippet: hit.snippet,
						rank: hit.rank,
						matchMessageId: hit.entryId,
						role: hit.role,
						timestamp: hit.timestamp,
						cwd: hit.cwd,
						name: hit.name,
						startedAt: hit.startedAt,
					};
					const hydrateFull = full || hit.rank === 0;
					// Every hit is sized against the cumulative remaining budget: keep
					// as-is when it fits, else truncate to the largest uniform cap that
					// fits across messages and bookends, else metadata-only.
					// contentTruncated signals either case.
					const fitOrTruncate = (
						hitObj: Record<string, unknown>,
						messages: WindowMessage[],
						bookends?: { start: WindowMessage[]; end: WindowMessage[] },
					): Record<string, unknown> => {
						const out: Record<string, unknown> = { ...hitObj };
						if (JSON.stringify(out).length > remaining) {
							const pools = bookends ? [messages, bookends.start, bookends.end] : [messages];
							const maxLen = Math.max(...pools.flatMap((a) => a.map((m) => m.content.length)), 0);
							Object.assign(
								out,
								boundContent(
									(cap) => ({
										...hitObj,
										messages: cap === null ? [] : truncateContent(messages, cap),
										...(bookends && cap !== null
											? { bookends: { start: truncateContent(bookends.start, cap), end: truncateContent(bookends.end, cap) } }
											: bookends
												? { bookends: { start: [], end: [] } }
												: {}),
										contentTruncated: true,
									}),
									maxLen,
									remaining,
								),
							);
						}
						used += JSON.stringify(out).length;
						return out;
					};
					const hydrationFallback = (error: unknown) =>
						fitOrTruncate(
							{ ...meta, detail: hydrateFull ? "full" : "compact", messages: [], bookends: { start: [], end: [] }, messagesBefore: 0, messagesAfter: 0, error: (error instanceof Error ? error.message : String(error)).slice(0, 512) },
							[],
						);
					if (!hydrateFull) {
						// Compact hits still carry the matched anchor message.
						try {
							const win = getWindow(hit.path, hit.entryId, 0);
							// Mark when the fixed compact cap already removed content, so a
							// hit that still fits the budget isn't mistaken for complete.
							const overCompactCap = win.messages.some((m) => m.content.length > 2000);
							return fitOrTruncate({ ...meta, detail: "compact", ...(overCompactCap ? { contentTruncated: true } : {}), messages: truncateContent(win.messages, 2000), bookends: { start: [], end: [] }, messagesBefore: win.messagesBefore, messagesAfter: win.messagesAfter }, win.messages);
						} catch (error) {
							return hydrationFallback(error);
						}
					}
					try {
						const win = getWindow(hit.path, hit.entryId, 5);
						let bookends = { start: [], end: [] } as { start: WindowMessage[]; end: WindowMessage[] };
						try {
							// Same branch as the anchor — readSession would follow the
							// file's final leaf and attach unrelated sibling messages.
							const branchMsgs = getBranchMessages(hit.path, hit.entryId);
							bookends = { start: branchMsgs.slice(0, 3), end: branchMsgs.slice(-3) };
						} catch {
							// Bookends optional.
						}
						return fitOrTruncate(
							{
								...meta,
								detail: "full" as const,
								messages: win.messages,
								bookends,
								messagesBefore: win.messagesBefore,
								messagesAfter: win.messagesAfter,
							},
							win.messages,
							bookends,
						);
					} catch (error) {
						// Session file unreadable/moved since indexing → anchor-only.
						return hydrationFallback(error);
					}
				});

				const result: Record<string, unknown> = { mode: "discovery", query: resultQuery, results, backlogRemaining };
				return textResult(result);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return textResult({ success: false, error: message });
			}
		},
	});
}

function textResult(result: unknown) {
	let bounded = result;
	let text = JSON.stringify(bounded);
	if (text.length > OUTPUT_CHAR_BUDGET && bounded && typeof bounded === "object" && !Array.isArray(bounded)) {
		const copy: Record<string, unknown> = { ...(bounded as Record<string, unknown>), contentTruncated: true };
		for (const key of ["results", "sessions", "messages"] as const) {
			if (Array.isArray(copy[key])) copy[key] = [...copy[key] as unknown[]];
		}
		bounded = copy;
		text = JSON.stringify(bounded);
		while (text.length > OUTPUT_CHAR_BUDGET) {
			const array = ["results", "sessions", "messages"]
				.map((key) => copy[key])
				.find((value): value is unknown[] => Array.isArray(value) && value.length > 0);
			if (!array) {
				bounded = { success: false, error: "session_search result metadata exceeds output budget" };
				text = JSON.stringify(bounded);
				break;
			}
			array.pop();
			text = JSON.stringify(bounded);
		}
	}
	return {
		content: [{ type: "text" as const, text }],
		details: bounded,
	};
}
