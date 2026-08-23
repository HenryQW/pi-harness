import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface MemoryConfig {
	directory: string;
	memoryCharLimit: number;
	userCharLimit: number;
}

export function DEFAULT_DIRECTORY(): string {
	return join(getAgentDir(), "memory");
}

export const DEFAULT_MEMORY_CHAR_LIMIT = 8800;
export const DEFAULT_USER_CHAR_LIMIT = 5500;

export function loadMemoryConfig(explicitPath?: string): MemoryConfig {
	const configPath = explicitPath ?? join(getAgentDir(), "config", "pi-memory.json");
	let raw: string;
	try {
		raw = readFileSync(configPath, "utf8");
	} catch (error: unknown) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
			return {
				directory: DEFAULT_DIRECTORY(),
				memoryCharLimit: DEFAULT_MEMORY_CHAR_LIMIT,
				userCharLimit: DEFAULT_USER_CHAR_LIMIT,
			};
		}
		throw error;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Malformed JSON in memory config at ${configPath}: ${message}`);
	}

	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`Memory config at ${configPath} must be a JSON object.`);
	}

	const obj = parsed as Record<string, unknown>;

	// Fail fast on typos: an unrecognized key would otherwise silently activate
	// defaults (e.g. "memoryCharLimits": 100), contradicting the fail-fast contract.
	const KNOWN_KEYS = ["directory", "memoryCharLimit", "userCharLimit"];
	for (const key of Object.keys(obj)) {
		if (!KNOWN_KEYS.includes(key)) {
			throw new Error(`Unknown key '${key}' in memory config at ${configPath}. Expected: ${KNOWN_KEYS.join(", ")}.`);
		}
	}

	let directory = DEFAULT_DIRECTORY();
	if (obj.directory !== undefined) {
		if (typeof obj.directory !== "string" || obj.directory.trim() === "") {
			throw new Error(`Invalid 'directory' in memory config at ${configPath}: must be a non-empty string, got ${JSON.stringify(obj.directory)}`);
		}
		if (!isAbsolute(obj.directory)) {
			throw new Error(`Invalid 'directory' in memory config at ${configPath}: must be an absolute path, got ${JSON.stringify(obj.directory)}`);
		}
		directory = obj.directory;
	}

	let memoryCharLimit = DEFAULT_MEMORY_CHAR_LIMIT;
	if (obj.memoryCharLimit !== undefined) {
		const val = obj.memoryCharLimit;
		if (typeof val !== "number" || !Number.isSafeInteger(val) || val <= 0 || val > 100_000) {
			throw new Error(`Invalid 'memoryCharLimit' in memory config at ${configPath}: must be a positive safe integer <= 100000, got ${JSON.stringify(val)}`);
		}
		memoryCharLimit = val;
	}

	let userCharLimit = DEFAULT_USER_CHAR_LIMIT;
	if (obj.userCharLimit !== undefined) {
		const val = obj.userCharLimit;
		if (typeof val !== "number" || !Number.isSafeInteger(val) || val <= 0 || val > 100_000) {
			throw new Error(`Invalid 'userCharLimit' in memory config at ${configPath}: must be a positive safe integer <= 100000, got ${JSON.stringify(val)}`);
		}
		userCharLimit = val;
	}

	return {
		directory,
		memoryCharLimit,
		userCharLimit,
	};
}
