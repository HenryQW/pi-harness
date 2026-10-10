/**
 * pi-session-recall entry point: tool registration and mode dispatch.
 */
import { getAgentDir, keyHint, truncateToVisualLines } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { extensionConfigDir } from "@henryqw/pi-config-store";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type, type TSchema } from "typebox";
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

/** Bound a read or scroll result to the output budget: the largest uniform
 *  per-message content cap, or empty messages when even that does not fit.
 *  contentTruncated is character-level truncation, distinct from `truncated`. */
function boundMessages(base: Record<string, unknown>, messages: WindowMessage[]): Record<string, unknown> {
	const result = { ...base, messages };
	if (JSON.stringify(result).length <= OUTPUT_CHAR_BUDGET || messages.length === 0) return result;
	const build = (cap: number) => ({ ...base, messages: truncateContent(messages, cap), contentTruncated: true });
	const cap = maxFittingCap(Math.max(...messages.map((m) => m.content.length), 0), OUTPUT_CHAR_BUDGET, build);
	return cap === null ? { ...base, messages: [], contentTruncated: true } : build(cap);
}

const INVENTORY_COLLECTIONS = ["packageScripts", "executableScripts", "skills", "agentInstructions"] as const;
type InventoryCollection = (typeof INVENTORY_COLLECTIONS)[number];
type InventoryCollections = Record<InventoryCollection, unknown[]>;

const collectionRecord = <T>(value: (key: InventoryCollection) => T) =>
	Object.fromEntries(INVENTORY_COLLECTIONS.map((key) => [key, value(key)])) as Record<InventoryCollection, T>;

function inventoryShape(source: RepositoryInventory, kept: InventoryCollections): Record<string, unknown> {
	const omittedCounts = collectionRecord((key) => source[key].length - kept[key].length);
	return {
		available: source.available,
		...(source.reason ? { reason: source.reason } : {}),
		...(source.provenance ? { provenance: source.provenance } : {}),
		worktreeVerified: source.worktreeVerified,
		...collectionRecord((key) => kept[key]),
		truncated: Object.values(omittedCounts).some((count) => count > 0),
		omittedCounts,
	};
}

/** Keep stable prefixes from every inventory collection within one bounded,
 * round-robin allocation so a large first collection cannot starve the rest. */
