import { isDeepStrictEqual } from "node:util";
import {
	compact,
	estimateTokens,
	findCutPoint,
	getAgentDir,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createConfigStore } from "@henryqw/pi-config-store";
import type {
	AgentBeforeSettleEvent,
	CompactionEntry,
	ContextEditEntryDraft,
	ExtensionAPI,
	ExtensionContext,
	ProjectedSessionEntry,
	SessionEntry,
	TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import {
	executeTaskRoutes,
	registerModelTask,
	resolveConfiguredTaskRoutes,
	type ModelTask,
	type ResolvedTaskRoute,
	type TaskRouteError,
} from "@henryqw/pi-task-models";

type AgentMessage = Parameters<typeof estimateTokens>[0];

/** Native boundaries maintain completed turns; the pre-request guard handles fresh oversized input. */
const DEFAULT_COMPACT_THRESHOLD_PERCENT = 70;
const MIN_COMPACT_THRESHOLD_PERCENT = 25;
export const AUTO_COMPACT_TASK = {
	id: "pi-auto-compact/autoCompact",
	label: "Auto compaction",
	purpose: "Compact session context before it is exhausted.",
	defaultProfile: "fast",
} as const satisfies ModelTask;
type AutoCompactConfig = { autoCompactThreshold: number };

function isValidThreshold(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= MIN_COMPACT_THRESHOLD_PERCENT && value < 100;
}

function parseAutoCompactConfig(value: unknown): AutoCompactConfig {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Config must be an object.");
	}
	const threshold = (value as Record<string, unknown>).autoCompactThreshold ?? DEFAULT_COMPACT_THRESHOLD_PERCENT;
	if (!isValidThreshold(threshold)) {
		throw new Error(`autoCompactThreshold must be at least ${MIN_COMPACT_THRESHOLD_PERCENT} and below 100.`);
	}
	return { autoCompactThreshold: threshold };
}

function configuredTaskRoutes(ctx: ExtensionContext): ResolvedTaskRoute[] {
	try {
		return resolveConfiguredTaskRoutes(ctx, AUTO_COMPACT_TASK);
	} catch (error) {
		const { taskRouteCode, profileName } = error as TaskRouteError;
		if (taskRouteCode === "config-missing") return [];
		const cause = taskRouteCode === "profile-missing"
			? `Task model profile ${profileName} is not configured`
			: taskRouteCode === "no-route"
				? `No usable ${profileName} task model route`
				: "Couldn't read task model config";
		ctx.ui.notify(`${cause}; using current session model.`, "error");
		return [];
	}
}

function withoutDeletedHeaders(headers: Record<string, string | null> | undefined): Record<string, string> | undefined {
	return headers
		? Object.fromEntries(Object.entries(headers).filter((entry): entry is [string, string] => entry[1] !== null))
		: undefined;
}

// Emergency context guard keeps recent messages while default compaction runs.
const KEEP_RECENT_PERCENT = 15;
const COMPACTION_INSTRUCTIONS = "Preserve the current task and any unfinished work.";
const RESUME_MESSAGE_TYPE = "pi-auto-compact/resume";
const RESUME_MESSAGE = "Auto-compact ran. Continue the current task.";
const COMPACTION_ABORT_ERROR = "This operation was aborted";
const ACTIVATION_ERROR =
	"pi-auto-compact failed to activate: Pi built-in auto-compaction is enabled. " +
	"Set compaction.enabled to false in Pi settings, then restart Pi.";

/** Estimate current request size, including Pi system transcript state. */
function estimateMessageTokens(message: AgentMessage): number {
	if (message.role === "system") return Math.ceil(JSON.stringify(message).length / 4);
	return estimateTokens(message);
}

function estimateTotalTokens(messages: AgentMessage[]): number {
	return messages.reduce((total, message) => total + estimateMessageTokens(message), 0);
}

/**
 * Return temporary context containing complete newest turns plus notice.
 * System messages are transcript state, so preserve them in their original order
 * even when the surrounding conversation is removed.
 */
