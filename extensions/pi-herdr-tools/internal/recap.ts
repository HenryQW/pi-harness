import { buildSessionContext, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { executeTaskRoutes, registerModelTask, registerTaskModelsConfigReporting, type ModelTask } from "@henryqw/pi-task-models";
import { buildMergeTranscript, tailBytes } from "./merge.ts";
import { configuredTaskRoutes } from "./task-models.ts";

const WIDGET_KEY = "pi-herdr-recap";
/** Long enough that a short look away costs no model call; short enough that the recap is ready after a typical visit to other panes. */
export const RECAP_IDLE_MS = 240_000;
const RECAP_MAX_WORDS = 40;
/** One budget for the whole prompt keeps it within small task-model context windows. */
export const RECAP_PROMPT_BUDGET_BYTES = 48 * 1024;
/** The title and newest summary use at most this share, so the newest turns always fit. */
const RECAP_SUMMARY_BUDGET_BYTES = 16 * 1024;
const RECAP_PROMPT = `The user stepped away from this coding conversation and is returning. Write a recap of at most ${RECAP_MAX_WORDS} words in one or two plain sentences without markdown: the overall goal, the current state, then one next action. Reply with the recap only.`;
export const RECAP_TASK = {
	id: "pi-herdr-tools/recap",
	label: "Idle recap",
	purpose: "Summarize where an idle conversation stopped.",
	defaultProfile: "fast",
} as const satisfies ModelTask;

class RecapModelError extends Error {}

/** Put the accent icon at column 0 and indent continuation lines under the dim recap text. */
export function renderRecapWidget(text: string, theme: Theme, width: number): string[] {
	return wrapTextWithAnsi(`Recap: ${text}`, Math.max(1, width - 2)).map((line, index) =>
		truncateToWidth(`${index ? "  " : `${theme.fg("accent", "↺")} `}${theme.fg("dim", line)}`, Math.max(1, width), ""),
	);
}

/** Keep at most maxBytes of UTF-8 from the head of the text. */
function headBytes(text: string, maxBytes: number): string {
	const bytes = Buffer.from(text);
	// A cut inside a multibyte character decodes to a trailing U+FFFD; drop it to stay within the budget.
	return bytes.length <= maxBytes ? text : bytes.subarray(0, maxBytes).toString("utf8").replace(/\uFFFD+$/, "");
}

async function generateRecap(prompt: string, ctx: ExtensionContext, signal: AbortSignal, reportTaskModels: (ctx: ExtensionContext) => void): Promise<string> {
	return executeTaskRoutes(
		configuredTaskRoutes(ctx, RECAP_TASK, "Recap", reportTaskModels),
		async (route) => {
			let response;
			try {
				response = await ctx.modelRegistry.streamSimple(route.model, {
					systemPrompt: RECAP_PROMPT,
					messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
				}, {
					signal,
					maxRetries: 0,
					...(route.thinkingLevel === "off" ? {} : { reasoning: route.thinkingLevel }),
				}).result();
			} catch (error) {
				if (signal.aborted) throw error;
				throw new RecapModelError(error instanceof Error ? error.message : "Recap task model failed.");
			}
			if (response.stopReason !== "stop") throw new RecapModelError(response.errorMessage || "Recap task model did not return a complete recap.");
			const words = response.content
				.flatMap((part) => (part.type === "text" ? part.text.split(/\s+/) : []))
				.filter(Boolean);
			if (!words.length) throw new RecapModelError("Recap task model returned no text.");
			return words.slice(0, RECAP_MAX_WORDS).join(" ");
		},
		{ signal, shouldFallback: (error) => error instanceof RecapModelError },
	);
}

/** After a settled run stays idle, show a short recap above the editor. The recap never enters model context. */
export default function idleRecapExtension(pi: ExtensionAPI): void {
	registerModelTask(pi, RECAP_TASK);
	const reportTaskModels = registerTaskModelsConfigReporting(pi);
	let timer: ReturnType<typeof setTimeout> | undefined;
	let active: AbortController | undefined;
	let stopTerminalInput: (() => void) | undefined;
	let recappedLeaf: string | null | undefined;
	const warned = new Set<string>();

	const cancelPending = () => {
		clearTimeout(timer);
		timer = undefined;
		active?.abort();
		active = undefined;
		stopTerminalInput?.();
		stopTerminalInput = undefined;
	};
	const cancel = (ctx: ExtensionContext) => {
		cancelPending();
		ctx.ui.setWidget(WIDGET_KEY, undefined);
	};
	const idle = (ctx: ExtensionContext) => ctx.isIdle() && !ctx.ui.getEditorText().trim();

	const recap = async (ctx: ExtensionContext) => {
		timer = undefined;
		const leaf = ctx.sessionManager.getLeafId();
		if (leaf === recappedLeaf || !idle(ctx)) return;
		const messages = buildSessionContext(ctx.sessionManager.getEntries(), leaf).messages;
		// buildMergeTranscript keeps only user and assistant turns; summaries carry the goal after compaction or branch navigation.
		const summary = messages.flatMap((message) =>
			message.role === "compactionSummary" || message.role === "branchSummary" ? [message.summary] : [],
		).at(-1);
		const transcript = buildMergeTranscript(messages);
		if (!transcript && !summary) return;
		const title = pi.getSessionName();
		const head = headBytes(
			[title && `Conversation title: ${title}`, summary && `Earlier summary: ${summary}`].filter(Boolean).join("\n\n"),
			RECAP_SUMMARY_BUDGET_BYTES,
		);
		const tail = transcript && tailBytes(transcript, RECAP_PROMPT_BUDGET_BYTES - Buffer.byteLength(head, "utf8") - 2);
		const prompt = [head, tail].filter(Boolean).join("\n\n");
		const controller = new AbortController();
		active = controller;
		try {
			const text = await generateRecap(prompt, ctx, controller.signal, reportTaskModels);
			if (active !== controller || !idle(ctx) || ctx.sessionManager.getLeafId() !== leaf) return;
			recappedLeaf = leaf;
			if (ctx.mode === "tui") {
				ctx.ui.setWidget(WIDGET_KEY, (_tui, theme) => ({
					invalidate() {},
					render: (width) => renderRecapWidget(text, theme, width),
				}));
			} else {
				ctx.ui.setWidget(WIDGET_KEY, [`↺ Recap: ${text}`]);
			}
		} catch (error) {
			// Route errors repeat on every idle cycle until /task-models changes, so show each message once.
			const message = error instanceof Error ? error.message : "Idle recap failed.";
			if (active === controller && !warned.has(message)) {
				warned.add(message);
				ctx.ui.notify(message, "warning");
			}
		} finally {
			if (active === controller) active = undefined;
		}
	};

	pi.on("agent_settled", (_event, ctx) => {
		cancel(ctx);
		if (!ctx.hasUI || ctx.ui.getEditorText().trim()) return;
		timer = setTimeout(() => void recap(ctx), RECAP_IDLE_MS);
		timer.unref();
		// Extension commands, built-in commands, and `!` shell commands do not emit `input`; any key cancels the pending recap.
		if (ctx.mode === "tui") {
			stopTerminalInput = ctx.ui.onTerminalInput(() => {
				cancelPending();
				return undefined;
			});
		}
	});
	pi.on("input", (_event, ctx) => {
		cancel(ctx);
		return { action: "continue" };
	});
	pi.on("user_bash", (_event, ctx) => {
		cancel(ctx);
	});
	pi.on("agent_start", (_event, ctx) => cancel(ctx));
	pi.on("session_tree", (_event, ctx) => cancel(ctx));
	pi.on("session_shutdown", (_event, ctx) => cancel(ctx));
}
