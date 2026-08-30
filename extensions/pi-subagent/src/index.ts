import { readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, parseFrontmatter, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { extensionConfigDir } from "@henryqw/pi-config-store";
import {
	loadTaskModelsConfig,
	modelReference,
	orderedProfileRoutes,
	resolveConfiguredTaskRoute,
	resolveTaskModelRoute,
	type AvailableModel,
	type ModelTask,
	type ProfileName,
	type ResolvedTaskRoute,
	type ThinkingLevel,
} from "@henryqw/pi-task-models";

export {
	addUsage,
	capEphemeralSubagentOutput,
	createEphemeralSubagentExecutor,
	DEFAULT_MAX_TURNS,
	EphemeralSubagentError,
	EXECUTION_BUDGET_ENV,
	formatDuration,
	type EphemeralSubagentActivityEvent,
	type EphemeralSubagentErrorCode,
	type EphemeralSubagentExecutor,
	type EphemeralSubagentExecutorOptions,
	type EphemeralSubagentResult,
	type EphemeralSubagentRunInput,
	type EphemeralSubagentTimeout,
} from "./ephemeral.ts";
export {
	createChildWorktree,
	finalizeChildWorktree,
	inspectIndexFlags,
	inspectWorktreeDirty,
	WorktreeSetupError,
	worktreeContextNote,
	type WorktreeDirtyInspection,
	type WorktreeInfo,
	type WorktreePayload,
} from "./worktree.ts";
export {
	prepareExactReviewEvidence,
	REVIEW_MAX_PATCH_BYTES,
	REVIEW_MAX_PATHS,
	type PreparedReviewEvidence,
	type PrepareExactReviewEvidenceInput,
} from "./review-evidence.ts";

const CODEX_ALIAS = /^openai-codex-(?:[2-9]|[1-9]\d+)$/;
const MULTI_CODEX_EXTENSION = fileURLToPath(import.meta.resolve("@henryqw/pi-multi-codex/extensions/multi-codex.ts"));
const ROLE_TOOLS_EXTENSION = fileURLToPath(new URL("../extensions/role-tools.ts", import.meta.url));
export const ROLE_TOOL_POLICY_FLAG = "pi-subagent-role-tools";
export const CHILD_EXCLUDED_TOOL_NAMES = ["delegate_task", "delegate_flow", "delegate_flow_continue", "ask_question"] as const;
export const CHILD_EXCLUDED_TOOLS = CHILD_EXCLUDED_TOOL_NAMES.join(",");
const CHILD_IDENTITY_POLICY = "You are a delegated Pi Subagent, not Main. Execute the assigned Role and task directly. Main-only delegation rules do not apply. Recursive delegation is unavailable; do not seek or invoke delegation tools.";

export const DELEGATE_TASK = {
	id: "pi-subagent/delegateTask",
	label: "Subagent delegation",
	purpose: "Launch an isolated Pi subagent.",
	defaultProfile: "fast",
} as const satisfies ModelTask;

export interface Role {
	name: string;
	description: string;
	tools: string[];
	isolation?: string;
	extensions: string[];
	skills: string[];
	systemPrompt: string;
}

export interface PiLaunch {
	env: Record<string, string>;
	args: string[];
}

export interface ResolvedRoleLaunch extends PiLaunch {
	model: AvailableModel;
	thinkingLevel: ThinkingLevel;
	missingSkills: string[];
}

export interface CreateRoleLaunchInput {
	role: Role;
	route: ResolvedTaskRoute;
	extensions?: readonly string[];
	tools?: readonly string[];
	env?: Readonly<Record<string, string>>;
}

export interface ResolveRoleLaunchInput extends Omit<CreateRoleLaunchInput, "route"> {
	task: ModelTask;
	agentDir?: string;
}

export interface ResolvedRoleSkills {
	paths: string[];
	missing: string[];
}

const cleanText = (value: unknown, field: string, source: string): string => {
	if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
		throw new Error(`${source}: ${field} must be non-empty text.`);
	}
	return value.trim();
};

