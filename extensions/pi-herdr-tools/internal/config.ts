import { createConfigStore, field, parsers } from "@henryqw/pi-config-store";

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

export function formatConfig(config: BtwConfig): string {
	return [
		`auto-submit: ${config.autoSubmit ? "on" : "off"}`,
		`tools: ${config.tools}`,
		`split: ${config.split}`,
	].join(" · ");
}

export const CONFIG_COMMAND_USAGE =
	"/btw config [auto-submit on|off | tools inherit|all|read-only|none | split right|down | reset]";

export function applyConfigCommand(current: BtwConfig, input: string): BtwConfig {
	const [key, value, ...extra] = input.split(/\s+/);
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

	return config;
}

export function createBtwConfigStore(agentDir?: string) {
	return createConfigStore({
		extensionId: "pi-herdr-btw",
		agentDir,
		fields: {
			autoSubmit: field(parsers.boolean(), DEFAULT_CONFIG.autoSubmit),
			tools: field(parsers.oneOf(TOOL_MODES), DEFAULT_CONFIG.tools),
			split: field(parsers.oneOf(["right", "down"] as const), DEFAULT_CONFIG.split),
		},
	});
}
