import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface SubagentTimeoutConfig {
	/** Minutes a child may stay idle before it is asked to stop. */
	idleMinutes?: number;
	/** Hard cap in minutes before a child is killed regardless of activity. */
	maxMinutes?: number;
}

export interface SubagentConfig {
	maxSubagents?: number;
	maxTurns?: number;
	timeout?: SubagentTimeoutConfig;
}

export interface LoadedSubagentConfig {
	config: SubagentConfig;
	/** Human-readable problems when the file exists but is partly unusable; the file is never rewritten. */
	error?: string;
}

const positive = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value) && value > 0;

// Node clamps setTimeout delays above 2^31 - 1 ms to 1 ms, which would kill
// every child immediately instead of applying the configured deadline.
const MAX_TIMER_DELAY_MS = 2_147_483_647;
export const DEFAULT_TIMEOUT_CONFIG = { idleMinutes: 10, maxMinutes: 30 } as const;
const TIMEOUT_FIELDS = ["idleMinutes", "maxMinutes"] as const;

/**
 * All pi-subagent config lives in its existing extension-named directory;
 * agentDir is injectable so tests can point at a temp directory.
 */
export const configPath = (agentDir = getAgentDir()): string =>
	join(agentDir, "config", "pi-subagent", "pi-subagent.json");

/**
 * Read the optional user config at `<agentDir>/config/pi-subagent/pi-subagent.json`.
 * Treated as untrusted user data: malformed files are preserved untouched and
 * reported instead of crashing the session; callers fall back to defaults.
 */
export function readSubagentConfig(agentDir = getAgentDir()): LoadedSubagentConfig {
	const path = configPath(agentDir);
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
	for (const key of Object.keys(record)) {
		if (key !== "maxSubagents" && key !== "maxTurns" && key !== "timeout") {
			problems.push(`unknown config key ${JSON.stringify(key)}; expected maxSubagents, maxTurns, timeout`);
		}
	}

	for (const key of ["maxSubagents", "maxTurns"] as const) {
		const value = record[key];
		if (value === undefined) continue;
		if (typeof value === "number" && Number.isSafeInteger(value) && value >= 1) {
			config[key] = value;
		} else {
			problems.push(`${key} must be a safe integer >= 1, got ${JSON.stringify(value)}`);
		}
	}

	if (record.timeout !== undefined) {
		if (!record.timeout || typeof record.timeout !== "object" || Array.isArray(record.timeout)) {
			problems.push(`timeout must be a JSON object, got ${JSON.stringify(record.timeout)}`);
		} else {
			const timeoutRecord = record.timeout as Record<string, unknown>;
			const timeout: SubagentTimeoutConfig = {};
			for (const key of TIMEOUT_FIELDS) {
				const value = timeoutRecord[key];
				if (value === undefined) continue;
				if (!positive(value)) {
					problems.push(`timeout.${key} must be a positive number of minutes, got ${JSON.stringify(value)}`);
				} else if (value * 60_000 > MAX_TIMER_DELAY_MS) {
					problems.push(`timeout.${key} exceeds the maximum supported delay of ${MAX_TIMER_DELAY_MS} ms, got ${JSON.stringify(value)} minutes`);
				} else {
					timeout[key] = value;
				}
			}
			for (const key of Object.keys(timeoutRecord)) {
				if (!TIMEOUT_FIELDS.includes(key as keyof SubagentTimeoutConfig)) {
					problems.push(`unknown timeout.${key}; expected ${TIMEOUT_FIELDS.join(", ")}`);
				}
			}
			if (Object.keys(timeout).length) config.timeout = timeout;
		}
	}

	// The hard cap must exceed the idle deadline or every idle kill is
	// unreachable. Falling back to defaults drops the whole timeout object,
	// matching other invalid values.
	if (config.timeout) {
		const idleMinutes = config.timeout.idleMinutes ?? DEFAULT_TIMEOUT_CONFIG.idleMinutes;
		const maxMinutes = config.timeout.maxMinutes ?? DEFAULT_TIMEOUT_CONFIG.maxMinutes;
		if (maxMinutes <= idleMinutes) {
			problems.push(`timeout.maxMinutes (${maxMinutes}) must be greater than timeout.idleMinutes (${idleMinutes})`);
			delete config.timeout;
		}
	}

	return { config, error: problems.length ? `${path}: ${problems.join("; ")}; using defaults.` : undefined };
}
