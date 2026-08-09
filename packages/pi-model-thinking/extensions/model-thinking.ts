import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const satisfies readonly ThinkingLevel[];
const CLEAR = "Use current level";
const configPath = () => join(getAgentDir(), "config", "pi-model-thinking.json");

function isValidThinkingLevel(value: unknown): value is ThinkingLevel {
	return typeof value === "string" && LEVELS.includes(value as ThinkingLevel);
}

// Config is untrusted user input. Keep only recognized model-level pairs.
function readConfig(): Record<string, ThinkingLevel> {
	let value: unknown;
	try {
		value = JSON.parse(readFileSync(configPath(), "utf8"));
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return {};
		throw error;
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Config must be an object.");
	return Object.fromEntries(Object.entries(value).filter(([, level]) => isValidThinkingLevel(level)));
}

// Config is tiny; concurrent Pi processes use last-writer-wins updates.
function writeConfig(config: Record<string, ThinkingLevel>): void {
	const file = configPath();
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
}

export default function modelThinkingExtension(pi: ExtensionAPI): void {
	const setThinkingLevel = (provider: string, id: string): ThinkingLevel | undefined => {
		try {
			const level = readConfig()[`${provider}/${id}`];
			if (level) {
				pi.setThinkingLevel(level);
				return pi.getThinkingLevel();
			}
		} catch {
			// Broken config must not block session startup or model selection.
		}
	};

	pi.registerCommand("model-thinking", {
		description: "remember thinking level for current model",
		handler: async (_args, ctx) => {
			if (!ctx.model) {
				ctx.ui.notify("Select a model first.", "error");
				return;
			}

			const key = `${ctx.model.provider}/${ctx.model.id}`;
			let config: Record<string, ThinkingLevel>;
			try {
				config = readConfig();
			} catch {
				ctx.ui.notify("Couldn't read model thinking config.", "error");
				return;
			}

			const selected = await ctx.ui.select(
				`Thinking for ${key} · saved: ${config[key] ?? "none"}`,
				[...LEVELS, CLEAR],
			);
			if (!selected) return;

			const level = isValidThinkingLevel(selected) ? selected : undefined;
			if (selected === CLEAR) delete config[key];
			else if (level) config[key] = level;
			else return;

			try {
				writeConfig(config);
			} catch {
				ctx.ui.notify("Couldn't save model thinking config.", "error");
				return;
			}

			if (level) pi.setThinkingLevel(level);
			ctx.ui.notify(level ? `${key}: will auto set thinking to ${level}` : `${key}: config cleared`, "info");
		},
	});

	// Startup covers initial/restored models; model_select covers later switches.
	pi.on("session_start", (_event, ctx) => {
		if (ctx.model) setThinkingLevel(ctx.model.provider, ctx.model.id);
	});
	pi.on("model_select", (event, ctx) => {
		const level = setThinkingLevel(event.model.provider, event.model.id);
		// Pi writes its model status after handlers finish; defer so this message remains visible.
		if (level) setTimeout(() => ctx.ui.notify(`Model Thinking auto set thinking to ${level}.`, "info"), 0);
	});
}
