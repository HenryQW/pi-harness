declare module "pi-mcp-adapter" {
	export function createMcpAdapter(options: {
		config: { mcpServers: Record<string, unknown>; settings?: Record<string, unknown> };
	}): (pi: import("@earendil-works/pi-coding-agent").ExtensionAPI) => void;
}

declare module "pi-mcp-adapter/config" {
	export function loadMcpConfig(
		overridePath?: string,
		cwd?: string,
	): { mcpServers: Record<string, unknown>; settings?: Record<string, unknown> };
}
