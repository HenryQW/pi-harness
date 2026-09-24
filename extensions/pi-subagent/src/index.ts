import { readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	DefaultPackageManager,
	getAgentDir,
	parseFrontmatter,
	SettingsManager,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { extensionConfigDir } from "@henryqw/pi-config-store";
import { hasDisplayControlCharacters } from "./display-text.ts";
import { selectRoleMcpConfig } from "./mcp-role.ts";
import {
	loadTaskModelsConfig,
	modelReference,
	orderedProfileRoutes,
	PROFILE_NAMES,
	resolveConfiguredTaskRoute,
	resolveTaskModelRoute,
	type AvailableModel,
	type ModelTask,
	type ProfileName,
	type ResolvedTaskRoute,
	type ThinkingLevel,
} from "@henryqw/pi-task-models";

export { DISPLAY_TEXT_CONTRACT, hasDisplayControlCharacters } from "./display-text.ts";
export { parseRoleMcpAllowlist, roleMcpFlagValue, selectRoleMcpConfig, type RoleMcpConfig } from "./mcp-role.ts";
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
	type EphemeralSubagentExecutionBudget,
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
export {
	captureWorkingCheckoutBaseline,
	captureWorkingCheckoutState,
	prepareWorkingChangeEvidence,
	sameWorkingCheckoutState,
	sameWorkingSnapshot,
	type PreparedWorkingChangeEvidence,
	type WorkingCheckoutBaseline,
	type WorkingCheckoutState,
	type WorkingSnapshotIdentity,
} from "./working-evidence.ts";

const CODEX_ALIAS = /^openai-codex-(?:[2-9]|[1-9]\d+)$/;
const MULTI_CODEX_EXTENSION = fileURLToPath(import.meta.resolve("@henryqw/pi-multi-codex/extensions/multi-codex.ts"));
const ROLE_MCP_EXTENSION = fileURLToPath(new URL("../extensions/role-mcp.ts", import.meta.url));
const ROLE_TOOLS_EXTENSION = fileURLToPath(new URL("../extensions/role-tools.ts", import.meta.url));
export const PI_SUBAGENT_PROCESS_LEASE = "PI_SUBAGENT_PROCESS_LEASE";
export const ROLE_MCP_POLICY_FLAG = "pi-subagent-role-mcps";
export const ROLE_TOOL_POLICY_FLAG = "pi-subagent-role-tools";
export const CHILD_EXCLUDED_TOOL_NAMES = [
	"delegate_task",
	"ask_question",
	"subagent_status",
	"subagent_resume",
	"subagent_stage",
	"subagent_abort",
] as const;
export const CHILD_EXCLUDED_TOOLS = CHILD_EXCLUDED_TOOL_NAMES.join(",");
const SYSTEM_PROMPT_FLAG = "--append-system-prompt";
const CHILD_IDENTITY_POLICY = "You are a delegated Pi Subagent, not Main. Execute the assigned Role and task directly. Main-only delegation rules do not apply. Recursive delegation is unavailable; do not seek or invoke delegation tools.";

export const DELEGATE_TASK = {
	id: "pi-subagent/delegateTask",
	label: "Subagent delegation",
	purpose: "Launch direct or checked isolated Pi delegation.",
	defaultProfile: "fast",
} as const satisfies ModelTask;

export type RoleName = string;

export interface Role {
	name: RoleName;
	description: string;
	modelClass?: ProfileName;
	tools: string[];
	extensions: string[];
	skills: string[];
	mcps?: string[];
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

export interface PreparedRoleLaunch extends ResolvedRoleLaunch {
	role: RoleName;
	tools: readonly string[];
	systemPrompt: string;
	promptArgIndex: number;
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
	modelClass?: ProfileName;
	agentDir?: string;
}

export interface ResolveConfiguredRoleLaunchInput {
	role: string;
	modelClass: ProfileName;
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

const cleanDisplayText = (value: unknown, field: string, source: string): string => {
	if (typeof value === "string" && hasDisplayControlCharacters(value)) {
		throw new Error(`${source}: ${field} must not contain C0/C1 control characters.`);
	}
	return cleanText(value, field, source);
};

/** Normalize one arbitrary Role name using the Role configuration contract. */
export function parseRoleName(value: unknown, source = "Role"): RoleName {
	return cleanDisplayText(value, "name", source);
}

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

function mcpList(value: unknown, source: string): string[] {
	const names = stringList(value ?? [], "mcps", source);
	if (new Set(names).size !== names.length) throw new Error(`${source}: mcps contains duplicate MCP server names.`);
	return names;
}

function roleToolPolicy(role: Role, additionalTools: readonly string[] = []): string[] {
	return [...new Set([...role.tools, ...additionalTools].map((tool) => cleanText(tool, "tool", `Role ${role.name}`)))];
}

function namesMcpAdapter(extension: string): boolean {
	return extension.toLowerCase().split(/[\\/:@]+/).some((component) => component === "pi-mcp-adapter" || component.startsWith("pi-mcp-adapter."));
}

const FORBIDDEN_ROLE_PACKAGE_SOURCE_NAMES = ["pi-subagent", "pi-mcp-adapter"] as const;

function rejectForbiddenRolePackageSource(value: string, role: Role): void {
	const components = value.toLowerCase().split(/[\\/:@]+/);
	if (FORBIDDEN_ROLE_PACKAGE_SOURCE_NAMES.some((name) => components.some((component) => component === name || component.startsWith(`${name}.`)))) {
		throw new Error(`Role ${role.name} extension explicitly names the forbidden ${FORBIDDEN_ROLE_PACKAGE_SOURCE_NAMES.join("/")} source: ${value}`);
	}
}

function roleModelClass(value: unknown, source: string): ProfileName | undefined {
	if (value === undefined) return;
	if (typeof value !== "string" || !(PROFILE_NAMES as readonly string[]).includes(value)) {
		throw new Error(`${source}: modelClass must be one of ${PROFILE_NAMES.join(", ")}.`);
	}
	return value as ProfileName;
}

function rejectRetiredRoleIsolation(value: unknown, source: string): void {
	if (value === undefined) return;
	throw new Error(`${source}: Role isolation is retired; select mode \"isolated\" on delegate_task instead.`);
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
	rejectRetiredRoleIsolation(frontmatter.isolation, file);
	const modelClass = roleModelClass(frontmatter.modelClass, file);
	return {
		name: parseRoleName(frontmatter.name, file),
		description: cleanDisplayText(frontmatter.description, "description", file),
		...(modelClass === undefined ? {} : { modelClass }),
		tools: stringList(frontmatter.tools, "tools", file),
		extensions: extensionList(frontmatter.extensions, file),
		skills: stringList(frontmatter.skills, "skills", file),
		mcps: mcpList(frontmatter.mcps, file),
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
	return resolveConfiguredRoute(ctx, profileName, config.profiles[profileName]);
}

function resolveConfiguredRoute(
	ctx: ExtensionContext,
	profileName: ProfileName,
	profile: ReturnType<typeof loadTaskModelsConfig>["value"]["profiles"][ProfileName],
): ResolvedTaskRoute {
	if (!profile) throw new Error(`No ${profileName} task model profile is configured. Run /task-models.`);
	for (const route of orderedProfileRoutes(profile)) {
		const resolved = resolveTaskModelRoute(ctx, route);
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

function packageManager(ctx: Pick<ExtensionContext, "cwd" | "isProjectTrusted">): DefaultPackageManager {
	const agentDir = getAgentDir();
	const settingsManager = SettingsManager.create(ctx.cwd, agentDir, { projectTrusted: ctx.isProjectTrusted() });
	return new DefaultPackageManager({ cwd: ctx.cwd, agentDir, settingsManager });
}

/** Resolve all enabled package resources selected by one Role's extension sources. */
export async function resolveRolePackageResources(
	role: Role,
	ctx: Pick<ExtensionContext, "cwd" | "isProjectTrusted">,
): Promise<{ extensions: string[]; skills: string[]; prompts: string[]; themes: string[] }> {
	const sources = role.extensions;
	for (const source of sources) rejectForbiddenRolePackageSource(source, role);
	if (!sources.length) return { extensions: [], skills: [], prompts: [], themes: [] };
	const resolved = await packageManager(ctx).resolveExtensionSources([...sources]);
	const resourceGroups = [resolved.extensions, resolved.skills, resolved.prompts, resolved.themes]
		.map((resources) => resources.filter((resource) => resource.enabled));
	const resolvedSources = new Set(resourceGroups.flat().map((resource) => resource.metadata.source));
	const missing = sources.filter((source) => !resolvedSources.has(source));
	if (missing.length) throw new Error(`Role extension sources resolved no resources: ${missing.join(", ")}.`);
	return {
		extensions: resourceGroups[0]!.map((resource) => resource.path),
		skills: resourceGroups[1]!.map((resource) => resource.path),
		prompts: resourceGroups[2]!.map((resource) => resource.path),
		themes: resourceGroups[3]!.map((resource) => resource.path),
	};
}

export function createRoleLaunch(
	pi: Pick<ExtensionAPI, "getCommands">,
	ctx: Pick<ExtensionContext, "isProjectTrusted">,
	input: CreateRoleLaunchInput,
): ResolvedRoleLaunch {
	return createRoleLaunchFromSkills(ctx, input, resolveRoleSkills(pi, input.role));
}

function createRoleLaunchFromSkills(
	ctx: Pick<ExtensionContext, "isProjectTrusted">,
	input: CreateRoleLaunchInput,
	skills: ResolvedRoleSkills,
): ResolvedRoleLaunch {
	const role = input.role;
	const mcps = mcpList(role.mcps, `Role ${role.name}`);
	const tools = roleToolPolicy(role, input.tools);
	const selectedExtensions = [...role.extensions, ...(input.extensions ?? [])]
		.map((extension) => validateExtension(extension, `Role ${role.name}`));
	if (selectedExtensions.some(namesMcpAdapter)) {
		throw new Error(`Role ${role.name} must select MCP servers with mcps instead of loading pi-mcp-adapter directly.`);
	}
	const extensions = [
		...selectedExtensions,
		...(CODEX_ALIAS.test(input.route.model.provider) ? [MULTI_CODEX_EXTENSION] : []),
		...(mcps.length ? [ROLE_MCP_EXTENSION] : []),
		ROLE_TOOLS_EXTENSION,
	];
	const env = Object.fromEntries(Object.entries(input.env ?? {}).map(([key, value]) => {
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Invalid launch environment name: ${key}`);
		if (typeof value !== "string" || value.includes("\0")) throw new Error(`Invalid launch environment value: ${key}`);
		return [key, value];
	}));
	const args = ["--no-session", "--no-extensions", "--no-skills", "--exclude-tools", CHILD_EXCLUDED_TOOLS];
	if (mcps.length) args.push(`--${ROLE_MCP_POLICY_FLAG}`, JSON.stringify(mcps));
	for (const extension of new Set(extensions)) args.push("--extension", extension);
	for (const skill of skills.paths) args.push("--skill", skill);
	args.push(`--${ROLE_TOOL_POLICY_FLAG}`, JSON.stringify(tools));
	args.push("--model", modelReference(input.route.model));
	if (input.route.thinkingLevel) args.push("--thinking", input.route.thinkingLevel);
	args.push(ctx.isProjectTrusted() ? "--approve" : "--no-approve");
	args.push(SYSTEM_PROMPT_FLAG, `${CHILD_IDENTITY_POLICY}\n\n${cleanText(role.systemPrompt, "system prompt", `Role ${role.name}`)}`);
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
	const { task, modelClass, agentDir, ...launchInput } = input;
	const selectedClass = modelClass ?? input.role.modelClass;
	return createRoleLaunch(pi, ctx, {
		...launchInput,
		route: selectedClass === undefined
			? resolveConfiguredTaskRoute(ctx, task, agentDir)
			: resolveTaskRoute(ctx, selectedClass, agentDir),
	});
}

function stripRoleSystemPrompt(rawArgs: readonly string[]): {
	args: string[];
	systemPrompt: string;
	promptArgIndex: number;
} {
	const indexes = rawArgs.flatMap((arg, index) => arg === SYSTEM_PROMPT_FLAG ? [index] : []);
	if (indexes.length !== 1) throw new Error(`Role launch must contain exactly one ${SYSTEM_PROMPT_FLAG} pair.`);
	const promptArgIndex = indexes[0]!;
	const systemPrompt = rawArgs[promptArgIndex + 1];
	if (typeof systemPrompt !== "string" || !systemPrompt.includes("\n") || !systemPrompt.trim() || systemPrompt.includes("\0")) {
		throw new Error(`Role ${SYSTEM_PROMPT_FLAG} value must be the exact multiline Role prompt.`);
	}
	const args = [...rawArgs.slice(0, promptArgIndex), ...rawArgs.slice(promptArgIndex + 2)];
	if (args.includes(SYSTEM_PROMPT_FLAG) || args.includes(systemPrompt)) {
		throw new Error("Sanitized Role argv must contain no prompt flag or raw Role prompt.");
	}
	return { args, systemPrompt, promptArgIndex };
}

function prepareResolvedRoleLaunch(
	roleDefinition: Role,
	launch: ResolvedRoleLaunch,
	additionalTools: readonly string[] = [],
): PreparedRoleLaunch {
	const role = parseRoleName(roleDefinition.name);
	rejectRetiredRoleIsolation((roleDefinition as Role & { isolation?: unknown }).isolation, `Role ${role}`);
	const tools = Object.freeze(roleToolPolicy(roleDefinition, additionalTools));
	const { args, systemPrompt, promptArgIndex } = stripRoleSystemPrompt(launch.args);
	return { ...launch, args, role, tools, systemPrompt, promptArgIndex };
}

function assertNoMissingRoleSkills(role: Role, launch: ResolvedRoleLaunch): void {
	if (!launch.missingSkills.length) return;
	throw new Error(`Role ${parseRoleName(role.name)} requires missing Skills: ${launch.missingSkills.join(", ")}.`);
}

/** Prepare a resolved or resolvable Role launch while keeping its system prompt out of argv. */
export function prepareRoleLaunch(
	pi: Pick<ExtensionAPI, "getCommands">,
	ctx: ExtensionContext,
	input: ResolveRoleLaunchInput,
): PreparedRoleLaunch;
export function prepareRoleLaunch(
	pi: Pick<ExtensionAPI, "getCommands">,
	ctx: ExtensionContext,
	input: CreateRoleLaunchInput,
): PreparedRoleLaunch;
export function prepareRoleLaunch(
	pi: Pick<ExtensionAPI, "getCommands">,
	ctx: ExtensionContext,
	input: ResolveRoleLaunchInput | CreateRoleLaunchInput,
): PreparedRoleLaunch {
	const launch = "route" in input
		? createRoleLaunch(pi, ctx, input)
		: resolveRoleLaunch(pi, ctx, input);
	assertNoMissingRoleSkills(input.role, launch);
	return prepareResolvedRoleLaunch(input.role, launch, input.tools);
}

/** Resolve and prepare a configured Role with its package-owned resources. */
export async function resolveConfiguredRoleLaunch(
	pi: Pick<ExtensionAPI, "getCommands">,
	ctx: ExtensionContext,
	input: ResolveConfiguredRoleLaunchInput,
): Promise<PreparedRoleLaunch> {
	const roleName = parseRoleName(input.role);
	if (input.modelClass === undefined) throw new Error("Configured Role launch requires an explicit modelClass.");
	const matches = loadRoles().filter((role) => role.name === roleName);
	if (matches.length !== 1) throw new Error(`Required configured Role ${roleName} is missing or ambiguous.`);
	const role = matches[0]!;
	if (role.mcps?.length) {
		const { loadMcpConfig } = await import("pi-mcp-adapter/config");
		selectRoleMcpConfig(loadMcpConfig(join(getAgentDir(), "mcp.json"), ctx.cwd), role.mcps);
	}
	const resources = await resolveRolePackageResources(role, ctx);
	const effectiveRole: Role = { ...role, extensions: resources.extensions };
	const namedSkills = resolveRoleSkills(pi, effectiveRole);
	const skills: ResolvedRoleSkills = {
		...namedSkills,
		paths: [...new Set([...namedSkills.paths, ...resources.skills])],
	};
	const launch = createRoleLaunchFromSkills(ctx, {
		role: effectiveRole,
		route: resolveTaskRoute(ctx, input.modelClass),
	}, skills);
	assertNoMissingRoleSkills(effectiveRole, launch);
	const additions = [
		"--no-prompt-templates",
		"--no-themes",
		...resources.prompts.flatMap((path) => ["--prompt-template", path]),
		...resources.themes.flatMap((path) => ["--theme", path]),
	];
	const promptArgIndex = launch.args.indexOf(SYSTEM_PROMPT_FLAG);
	if (promptArgIndex < 0) throw new Error(`Resolved Role launch has no ${SYSTEM_PROMPT_FLAG}.`);
	const args = [...launch.args];
	args.splice(promptArgIndex, 0, ...additions);
	return prepareResolvedRoleLaunch(effectiveRole, { ...launch, args });
}

/** Restore the system prompt pair after a caller has prepared its launch argv. */
export function finalizeRoleLaunch(prepared: PreparedRoleLaunch): ResolvedRoleLaunch {
	if (prepared.args.includes(SYSTEM_PROMPT_FLAG)) {
		throw new Error(`Prepared Role launch already contains ${SYSTEM_PROMPT_FLAG}.`);
	}
	if (!Number.isSafeInteger(prepared.promptArgIndex)
		|| prepared.promptArgIndex < 0 || prepared.promptArgIndex > prepared.args.length) {
		throw new Error("Prepared Role launch has an invalid system prompt insertion index.");
	}
	if (typeof prepared.systemPrompt !== "string" || !prepared.systemPrompt.trim() || prepared.systemPrompt.includes("\0")) {
		throw new Error("Prepared Role launch has an invalid system prompt.");
	}
	const args = [...prepared.args];
	args.splice(prepared.promptArgIndex, 0, SYSTEM_PROMPT_FLAG, prepared.systemPrompt);
	return {
		env: prepared.env,
		args,
		model: prepared.model,
		thinkingLevel: prepared.thinkingLevel,
		missingSkills: prepared.missingSkills,
	};
}

export * from "./composition.ts";
export * from "./git-runtime.ts";
export * from "./herdr-runtime.ts";
export { ISOLATED_MODEL_TASK, RoleLaunchRuntime, type LaunchRuntimeOptions } from "./launch-runtime.ts";
export * from "./runner.ts";
export * from "./schema.ts";
export * from "./store.ts";
