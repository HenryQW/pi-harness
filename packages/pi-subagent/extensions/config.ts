import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface SubagentTimeoutConfig {
	/** Soft deadline in minutes; the child is asked to stop after this. */
	softMinutes?: number;
	/** Extra minutes past the soft deadline before a stuck child is killed. */
	graceMinutes?: number;
	/** Activity window in seconds that qualifies an active child for grace. */
	activeWindowSeconds?: number;
}

export interface SubagentConfig {
	maxSubagents?: number;
	timeout?: SubagentTimeoutConfig;
}

export interface LoadedSubagentConfig {
	config: SubagentConfig;
	/** Human-readable problems when the file exists but is partly unusable; the file is never rewritten. */
	error?: string;
}

const positive = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value) && value > 0;

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
	const record = parsed as Record<string, unknown>;
	const problems: string[] = [];
	const config: SubagentConfig = {};

	if (record.maxSubagents !== undefined) {
		if (typeof record.maxSubagents === "number" && Number.isInteger(record.maxSubagents) && record.maxSubagents >= 1) {
			config.maxSubagents = record.maxSubagents;
		} else {
			problems.push(`maxSubagents must be an integer >= 1, got ${JSON.stringify(record.maxSubagents)}`);
		}
	}

	if (record.timeout !== undefined) {
		if (!record.timeout || typeof record.timeout !== "object" || Array.isArray(record.timeout)) {
			problems.push(`timeout must be a JSON object, got ${JSON.stringify(record.timeout)}`);
		} else {
			const timeout: SubagentTimeoutConfig = {};
			const fields: Array<[keyof SubagentTimeoutConfig, string]> = [
				["softMinutes", "minutes"],
				["graceMinutes", "minutes"],
				["activeWindowSeconds", "seconds"],
			];
			for (const [key, unit] of fields) {
				const value = (record.timeout as Record<string, unknown>)[key];
				if (value === undefined) continue;
				if (positive(value)) (timeout as Record<string, number>)[key] = value;
				else problems.push(`timeout.${key} must be a positive number of ${unit}, got ${JSON.stringify(value)}`);
			}
			if (Object.keys(timeout).length) config.timeout = timeout;
		}
	}

	return { config, error: problems.length ? `${path}: ${problems.join("; ")}; using defaults.` : undefined };
}
