import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TaskModelFallback } from "../dist/index.js";

// Keep one warning per parent session and route, including after extension reloads.
const FALLBACK_WARNINGS = Symbol.for("pi-subagent/task-model-fallback-warnings");

export function captureFallbackWarning(
	pi: Pick<ExtensionAPI, "sendMessage">,
	ctx: ExtensionContext,
	current: () => boolean,
	signal: AbortSignal,
): (fallback: TaskModelFallback) => void {
	const sessionId = ctx.sessionManager.getSessionId();
	return ({ profileName, model, thinkingLevel }) => {
		if (signal.aborted || !current() || ctx.sessionManager.getSessionId() !== sessionId) return;
		const message = `Task model profile ${profileName}: primary route is unavailable; selected fallback ${JSON.stringify(model)} (thinking ${thinkingLevel}).`;
		const state = globalThis as { [FALLBACK_WARNINGS]?: WeakMap<object, { sessionId: string; shown: Set<string> }> };
		const sessions = state[FALLBACK_WARNINGS] ??= new WeakMap();
		let warnings = sessions.get(ctx.sessionManager);
		if (warnings?.sessionId !== sessionId) {
			warnings = { sessionId, shown: new Set() };
			sessions.set(ctx.sessionManager, warnings);
		}
		if (warnings.shown.has(message)) return;
		if (ctx.hasUI) ctx.ui.notify(message, "warning");
		else pi.sendMessage({ customType: "pi-subagent-model-fallback", content: message, display: true }, { triggerTurn: false, deliverAs: "followUp" });
		warnings.shown.add(message);
	};
}
