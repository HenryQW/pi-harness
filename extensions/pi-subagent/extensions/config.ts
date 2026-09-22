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
	maxTokens?: number;
	maxCorrections?: number;
	timeout?: SubagentTimeoutConfig;
}

export interface LoadedSubagentConfig {
	source: "file" | "missing";
	config: SubagentConfig;
	/** Human-readable problems; malformed files are preserved and delegation fails closed. */
	error?: string;
}

export interface EffectiveExecutionPolicy {
	maxSubagents: number;
	maxTurns: number;
	maxTokens?: number;
	childIdleMs: number;
	childMaxMs: number;
	maxCorrections: number;
}

type ParsedSubagentConfig = Omit<LoadedSubagentConfig, "source">;

const EXTENSION_ID = "pi-subagent";
const positive = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value) && value > 0;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
export const DEFAULT_TIMEOUT_CONFIG = { idleMinutes: 10, maxMinutes: 30 } as const;
export const DEFAULT_EXECUTION_POLICY = {
	maxSubagents: 5,
	maxTurns: 50,
	maxCorrections: 1,
} as const;
const INTEGER_FIELDS = ["maxSubagents", "maxTurns", "maxTokens"] as const;
const POLICY_FIELDS = ["maxCorrections"] as const;
const TIMEOUT_FIELDS = ["idleMinutes", "maxMinutes"] as const;

export const configPath = (agentDir = getAgentDir()): string =>
	extensionConfigPath(EXTENSION_ID, agentDir);

function parseSubagentConfig(parsed: unknown, path: string): ParsedSubagentConfig {
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return { config: {}, error: `${path} must contain a JSON object; delegation is blocked until this file is corrected.` };
	}
	const record = parsed as Record<string, unknown>;
	const problems: string[] = [];
	const config: SubagentConfig = {};
	for (const key of Object.keys(record)) {
		if (![...INTEGER_FIELDS, ...POLICY_FIELDS, "timeout"].includes(key as never)) {
			problems.push(`unknown config key ${JSON.stringify(key)}; expected ${[...INTEGER_FIELDS, ...POLICY_FIELDS].join(", ")}, timeout`);
		}
	}
	for (const key of INTEGER_FIELDS) {
		const value = record[key];
		if (value === undefined) continue;
		if (typeof value === "number" && Number.isSafeInteger(value) && value >= 1) config[key] = value;
		else problems.push(`${key} must be a safe integer >= 1, got ${JSON.stringify(value)}`);
	}
	if (record.maxCorrections !== undefined) {
		if (!Number.isSafeInteger(record.maxCorrections) || (record.maxCorrections as number) < 0) {
			problems.push(`maxCorrections must be a safe integer >= 0, got ${JSON.stringify(record.maxCorrections)}`);
		} else config.maxCorrections = record.maxCorrections as number;
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
				if (!positive(value)) problems.push(`timeout.${key} must be a positive number of minutes, got ${JSON.stringify(value)}`);
				else if (value * 60_000 > MAX_TIMER_DELAY_MS) problems.push(`timeout.${key} exceeds ${MAX_TIMER_DELAY_MS} ms, got ${JSON.stringify(value)} minutes`);
				else timeout[key] = value;
			}
			for (const key of Object.keys(timeoutRecord)) {
				if (!TIMEOUT_FIELDS.includes(key as keyof SubagentTimeoutConfig)) problems.push(`unknown timeout.${key}; expected ${TIMEOUT_FIELDS.join(", ")}`);
			}
			if (Object.keys(timeout).length) config.timeout = timeout;
		}
	}
	if (config.timeout) {
		const idleMinutes = config.timeout.idleMinutes ?? DEFAULT_TIMEOUT_CONFIG.idleMinutes;
		const maxMinutes = config.timeout.maxMinutes ?? DEFAULT_TIMEOUT_CONFIG.maxMinutes;
		if (maxMinutes <= idleMinutes) {
			problems.push(`timeout.maxMinutes (${maxMinutes}) must be greater than timeout.idleMinutes (${idleMinutes})`);
			delete config.timeout;
		}
	}
	return {
		config,
		error: problems.length ? `${path}: ${problems.join("; ")}; delegation is blocked until this file is corrected.` : undefined,
	};
}

/** Resolve one immutable policy. Malformed explicit safety settings fail closed. */
export function resolveExecutionPolicy(loaded: LoadedSubagentConfig): EffectiveExecutionPolicy {
	if (loaded.error) throw new Error(loaded.error);
	const timeout = loaded.config.timeout;
	return Object.freeze({
		maxSubagents: loaded.config.maxSubagents ?? DEFAULT_EXECUTION_POLICY.maxSubagents,
		maxTurns: loaded.config.maxTurns ?? DEFAULT_EXECUTION_POLICY.maxTurns,
		...(loaded.config.maxTokens === undefined ? {} : { maxTokens: loaded.config.maxTokens }),
		childIdleMs: (timeout?.idleMinutes ?? DEFAULT_TIMEOUT_CONFIG.idleMinutes) * 60_000,
		childMaxMs: (timeout?.maxMinutes ?? DEFAULT_TIMEOUT_CONFIG.maxMinutes) * 60_000,
		maxCorrections: loaded.config.maxCorrections ?? DEFAULT_EXECUTION_POLICY.maxCorrections,
	});
}

/** Read untrusted optional config without rewriting it. */
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
				? `${path} is not valid JSON (${reason}); delegation is blocked until this file is corrected.`
				: `${path} couldn't be read (${reason}); delegation is blocked until this file is corrected.`,
		};
	}
}
