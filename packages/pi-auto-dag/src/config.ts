import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	CONFIG_VERSION,
	DEFAULT_MAX_PARALLEL_TASKS,
	DEFAULT_MAX_REVIEW_ROUNDS,
	DEFAULT_REQUIRED_GATE_TIMEOUT_MS,
	MAX_REQUIRED_GATE_TIMEOUT_MS,
	type ConfiguredProfile,
	type ProfileRoutingConfig,
	type ProjectConfig,
	type ResolvedProfile,
	type SkillRegistryEntry,
} from "./model.ts";
import { exactKeys, nonEmptyString, object, optionalPositiveInteger, positiveInteger, stringArray } from "./validate.ts";

const CONFIG_KEYS = [
	"version",
	"profiles",
	"implementation_profiles",
	"reviewer_profile",
	"repair_profile",
] as const;
const OPTIONAL_CONFIG_KEYS = ["max_parallel_tasks", "max_review_rounds", "required_gate_timeout_ms"] as const;
const PROFILE_KEYS = ["description", "agent_dir", "skills", "tools"] as const;

export interface AvailableSkill {
	name: string;
	filePath: string;
}

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

	const profiles = parseProfiles(input.profiles);
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
	for (const id of new Set([...implementationProfiles, reviewerProfile, repairProfile])) {
		if (!Object.hasOwn(profiles, id)) throw new Error(`configuration profiles is missing referenced profile: ${id}`);
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
		profiles,
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
		required_gate_timeout_ms: requiredGateTimeoutMs,
	};
}

export async function loadProjectConfig(
	availableSkills: readonly AvailableSkill[] = [],
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
	return await resolveProjectConfig(config, availableSkills);
}

export async function resolveProjectConfig(
	config: ProfileRoutingConfig,
	availableSkills: readonly AvailableSkill[] = [],
): Promise<ProjectConfig> {
	const registry = parseAvailableSkills(availableSkills);
	const requiredNames = new Set(Object.values(config.profiles).flatMap((profile) => profile.skills));
	for (const name of requiredNames) {
		if (!registry.some((skill) => skill.name === name)) throw new Error(`Configured Pi skill is unavailable: ${name}`);
	}
	const skillRegistry = registry.filter((skill) => requiredNames.has(skill.name));
	const profiles = Object.fromEntries(await Promise.all(Object.entries(config.profiles).map(async ([id, configured]) => {
		const profile: ResolvedProfile = {
			...configured,
			id,
			skills: skillRegistry.filter((skill) => configured.skills.includes(skill.name)).map((skill) => skill.file_path),
		};
		await assertProfileResources(profile);
		return [id, profile] as const;
	})));
	return { ...config, profiles, skill_registry: skillRegistry };
}

export async function revalidateResolvedProfile(config: ProjectConfig, id: string): Promise<ResolvedProfile> {
	const profile = config.profiles[id];
	if (!profile) throw new Error(`Resolved Pi profile is missing: ${id}`);
	await assertProfileResources(profile);
	return profile;
}

function parseProfiles(value: unknown): Record<string, ConfiguredProfile> {
	const input = object(value, "configuration profiles");
	return Object.fromEntries(Object.entries(input).map(([rawId, value]) => {
		const id = nonEmptyString(rawId, "configuration profile ID");
		const label = `configuration profiles.${id}`;
		const profile = object(value, label);
		exactKeys(profile, PROFILE_KEYS, label);
		const agentDir = nonEmptyString(profile.agent_dir, `${label}.agent_dir`);
		if (!isAbsolute(agentDir)) throw new Error(`${label}.agent_dir must be absolute`);
		return [id, {
			description: nonEmptyString(profile.description, `${label}.description`),
			agent_dir: agentDir,
			skills: uniqueStrings(stringArray(profile.skills, `${label}.skills`), `${label}.skills`),
			tools: uniqueStrings(stringArray(profile.tools, `${label}.tools`), `${label}.tools`),
		} satisfies ConfiguredProfile] as const;
	}));
}

function parseAvailableSkills(skills: readonly AvailableSkill[]): SkillRegistryEntry[] {
	return skills.map((skill, index) => {
		const name = nonEmptyString(skill.name, `effective Pi skill[${index}].name`);
		const filePath = nonEmptyString(skill.filePath, `effective Pi skill[${index}].filePath`);
		if (!isAbsolute(filePath)) throw new Error(`effective Pi skill[${index}].filePath must be absolute: ${filePath}`);
		return { name, file_path: filePath };
	});
}

async function assertProfileResources(profile: ResolvedProfile): Promise<void> {
	await assertPath(profile.agent_dir, `Profile ${profile.id} directory`, "directory");
	for (const path of profile.skills) await assertPath(path, `Profile ${profile.id} skill file`, "file");
}

async function assertPath(path: string, label: string, kind: "directory" | "file"): Promise<void> {
	let info;
	try {
		info = await stat(path);
	} catch {
		throw new Error(`${label} is missing: ${path}`);
	}
	if (kind === "directory" ? !info.isDirectory() : !info.isFile()) throw new Error(`${label} is not a ${kind}: ${path}`);
}

function uniqueStrings(values: string[], label: string): string[] {
	const result = [...new Set(values)];
	if (result.length !== values.length) throw new Error(`${label} must not contain duplicates`);
	return result;
}
