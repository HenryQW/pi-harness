/**
 * pi-session-recall entry point: tool registration and mode dispatch.
 */
import { getAgentDir, keyHint, truncateToVisualLines } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { extensionConfigDir } from "@henryqw/pi-config-store";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { realpathSync } from "node:fs";
import { join, sep } from "node:path";
import { getPreparationRows, getSessionRows, searchIndex, syncSessions } from "./search-core.ts";
import { getWindow, readSession } from "./hydrate.ts";
import { MAX_QUERY_CHARS } from "./query.ts";
import { inventoryRepository, type RepositoryInventory } from "./repository-inventory.ts";
import type { PreparationSessionRow, WindowMessage } from "./types.ts";

const dbPath = () => join(extensionConfigDir("pi-session-recall"), "index.db");
const sessionsDir = () => join(getAgentDir(), "sessions");

const OUTPUT_CHAR_BUDGET = 50_000;
const INVENTORY_CHAR_BUDGET = 10_000;
const ERROR_MESSAGE_CHARS = 512;

function clamp(n: number | undefined, min: number, max: number, dflt: number): number {
	if (typeof n !== "number" || !Number.isFinite(n)) return dflt;
	return Math.max(min, Math.min(max, Math.floor(n)));
}

/** UTF-16 surrogate halves. */
const isHighSurrogate = (s: string, i: number) => {
	const u = s.charCodeAt(i);
	return u >= 0xd800 && u <= 0xdbff;
};
const isLowSurrogate = (s: string, i: number) => {
	const u = s.charCodeAt(i);
	return u >= 0xdc00 && u <= 0xdfff;
};

