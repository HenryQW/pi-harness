import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { LoadedMcpConfig, McpServerConfig } from "@earendil-works/pi-coding-agent";

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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Select the Role's allowlisted servers from the global `mcp.json` in Pi's native `mcpServers`
 * shape; the project `.pi/mcp.json` is ignored. A `--no-extensions` child has no codemode tool, so
 * every selected server is forced to direct exposure and codemode is never activated.
 */
export function loadRoleMcpConfig(agentDir: string, allowlist: readonly string[]): LoadedMcpConfig {
	const path = join(agentDir, "mcp.json");
	let parsed: unknown = {};
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
			throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
		}
	}
	if (!isRecord(parsed) || (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers))) {
		throw new Error(`${path}: expected an object with an "mcpServers" object.`);
	}
	const configured = parsed.mcpServers ?? {};
	const missing = allowlist.filter((name) => !Object.hasOwn(configured, name));
	if (missing.length) throw new Error(`Role MCP servers are not configured: ${missing.join(", ")}.`);
	const servers = allowlist.map((name) => {
		const value = configured[name];
		if (!isRecord(value)) throw new Error(`${path}: MCP server "${name}" must be an object.`);
		if (value.enabled === false) throw new Error(`${path}: Role MCP server "${name}" is disabled.`);
		const stdio = typeof value.command === "string" && value.command.trim() !== "" && (value.type === undefined || value.type === "stdio");
		const http = typeof value.url === "string" && value.url.trim() !== "" && (value.type === undefined || value.type === "http" || value.type === "streamable-http");
		if (stdio === http) {
			throw new Error(`${path}: MCP server "${name}" needs either a "command" (stdio) or a "url" (http or streamable-http).`);
		}
		const { toolExposure: _toolExposure, ...config } = value;
		return { name, config: { ...config, exposure: "direct" } as McpServerConfig, source: path, scope: "global" as const };
	});
	return { servers, autoEnableCodemode: false, errors: [] };
}
