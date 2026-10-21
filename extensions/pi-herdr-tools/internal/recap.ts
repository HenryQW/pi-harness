import { buildSessionContext, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { executeTaskRoutes, registerModelTask, registerTaskModelsConfigReporting, type ModelTask } from "@henryqw/pi-task-models";
import { buildMergeTranscript } from "./merge.ts";
import { configuredTaskRoutes } from "./task-models.ts";

const WIDGET_KEY = "pi-herdr-recap";
/** oh-my-pi's default: a short look away costs no model call, and the recap is ready after a typical visit to other panes. */
export const RECAP_IDLE_MS = 240_000;
const RECAP_MAX_WORDS = 40;
const RECAP_PROMPT = `The user stepped away from this coding conversation and is returning. Write a recap of at most ${RECAP_MAX_WORDS} words in one or two plain sentences without markdown: the overall goal, the current state, then one next action. Reply with the recap only.`;
export const RECAP_TASK = {
	id: "pi-herdr-tools/recap",
	label: "Idle recap",
	purpose: "Summarize where an idle conversation stopped.",
	defaultProfile: "fast",
} as const satisfies ModelTask;

class RecapModelError extends Error {}

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
	let recappedLeaf: string | null | undefined;

	const cancel = (ctx: ExtensionContext) => {
		clearTimeout(timer);
		timer = undefined;
		active?.abort();
		active = undefined;
		ctx.ui.setWidget(WIDGET_KEY, undefined);
	};
	const idle = (ctx: ExtensionContext) => ctx.isIdle() && !ctx.ui.getEditorText().trim();

	const recap = async (ctx: ExtensionContext) => {
		timer = undefined;
		const leaf = ctx.sessionManager.getLeafId();
		if (leaf === recappedLeaf || !idle(ctx)) return;
		const transcript = buildMergeTranscript(buildSessionContext(ctx.sessionManager.getEntries(), leaf).messages);
		if (!transcript) return;
		const title = pi.getSessionName();
		const controller = new AbortController();
		active = controller;
		try {
			const text = await generateRecap(title ? `Conversation title: ${title}\n\n${transcript}` : transcript, ctx, controller.signal, reportTaskModels);
			if (active !== controller || !idle(ctx)) return;
			recappedLeaf = leaf;
			const icon = ctx.mode === "tui" ? ctx.ui.theme.fg("accent", "↺") : "↺";
			ctx.ui.setWidget(WIDGET_KEY, [`${icon} Recap: ${text}`]);
		} catch (error) {
			if (active === controller) ctx.ui.notify(error instanceof Error ? error.message : "Idle recap failed.", "warning");
		} finally {
			if (active === controller) active = undefined;
		}
	};

	pi.on("agent_settled", (_event, ctx) => {
		cancel(ctx);
		if (!ctx.hasUI || ctx.ui.getEditorText().trim()) return;
		timer = setTimeout(() => void recap(ctx), RECAP_IDLE_MS);
		timer.unref();
	});
	pi.on("input", (_event, ctx) => {
		cancel(ctx);
		return { action: "continue" };
	});
	pi.on("agent_start", (_event, ctx) => cancel(ctx));
	pi.on("session_tree", (_event, ctx) => cancel(ctx));
	pi.on("session_shutdown", (_event, ctx) => cancel(ctx));
}
