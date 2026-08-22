import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface SubagentConfig {
	maxChildren?: number;
}

export interface LoadedSubagentConfig {
	config: SubagentConfig;
	/** Human-readable problem when the file exists but is unusable; the file is never rewritten. */
	error?: string;
}

/**
 * Read the optional user config at `<agentDir>/config/pi-subagent.json`.
 * Treated as untrusted user data: malformed files are preserved untouched and
 * reported instead of crashing the session; callers fall back to defaults.
 */
export function readSubagentConfig(agentDir = getAgentDir()): LoadedSubagentConfig {
	const path = join(agentDir, "config", "pi-subagent.json");
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { config: {} };
		throw error;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		return {
			config: {},
			error: `${path} is not valid JSON (${error instanceof Error ? error.message : String(error)}); using defaults.`,
		};
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return { config: {}, error: `${path} must contain a JSON object; using defaults.` };
	}
	const { maxChildren } = parsed as Record<string, unknown>;
	if (maxChildren === undefined) return { config: {} };
	if (typeof maxChildren !== "number" || !Number.isInteger(maxChildren) || maxChildren < 1) {
		return {
			config: {},
			error: `${path}: maxChildren must be an integer >= 1, got ${JSON.stringify(maxChildren)}; using defaults.`,
		};
	}
	return { config: { maxChildren } };
}
