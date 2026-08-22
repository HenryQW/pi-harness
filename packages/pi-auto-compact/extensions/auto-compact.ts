import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	compact,
	estimateTokens,
	getAgentDir,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_TASK_ASSIGNMENTS,
	orderedProfileRoutes,
	readTaskModelsConfig,
	resolveTaskModelRoute,
	type ResolvedTaskRoute,
} from "@henryqw/pi-task-models";

type AgentMessage = Parameters<typeof estimateTokens>[0];

/**
 * Proactive compaction runs at four points:
 * - turn_start: catch sessions already over threshold before next request.
 * - turn_end: catch growth caused by tool results before next LLM turn.
 * - agent_end: catch growth from the final provider turn.
 * - context: last-resort guard with a temporary keep-recent context.
 *
 * Pi's ctx.compact() aborts active low-level run internally. Mid-task
 * compaction sends a follow-up user message to resume work after summary.
 */
const DEFAULT_COMPACT_THRESHOLD_PERCENT = 50;
const MIN_COMPACT_THRESHOLD_PERCENT = 25;
const AUTO_COMPACT_TASK = "pi-auto-compact/autoCompact";
const DEFAULT_AUTO_COMPACT_PROFILE = DEFAULT_TASK_ASSIGNMENTS[AUTO_COMPACT_TASK];
const configPath = () => join(getAgentDir(), "config", "pi-auto-compact.json");

type Config = {
	autoCompactThreshold: number;
};

function isValidThreshold(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= MIN_COMPACT_THRESHOLD_PERCENT && value < 100;
}

function readConfig(): Config {
	let value: unknown;
	try {
		value = JSON.parse(readFileSync(configPath(), "utf8"));
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
			return { autoCompactThreshold: DEFAULT_COMPACT_THRESHOLD_PERCENT };
		}
		throw error;
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Config must be an object.");
	}
	const threshold = (value as Record<string, unknown>).autoCompactThreshold ?? DEFAULT_COMPACT_THRESHOLD_PERCENT;
	if (!isValidThreshold(threshold)) {
		throw new Error(`autoCompactThreshold must be at least ${MIN_COMPACT_THRESHOLD_PERCENT} and below 100.`);
	}
	return { autoCompactThreshold: threshold };
}

function writeConfig(config: Config): void {
	const file = configPath();
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
}

function configuredTaskRoutes(ctx: ExtensionContext): ResolvedTaskRoute[] {
	let config;
	try {
		config = readTaskModelsConfig();
	} catch {
		ctx.ui.notify("Couldn't read task model config; using current session model.", "error");
		return [];
	}

	const profileName = config.tasks[AUTO_COMPACT_TASK] ?? DEFAULT_AUTO_COMPACT_PROFILE;
	const profile = config.profiles[profileName];
	if (!profile) {
		ctx.ui.notify(`Task model profile ${profileName} is not configured; using current session model.`, "error");
		return [];
	}

	const routes = orderedProfileRoutes(profile)
		.map((route) => resolveTaskModelRoute(ctx, route))
		.filter((route): route is ResolvedTaskRoute => route !== undefined);
	if (!routes.length) {
		ctx.ui.notify(`No usable ${profileName} task model route; using current session model.`, "error");
	}
	return routes;
}

function withoutDeletedHeaders(headers: Record<string, string | null> | undefined): Record<string, string> | undefined {
	return headers
		? Object.fromEntries(Object.entries(headers).filter((entry): entry is [string, string] => entry[1] !== null))
		: undefined;
}

// Emergency context guard keeps recent messages while default compaction runs.
const KEEP_RECENT_PERCENT = 15;
const COMPACTION_INSTRUCTIONS = "Preserve current task to be resumed after compaction.";
const RESUME_MESSAGE = "Auto-compact ran. Continue the current task.";
const COMPACTION_ABORT_ERROR = "This operation was aborted";
const ACTIVATION_ERROR =
	"pi-auto-compact failed to activate: Pi built-in auto-compaction is enabled. " +
	"Set compaction.enabled to false in Pi settings, then restart Pi.";

/** Estimate current request size using same estimator Pi uses. */
function estimateTotalTokens(messages: AgentMessage[]): number {
	return messages.reduce((total, message) => total + estimateTokens(message), 0);
}

/**
 * Do not cut inside assistant/toolResult history. A user boundary is safe:
 * tool calls and their results belong to preceding turn.
 */
function snapToUserBoundary(messages: AgentMessage[], index: number): number {
	while (index < messages.length && messages[index].role !== "user") index++;
	return index;
}

