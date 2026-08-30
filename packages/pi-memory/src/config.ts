import { isAbsolute, join } from "node:path";
import { createConfigStore, extensionConfigDir, extensionConfigPath } from "@henryqw/pi-config-store";

const EXTENSION_ID = "pi-memory";

export const configPath = (agentDir?: string) => extensionConfigPath(EXTENSION_ID, agentDir);

export interface MemoryConfig {
	directory: string;
	memoryCharLimit: number;
	userCharLimit: number;
}

export function DEFAULT_DIRECTORY(agentDir?: string): string {
	return join(extensionConfigDir(EXTENSION_ID, agentDir), "memory");
}

export const DEFAULT_MEMORY_CHAR_LIMIT = 8800;
export const DEFAULT_USER_CHAR_LIMIT = 5500;

function charLimit(key: "memoryCharLimit" | "userCharLimit", value: unknown, defaultValue: number, path: string): number {
	if (value === undefined) return defaultValue;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > 100_000) {
		throw new Error(`Invalid '${key}' in memory config at ${path}: must be a positive safe integer <= 100000, got ${JSON.stringify(value)}`);
	}
	return value;
}

function parseMemoryConfig(value: unknown, path: string, defaultDirectory: string): MemoryConfig {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`Memory config at ${path} must be a JSON object.`);
	}

	const config = value as Record<string, unknown>;
	const knownKeys = ["directory", "memoryCharLimit", "userCharLimit"];
	for (const key of Object.keys(config)) {
		if (!knownKeys.includes(key)) {
			throw new Error(`Unknown key '${key}' in memory config at ${path}. Expected: ${knownKeys.join(", ")}.`);
		}
	}

	let directory = defaultDirectory;
	if (config.directory !== undefined) {
		if (typeof config.directory !== "string" || config.directory.trim() === "") {
			throw new Error(`Invalid 'directory' in memory config at ${path}: must be a non-empty string, got ${JSON.stringify(config.directory)}`);
		}
		if (!isAbsolute(config.directory)) {
			throw new Error(`Invalid 'directory' in memory config at ${path}: must be an absolute path, got ${JSON.stringify(config.directory)}`);
		}
		if (/\p{C}/u.test(config.directory)) {
			throw new Error(`Invalid 'directory' in memory config at ${path}: must not contain control characters.`);
		}
		directory = config.directory;
	}

	return {
		directory,
		memoryCharLimit: charLimit("memoryCharLimit", config.memoryCharLimit, DEFAULT_MEMORY_CHAR_LIMIT, path),
		userCharLimit: charLimit("userCharLimit", config.userCharLimit, DEFAULT_USER_CHAR_LIMIT, path),
	};
}

function memoryConfigStore(agentDir?: string) {
	const path = configPath(agentDir);
	return createConfigStore<MemoryConfig>({
		extensionId: EXTENSION_ID,
		agentDir,
		defaults: () => ({
			directory: DEFAULT_DIRECTORY(agentDir),
			memoryCharLimit: DEFAULT_MEMORY_CHAR_LIMIT,
			userCharLimit: DEFAULT_USER_CHAR_LIMIT,
		}),
		parse: (value) => parseMemoryConfig(value, path, DEFAULT_DIRECTORY(agentDir)),
	});
}

export function loadMemoryConfig(agentDir?: string): { source: "file" | "missing"; value: MemoryConfig } {
	const path = configPath(agentDir);
	try {
		return memoryConfigStore(agentDir).loadSync();
	} catch (error) {
		if (error instanceof SyntaxError) {
			throw new Error(`Malformed JSON in memory config at ${path}: ${error.message}`);
		}
		if (error instanceof TypeError) {
			throw new Error(`Malformed memory config at ${path}: invalid UTF-8.`);
		}
		if (error instanceof Error && error.message.startsWith("Config exceeds")) {
			throw new Error(`Memory config at ${path} is too large; expected < 64 KiB.`);
		}
		throw error;
	}
}
