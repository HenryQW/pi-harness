import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

// Repository-mandated single-extension config path boundary (root AGENTS.md).
export const configPath = () => join(getAgentDir(), "config", "pi-memory.json");

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
	const path = explicitPath ?? configPath();
	let raw: string;
	try {
		// Bound the read: a config accidentally replaced with (or symlinked to) a
		// huge file must not exhaust memory before validation. Real configs are
		// tiny; 64 KiB is generous.
		const bytes = readFileSync(path);
		if (bytes.length > 64 * 1024) {
			throw new Error(`Memory config at ${path} is too large (${bytes.length} bytes); expected < 64 KiB.`);
		}
		// Fatal decode: invalid UTF-8 must surface as malformed config, not a
		// U+FFFD-replaced view that could pass path checks and silently redirect
		// the memory directory.
		raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch (error: unknown) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
			return {
				directory: DEFAULT_DIRECTORY(),
				memoryCharLimit: DEFAULT_MEMORY_CHAR_LIMIT,
				userCharLimit: DEFAULT_USER_CHAR_LIMIT,
			};
		}
		if (error instanceof TypeError) {
			throw new Error(`Malformed memory config at ${path}: invalid UTF-8.`);
		}
		throw error;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Malformed JSON in memory config at ${path}: ${message}`);
	}

	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`Memory config at ${path} must be a JSON object.`);
	}

	const obj = parsed as Record<string, unknown>;

	// Fail fast on typos: an unrecognized key would otherwise silently activate
	// defaults (e.g. "memoryCharLimits": 100), contradicting the fail-fast contract.
	const KNOWN_KEYS = ["directory", "memoryCharLimit", "userCharLimit"];
	for (const key of Object.keys(obj)) {
		if (!KNOWN_KEYS.includes(key)) {
			throw new Error(`Unknown key '${key}' in memory config at ${path}. Expected: ${KNOWN_KEYS.join(", ")}.`);
		}
	}

	let directory = DEFAULT_DIRECTORY();
	if (obj.directory !== undefined) {
		if (typeof obj.directory !== "string" || obj.directory.trim() === "") {
			throw new Error(`Invalid 'directory' in memory config at ${path}: must be a non-empty string, got ${JSON.stringify(obj.directory)}`);
		}
		if (!isAbsolute(obj.directory)) {
			throw new Error(`Invalid 'directory' in memory config at ${path}: must be an absolute path, got ${JSON.stringify(obj.directory)}`);
		}
		// Untrusted config value gets embedded verbatim in prompt warnings;
		// control characters could forge prompt lines.
		if (/\p{C}/u.test(obj.directory)) {
			throw new Error(`Invalid 'directory' in memory config at ${path}: must not contain control characters.`);
		}
		directory = obj.directory;
	}

	let memoryCharLimit = DEFAULT_MEMORY_CHAR_LIMIT;
	if (obj.memoryCharLimit !== undefined) {
		const val = obj.memoryCharLimit;
		if (typeof val !== "number" || !Number.isSafeInteger(val) || val <= 0 || val > 100_000) {
			throw new Error(`Invalid 'memoryCharLimit' in memory config at ${path}: must be a positive safe integer <= 100000, got ${JSON.stringify(val)}`);
		}
		memoryCharLimit = val;
	}

	let userCharLimit = DEFAULT_USER_CHAR_LIMIT;
	if (obj.userCharLimit !== undefined) {
		const val = obj.userCharLimit;
		if (typeof val !== "number" || !Number.isSafeInteger(val) || val <= 0 || val > 100_000) {
			throw new Error(`Invalid 'userCharLimit' in memory config at ${path}: must be a positive safe integer <= 100000, got ${JSON.stringify(val)}`);
		}
		userCharLimit = val;
	}

	return {
		directory,
		memoryCharLimit,
		userCharLimit,
	};
}