const stringList = (value: unknown, field: string, source: string): string[] => {
	if (value === undefined) throw new Error(`${source}: ${field} is required.`);
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim() || item.includes("\0"))) {
		throw new Error(`${source}: ${field} must be an array of strings.`);
	}
	return value.map((item) => item.trim());
};

function validateExtension(extension: string, source: string): string {
	const value = cleanText(extension, "extension", source);
	const packageSource = /^(?:npm|git|github|https?|ssh):/.test(value);
	const userPath = isAbsolute(value) || value.startsWith("~/") || value.startsWith("~\\") || value.startsWith("file://");
	if (!packageSource && !userPath) {
		throw new Error(`${source}: extensions entries must be absolute paths or package sources.`);
	}
	return value;
}

function extensionList(value: unknown, source: string): string[] {
	return stringList(value, "extensions", source).map((extension) => validateExtension(extension, source));
}

// Built-in Roles resolved from the package-shipped Markdown relative to this module.
const BUILTIN_ROLE_NAMES = ["implementer", "reviewer", "scout"] as const;
export type BuiltinRoleName = (typeof BUILTIN_ROLE_NAMES)[number];

/** Single-file Role parser shared by built-in and user roles. */
function parseRoleFile(file: string, raw: string): Role {
	let parsed: ReturnType<typeof parseFrontmatter>;
	try {
		parsed = parseFrontmatter(raw);
	} catch (error) {
		throw new Error(`${file}: ${error instanceof Error ? error.message : String(error)}`);
	}
	const frontmatter = parsed.frontmatter;
	const isolation = frontmatter.isolation === undefined ? undefined : cleanText(frontmatter.isolation, "isolation", file);
	if (isolation !== undefined && isolation !== "worktree") throw new Error(`${file}: isolation must be "worktree".`);
	return {
		name: cleanText(frontmatter.name, "name", file),
		description: cleanText(frontmatter.description, "description", file),
		tools: stringList(frontmatter.tools, "tools", file),
		isolation,
		extensions: extensionList(frontmatter.extensions, file),
		skills: stringList(frontmatter.skills, "skills", file),
		systemPrompt: cleanText(parsed.body, "system prompt", file),
	};
}

