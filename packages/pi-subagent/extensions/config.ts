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

// Node clamps setTimeout delays above 2^31 - 1 ms to 1 ms, which would kill
// every child immediately instead of applying the configured deadline.
const MAX_TIMER_DELAY_MS = 2_147_483_647;
// Defaults for fields the user left unset, used when bounding the combined
// soft + grace hard-deadline delay.
const DEFAULT_SOFT_MINUTES = 10;
const DEFAULT_GRACE_MINUTES = 5;
const TIMEOUT_FIELDS: Array<[keyof SubagentTimeoutConfig, number, string]> = [
	["softMinutes", 60_000, "minutes"],
	["graceMinutes", 60_000, "minutes"],
	["activeWindowSeconds", 1_000, "seconds"],
];

/**
 * Required single-extension config path form (AGENTS.md); agentDir is
 * injectable so tests can point at a temp directory.
 */
export const subagentConfigPath = (agentDir = getAgentDir()): string =>
	join(agentDir, "config", "pi-subagent.json");

/**
 * Read the optional user config at `<agentDir>/config/pi-subagent.json`.
 * Treated as untrusted user data: malformed files are preserved untouched and
 * reported instead of crashing the session; callers fall back to defaults.
 */
export function readSubagentConfig(agentDir = getAgentDir()): LoadedSubagentConfig {
	const path = subagentConfigPath(agentDir);
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
		if (key !== "maxSubagents" && key !== "timeout") {
			problems.push(`unknown config key ${JSON.stringify(key)}; expected maxSubagents, timeout`);
		}
	}

	if (record.maxSubagents !== undefined) {
		if (typeof record.maxSubagents === "number" && Number.isSafeInteger(record.maxSubagents) && record.maxSubagents >= 1) {
			config.maxSubagents = record.maxSubagents;
		} else {
			problems.push(`maxSubagents must be a safe integer >= 1, got ${JSON.stringify(record.maxSubagents)}`);
		}
	}

	if (record.timeout !== undefined) {
		if (!record.timeout || typeof record.timeout !== "object" || Array.isArray(record.timeout)) {
			problems.push(`timeout must be a JSON object, got ${JSON.stringify(record.timeout)}`);
		} else {
			const timeoutRecord = record.timeout as Record<string, unknown>;
			const timeout: SubagentTimeoutConfig = {};
			for (const [key, unitMs, unit] of TIMEOUT_FIELDS) {
				const value = timeoutRecord[key];
				if (value === undefined) continue;
				if (!positive(value)) {
					problems.push(`timeout.${key} must be a positive number of ${unit}, got ${JSON.stringify(value)}`);
				} else if (value * unitMs > MAX_TIMER_DELAY_MS) {
					problems.push(`timeout.${key} exceeds the maximum supported delay of ${MAX_TIMER_DELAY_MS} ms, got ${JSON.stringify(value)} ${unit}`);
				} else {
					(timeout as Record<string, number>)[key] = value;
				}
			}
			for (const key of Object.keys(timeoutRecord)) {
				if (!TIMEOUT_FIELDS.some(([known]) => known === key)) {
					problems.push(`unknown timeout.${key}; expected ${TIMEOUT_FIELDS.map(([known]) => known).join(", ")}`);
				}
			}
			if (Object.keys(timeout).length) config.timeout = timeout;
		}
	}

	// The hard deadline schedules softMs + graceMs in one timer; the combination
	// must stay inside Node's limit even when each field fits alone. Falling back
	// to defaults drops the whole timeout object, matching other invalid values.
	if (config.timeout) {
		const hardDeadlineMinutes =
			(config.timeout.softMinutes ?? DEFAULT_SOFT_MINUTES) +
			(config.timeout.graceMinutes ?? DEFAULT_GRACE_MINUTES);
		if (hardDeadlineMinutes * 60_000 > MAX_TIMER_DELAY_MS) {
			problems.push(`timeout softMinutes + graceMinutes must stay within ${MAX_TIMER_DELAY_MS} ms combined, got ${hardDeadlineMinutes} minutes`);
			delete config.timeout;
		}
	}

	return { config, error: problems.length ? `${path}: ${problems.join("; ")}; using defaults.` : undefined };
}
