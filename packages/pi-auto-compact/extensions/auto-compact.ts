import { estimateTokens } from "@earendil-works/pi-coding-agent";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

type AgentMessage = Parameters<typeof estimateTokens>[0];

/**
 * Proactive compaction runs at three points:
 * - turn_start: catch sessions already over threshold before next request.
 * - turn_end: catch growth caused by tool results before next LLM turn.
 * - context: last-resort guard with a temporary keep-recent context.
 *
 * Pi's ctx.compact() aborts active low-level run internally. Its completion
 * callback sends follow-up user message, which resumes task after summary.
 */
const COMPACT_THRESHOLD_PERCENT = 50;

// Emergency context guard keeps recent messages while default compaction runs.
const KEEP_RECENT_PERCENT = 15;
const RESUME_MESSAGE = "Auto-compact ran. Continue the current task.";

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
	// Prevent turn_start, turn_end, and context from starting duplicate summaries.
	let compactionPending = false;

	const runCompaction = (ctx: ExtensionContext) => {
		ctx.compact({
			onComplete: () => {
				compactionPending = false;
				// Pi may flush queued input during compaction_end. Wait one macrotask
				// before checking idle, otherwise follow-up can race that flush.
				setImmediate(() => {
					if (ctx.isIdle()) pi.sendUserMessage(RESUME_MESSAGE);
				});
			},
			onError: () => {
				compactionPending = false;
			},
		});
	};

	const compactIfNeeded = (ctx: ExtensionContext) => {
		if (compactionPending) return;

		const usage = ctx.getContextUsage();
		if (usage?.percent == null || usage.percent <= COMPACT_THRESHOLD_PERCENT) return;

		compactionPending = true;
		runCompaction(ctx);
	};

	// Do not use agent_settled here: long tool loops may cross threshold before
	// the full run settles. These hooks inspect every provider-turn boundary.
	// Pre-turn catches resumed/queued work before provider request starts.
	pi.on("turn_start", (_event, ctx) => compactIfNeeded(ctx));

	// Only tool-call turns need mid-run compaction. Final answers should not
	// receive an unsolicited continuation message.
	pi.on("turn_end", (event, ctx) => {
		if (hasToolCall(event.message)) compactIfNeeded(ctx);
	});

	// Runs before every provider request. Temporary truncation protects request
	// size while asynchronous default compaction summarizes persisted history.
	pi.on("context", (event, ctx) => {
		if (compactionPending) return;

		const contextWindow = ctx.getContextUsage()?.contextWindow ?? ctx.model?.contextWindow ?? 0;
		const estimatedTokens = estimateTotalTokens(event.messages);
		if (contextWindow <= 0 || estimatedTokens <= contextWindow * COMPACT_THRESHOLD_PERCENT / 100) return;

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

	// Resume/fork can load an already-large session before first turn.
	pi.on("session_start", (event, ctx) => {
		if (event.reason === "resume" || event.reason === "fork") {
			compactIfNeeded(ctx);
		}
	});
}
