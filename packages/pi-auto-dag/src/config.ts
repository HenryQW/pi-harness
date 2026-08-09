import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { readFile, stat } from "node:fs/promises";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	CONFIG_VERSION,
	DEFAULT_MAX_PARALLEL_TASKS,
	DEFAULT_MAX_REVIEW_ROUNDS,
	PROFILE_NAMES,
	type ProfileName,
	type ProjectConfig,
} from "./model.ts";
import { exactKeys, nonEmptyString, object, optionalPositiveInteger, positiveInteger } from "./validate.ts";

export function parseProjectConfig(value: unknown): ProjectConfig {
	const input = object(value, "auto-dag configuration");
	for (const key of Object.keys(input)) {
		if (!["version", "profiles", "max_parallel_tasks", "max_review_rounds"].includes(key)) {
			throw new Error(`Unknown auto-dag configuration setting: ${key}`);
		}
	}
	if (!("version" in input)) throw new Error("Missing auto-dag configuration setting: version");
	if (!("profiles" in input)) throw new Error("Missing auto-dag configuration setting: profiles");

	if (positiveInteger(input.version, "configuration version") !== CONFIG_VERSION) {
		throw new Error(`Unsupported auto-dag configuration version: ${input.version}`);
	}

	const profileInput = object(input.profiles, "configuration profiles");
	exactKeys(profileInput, PROFILE_NAMES, "configuration profiles");
	const profiles = {} as Record<ProfileName, string>;
	for (const name of PROFILE_NAMES) {
		profiles[name] = nonEmptyString(profileInput[name], `configuration profiles.${name}`);
	}

	return {
		version: CONFIG_VERSION,
		profiles,
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
	};
}

export async function loadProjectConfig(): Promise<ProjectConfig> {
	const path = join(getAgentDir(), "config", "pi-auto-dag.json");
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		throw new Error(`Cannot read pi-auto-dag configuration at ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
	try {
		return parseProjectConfig(JSON.parse(text));
	} catch (error) {
		if (error instanceof SyntaxError) throw new Error(`Pi-auto-dag configuration at ${path} is not valid JSON: ${error.message}`);
		throw error;
	}
}

export function expandProfilePath(path: string): string {
	const expanded = path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
	if (!isAbsolute(expanded)) throw new Error(`Profile path must be absolute or start with ~/: ${path}`);
	return expanded;
}

export async function assertProfileDirectories(config: ProjectConfig): Promise<void> {
	for (const name of PROFILE_NAMES) {
		const path = expandProfilePath(config.profiles[name]);
		let info;
		try {
			info = await stat(path);
		} catch {
			throw new Error(`Profile ${name} directory is missing: ${path}`);
		}
		if (!info.isDirectory()) throw new Error(`Profile ${name} path is not a directory: ${path}`);
	}
}
