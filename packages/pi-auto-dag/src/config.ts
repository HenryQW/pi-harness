import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { loadRoles, type Role } from "@henryqw/pi-subagent";
import {
	CONFIG_VERSION,
	DEFAULT_MAX_PARALLEL_TASKS,
	DEFAULT_MAX_REVIEW_ROUNDS,
	DEFAULT_REQUIRED_GATE_TIMEOUT_MS,
	MAX_REQUIRED_GATE_TIMEOUT_MS,
	type ProjectConfig,
	type RoleRoutingConfig,
} from "./model.ts";
import { nonEmptyString, object, optionalPositiveInteger, positiveInteger, stringArray } from "./validate.ts";

const CONFIG_KEYS = [
	"version",
	"implementation_roles",
	"reviewer_role",
	"repair_role",
] as const;
const OPTIONAL_CONFIG_KEYS = ["max_parallel_tasks", "max_review_rounds", "required_gate_timeout_ms"] as const;

export function parseProjectConfig(value: unknown): RoleRoutingConfig {
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

	const implementationRoles = uniqueStrings(
		stringArray(input.implementation_roles, "configuration implementation_roles"),
		"configuration implementation_roles",
	);
	if (!implementationRoles.length) throw new Error("configuration implementation_roles must contain a Role");
	const reviewerRole = nonEmptyString(input.reviewer_role, "configuration reviewer_role");
	const repairRole = nonEmptyString(input.repair_role, "configuration repair_role");
	if (!implementationRoles.includes(repairRole)) {
		throw new Error(`configuration repair_role must be an implementation Role: ${repairRole}`);
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
		implementation_roles: implementationRoles,
		reviewer_role: reviewerRole,
		repair_role: repairRole,
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

export async function loadProjectConfig(roles?: readonly Role[]): Promise<ProjectConfig> {
	const path = join(getAgentDir(), "config", "pi-auto-dag.json");
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		throw new Error(`Cannot read pi-auto-dag configuration at ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
	let config: RoleRoutingConfig;
	try {
		config = parseProjectConfig(JSON.parse(text));
	} catch (error) {
		if (error instanceof SyntaxError) throw new Error(`Pi-auto-dag configuration at ${path} is not valid JSON: ${error.message}`);
		throw error;
	}
	return resolveProjectConfig(config, roles ?? loadRoles());
}

export function resolveProjectConfig(config: RoleRoutingConfig, roles: readonly Role[]): ProjectConfig {
	const byName = new Map<string, Role>();
	for (const role of roles) {
		const name = nonEmptyString(role.name, "Subagent Role name");
		if (byName.has(name)) throw new Error(`Duplicate Subagent Role: ${name}.`);
		byName.set(name, role);
	}
	const required = new Set([...config.implementation_roles, config.reviewer_role, config.repair_role]);
	for (const name of required) {
		if (!byName.has(name)) throw new Error(`Configured Subagent Role is unavailable: ${name}`);
	}
	return {
		...config,
		roles: Object.fromEntries([...required].map((name) => [name, byName.get(name)!])),
	};
}

export function configuredRole(config: ProjectConfig, name: string): Role {
	const role = config.roles[name];
	if (!role) throw new Error(`Configured Subagent Role is unavailable: ${name}`);
	return role;
}

function uniqueStrings(values: string[], label: string): string[] {
	const result = [...new Set(values)];
	if (result.length !== values.length) throw new Error(`${label} must not contain duplicates`);
	return result;
}
