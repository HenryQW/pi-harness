import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	CONFIG_VERSION,
	DEFAULT_MAX_PARALLEL_TASKS,
	DEFAULT_MAX_REVIEW_ROUNDS,
	DEFAULT_REQUIRED_GATE_TIMEOUT_MS,
	MAX_REQUIRED_GATE_TIMEOUT_MS,
	type ProjectConfig,
} from "./model.ts";
import { object, optionalPositiveInteger, positiveInteger } from "./validate.ts";

const CONFIG_KEYS = ["version", "max_parallel_tasks", "max_review_rounds", "required_gate_timeout_ms"] as const;

/** Missing file means defaults; malformed or invalid files fail fast and are never rewritten. */
export function parseProjectConfig(value: unknown): ProjectConfig {
	const input = object(value, "auto-dag configuration");
	for (const key of Object.keys(input)) {
		if (!CONFIG_KEYS.includes(key as never)) {
			throw new Error(`Unknown auto-dag configuration setting: ${key}`);
		}
	}
	if (!(typeof input.version === "number" && Number.isInteger(input.version) && input.version > 0)) {
		throw new Error("Missing auto-dag configuration setting: version");
	}
	if (positiveInteger(input.version, "configuration version") !== CONFIG_VERSION) {
		throw new Error(`Unsupported auto-dag configuration version: ${input.version}`);
	}

	const requiredGateTimeoutMs = optionalPositiveInteger(
		input.required_gate_timeout_ms,
		DEFAULT_REQUIRED_GATE_TIMEOUT_MS,
		"configuration required_gate_timeout_ms",
	);
	if (requiredGateTimeoutMs > MAX_REQUIRED_GATE_TIMEOUT_MS) {
		throw new Error(`configuration required_gate_timeout_ms must not exceed ${MAX_REQUIRED_GATE_TIMEOUT_MS}`);
	}

	return {
		version: CONFIG_VERSION,
		max_parallel_tasks: optionalPositiveInteger(
			input.max_parallel_tasks,
			DEFAULT_MAX_PARALLEL_TASKS,
			"configuration max_parallel_tasks",
		),
		max_review_rounds: optionalPositiveInteger(
			input.max_review_rounds,
			DEFAULT_MAX_REVIEW_ROUNDS,
			"configuration max_review_rounds",
		),
		required_gate_timeout_ms: requiredGateTimeoutMs,
	};
}

export async function loadProjectConfig(): Promise<ProjectConfig> {
	const path = join(getAgentDir(), "config", "pi-auto-dag.json");
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {
			version: CONFIG_VERSION,
			max_parallel_tasks: DEFAULT_MAX_PARALLEL_TASKS,
			max_review_rounds: DEFAULT_MAX_REVIEW_ROUNDS,
			required_gate_timeout_ms: DEFAULT_REQUIRED_GATE_TIMEOUT_MS,
		};
		throw new Error(`Cannot read pi-auto-dag configuration at ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
	try {
		return parseProjectConfig(JSON.parse(text));
	} catch (error) {
		if (error instanceof SyntaxError) throw new Error(`Pi-auto-dag configuration at ${path} is not valid JSON: ${error.message}`);
		throw error;
	}
}
