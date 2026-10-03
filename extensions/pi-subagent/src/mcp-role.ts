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

const isString = (value: unknown) => typeof value === "string";
const isStringRecord = (value: unknown) => isRecord(value) && Object.values(value).every(isString);
const parseUrl = (value: unknown) => (typeof value === "string" && URL.canParse(value) ? new URL(value) : undefined);

// Pi's native MCP rules (core/mcp-servers.ts); `validateMcpServerConfig` is not exported, so they are mirrored here.
const SERVER_NAME = /^[A-Za-z0-9_-]+$/;
const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];
const isHttpsOrLoopback = (url: URL | undefined) =>
	url !== undefined && (url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.includes(url.hostname)));
/** Tool namespace `mcp__<server>` replaces `-` with `_`, so names differing only there collide. */
const mcpNamespace = (name: string) => name.replace(/-/g, "_");
// Pi's exposure names and the alias it still accepts (core/mcp-servers.ts); the native loader is bypassed, so resolve it here.
const MCP_EXPOSURES = ["codemode", "deferred", "direct", "hidden"] as const;
const MCP_EXPOSURE_ALIASES: Record<string, string> = { "codemode-deferred": "codemode" };
const resolveExposure = (value: string) => MCP_EXPOSURE_ALIASES[value] ?? value;
const isExposure = (value: unknown) => typeof value === "string" && (MCP_EXPOSURES as readonly string[]).includes(resolveExposure(value));

type FieldCheck = [(value: unknown, server: Record<string, unknown>) => boolean, string];
/** Documented `mcpServers` fields (Pi's docs/mcp.md) and their shapes, by transport; dotted keys are nested. */
const COMMON_CHECKS: Record<string, FieldCheck> = {
	enabled: [(value) => typeof value === "boolean", "a boolean"],
	timeout: [(value) => typeof value === "number" && Number.isFinite(value) && value > 0, "a positive number"],
	description: [isString, "a string"],
};
const STDIO_CHECKS: Record<string, FieldCheck> = {
	args: [(value) => Array.isArray(value) && value.every(isString), "an array of strings"],
	env: [isStringRecord, "an object of strings"],
	cwd: [isString, "a string"],
};
const HTTP_CHECKS: Record<string, FieldCheck> = {
	url: [(value) => /^https?:$/.test(parseUrl(value)?.protocol ?? ""), "an http or https URL"],
	headers: [isStringRecord, "an object of strings"],
	oauth: [isRecord, "an object"],
	"oauth.clientId": [isString, "a string"],
	"oauth.clientSecret": [isString, "a string"],
	"oauth.callbackPort": [(value) => Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 65535, "a port number"],
	"oauth.callbackUrl": [(value, server) => {
		const url = parseUrl(value);
		const port = (server.oauth as Record<string, unknown>).callbackPort;
		return url !== undefined && url.protocol === "http:" && LOOPBACK_HOSTS.includes(url.hostname) && url.search === "" && url.hash === ""
			&& (url.port === "" || port === undefined || Number(url.port) === port);
	}, "an http URL on localhost, 127.0.0.1, or [::1] without query or fragment, on the \"oauth.callbackPort\" port"],
	"oauth.scope": [isString, "a string"],
	"oauth.clientName": [(value) => typeof value === "string" && value.trim() !== "", "a non-empty string"],
	"oauth.authServerMetadataUrl": [(value) => isHttpsOrLoopback(parseUrl(value)), "an https URL, or http on localhost, 127.0.0.1, or [::1]"],
	auth: [(value) => isRecord(value) && typeof value.provider === "string" && value.provider !== "", "an object with a non-empty \"provider\" string"],
};
const EXPOSURE_CHECKS: Record<string, FieldCheck> = {
	exposure: [isExposure, `one of ${MCP_EXPOSURES.map((exposure) => `"${exposure}"`).join(", ")}`],
	toolExposure: [(value) => isRecord(value) && Object.values(value).every(isExposure), "an object mapping tool names to exposures"],
};

/** Validate one selected server against Pi's documented `mcpServers` rules; the native loader is bypassed by `loadConfig`. */
function validateRoleMcpServer(path: string, name: string, value: unknown, codemode: boolean): McpServerConfig {
	const fail: (message: string) => never = (message) => { throw new Error(`${path}: MCP server "${name}" ${message}`); };
	if (!SERVER_NAME.test(name)) fail("has an invalid name (use letters, digits, \"_\" and \"-\").");
	if (!isRecord(value)) fail("must be an object.");
	if (value.enabled === false) throw new Error(`${path}: Role MCP server "${name}" is disabled.`);
	const stdio = typeof value.command === "string" && value.command.trim() !== "" && (value.type === undefined || value.type === "stdio");
	const http = typeof value.url === "string" && value.url.trim() !== "" && (value.type === undefined || value.type === "http" || value.type === "streamable-http");
	if (stdio === http) fail("needs either a \"command\" (stdio) or a \"url\" (http or streamable-http).");
	for (const [field, [valid, shape]] of Object.entries({ ...COMMON_CHECKS, ...(stdio ? STDIO_CHECKS : HTTP_CHECKS), ...(codemode ? EXPOSURE_CHECKS : {}) })) {
		const fieldValue = field.split(".").reduce<unknown>((parent, key) => (isRecord(parent) ? parent[key] : undefined), value);
		if (fieldValue !== undefined && !valid(fieldValue, value)) fail(`field "${field}" must be ${shape}.`);
	}
	// The native transport sends the provider's token to `url`, so Pi only allows it over https or loopback.
	if (value.auth !== undefined && !isHttpsOrLoopback(parseUrl(value.url))) {
		fail("field \"auth\" requires \"url\" to use https, or http on localhost, 127.0.0.1, or [::1].");
	}
	if (codemode) {
		const { exposure, toolExposure } = value;
		return {
			...value,
			...(typeof exposure === "string" ? { exposure: resolveExposure(exposure) } : {}),
			...(isRecord(toolExposure) ? { toolExposure: Object.fromEntries(Object.entries(toolExposure).map(([tool, entry]) => [tool, resolveExposure(entry as string)])) } : {}),
		} as McpServerConfig;
	}
	const { toolExposure: _toolExposure, ...config } = value;
	return { ...config, exposure: "direct" } as McpServerConfig;
}

/**
 * Select the Role's allowlisted servers from the global `mcp.json` in Pi's native `mcpServers`
 * shape; the project `.pi/mcp.json` is ignored. A child that activates `codemode` keeps each
 * server's configured exposure, so scripts reach `codemode` and `deferred` tools. Any other child
 * cannot reach undeclared tools, so every selected server is forced to direct exposure. Codemode is
 * never activated by MCP configuration: the Role tool policy owns the active set.
 */
export function loadRoleMcpConfig(agentDir: string, allowlist: readonly string[], options: { codemode: boolean } = { codemode: false }): LoadedMcpConfig {
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
	const namespaces = new Map<string, string>();
	const servers = allowlist.map((name) => {
		const clash = namespaces.get(mcpNamespace(name));
		if (clash) throw new Error(`${path}: Role MCP server "${name}" conflicts with "${clash}": names that differ only in "-" and "_" share one tool namespace.`);
		namespaces.set(mcpNamespace(name), name);
		return { name, config: validateRoleMcpServer(path, name, configured[name], options.codemode), source: path, scope: "global" as const };
	});
	return { servers, autoEnableCodemode: false, errors: [] };
}
