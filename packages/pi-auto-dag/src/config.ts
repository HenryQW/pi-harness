import { stat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { commandOutput, runCommand, type CommandRunner } from "./command.ts";
import {
	CONFIG_VERSION,
	DEFAULT_MAX_PARALLEL_TASKS,
	DEFAULT_MAX_REVIEW_ROUNDS,
	DEFAULT_REQUIRED_GATE_TIMEOUT_MS,
	PROFILE_RESOLUTION_VERSION,
	type ProfileRoutingConfig,
	type ProjectConfig,
	type ResolvedProfile,
} from "./model.ts";
import { exactKeys, nonEmptyString, object, optionalPositiveInteger, positiveInteger, stringArray } from "./validate.ts";

const CONFIG_KEYS = [
	"version",
	"profile_resolver",
	"implementation_profiles",
	"reviewer_profile",
	"repair_profile",
] as const;
const OPTIONAL_CONFIG_KEYS = ["max_parallel_tasks", "max_review_rounds", "required_gate_timeout_ms"] as const;

export function parseProjectConfig(value: unknown): ProfileRoutingConfig {
	const input = object(value, "auto-dag configuration");
	for (const key of Object.keys(input)) {
		if (![...CONFIG_KEYS, ...OPTIONAL_CONFIG_KEYS].includes(key as never)) {
			throw new Error(`Unknown auto-dag configuration setting: ${key}`);
		}
	}
	for (const key of CONFIG_KEYS) {
		if (!(key in input)) throw new Error(`Missing auto-dag configuration setting: ${key}`);
	}
	if (positiveInteger(input.version, "configuration version") !== CONFIG_VERSION) {
		throw new Error(`Unsupported auto-dag configuration version: ${input.version}`);
	}

	const profileResolver = stringArray(input.profile_resolver, "configuration profile_resolver");
	if (!profileResolver.length) throw new Error("configuration profile_resolver must contain a command");
	const implementationProfiles = uniqueStrings(
		stringArray(input.implementation_profiles, "configuration implementation_profiles"),
		"configuration implementation_profiles",
	);
	if (!implementationProfiles.length) throw new Error("configuration implementation_profiles must contain a profile");
	const reviewerProfile = nonEmptyString(input.reviewer_profile, "configuration reviewer_profile");
	const repairProfile = nonEmptyString(input.repair_profile, "configuration repair_profile");
	if (!implementationProfiles.includes(repairProfile)) {
		throw new Error(`configuration repair_profile must be an implementation profile: ${repairProfile}`);
	}

	return {
		version: CONFIG_VERSION,
		profile_resolver: profileResolver,
		implementation_profiles: implementationProfiles,
		reviewer_profile: reviewerProfile,
		repair_profile: repairProfile,
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
		required_gate_timeout_ms: optionalPositiveInteger(
			input.required_gate_timeout_ms,
			DEFAULT_REQUIRED_GATE_TIMEOUT_MS,
			"configuration required_gate_timeout_ms",
		),
	};
}

export async function loadProjectConfig(
	runner: CommandRunner = runCommand,
	cwd = process.cwd(),
): Promise<ProjectConfig> {
	const path = join(getAgentDir(), "config", "pi-auto-dag.json");
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		throw new Error(`Cannot read pi-auto-dag configuration at ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
	let config: ProfileRoutingConfig;
	try {
		config = parseProjectConfig(JSON.parse(text));
	} catch (error) {
		if (error instanceof SyntaxError) throw new Error(`Pi-auto-dag configuration at ${path} is not valid JSON: ${error.message}`);
		throw error;
	}
	return await resolveProjectConfig(config, runner, cwd);
}

export async function resolveProjectConfig(
	config: ProfileRoutingConfig,
	runner: CommandRunner = runCommand,
	cwd = process.cwd(),
): Promise<ProjectConfig> {
	const [rawCommand, ...prefix] = config.profile_resolver;
	const command = expandUserPath(rawCommand);
	const profileIds = [...new Set([
		...config.implementation_profiles,
		config.reviewer_profile,
		config.repair_profile,
	])];
	const profiles: Record<string, ResolvedProfile> = {};
	for (const id of profileIds) {
		let value: unknown;
		try {
			value = JSON.parse(await commandOutput(runner, command, [...prefix, id], cwd));
		} catch (error) {
			throw new Error(`Cannot resolve Pi profile ${id}: ${error instanceof Error ? error.message : String(error)}`);
		}
		const profile = parseResolvedProfile(value, id);
		await assertProfileResources(profile);
		profiles[id] = profile;
	}
	return { ...config, profiles };
}

export function parseResolvedProfile(value: unknown, expectedId: string): ResolvedProfile {
	const label = `resolved Pi profile ${expectedId}`;
	const input = object(value, label);
	exactKeys(input, ["version", "id", "description", "agent_dir", "skills", "tools"], label);
	if (positiveInteger(input.version, `${label}.version`) !== PROFILE_RESOLUTION_VERSION) {
		throw new Error(`Unsupported resolved Pi profile version: ${input.version}`);
	}
	const id = nonEmptyString(input.id, `${label}.id`);
	if (id !== expectedId) throw new Error(`${label}.id must equal requested profile ID`);
	const agentDir = nonEmptyString(input.agent_dir, `${label}.agent_dir`);
	if (!isAbsolute(agentDir)) throw new Error(`${label}.agent_dir must be absolute`);
	const skills = uniqueStrings(stringArray(input.skills, `${label}.skills`), `${label}.skills`);
	for (const path of skills) {
		if (!isAbsolute(path)) throw new Error(`${label}.skills paths must be absolute: ${path}`);
	}
	return {
		version: PROFILE_RESOLUTION_VERSION,
		id,
		description: nonEmptyString(input.description, `${label}.description`),
		agent_dir: agentDir,
		skills,
		tools: uniqueStrings(stringArray(input.tools, `${label}.tools`), `${label}.tools`),
	};
}

function expandUserPath(path: string): string {
	return path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

async function assertProfileResources(profile: ResolvedProfile): Promise<void> {
	await assertDirectory(profile.agent_dir, `Profile ${profile.id} directory`);
	for (const path of profile.skills) await assertDirectory(path, `Profile ${profile.id} skill path`);
}

async function assertDirectory(path: string, label: string): Promise<void> {
	let info;
	try {
		info = await stat(path);
	} catch {
		throw new Error(`${label} is missing: ${path}`);
	}
	if (!info.isDirectory()) throw new Error(`${label} is not a directory: ${path}`);
}

function uniqueStrings(values: string[], label: string): string[] {
	const result = [...new Set(values)];
	if (result.length !== values.length) throw new Error(`${label} must not contain duplicates`);
	return result;
}
