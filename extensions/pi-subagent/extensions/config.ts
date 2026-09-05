import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { createConfigStore, extensionConfigPath } from "@henryqw/pi-config-store";

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
	source: "file" | "missing";
	config: SubagentConfig;
	/** Human-readable problems when the file exists but is partly unusable; the file is never rewritten. */
	error?: string;
}

type ParsedSubagentConfig = Omit<LoadedSubagentConfig, "source">;

const EXTENSION_ID = "pi-subagent";
const positive = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value) && value > 0;

// Node clamps setTimeout delays above 2^31 - 1 ms to 1 ms, which would kill
// every child immediately instead of applying the configured deadline.
const MAX_TIMER_DELAY_MS = 2_147_483_647;
export const DEFAULT_TIMEOUT_CONFIG = { idleMinutes: 10, maxMinutes: 30 } as const;
const TIMEOUT_FIELDS = ["idleMinutes", "maxMinutes"] as const;

/** Return the canonical default JSON path for pi-subagent's config home. */
export const configPath = (agentDir = getAgentDir()): string =>
	extensionConfigPath(EXTENSION_ID, agentDir);

function parseSubagentConfig(parsed: unknown, path: string): ParsedSubagentConfig {
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

	return { config, error: problems.length ? `${path}: ${problems.join("; ")}; invalid settings use defaults while valid settings still apply.` : undefined };
}

/**
 * Read the optional user config at `<agentDir>/config/pi-subagent/config.json`.
 * Treated as untrusted user data: malformed files are preserved untouched and
 * reported instead of crashing the session; callers fall back to defaults.
 */
export function readSubagentConfig(agentDir = getAgentDir()): LoadedSubagentConfig {
	const path = configPath(agentDir);
	let validationError: string | undefined;
	const store = createConfigStore<SubagentConfig>({
		extensionId: EXTENSION_ID,
		agentDir,
		defaults: () => ({}),
		parse(value) {
			const parsed = parseSubagentConfig(value, path);
			validationError = parsed.error;
			return parsed.config;
		},
	});
	try {
		const loaded = store.loadSync();
		return {
			source: loaded.source,
			config: loaded.value,
			...(validationError === undefined ? {} : { error: validationError }),
		};
	} catch (error) {
		const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
		if (code !== undefined && code !== "ERR_ENCODING_INVALID_ENCODED_DATA") throw error;
		const reason = error instanceof Error ? error.message : String(error);
		return {
			source: "file",
			config: {},
			error: error instanceof SyntaxError
				? `${path} is not valid JSON (${reason}); using defaults.`
				: `${path} couldn't be read (${reason}); using defaults.`,
		};
	}
}
