import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CHILD_EXCLUDED_TOOL_NAMES, ROLE_TOOL_POLICY_FLAG } from "@henryqw/pi-subagent";

const childExcludedTools: ReadonlySet<string> = new Set(CHILD_EXCLUDED_TOOL_NAMES);

function configuredTools(value: unknown): string[] | undefined {
	if (value === undefined) return;
	if (typeof value !== "string") throw new Error(`${ROLE_TOOL_POLICY_FLAG} must be JSON tool names.`);
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		throw new Error(`${ROLE_TOOL_POLICY_FLAG} must be JSON tool names.`);
	}
	if (!Array.isArray(parsed) || parsed.some((name) => typeof name !== "string" || !name.trim() || name.includes("\0"))) {
		throw new Error(`${ROLE_TOOL_POLICY_FLAG} must be JSON tool names.`);
	}
	return [...new Set(parsed.map((name) => name.trim()))];
}

export default function roleTools(pi: ExtensionAPI): void {
	pi.registerFlag(ROLE_TOOL_POLICY_FLAG, {
		description: "Internal Pi Subagent Role tool policy",
		type: "string",
	});
	pi.on("session_start", () => {
		const selected = configuredTools(pi.getFlag(ROLE_TOOL_POLICY_FLAG));
		if (!selected) return;
		const allTools = pi.getAllTools();
		const registeredTools = new Set(allTools.map((tool) => tool.name));
		const extensionTools = allTools
			.filter((tool) => !["builtin", "sdk", "inline"].includes(tool.sourceInfo.source))
			.map((tool) => tool.name);
		pi.setActiveTools([...new Set([...selected, ...extensionTools])].filter((name) => !childExcludedTools.has(name)));
		const activeTools = new Set(pi.getActiveTools().filter((name) => registeredTools.has(name) && !childExcludedTools.has(name)));
		const unavailable = selected.filter((name) => !activeTools.has(name));
		if (unavailable.length) {
			throw new Error(`Subagent requested unavailable tools: ${unavailable.join(", ")}. Check spelling and load the provider extension that registers them.`);
		}
	});
}
