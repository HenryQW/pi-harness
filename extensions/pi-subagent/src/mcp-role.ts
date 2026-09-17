export interface RoleMcpConfig {
	mcpServers: Record<string, unknown>;
	settings?: Record<string, unknown>;
}

export function parseRoleMcpAllowlist(value: unknown): string[] {
	if (typeof value !== "string") throw new Error("The Role MCP policy flag must contain a JSON array of MCP server names.");
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		throw new Error("The Role MCP policy flag must contain a JSON array of MCP server names.");
	}
	if (!Array.isArray(parsed)
		|| parsed.some((name) => typeof name !== "string" || !name.trim() || name.includes("\0"))) {
		throw new Error("The Role MCP policy flag must contain a JSON array of MCP server names.");
	}
	const names = parsed.map((name) => name.trim());
	if (new Set(names).size !== names.length) throw new Error("The Role MCP policy flag contains duplicate MCP server names.");
	return names;
}

export function roleMcpFlagValue(args: readonly string[], flag: string): string | undefined {
	const indexes = args.flatMap((arg, index) => arg === flag ? [index] : []);
	if (indexes.length > 1) throw new Error(`${flag} must appear at most once.`);
	if (!indexes.length) return;
	const value = args[indexes[0]! + 1];
	if (value === undefined) throw new Error(`${flag} requires a value.`);
	return value;
}

export function selectRoleMcpConfig(config: RoleMcpConfig, allowlist: readonly string[]): RoleMcpConfig {
	const missing = allowlist.filter((name) => !Object.hasOwn(config.mcpServers, name));
	if (missing.length) throw new Error(`Role MCP servers are not configured: ${missing.join(", ")}.`);
	const mcpServers = Object.fromEntries(allowlist.map((name) => [name, config.mcpServers[name]]));
	const { agentPluginPaths: _agentPluginPaths, hostConfigDiscovery: _hostConfigDiscovery, ...settings } = config.settings ?? {};
	return {
		mcpServers,
		...(Object.keys(settings).length ? { settings } : {}),
	};
}