function keepRecent(messages: AgentMessage[], keepTokens: number): AgentMessage[] | null {
	const systemTokens = estimateTotalTokens(messages.filter((message) => message.role === "system"));
	const suffixTokens = new Array<number>(messages.length + 1).fill(0);
	for (let i = messages.length - 1; i >= 0; i--) {
		suffixTokens[i] = suffixTokens[i + 1] + (messages[i].role === "system" ? 0 : estimateMessageTokens(messages[i]));
	}

	const userBoundaries = messages.flatMap((message, index) => message.role === "user" ? [index] : []);
	if (userBoundaries.length === 0) return null;

	let cutIndex = userBoundaries.at(-1) as number;
	for (const boundary of userBoundaries) {
		const removed = messages.slice(0, boundary).filter((message) => message.role !== "system");
		if (removed.length === 0) continue;
		const notice: AgentMessage = {
			role: "user",
			content: `[Temporary context reduction: ${removed.length} earlier messages (~${Math.round(estimateTotalTokens(removed) / 1000)}K tokens) are omitted from this request while compaction runs. Continue with the current task.]`,
			timestamp: Date.now(),
		};
		if (systemTokens + suffixTokens[boundary] + estimateMessageTokens(notice) <= keepTokens) {
			cutIndex = boundary;
			break;
		}
	}

	const removed = messages.slice(0, cutIndex).filter((message) => message.role !== "system");
	if (removed.length === 0) return null;
	const notice: AgentMessage = {
		role: "user",
		content: `[Temporary context reduction: ${removed.length} earlier messages (~${Math.round(estimateTotalTokens(removed) / 1000)}K tokens) are omitted from this request while compaction runs. Continue with the current task.]`,
		timestamp: Date.now(),
	};
	const retained: AgentMessage[] = [];
	for (let i = 0; i < messages.length; i++) {
		if (i === cutIndex) retained.push(notice);
		if (messages[i].role === "system" || i >= cutIndex) retained.push(messages[i]);
	}
	return estimateTotalTokens(retained) <= keepTokens ? retained : null;
}

type BoundaryEvent = TurnEndEvent | AgentBeforeSettleEvent;

/** findCutPoint operates on entries; materialize the effective content without changing the live session. */
function effectiveEntries(projected: ProjectedSessionEntry[]): SessionEntry[] {
	return projected.map(({ sourceEntry, messages }) => {
		if (sourceEntry.type === "message" && messages.length === 1) {
			return { ...sourceEntry, message: messages[0]! };
		}
		if (sourceEntry.type === "custom_message" && messages.length === 1 && messages[0]!.role === "user") {
			return { ...sourceEntry, content: messages[0]!.content };
		}
		// An omitted message must not count towards the cut-point budget.
		if ((sourceEntry.type === "message" || sourceEntry.type === "custom_message") && !messages.length) {
			return { ...sourceEntry, type: "custom", customType: "omitted-context" };
		}
		return sourceEntry;
	});
}

function fileOperations(messages: AgentMessage[], previous?: CompactionEntry) {
	const read = new Set<string>();
	const written = new Set<string>();
	const edited = new Set<string>();
	const details = previous?.details as { readFiles?: unknown; modifiedFiles?: unknown } | undefined;
	if (Array.isArray(details?.readFiles)) {
		for (const path of details.readFiles) if (typeof path === "string") read.add(path);
	}
	if (Array.isArray(details?.modifiedFiles)) {
		for (const path of details.modifiedFiles) if (typeof path === "string") edited.add(path);
	}
	for (const message of messages) {
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const part of message.content) {
			if (part.type !== "toolCall") continue;
			const path = part.arguments?.path;
			if (typeof path !== "string" || !path) continue;
			if (part.name === "read") read.add(path);
			else if (part.name === "write") written.add(path);
			else if (part.name === "edit") edited.add(path);
		}
	}
	return { read, written, edited };
}