/**
 * Return temporary context containing newest messages plus notice.
 * This changes only request context; session history remains intact.
 */
function keepRecent(messages: AgentMessage[], keepTokens: number): AgentMessage[] | null {
	let tokens = 0;
	let cutIndex = 0;

	for (let i = messages.length - 1; i >= 0; i--) {
		const messageTokens = estimateTokens(messages[i]);
		if (tokens + messageTokens > keepTokens) {
			cutIndex = snapToUserBoundary(messages, i + 1);
			break;
		}
		tokens += messageTokens;
	}

	if (cutIndex <= 0) return null;

	const removed = messages.slice(0, cutIndex);
	return [
		{
			role: "user",
			content: `[Context compacted: ${removed.length} earlier messages (~${Math.round(estimateTotalTokens(removed) / 1000)}K tokens) were summarized. Continue with the current task.]`,
			timestamp: Date.now(),
		},
		...messages.slice(cutIndex),
	];
}

/** Final assistant turns need no automatic follow-up; tool turns do. */
function hasToolCall(message: AgentMessage): boolean {
	return (
		message.role === "assistant" &&
		Array.isArray(message.content) &&
		message.content.some((part) => part.type === "toolCall")
	);
}

export default function (pi: ExtensionAPI) {
	let active = false;
	let autoCompactThreshold = DEFAULT_COMPACT_THRESHOLD_PERCENT;
	// Prevent lifecycle hooks from starting duplicate summaries.
	let compactionPending = false;
	let compactionAbortExpected = false;

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
					if (ctx.isIdle()) pi.sendUserMessage(RESUME_MESSAGE);
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

	// Do not use agent_settled here: long tool loops may cross threshold before
	// the full run settles. These hooks inspect every provider-turn boundary.
	// Pre-turn catches resumed/queued work before provider request starts.
	pi.on("turn_start", (_event, ctx) => compactIfNeeded(ctx));

	// Only tool-call turns need mid-run compaction.
	pi.on("turn_end", (event, ctx) => {
		if (hasToolCall(event.message)) compactIfNeeded(ctx);
	});

	// Catch threshold crossings caused by the final provider turn.
	pi.on("agent_end", (_event, ctx) => compactIfNeeded(ctx, false));

	// Runs before every provider request. Temporary truncation protects request
	// size while asynchronous default compaction summarizes persisted history.
	pi.on("context", (event, ctx) => {
		if (!active || compactionPending) return;

		const contextWindow = ctx.getContextUsage()?.contextWindow ?? ctx.model?.contextWindow ?? 0;
		const estimatedTokens = estimateTotalTokens(event.messages);
		if (contextWindow <= 0 || estimatedTokens <= contextWindow * autoCompactThreshold / 100) return;

		const truncated = keepRecent(
			event.messages,
			Math.floor(contextWindow * KEEP_RECENT_PERCENT / 100),
		);
		if (!truncated) return;

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

			let config: Config;
			try {
				config = readConfig();
			} catch {
				ctx.ui.notify("Couldn't read pi-auto-compact config.", "error");
				return;
			}

			const input = await ctx.ui.input(
				`Auto-compact threshold (%) · current: ${config.autoCompactThreshold}`,
				"Enter a number at least 25 and below 100",
			);
			if (input === undefined) return;

			const threshold = Number(input.trim());
			if (Number.isFinite(threshold) && threshold < MIN_COMPACT_THRESHOLD_PERCENT) {
				ctx.ui.notify("Auto-compact threshold below 25% is not meaningful.", "error");
				return;
			}
			if (!isValidThreshold(threshold)) {
				ctx.ui.notify("Threshold must be at least 25% and below 100%.", "error");
				return;
			}

			try {
				writeConfig({ autoCompactThreshold: threshold });
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
			autoCompactThreshold = readConfig().autoCompactThreshold;
		} catch {
			autoCompactThreshold = DEFAULT_COMPACT_THRESHOLD_PERCENT;
			ctx.ui.notify("Couldn't read pi-auto-compact config; using 50%.", "error");
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

		for (const route of routes) {
			try {
				const auth = await ctx.modelRegistry.getApiKeyAndHeaders(route.model);
				if (!auth.ok) continue;

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
			} catch {
				if (event.signal.aborted) return;
			}
		}

		if (!event.signal.aborted) {
			ctx.ui.notify("Configured task model routes failed; using current session model.", "error");
		}
	});
}
