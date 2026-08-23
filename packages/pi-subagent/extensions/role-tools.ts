import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const ROLE_TOOL_POLICY_FLAG = "pi-subagent-role-tools";
const CHILD_EXCLUDED_TOOLS = new Set(["delegate_task", "ask_question", "auto_dag_approve", "auto_dag_start"]);

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
		const extensionTools = pi.getAllTools()
			.filter((tool) => !["builtin", "sdk", "inline"].includes(tool.sourceInfo.source))
			.map((tool) => tool.name);
		pi.setActiveTools([...new Set([...selected, ...extensionTools])].filter((name) => !CHILD_EXCLUDED_TOOLS.has(name)));
	});
}