function readRoleFile(file: string): Role {
	try {
		return parseRoleFile(file, readFileSync(file, "utf8"));
	} catch (error) {
		if (error instanceof Error && error.message.startsWith(`${file}: `)) throw error;
		throw new Error(`${file}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

export function loadBuiltinRole(name: BuiltinRoleName): Role {
	return readRoleFile(fileURLToPath(new URL(`../examples/roles/${name}.md`, import.meta.url)));
}

function builtinRoles(): Role[] {
	return BUILTIN_ROLE_NAMES.map(loadBuiltinRole);
}

/**
 * Validated package-shipped Roles plus valid user roles from `config/pi-subagent`.
 * A user role with a built-in name overrides the default; duplicate names among
 * user files are an error. Missing user directory returns the built-ins.
 */
export function loadRoles(agentDir = getAgentDir()): Role[] {
	const byName = new Map(builtinRoles().map((role) => [role.name, role]));
	const dir = extensionConfigDir("pi-subagent", agentDir);
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch (error: unknown) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [...byName.values()];
		throw error;
	}

	const userRoles = entries
		.filter((entry) => entry.name.endsWith(".md") && (entry.isFile() || entry.isSymbolicLink()))
		.sort((a, b) => a.name.localeCompare(b.name))
		.map((entry) => readRoleFile(join(dir, entry.name)));

	const names = new Set<string>();
	for (const role of userRoles) {
		if (names.has(role.name)) throw new Error(`Duplicate Subagent role: ${role.name}.`);
		names.add(role.name);
		byName.set(role.name, role);
	}
	return [...byName.values()];
}

export function resolveTaskRoute(
	ctx: ExtensionContext,
	profileName: ProfileName,
	agentDir = getAgentDir(),
): ResolvedTaskRoute {
	let config;
	try {
		config = loadTaskModelsConfig(agentDir).value;
	} catch {
		throw new Error("Couldn't read task model config. Run /task-models.");
	}
	return resolveConfiguredRoute(ctx, profileName, config.profiles[profileName], agentDir);
}

function resolveConfiguredRoute(
	ctx: ExtensionContext,
	profileName: ProfileName,
	profile: ReturnType<typeof loadTaskModelsConfig>["value"]["profiles"][ProfileName],
	agentDir = getAgentDir(),
): ResolvedTaskRoute {
	if (!profile) throw new Error(`No ${profileName} task model profile is configured. Run /task-models.`);
	for (const route of orderedProfileRoutes(profile)) {
		const resolved = resolveTaskModelRoute(ctx, route, agentDir);
		if (resolved) return resolved;
	}
	throw new Error(`No usable ${profileName} task model route. Run /task-models.`);
}

export function resolveRoleSkills(pi: Pick<ExtensionAPI, "getCommands">, role: Role): ResolvedRoleSkills {
	const skills = new Map(pi.getCommands()
		.filter((command) => command.source === "skill")
		.map((command) => [command.name, command.sourceInfo.path]));
	const paths: string[] = [];
	const missing: string[] = [];
	for (const name of role.skills) {
		const path = skills.get(`skill:${name}`);
		if (path) paths.push(path);
		else missing.push(name);
	}
	return { paths, missing };
}

export function createRoleLaunch(
	pi: Pick<ExtensionAPI, "getCommands">,
	ctx: Pick<ExtensionContext, "isProjectTrusted">,
	input: CreateRoleLaunchInput,
): ResolvedRoleLaunch {
	const role = input.role;
	const skills = resolveRoleSkills(pi, role);
	const tools = [...new Set([...role.tools, ...(input.tools ?? [])].map((tool) => cleanText(tool, "tool", `Role ${role.name}`)))];
	const extensions = [
		...role.extensions,
		...(input.extensions ?? []),
		...(CODEX_ALIAS.test(input.route.model.provider) ? [MULTI_CODEX_EXTENSION] : []),
		ROLE_TOOLS_EXTENSION,
	].map((extension) => validateExtension(extension, `Role ${role.name}`));
	const env = Object.fromEntries(Object.entries(input.env ?? {}).map(([key, value]) => {
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Invalid launch environment name: ${key}`);
		if (typeof value !== "string" || value.includes("\0")) throw new Error(`Invalid launch environment value: ${key}`);
		return [key, value];
	}));
	const args = ["--no-session", "--no-extensions", "--no-skills", "--exclude-tools", CHILD_EXCLUDED_TOOLS];
	for (const extension of new Set(extensions)) args.push("--extension", extension);
	for (const skill of skills.paths) args.push("--skill", skill);
	args.push(`--${ROLE_TOOL_POLICY_FLAG}`, JSON.stringify(tools));
	args.push("--model", modelReference(input.route.model));
	if (input.route.thinkingLevel) args.push("--thinking", input.route.thinkingLevel);
	args.push(ctx.isProjectTrusted() ? "--approve" : "--no-approve");
	args.push("--append-system-prompt", `${CHILD_IDENTITY_POLICY}\n\n${cleanText(role.systemPrompt, "system prompt", `Role ${role.name}`)}`);
	return {
		env,
		args,
		model: input.route.model,
		thinkingLevel: input.route.thinkingLevel,
		missingSkills: skills.missing,
	};
}

export function resolveRoleLaunch(
	pi: Pick<ExtensionAPI, "getCommands">,
	ctx: ExtensionContext,
	input: ResolveRoleLaunchInput,
): ResolvedRoleLaunch {
	return createRoleLaunch(pi, ctx, {
		...input,
		route: resolveConfiguredTaskRoute(ctx, input.task, input.agentDir),
	});
}
