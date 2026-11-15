import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { modelReference, registerModelTask, resolveConfiguredTaskRoute, THINKING_LEVELS, type ModelTask, type ThinkingLevel } from "./index.js";

const roles = ["reviewer", "researcher", "worker", "planner", "oracle"] as const;
const tasks = roles.map((role) => ({
	id: `billion-context/acp-${role}`,
	label: `Delegate ${role}`,
	purpose: `Route the ${role} delegate.`,
	defaultProfile: role === "researcher" ? "fast" : "balanced",
} satisfies ModelTask));

export function registerBiliModels(pi: ExtensionAPI, agentDir: string, reportConfig: (ctx: ExtensionContext) => void): void {
	for (const task of tasks) registerModelTask(pi, task);
	pi.on("tool_call", (event, ctx) => {
		if (event.toolName !== "acp_delegate" || event.input.resumeFrom) return;
		if (!pi.getAllTools().some(({ name, sourceInfo }) => name === event.toolName
			&& sourceInfo.origin === "package" && /^npm:billion-context(?:@[^/]+)?$/.test(sourceInfo.source))) return;
		const input = event.input;
		const task = tasks.find((candidate) => candidate.id === `billion-context/acp-${input.agent}`);
		if (!task) return; // The delegate tool owns validation of unknown roles.
		try {
			const thinking = input.thinkingLevel;
			if (thinking !== undefined && !(THINKING_LEVELS as readonly unknown[]).includes(thinking)) {
				throw new Error("Invalid delegate thinkingLevel.");
			}
			if (input.model !== undefined) {
				if (typeof input.model !== "string" || !/^[^\s/]+\/\S+$/.test(input.model) || input.model.includes("\0")) {
					throw new Error("Delegate model must be provider/model without whitespace.");
				}
				if (thinking !== undefined) {
					const model = ctx.modelRegistry.getAvailable().find((item) => item.input.includes("text") && modelReference(item) === input.model);
					if (!model || !getSupportedThinkingLevels(model).includes(thinking as ThinkingLevel)) {
						throw new Error(`Delegate model ${input.model} is unavailable or does not support thinking ${thinking}.`);
					}
				}
				return;
			}
			reportConfig(ctx);
			// A child process has its own model scope; the parent's scopedModels must not restrict it.
			const childContext = { model: ctx.model, scopedModels: [], modelRegistry: ctx.modelRegistry };
			const route = resolveConfiguredTaskRoute(childContext, task, agentDir, thinking as ThinkingLevel | undefined, (profile, fallback) => {
				const message = `Delegate ${input.agent}: profile ${profile} uses fallback ${modelReference(fallback.model)} (${fallback.thinkingLevel}).`;
				if (ctx.hasUI) ctx.ui.notify(message, "warning");
				else process.stderr.write(`${message}\n`);
			});
			input.model = modelReference(route.model);
			input.thinkingLevel = route.thinkingLevel;
		} catch (error) {
			return { block: true, reason: `Delegate routing failed: ${error instanceof Error ? error.message : String(error)}` };
		}
	});
}