function boundInventory(source: RepositoryInventory, maxChars: number): Record<string, unknown> {
	const full = inventoryShape(source, source);
	if (JSON.stringify(full).length <= maxChars) return full;

	const kept = collectionRecord((): unknown[] => []);
	const blocked = new Set<InventoryCollection>();
	for (;;) {
		let advanced = false;
		for (const key of INVENTORY_COLLECTIONS) {
			if (blocked.has(key) || kept[key].length >= source[key].length) continue;
			const candidate = { ...kept, [key]: [...kept[key], source[key][kept[key].length]] };
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
	const minimumInventory = inventoryShape(repositoryInventory, collectionRecord(() => []));
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
}

// Output schema: one variant per mode, discriminated by `mode`. Codemode scripts
// receive this structured value; the model receives the identical JSON text.
const Nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);
const WindowMessageSchema = Type.Object({
	entryId: Type.String(),
	role: Type.String(),
	content: Type.String(),
	timestamp: Type.String(),
	anchor: Type.Optional(Type.Boolean()),
});
const SyncWarningSchema = Type.Union([
	Type.Object({ kind: Type.Literal("incomplete-walk") }),
	Type.Object({ kind: Type.Literal("sync-failed"), error: Type.String() }),
]);
/** Character-level trimming to the 50,000-character result budget. */
const contentTruncated = Type.Optional(Type.Boolean());
const OUTPUT_SCHEMA = Type.Union([
	Type.Object({
		mode: Type.Literal("browse"),
		sessions: Type.Array(Type.Object({
			path: Type.String(),
			cwd: Type.String(),
			name: Type.Optional(Type.String()),
			startedAt: Type.Optional(Type.String()),
			preview: Type.Optional(Type.String()),
		})),
		syncWarning: Type.Optional(SyncWarningSchema),
		contentTruncated,
	}),
	Type.Object({
		mode: Type.Literal("discovery"),
		query: Type.String(),
		results: Type.Array(Type.Object({
			path: Type.String(),
			snippet: Type.String(),
			rank: Type.Number(),
			matchMessageId: Type.String(),
			role: Type.String(),
			timestamp: Type.String(),
			cwd: Type.Optional(Type.String()),
			name: Type.Optional(Type.String()),
			startedAt: Type.Optional(Type.String()),
		})),
		backlogRemaining: Type.Number(),
		syncWarning: Type.Optional(SyncWarningSchema),
		contentTruncated,
	}),
	Type.Object({
		mode: Type.Literal("read"),
		sessionId: Type.String(),
		messages: Type.Array(WindowMessageSchema),
		totalMessages: Type.Number(),
		truncated: Type.Boolean(),
		branchTip: Nullable(Type.String()),
		contentTruncated,
	}),
	Type.Object({
		mode: Type.Literal("scroll"),
		sessionId: Type.String(),
		branchTip: Type.String(),
		messagesBefore: Type.Number(),
		messagesAfter: Type.Number(),
		messages: Type.Array(WindowMessageSchema),
		contentTruncated,
	}),
	Type.Object({
		mode: Type.Literal("prepare-pattern-miner"),
		scope: Type.Object({
			kind: StringEnum(["repository", "all"] as const),
			gitRoot: Nullable(Type.String()),
			requestedLimit: Type.Number(),
			sampledCount: Type.Number(),
		}),
		sync: Type.Object({ walkComplete: Type.Boolean(), backlogRemaining: Type.Number(), complete: Type.Boolean() }),
		sessions: Type.Array(Type.Object({
			path: Type.String(),
			cwd: Type.String(),
			name: Nullable(Type.String()),
			startedAt: Nullable(Type.String()),
			lineageId: Type.String(),
			branchTip: Nullable(Type.String()),
			totalMessages: Nullable(Type.Number()),
			truncated: Type.Boolean(),
			contentTruncated: Type.Boolean(),
			messages: Type.Array(WindowMessageSchema),
			error: Type.Optional(Type.Object({
				kind: StringEnum(["missing", "oversized", "unreadable"] as const),
				message: Type.String(),
			})),
		})),
		inventory: Type.Object({
			available: Type.Boolean(),
			reason: Type.Optional(StringEnum(["not-a-git-repository", "inventory-failed"] as const)),
			provenance: Type.Optional(Type.Object({
				packageScripts: Type.Literal("git-index"),
				executableScripts: Type.Literal("git-index"),
				agentInstructions: Type.Literal("git-index"),
				skills: Type.Literal("pi-effective-registry"),
			})),
			worktreeVerified: Type.Literal(false),
			packageScripts: Type.Array(Type.Object({ path: Type.String(), name: Type.String(), command: Type.String() })),
			executableScripts: Type.Array(Type.String()),
			skills: Type.Array(Type.Object({ name: Type.String(), description: Type.String(), sourcePath: Type.String() })),
			agentInstructions: Type.Array(Type.String()),
			truncated: Type.Boolean(),
			omittedCounts: Type.Object({
				packageScripts: Type.Number(),
				executableScripts: Type.Number(),
				skills: Type.Number(),
				agentInstructions: Type.Number(),
			}),
		}),
		contentTruncated: Type.Boolean(),
	}),
]);

const DESCRIPTION = `Search past Pi sessions locally with FTS5; returns indexed metadata and snippets.

- \`operation: "prepare-pattern-miner"\` + \`scope\`: prepare one bounded corpus and repository inventory.
- \`query\`: discover matches. Prefer distinctive identifiers or uncommon terms; multi-word queries are AND. Use \`OR\`/\`NOT\` for Boolean queries and quotes only when exact wording is known.
- \`sessionId\` + \`aroundMessageId\`: scroll ±\`window\`; retain \`branchTip\` across forks.
- \`sessionId\` alone: read; no args: browse recent sessions.
- Discovery returns metadata and snippets. Use a result's \`path\` and \`matchMessageId\` for a follow-up scroll.
- Invalid arguments, refused or missing session files, and failed preparation are tool errors.`;

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
		}, { additionalProperties: false }),
		outputSchema: OUTPUT_SCHEMA,
		annotations: { readOnlyHint: true, openWorldHint: false },
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
		// Failures throw: Pi marks the result as an error for the model, and
		// codemode scripts reject instead of receiving a success-shaped value.
		async execute(_toolCallId, params: ToolParams, signal, _onUpdate, ctx) {
			if (params.scope !== undefined && params.operation === undefined) {
				throw new Error("scope requires operation: prepare-pattern-miner.");
			}
			if (params.operation === "prepare-pattern-miner") {
				const incompatible = (["query", "sessionId", "aroundMessageId", "branchTip", "window"] as const)
					.filter((key) => params[key] !== undefined);
				if (incompatible.length > 0) {
					throw new Error(`prepare-pattern-miner does not accept: ${incompatible.join(", ")}.`);
				}
				if (params.scope !== "repository" && params.scope !== "all") {
					throw new Error("prepare-pattern-miner requires scope: repository or all.");
				}
				const limit = clamp(params.limit, 1, 10, 10);
				const inventory = await inventoryRepository(
					pi,
					{ cwd: ctx.cwd, signal },
					params.scope === "repository" ? "required" : "optional",
				);
				const sync = syncSessions(sessionsDir(), dbPath());
				const currentSessionPath = ctx.sessionManager.getSessionFile() ?? undefined;
				const rows = getPreparationRows(dbPath(), {
					limit,
					...(params.scope === "repository" ? { repositoryRoot: inventory.gitRoot! } : {}),
					currentSessionPath,
				});
				return textResult(buildPreparationResult(params.scope, limit, inventory.gitRoot, sync, rows, inventory));
			}

			let sessionId = params.sessionId?.trim() || undefined;
			const anchor = params.aroundMessageId?.trim() || undefined;
			if (sessionId) {
				// Trust boundary: canonical target must live under the real
				// sessions dir (realpath defeats symlink escapes).
				let resolved: string;
				let root: string;
				try {
					resolved = realpathSync(sessionId);
					root = realpathSync(sessionsDir());
				} catch {
					throw new Error(`session file not found: ${sessionId}`.slice(0, OUTPUT_CHAR_BUDGET));
				}
				if (!resolved.startsWith(root + sep) || !resolved.endsWith(".jsonl")) {
					throw new Error("sessionId must be a .jsonl file under the Pi sessions directory");
				}
				// Rebind to the validated canonical path so downstream reads cannot
				// be redirected by a symlink swapped in after validation (TOCTOU).
				sessionId = resolved;
			}

			// --- SCROLL ---
			if (sessionId && anchor) {
				const w = clamp(params.window, 1, 20, 5);
				const branchTip = params.branchTip?.trim() || undefined;
				let win: ReturnType<typeof getWindow>;
				try {
					win = getWindow(sessionId, anchor, w, branchTip ? { branchTip } : undefined);
				} catch (error) {
					if (error instanceof Error && error.message.length > OUTPUT_CHAR_BUDGET) {
						throw new Error(error.message.slice(0, OUTPUT_CHAR_BUDGET), { cause: error });
					}
					throw error;
				}
				const base = { mode: "scroll", sessionId, branchTip: win.branchTip, messagesBefore: win.messagesBefore, messagesAfter: win.messagesAfter };
				return textResult(boundMessages(base, win.messages));
			}

			// --- READ ---
			if (sessionId) {
				const { messages, ...metadata } = readSession(sessionId);
				return textResult(boundMessages({ mode: "read", sessionId, ...metadata }, messages));
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
			const { hits, backlogRemaining } = searchIndex(dbPath(), params.query, {
				limit,
				// Exclude the whole current file.
				currentSessionPath: ctx.sessionManager.getSessionFile() ?? undefined,
			});

			const resultQuery = params.query!.trim().slice(0, MAX_QUERY_CHARS);
			const results = hits.map((hit) => ({
				path: hit.path,
				snippet: hit.snippet,
				rank: hit.rank,
				matchMessageId: hit.entryId,
				role: hit.role,
				timestamp: hit.timestamp,
				cwd: hit.cwd,
				name: hit.name,
				startedAt: hit.startedAt,
			}));
			return textResult({
				mode: "discovery",
				query: resultQuery,
				results,
				backlogRemaining,
				...(syncWarning ? { syncWarning } : {}),
			});
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
			if (!array) throw new Error("session_search result metadata exceeds output budget");
			array.pop();
			text = JSON.stringify(bounded);
		}
	}
	// structuredContent is the parsed text, so scripts and the model see one value.
	return {
		content: [{ type: "text" as const, text }],
		details: bounded,
		structuredContent: JSON.parse(text),
	};
}