export function truncateContent(msgs: WindowMessage[], maxChars: number): WindowMessage[] {
	return msgs.map((m) => {
		if (m.content.length <= maxChars) return m;
		const c = m.content;
		let head = Math.ceil(maxChars / 2);
		const tail = Math.floor(maxChars / 2);
		// Shift only cut points that land inside an astral character (surrogate
		// pair); everything else keeps the exact head/tail split.
		if (head > 0 && isHighSurrogate(c, head - 1) && isLowSurrogate(c, head)) head--;
		let tailStart = c.length - tail;
		if (tail > 0 && tailStart > 0 && isHighSurrogate(c, tailStart - 1) && isLowSurrogate(c, tailStart)) tailStart++;
		return {
			...m,
			content: c.slice(0, head) + "…" + (tail > 0 ? c.slice(tailStart) : ""),
		};
	});
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

type InventoryCollection = "packageScripts" | "executableScripts" | "skills" | "agentInstructions";
const INVENTORY_COLLECTIONS: InventoryCollection[] = ["packageScripts", "executableScripts", "skills", "agentInstructions"];

function inventoryShape(
	source: RepositoryInventory,
	kept: Record<InventoryCollection, unknown[]>,
): Record<string, unknown> {
	const omittedCounts = {
		packageScripts: source.packageScripts.length - kept.packageScripts.length,
		executableScripts: source.executableScripts.length - kept.executableScripts.length,
		skills: source.skills.length - kept.skills.length,
		agentInstructions: source.agentInstructions.length - kept.agentInstructions.length,
	};
	return {
		available: source.available,
		...(source.reason ? { reason: source.reason } : {}),
		...(source.provenance ? { provenance: source.provenance } : {}),
		worktreeVerified: source.worktreeVerified,
		packageScripts: kept.packageScripts,
		executableScripts: kept.executableScripts,
		skills: kept.skills,
		agentInstructions: kept.agentInstructions,
		truncated: Object.values(omittedCounts).some((count) => count > 0),
		omittedCounts,
	};
}

/** Keep stable prefixes from every inventory collection within one bounded,
 * round-robin allocation so a large first collection cannot starve the rest. */
function boundInventory(source: RepositoryInventory, maxChars: number): Record<string, unknown> {
	const all: Record<InventoryCollection, unknown[]> = {
		packageScripts: source.packageScripts,
		executableScripts: source.executableScripts,
		skills: source.skills,
		agentInstructions: source.agentInstructions,
	};
	const full = inventoryShape(source, all);
	if (JSON.stringify(full).length <= maxChars) return full;

	const kept: Record<InventoryCollection, unknown[]> = {
		packageScripts: [],
		executableScripts: [],
		skills: [],
		agentInstructions: [],
	};
	const blocked = new Set<InventoryCollection>();
	for (;;) {
		let advanced = false;
		for (const key of INVENTORY_COLLECTIONS) {
			if (blocked.has(key) || kept[key].length >= all[key].length) continue;
			const candidate = { ...kept, [key]: [...kept[key], all[key][kept[key].length]] };
			if (JSON.stringify(inventoryShape(source, candidate)).length <= maxChars) {
				kept[key] = candidate[key];
				advanced = true;
			} else {
				blocked.add(key);
			}
		}
		if (!advanced) break;
	}
	return inventoryShape(source, kept);
}

interface PreparedSession {
	metadata: Record<string, unknown>;
	messages: WindowMessage[];
}

function hydrationError(error: unknown): { kind: "missing" | "oversized" | "unreadable"; message: string } {
	const message = (error instanceof Error ? error.message : String(error)).slice(0, ERROR_MESSAGE_CHARS);
	const code = (error as NodeJS.ErrnoException)?.code;
	return {
		kind: code === "ENOENT" ? "missing" : message.includes("exceeds 32 MiB snapshot limit") ? "oversized" : "unreadable",
		message,
	};
}

function hydratePreparationSession(row: PreparationSessionRow): PreparedSession {
	const indexed = {
		path: row.path,
		cwd: row.cwd,
		name: row.name ?? null,
		startedAt: row.startedAt ?? null,
		lineageId: row.lineageId,
	};
	try {
		const hydrated = readSession(row.path, 20, 10, { userAssistantTextOnly: true });
		return {
			metadata: {
				...indexed,
				branchTip: hydrated.branchTip,
				totalMessages: hydrated.totalMessages,
				truncated: hydrated.truncated,
				contentTruncated: false,
				messages: [],
			},
			messages: hydrated.messages,
		};
	} catch (error) {
		return {
			metadata: {
				...indexed,
				branchTip: null,
				totalMessages: null,
				truncated: false,
				contentTruncated: false,
				messages: [],
				error: hydrationError(error),
			},
			messages: [],
		};
	}
}

function allocatePreparationMessages(session: PreparedSession, budget: number): Record<string, unknown> {
	if (session.messages.length === 0) return session.metadata;
	if (JSON.stringify(session.messages).length - 2 <= budget) {
		return { ...session.metadata, messages: session.messages };
	}
	const maxLen = Math.max(...session.messages.map((message) => message.content.length), 0);
	const cap = maxFittingCap(maxLen, budget + 2, (value) => truncateContent(session.messages, value));
	return {
		...session.metadata,
		contentTruncated: true,
		messages: cap === null ? [] : truncateContent(session.messages, cap),
	};
}

function buildPreparationResult(
	kind: "repository" | "all",
	requestedLimit: number,
	gitRoot: string | undefined,
	syncResult: ReturnType<typeof syncSessions>,
	rows: PreparationSessionRow[],
	repositoryInventory: RepositoryInventory,
): Record<string, unknown> {
	const sync = {
		walkComplete: syncResult.walkComplete,
		backlogRemaining: syncResult.backlogRemaining,
		complete: syncResult.walkComplete && syncResult.backlogRemaining === 0,
	};
	const sessions = rows.map(hydratePreparationSession);
	const emptyCollections: Record<InventoryCollection, unknown[]> = {
		packageScripts: [],
		executableScripts: [],
		skills: [],
		agentInstructions: [],
	};
	const minimumInventory = inventoryShape(repositoryInventory, emptyCollections);
	const build = (
		preparedSessions: Record<string, unknown>[],
		inventory: Record<string, unknown>,
		contentTruncated: boolean,
	) => ({
		mode: "prepare-pattern-miner",
		scope: { kind, gitRoot: gitRoot ?? null, requestedLimit, sampledCount: preparedSessions.length },
		sync,
		sessions: preparedSessions,
		inventory,
		contentTruncated,
	});

	const metadataOnlyLength = JSON.stringify(build(sessions.map((session) => session.metadata), minimumInventory, false)).length;
	if (metadataOnlyLength > OUTPUT_CHAR_BUDGET) throw new Error("Pattern-miner preparation metadata exceeds output budget.");
	const inventoryBudget = Math.min(
		INVENTORY_CHAR_BUDGET,
		JSON.stringify(minimumInventory).length + OUTPUT_CHAR_BUDGET - metadataOnlyLength,
	);
	const inventory = boundInventory(repositoryInventory, inventoryBudget);
	const baseLength = JSON.stringify(build(sessions.map((session) => session.metadata), inventory, false)).length;
	const perSessionBudget = sessions.length === 0 ? 0 : Math.floor((OUTPUT_CHAR_BUDGET - baseLength) / sessions.length);
	const allocated = sessions.map((session) => allocatePreparationMessages(session, perSessionBudget));
	const contentTruncated = allocated.some((session) => session.contentTruncated === true);
	return build(allocated, inventory, contentTruncated);
}

interface ToolParams {
	operation?: "prepare-pattern-miner";
	scope?: "repository" | "all";
	query?: string;
	sessionId?: string;
	aroundMessageId?: string;
	branchTip?: string;
	window?: number;
	limit?: number;
	detail?: "adaptive" | "full";
}

const DESCRIPTION = `Search past Pi sessions locally with FTS5; returns stored messages.

- \`operation: "prepare-pattern-miner"\` + \`scope\`: prepare one bounded corpus and repository inventory.
- \`query\`: discover matches. Prefer distinctive identifiers or uncommon terms; multi-word queries are AND. Use \`OR\`/\`NOT\` for Boolean queries and quotes only when exact wording is known.
- \`sessionId\` + \`aroundMessageId\`: scroll ±\`window\`; retain \`branchTip\` across forks.
- \`sessionId\` alone: read; no args: browse recent sessions.
- Discovery is adaptive; use \`detail: "full"\` to hydrate every result.`;

export default function (pi: ExtensionAPI): void {
	// Best-effort sync at startup, deferred so the synchronous walk + SQLite
	// writes never block session start. The lazy in-tool-call sync retries.
	pi.on("session_start", (_event, _ctx) => {
		setTimeout(() => {
			try {
				syncSessions(sessionsDir(), dbPath());
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
		promptGuidelines: [
			"Use session_search only when the user explicitly asks about past Pi sessions, historical decisions, or repeated work not available in the current conversation. Do not use it for current-session continuation or ordinary repository inspection.",
		],
		parameters: Type.Object({
			operation: Type.Optional(StringEnum(["prepare-pattern-miner"] as const)),
			scope: Type.Optional(StringEnum(["repository", "all"] as const)),
			query: Type.Optional(Type.String({ description: "Search query (discovery). FTS5 syntax supported." })),
			sessionId: Type.Optional(Type.String({ description: "Absolute path of the session file." })),
			aroundMessageId: Type.Optional(Type.String({ description: "Anchor entry id for scroll mode — centers the window (with sessionId)." })),
			branchTip: Type.Optional(Type.String({ description: "Branch tip entry id from a previous response — selects which branch of a forked session to scroll; aroundMessageId must lie on it." })),
			window: Type.Optional(Type.Number({ description: "Scroll window radius, [1,20], default 5." })),
			limit: Type.Optional(Type.Number({ description: "Max results, [1,10]. Defaults to 10 for preparation and 3 otherwise." })),
			detail: Type.Optional(StringEnum(["adaptive", "full"] as const)),
		}),
		renderResult(result, { expanded }, theme) {
			const output = result.content.find((part) => part.type === "text")?.text ?? "";
			const styledOutput = theme.fg("toolOutput", output);
			if (expanded) return new Text(`\n${styledOutput}`, 0, 0);
			return {
				render(width: number) {
					const preview = truncateToVisualLines(styledOutput, 5, width);
					if (preview.skippedCount === 0) return ["", ...preview.visualLines];
					const hint = theme.fg("muted", `... (${preview.skippedCount} earlier lines,`) +
						` ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
					return ["", truncateToWidth(hint, width, "..."), ...preview.visualLines];
				},
				invalidate() {},
			};
		},
		async execute(_toolCallId, rawParams: ToolParams, signal, _onUpdate, ctx) {
			try {
				if (rawParams.operation !== undefined && rawParams.operation !== "prepare-pattern-miner") {
					throw new Error("Unsupported session_search operation.");
				}
				if (rawParams.scope !== undefined && rawParams.operation === undefined) {
					throw new Error("scope requires operation: prepare-pattern-miner.");
				}
				if (rawParams.operation === "prepare-pattern-miner") {
					const incompatible = (["query", "sessionId", "aroundMessageId", "branchTip", "window", "detail"] as const)
						.filter((key) => rawParams[key] !== undefined);
					if (incompatible.length > 0) {
						throw new Error(`prepare-pattern-miner does not accept: ${incompatible.join(", ")}.`);
					}
					if (rawParams.scope !== "repository" && rawParams.scope !== "all") {
						throw new Error("prepare-pattern-miner requires scope: repository or all.");
					}
					const limit = clamp(rawParams.limit, 1, 10, 10);
					const inventory = await inventoryRepository(
						pi,
						{ cwd: ctx.cwd, signal },
						rawParams.scope === "repository" ? "required" : "optional",
					);
					const sync = syncSessions(sessionsDir(), dbPath());
					const currentSessionPath = ctx.sessionManager.getSessionFile() ?? undefined;
					const rows = getPreparationRows(dbPath(), {
						limit,
						...(rawParams.scope === "repository" ? { repositoryRoot: inventory.gitRoot! } : {}),
						currentSessionPath,
					});
					return textResult(buildPreparationResult(rawParams.scope, limit, inventory.gitRoot, sync, rows, inventory));
				}

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
								branchTip: r.branchTip,
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

				// Lazy sync: drains any backlog the capped startup pass left. A partial
				// or failed sync degrades to a warning; the stale index stays usable.
				let syncWarning: { kind: "incomplete-walk" } | { kind: "sync-failed"; error: string } | undefined;
				try {
					const sync = syncSessions(sessionsDir(), dbPath());
					if (!sync.walkComplete) syncWarning = { kind: "incomplete-walk" };
				} catch (error) {
					syncWarning = { kind: "sync-failed", error: (error instanceof Error ? error.message : String(error)).slice(0, 512) };
				}

				// --- BROWSE ---
				if (!params.query?.trim()) {
					const rows = getSessionRows(dbPath(), clamp(params.limit, 1, 10, 3));
					return textResult({ mode: "browse", sessions: rows, ...(syncWarning ? { syncWarning } : {}) });
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
				// The same warning-bearing envelope is reused for the final result so the
				// reservation matches what is returned (and textResult's trimming keeps
				// top-level non-array keys like syncWarning).
				const envelope: Record<string, unknown> = {
					mode: "discovery",
					query: resultQuery,
					results: [],
					backlogRemaining,
					...(syncWarning ? { syncWarning } : {}),
				};
				let used = JSON.stringify(envelope).length + Math.max(0, hits.length - 1);
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
							const win = getWindow(hit.path, hit.entryId, 0, { userAssistantTextOnly: true });
							// Mark when the fixed compact cap already removed content, so a
							// hit that still fits the budget isn't mistaken for complete.
							const overCompactCap = win.messages.some((m) => m.content.length > 2000);
							return fitOrTruncate({ ...meta, detail: "compact", ...(overCompactCap ? { contentTruncated: true } : {}), ...(win.toolResultsOmitted ? { toolResultsOmitted: true } : {}), messages: truncateContent(win.messages, 2000), bookends: { start: [], end: [] }, messagesBefore: win.messagesBefore, messagesAfter: win.messagesAfter }, win.messages);
						} catch (error) {
							return hydrationFallback(error);
						}
					}
					try {
						// One bounded snapshot feeds both window and branch bookends.
						const win = getWindow(hit.path, hit.entryId, 5, full ? undefined : { userAssistantTextOnly: true });
						// Same branch as the anchor — following the file's final leaf
						// would attach unrelated sibling messages.
						const bookends = { start: win.branchMessages.slice(0, 3), end: win.branchMessages.slice(-3) };
						return fitOrTruncate(
							{
								...meta,
								detail: "full" as const,
								...(win.toolResultsOmitted ? { toolResultsOmitted: true } : {}),
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

				const result: Record<string, unknown> = { ...envelope, results };
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