/** An unchanged, successful read result with a matching persisted assistant call. */
function readResult(entry: ProjectedSessionEntry, projected: ProjectedSessionEntry[], editedIds: Set<string>) {
	const raw = entry.sourceEntry;
	const message = entry.messages[0];
	if (raw.type !== "message" || raw.message.role !== "toolResult" || message?.role !== "toolResult" ||
		message.toolName !== "read" || message.isError || raw.message.isError || editedIds.has(raw.id) ||
		!isDeepStrictEqual(message.content, raw.message.content) || !message.content.length ||
		message.content.some((block) => block.type !== "text")) return null;
	for (const candidate of projected.slice(0, projected.indexOf(entry))) {
		const assistant = candidate.messages[0];
		if (candidate.sourceEntry.type !== "message" || candidate.sourceEntry.message.role !== "assistant" ||
			editedIds.has(candidate.sourceEntry.id) || assistant?.role !== "assistant" ||
			!Array.isArray(assistant.content) || !isDeepStrictEqual(assistant.content, candidate.sourceEntry.message.content)) continue;
		const call = assistant.content.find((block) => block.type === "toolCall" && block.id === message.toolCallId);
		if (call?.type === "toolCall" && call.name === "read") return { message, args: call.arguments };
	}
	return null;
}

export default function (pi: ExtensionAPI) {
	registerModelTask(pi, AUTO_COMPACT_TASK);
	const configStore = createConfigStore<AutoCompactConfig>({
		extensionId: "pi-auto-compact",
		defaults: () => ({ autoCompactThreshold: DEFAULT_COMPACT_THRESHOLD_PERCENT }),
		parse: parseAutoCompactConfig,
	});
	let active = false;
	let autoCompactThreshold = DEFAULT_COMPACT_THRESHOLD_PERCENT;
	// Emergency compaction interrupts a run; boundary maintenance never does.
	let compactionPending = false;
	let compactionAbortExpected = false;
	let failedBoundary: { session: string; leaf: string | null } | undefined;

	const maintainBoundary = async (event: BoundaryEvent, ctx: ExtensionContext) => {
		if (!active || compactionPending || event.outcome !== "completed" || ctx.signal?.aborted || !ctx.model) return;
		if (event.type === "turn_end" && (event.message.role !== "assistant" ||
			!Array.isArray(event.message.content) || !event.message.content.some((part) => part.type === "toolCall") ||
			!event.toolResultEntryIds.length)) return;
		const session = ctx.sessionManager.getSessionId();
		const leaf = ctx.sessionManager.getLeafId();
		if (failedBoundary?.session === session && failedBoundary.leaf === leaf) return;
		if (event.entries.some((entry) => entry.type === "compaction")) return;
		const window = ctx.model.contextWindow;
		if (!window) return;
		const projected = event.context.contextEntries.map((entry) => ({ ...entry, messages: [...entry.messages] }));
		const pendingTokens = estimateTotalTokens(event.context.pendingMessages);
		let tokens = estimateTotalTokens(event.context.contextMessages) + pendingTokens;
		const threshold = window * autoCompactThreshold / 100;
		if (tokens <= threshold) return;

		const settings = SettingsManager.create(ctx.cwd, getAgentDir(), {
			projectTrusted: ctx.isProjectTrusted(),
		}).getCompactionSettings(ctx.model);
		const prior = projected.findIndex((entry) => entry.sourceEntry.type === "compaction" && entry.messages.length > 0);
		const start = prior < 0 ? 0 : prior + 1;
		const existingEdits = new Set(ctx.sessionManager.getBranch().filter((entry) => entry.type === "context_edit").map((entry) => entry.targetId));
		for (const entry of event.entries) if (entry.type === "context_edit") existingEdits.add(entry.targetId);
		const initialCut = findCutPoint(effectiveEntries(projected), start, projected.length, settings.keepRecentTokens);
		const current = event.type === "turn_end"
			? projected.findIndex((entry) => entry.sourceEntry.id === event.messageEntryId)
			: -1;
		const protectedStart = current < 0 ? initialCut.firstKeptEntryIndex : Math.min(current, initialCut.firstKeptEntryIndex);
		const edits: ContextEditEntryDraft[] = [];
		for (let index = start; index < protectedStart && tokens > threshold; index++) {
			const older = projected[index]!;
			const original = readResult(older, projected, existingEdits);
			if (!original) continue;
			const keeper = projected.slice(protectedStart).find((entry) => {
				const later = readResult(entry, projected, existingEdits);
				return later && later.message.toolName === original.message.toolName &&
				isDeepStrictEqual(later.args, original.args) && isDeepStrictEqual(later.message.content, original.message.content);
			});
			if (!keeper || !ctx.sessionManager.getEntry(older.sourceEntry.id) || !ctx.sessionManager.getEntry(keeper.sourceEntry.id)) continue;
			const notice = [{ type: "text" as const, text: `[Duplicate read; full result retained at entry ${keeper.sourceEntry.id}.]` }];
			const replacement = { ...original.message, content: notice };
			const saved = estimateTokens(original.message) - estimateTokens(replacement);
			if (saved <= 0) continue;
			edits.push({ type: "context_edit", targetId: older.sourceEntry.id, replacement: { content: notice } });
			older.messages = [replacement];
			existingEdits.add(older.sourceEntry.id);
			tokens -= saved;
		}
		if (tokens <= threshold) return { entries: [...event.entries, ...edits] };
		// A prior context-producing proposal may not yet have a committed entry ID.
		if (event.entries.some((entry) => entry.type !== "context_edit")) return edits.length ? { entries: [...event.entries, ...edits] } : undefined;
		const entries = effectiveEntries(projected);
		const cut = findCutPoint(entries, start, entries.length, settings.keepRecentTokens);
		const kept = projected[cut.firstKeptEntryIndex]?.sourceEntry;
		if (!kept || cut.firstKeptEntryIndex <= start || !ctx.sessionManager.getEntry(kept.id) ||
			(current >= 0 && cut.firstKeptEntryIndex > current)) {
			return edits.length ? { entries: [...event.entries, ...edits] } : undefined;
		}
		const historyEnd = cut.isSplitTurn ? cut.turnStartIndex : cut.firstKeptEntryIndex;
		const messages = (from: number, to: number) => projected.slice(from, to)
			.flatMap((entry) => entry.sourceEntry.type === "compaction" ? [] : entry.messages)
			.filter((message) => message.role !== "system");
		const history = messages(start, historyEnd);
		const prefix = cut.isSplitTurn ? messages(cut.turnStartIndex, cut.firstKeptEntryIndex) : [];
		if (!history.length && !prefix.length) return edits.length ? { entries: [...event.entries, ...edits] } : undefined;
		const previous = prior >= 0 && projected[prior]!.sourceEntry.type === "compaction"
			? projected[prior]!.sourceEntry as CompactionEntry : undefined;
		const preparation = {
			firstKeptEntryId: kept.id,
			messagesToSummarize: history,
			turnPrefixMessages: prefix,
			isSplitTurn: cut.isSplitTurn,
			tokensBefore: tokens,
			previousSummary: previous?.summary,
			fileOps: fileOperations([...history, ...prefix], previous),
			settings,
		};
		const signal = ctx.signal;
		try {
			const routes = configuredTaskRoutes(ctx);
			const summarize = async (model: NonNullable<ExtensionContext["model"]>, thinking: ExtensionContext["thinkingLevel"]) => {
				const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
				if (!auth.ok) throw new Error("Compaction model authentication failed.");
				return compact(preparation, auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model,
					auth.apiKey, withoutDeletedHeaders(auth.headers), COMPACTION_INSTRUCTIONS,
					signal, thinking, undefined, auth.env);
			};
			let result: Awaited<ReturnType<typeof compact>> | undefined;
			if (routes.length) {
				try {
					const routed = await executeTaskRoutes(routes, async (route) => ({
						compaction: await summarize(route.model, route.thinkingLevel),
					}), { signal, shouldFallback: () => true });
					result = routed.compaction;
				} catch {
					if (!signal?.aborted) ctx.ui.notify("Configured task model routes failed; using current session model.", "error");
				}
			}
			if (!result && !signal?.aborted) result = await summarize(ctx.model, ctx.thinkingLevel);
			if (signal?.aborted || ctx.sessionManager.getSessionId() !== session || ctx.sessionManager.getLeafId() !== leaf) return;
			if (!result?.summary.trim()) throw new Error("Compaction returned an empty summary.");
			return { entries: [...event.entries, ...edits, {
				type: "compaction" as const, summary: result.summary,
				firstKeptEntryId: result.firstKeptEntryId, details: result.details, usage: result.usage,
			}] };
		} catch {
			if (ctx.sessionManager.getSessionId() !== session || ctx.sessionManager.getLeafId() !== leaf) return;
			if (!signal?.aborted) {
				failedBoundary = { session, leaf };
				ctx.ui.notify("Auto-compaction failed. Check model routes and authentication; run /compact to retry manually.", "error");
			}
			return edits.length && !signal?.aborted ? { entries: [...event.entries, ...edits] } : undefined;
		}
	};

	const runCompaction = (ctx: ExtensionContext, resumeTask = true) => {
		compactionAbortExpected = Boolean(ctx.signal && !ctx.signal.aborted);
		ctx.compact({
			customInstructions: COMPACTION_INSTRUCTIONS,
			onComplete: () => {
				compactionPending = false;
				compactionAbortExpected = false;
				if (!resumeTask) return;
				// Pi may flush queued input during compaction_end. Wait one macrotask
				// before checking idle, otherwise follow-up can race that flush.
				setImmediate(() => {
					if (!ctx.isIdle()) return;
					pi.sendMessage({
						customType: RESUME_MESSAGE_TYPE,
						content: RESUME_MESSAGE,
						display: false,
					}, { triggerTurn: true });
				});
			},
			onError: () => {
				compactionPending = false;
				compactionAbortExpected = false;
			},
		});
	};

	const compactIfNeeded = (ctx: ExtensionContext, resumeTask = true) => {
		if (!active || compactionPending) return;

		const usage = ctx.getContextUsage();
		if (usage?.percent == null || usage.percent <= autoCompactThreshold) return;

		compactionPending = true;
		runCompaction(ctx, resumeTask);
	};

	// Hide only empty abort produced when ctx.compact() cancels active run.
	pi.on("message_end", (event, ctx) => {
		const message = event.message;
		if (
			!compactionPending ||
			!compactionAbortExpected ||
			!ctx.signal?.aborted ||
			message.role !== "assistant" ||
			message.stopReason !== "error" ||
			message.errorMessage !== COMPACTION_ABORT_ERROR ||
			message.content.some((part) => part.type !== "text" || part.text !== "")
		) return;

		compactionAbortExpected = false;
		return {
			message: { ...message, stopReason: "stop", errorMessage: undefined },
		};
	});

	// Boundary drafts are committed by Pi before the next natural request or final settlement.
	pi.on("turn_end", maintainBoundary);
	pi.on("agent_before_settle", maintainBoundary);

	// Runs before every provider request. Temporary truncation protects request
	// size while asynchronous default compaction summarizes persisted history.
	pi.on("context_with_system", (event, ctx) => {
		if (!active || compactionPending || (failedBoundary && ctx.sessionManager &&
			failedBoundary.session === ctx.sessionManager.getSessionId() &&
			failedBoundary.leaf === ctx.sessionManager.getLeafId())) return;

		const contextWindow = ctx.getContextUsage()?.contextWindow ?? ctx.model?.contextWindow ?? 0;
		const estimatedTokens = estimateTotalTokens(event.messages);
		if (contextWindow <= 0 || estimatedTokens <= contextWindow * autoCompactThreshold / 100) return;

		const truncated = keepRecent(
			event.messages,
			Math.floor(contextWindow * KEEP_RECENT_PERCENT / 100),
		);
		if (!truncated) {
			ctx.ui.notify("Auto-compaction cannot safely reduce this first request; shorten the new input or run /compact.", "error");
			return;
		}

		// Mark pending before deferring. Another context event can fire before
		// setImmediate runs, and must not schedule a second compaction.
		compactionPending = true;
		setImmediate(() => runCompaction(ctx));
		return { messages: truncated };
	});

	pi.registerCommand("auto-compact", {
		description: "configure automatic compaction threshold",
		handler: async (args, ctx) => {
			if (args.trim()) {
				ctx.ui.notify("Usage: /auto-compact", "error");
				return;
			}

			let currentThreshold: number;
			try {
				currentThreshold = configStore.loadSync().value.autoCompactThreshold;
			} catch {
				ctx.ui.notify("Couldn't read pi-auto-compact config.", "error");
				return;
			}

			const input = await ctx.ui.input(
				`Auto-compact threshold (%) · current: ${currentThreshold}`,
				"Enter a number at least 25 and below 100",
			);
			if (input === undefined) return;

			const threshold = Number(input.trim());
			if (!isValidThreshold(threshold)) {
				ctx.ui.notify("Threshold must be at least 25% and below 100%.", "error");
				return;
			}

			try {
				await configStore.save({ autoCompactThreshold: threshold });
			} catch {
				ctx.ui.notify("Couldn't save pi-auto-compact config.", "error");
				return;
			}
			autoCompactThreshold = threshold;
			ctx.ui.notify(`Auto-compact threshold set to ${threshold}%.`, "info");
		},
	});

	// Pi's built-in automatic compaction competes with this extension. Refuse
	// activation unless effective global/project settings disable it.
	pi.on("session_start", (event, ctx) => {
		try {
			const config = configStore.loadSync();
			autoCompactThreshold = config.value.autoCompactThreshold;
		} catch {
			autoCompactThreshold = DEFAULT_COMPACT_THRESHOLD_PERCENT;
			ctx.ui.notify(`Couldn't read pi-auto-compact config; using ${DEFAULT_COMPACT_THRESHOLD_PERCENT}%.`, "error");
		}

		active = !SettingsManager.create(ctx.cwd, getAgentDir(), {
			projectTrusted: ctx.isProjectTrusted(),
		}).getCompactionEnabled();
		if (!active) throw new Error(ACTIVATION_ERROR);

		// Resume/fork can load an already-large session before first turn.
		if (event.reason === "resume" || event.reason === "fork") compactIfNeeded(ctx);
	});

	pi.on("session_before_compact", async (event, ctx) => {
		if (
			!active ||
			!compactionPending ||
			event.customInstructions !== COMPACTION_INSTRUCTIONS
		) return;

		// Pi omits details from prior extension compactions when preparing next run.
		const previous = [...event.branchEntries].reverse().find((entry) => entry.type === "compaction");
		if (previous?.details && typeof previous.details === "object") {
			const details = previous.details as { readFiles?: unknown; modifiedFiles?: unknown };
			if (Array.isArray(details.readFiles)) {
				for (const path of details.readFiles) {
					if (typeof path === "string") event.preparation.fileOps.read.add(path);
				}
			}
			if (Array.isArray(details.modifiedFiles)) {
				for (const path of details.modifiedFiles) {
					if (typeof path === "string") event.preparation.fileOps.edited.add(path);
				}
			}
		}

		const routes = configuredTaskRoutes(ctx);
		if (!routes.length) return;

		try {
			return await executeTaskRoutes(
				routes,
				async (route) => {
					const auth = await ctx.modelRegistry.getApiKeyAndHeaders(route.model);
					if (!auth.ok) throw new Error("Configured task model authentication failed.");

					const requestModel = auth.baseUrl ? { ...route.model, baseUrl: auth.baseUrl } : route.model;
					return {
						compaction: await compact(
							event.preparation,
							requestModel,
							auth.apiKey,
							withoutDeletedHeaders(auth.headers),
							event.customInstructions,
							event.signal,
							route.thinkingLevel,
							undefined,
							auth.env,
						),
					};
				},
				{ signal: event.signal, shouldFallback: () => true },
			);
		} catch {
			if (event.signal.aborted) return;
		}

		if (!event.signal.aborted) {
			ctx.ui.notify("Configured task model routes failed; using current session model.", "error");
		}
	});
}
