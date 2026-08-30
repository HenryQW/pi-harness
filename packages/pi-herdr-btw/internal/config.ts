import { createConfigStore } from "@henryqw/pi-config-store";

export const TOOL_MODES = ["inherit", "all", "read-only", "none"] as const;
export type BtwToolMode = (typeof TOOL_MODES)[number];
export type BtwSplit = "right" | "down";

export type BtwConfig = {
	autoSubmit: boolean;
	tools: BtwToolMode;
	split: BtwSplit;
};

export const DEFAULT_CONFIG: Readonly<BtwConfig> = Object.freeze({
	autoSubmit: false,
	tools: "inherit",
	split: "right",
});

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

export function parseConfig(value: unknown): BtwConfig {
	if (!isRecord(value)) throw new Error("/btw config must be a JSON object");
	const allowedKeys = new Set(["autoSubmit", "tools", "split"]);
	for (const key of Object.keys(value)) {
		if (!allowedKeys.has(key)) throw new Error(`unknown config key: ${key}`);
	}

	const config = { ...DEFAULT_CONFIG };
	if ("autoSubmit" in value) {
		if (typeof value.autoSubmit !== "boolean") throw new Error("autoSubmit must be true or false");
		config.autoSubmit = value.autoSubmit;
	}
	if ("tools" in value) {
		if (!TOOL_MODES.includes(value.tools as BtwToolMode)) {
			throw new Error("tools must be inherit, all, read-only, or none");
		}
		config.tools = value.tools as BtwToolMode;
	}
	if ("split" in value) {
		if (value.split !== "right" && value.split !== "down") {
			throw new Error("split must be right or down");
		}
		config.split = value.split;
	}
	return config;
}

export function formatConfig(config: BtwConfig): string {
	return [
		`auto-submit: ${config.autoSubmit ? "on" : "off"}`,
		`tools: ${config.tools}`,
		`split: ${config.split}`,
	].join(" · ");
}

export const CONFIG_COMMAND_USAGE =
	"/btw config [auto-submit on|off | tools inherit|all|read-only|none | split right|down | reset]";

export type ConfigCommandResult = {
	action: "show" | "save" | "reset";
	config: BtwConfig;
};

export function applyConfigCommand(current: BtwConfig, input: string): ConfigCommandResult {
	const trimmed = input.trim();
	if (!trimmed || trimmed === "show") return { action: "show", config: current };
	if (trimmed === "reset") return { action: "reset", config: { ...DEFAULT_CONFIG } };

	const [key, value, ...extra] = trimmed.split(/\s+/);
	if (!key || !value || extra.length > 0) throw new Error(CONFIG_COMMAND_USAGE);
	const config = { ...current };

	switch (key) {
		case "auto-submit":
			if (value !== "on" && value !== "off") throw new Error(CONFIG_COMMAND_USAGE);
			config.autoSubmit = value === "on";
			break;
		case "tools":
			if (!TOOL_MODES.includes(value as BtwToolMode)) {
				throw new Error(CONFIG_COMMAND_USAGE);
			}
			config.tools = value as BtwToolMode;
			break;
		case "split":
			if (value !== "right" && value !== "down") throw new Error(CONFIG_COMMAND_USAGE);
			config.split = value;
			break;
		default:
			throw new Error(CONFIG_COMMAND_USAGE);
	}

	return { action: "save", config };
}

export function createBtwConfigStore(agentDir?: string) {
	return createConfigStore<BtwConfig>({
		extensionId: "pi-herdr-btw",
		agentDir,
		defaults: () => ({ ...DEFAULT_CONFIG }),
		parse: parseConfig,
	});
}
