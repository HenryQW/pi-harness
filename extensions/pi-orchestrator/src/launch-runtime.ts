import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdtemp, open, readFile, realpath, rmdir, unlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
	DefaultPackageManager,
	getAgentDir,
	SettingsManager,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	CHILD_EXCLUDED_TOOL_NAMES,
	fingerprintRoleMcpConfig,
	loadRoles,
	ROLE_MCP_CONFIG_SHA256_FLAG,
	ROLE_MCP_POLICY_FLAG,
	resolveRoleLaunch,
	selectRoleMcpConfig,
	type ResolvedRoleLaunch,
	type Role as SubagentRole,
} from "@henryqw/pi-subagent";
import { registerModelTask } from "@henryqw/pi-task-models";
import type {
	CoordinatorRuntime,
	OperationContext,
	TransientLaunchHandle,
	VerifiedLaunch,
} from "./runner.ts";
import {
	launchKey,
	launchRecordFingerprint,
	requiredLaunchKeys,
	validateLaunchRecords,
	type ExecuteRequest,
	type LaunchRecord,
	type LaunchResourceFingerprint,
	type ModelClass,
	type NormalizedLaunchRecord,
	type Role,
	type WorkspaceIdentity,
} from "./schema.ts";

const REVIEWER_TOOLS = ["read", "grep", "find", "ls"] as const;
const CODEX_ALIAS = /^openai-codex-(?:[2-9]|[1-9]\d+)$/;
const PROMPT_FLAG = "--append-system-prompt";
const EXTENSION_FLAG = "--extension";
const SKILL_FLAG = "--skill";
const PROMPT_TEMPLATE_FLAG = "--prompt-template";
const THEME_FLAG = "--theme";
const DIRECTORY_MODE = 0o700;
const PROMPT_MODE = 0o600;
const FORBIDDEN_ROLE_SOURCE_NAMES = ["pi-orchestrator"] as const;

export const ORCHESTRATOR_MODEL_TASK = {
	id: "pi-orchestrator/roleLaunch",
	label: "Orchestrator Role launch",
	purpose: "Resolve one task-scoped orchestrator Role launch.",
	defaultProfile: "balanced",
} as const;

type LaunchPi = Pick<ExtensionAPI, "events" | "getAllTools" | "getCommands">;
type ToolInfo = ReturnType<ExtensionAPI["getAllTools"]>[number];

type KnownLaunchFiles = {
	roleMcp: string;
	roleTools: string;
	multiCodex: string;
	orchestratorEntrypoint: string;
};

type ResolvedSnapshot = {
	record: NormalizedLaunchRecord;
	prompt: string;
};

type ResolvedRoleResources = {
	extensions: string[];
	skills: string[];
	prompts: string[];
	themes: string[];
	mcpResources: string[];
	mcpConfigSha256?: string;
};

export interface LaunchRuntimeOptions {
	pi: LaunchPi;
	context(): ExtensionContext;
	resolveRoot(cwd: string, context: OperationContext): Promise<string>;
	inspectMain(input: { root: string }, context: OperationContext): Promise<WorkspaceIdentity>;
	orchestratorEntrypoint: string;
	agentDir?: string;
	now?: () => number;
	randomToken?: () => string;
}

export interface NormalizeResolvedRoleLaunchInput {
	role: Role;
	modelClass: ModelClass;
	effectiveRole: SubagentRole;
	launch: ResolvedRoleLaunch;
	commands: ReturnType<ExtensionAPI["getCommands"]>;
	tools: readonly ToolInfo[];
	knownFiles: KnownLaunchFiles;
	packageResources?: Omit<ResolvedRoleResources, "extensions">;
	signal?: AbortSignal;
}

function abortIfNeeded(signal?: AbortSignal): void {
	signal?.throwIfAborted();
}

function sha256(value: string | Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

function isMissing(error: unknown): boolean {
	return Boolean(error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT");
}

function isWithin(root: string, candidate: string): boolean {
	const fromRoot = relative(root, candidate);
	return fromRoot === "" || (fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot));
}

function requireUnique(values: readonly string[], label: string): void {
	if (new Set(values).size !== values.length) throw new Error(`${label} contains duplicate or ambiguous entries.`);
}

function rejectForbiddenRoleExtensionSource(value: string, role: Role): void {
	const components = value.toLowerCase().split(/[\\/:@]+/);
	if (FORBIDDEN_ROLE_SOURCE_NAMES.some((name) => components.some((component) => component === name || component.startsWith(`${name}.`)))) {
		throw new Error(`Role ${role} extension explicitly names the forbidden ${FORBIDDEN_ROLE_SOURCE_NAMES.join("/")} source: ${value}`);
	}
}

function packageManager(
	ctx: Pick<ExtensionContext, "cwd" | "isProjectTrusted">,
	agentDir: string,
): DefaultPackageManager {
	const settingsManager = SettingsManager.create(ctx.cwd, agentDir, { projectTrusted: ctx.isProjectTrusted() });
	return new DefaultPackageManager({ cwd: ctx.cwd, agentDir, settingsManager });
}

async function resolveRoleResources(
	sources: readonly string[],
	ctx: Pick<ExtensionContext, "cwd" | "isProjectTrusted">,
	agentDir: string | undefined,
	signal?: AbortSignal,
): Promise<ResolvedRoleResources> {
	abortIfNeeded(signal);
	if (!sources.length) return { extensions: [], skills: [], prompts: [], themes: [], mcpResources: [] };
	const resolved = await packageManager(ctx, agentDir ?? getAgentDir()).resolveExtensionSources([...sources]);
	abortIfNeeded(signal);
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
		mcpResources: [],
	};
}

async function resolveRoleMcpResources(
	allowlist: readonly string[],
	ctx: Pick<ExtensionContext, "cwd" | "isProjectTrusted">,
	agentDir: string | undefined,
	signal?: AbortSignal,
): Promise<Pick<ResolvedRoleResources, "mcpResources" | "mcpConfigSha256">> {
	if (!allowlist.length) return { mcpResources: [] };
	abortIfNeeded(signal);
	const resolvedAgentDir = agentDir ?? getAgentDir();
	const resolved = await packageManager(ctx, resolvedAgentDir).resolveExtensionSources(["npm:pi-mcp-adapter"]);
	const adapters = resolved.extensions.filter((resource) => resource.enabled && resource.metadata.source === "npm:pi-mcp-adapter");
	if (adapters.length !== 1) throw new Error("pi-mcp-adapter must resolve to exactly one enabled extension for an MCP-enabled Role.");
	const adapter = await canonicalRegularFile(adapters[0]!.path, "pi-mcp-adapter extension", signal);
	let configModulePath: string;
	try {
		configModulePath = createRequire(adapter).resolve("pi-mcp-adapter/config");
	} catch (error) {
		throw new Error("pi-mcp-adapter/config could not be resolved.", { cause: error });
	}
	const configModule = await canonicalRegularFile(configModulePath, "pi-mcp-adapter config module", signal);
	const imported = await import(pathToFileURL(configModule).href) as {
		loadMcpConfig?: (overridePath?: string, cwd?: string) => { mcpServers: Record<string, unknown>; settings?: Record<string, unknown> };
	};
	if (typeof imported.loadMcpConfig !== "function") throw new Error("pi-mcp-adapter/config does not export loadMcpConfig.");
	const config = selectRoleMcpConfig(imported.loadMcpConfig(join(resolvedAgentDir, "mcp.json"), ctx.cwd), allowlist);
	return {
		mcpResources: [adapter, configModule],
		mcpConfigSha256: fingerprintRoleMcpConfig(config),
	};
}

async function canonicalRegularFile(path: string, label: string, signal?: AbortSignal): Promise<string> {
	abortIfNeeded(signal);
	if (typeof path !== "string" || !path || path.includes("\0") || !isAbsolute(path)) {
		throw new Error(`${label} must name an absolute local file.`);
	}
	let info;
	try {
		info = await lstat(path);
	} catch (error) {
		if (isMissing(error)) throw new Error(`${label} is missing: ${path}`);
		throw new Error(`${label} cannot be inspected: ${path}`, { cause: error });
	}
	abortIfNeeded(signal);
	if (info.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link: ${path}`);
	if (!info.isFile()) throw new Error(`${label} must be an existing local regular file: ${path}`);
	let canonical: string;
	try {
		canonical = normalize(await realpath(path));
	} catch (error) {
		throw new Error(`${label} cannot be canonicalized: ${path}`, { cause: error });
	}
	abortIfNeeded(signal);
	const canonicalInfo = await lstat(canonical);
	if (canonicalInfo.isSymbolicLink() || !canonicalInfo.isFile()) {
		throw new Error(`${label} canonical target is not a local regular file: ${canonical}`);
	}
	return canonical;
}

function valuesAfter(args: readonly string[], flag: string): string[] {
	const values: string[] = [];
	for (let index = 0; index < args.length; index += 1) {
		if (args[index] !== flag) continue;
		if (index + 1 >= args.length) throw new Error(`Resolved Role argv has ${flag} without a value.`);
		values.push(args[index + 1]!);
		index += 1;
	}
	return values;
}

function addPackageResources(launch: ResolvedRoleLaunch, resources: Omit<ResolvedRoleResources, "extensions">): ResolvedRoleLaunch {
	const additions = [
		"--no-prompt-templates",
		"--no-themes",
		...resources.skills.flatMap((path) => [SKILL_FLAG, path]),
		...resources.prompts.flatMap((path) => [PROMPT_TEMPLATE_FLAG, path]),
		...resources.themes.flatMap((path) => [THEME_FLAG, path]),
		...(resources.mcpConfigSha256 ? [`--${ROLE_MCP_CONFIG_SHA256_FLAG}`, resources.mcpConfigSha256] : []),
	];
	const promptIndex = launch.args.indexOf(PROMPT_FLAG);
	if (promptIndex < 0) throw new Error(`Resolved Role launch has no ${PROMPT_FLAG}.`);
	const args = [...launch.args];
	args.splice(promptIndex, 0, ...additions);
	return { ...launch, args };
}

function stripRolePrompt(rawArgs: readonly string[]): { prompt: string; promptArgIndex: number; args: string[] } {
	const indexes = rawArgs.flatMap((arg, index) => arg === PROMPT_FLAG ? [index] : []);
	if (indexes.length !== 1) throw new Error(`Role launch must contain exactly one ${PROMPT_FLAG} pair.`);
	const promptArgIndex = indexes[0]!;
	const prompt = rawArgs[promptArgIndex + 1];
	if (prompt === undefined || !prompt.includes("\n") || !prompt.trim() || prompt.includes("\0")) {
		throw new Error(`Role ${PROMPT_FLAG} value must be the exact multiline Role prompt.`);
	}
	const args = [...rawArgs.slice(0, promptArgIndex), ...rawArgs.slice(promptArgIndex + 2)];
	if (args.includes(PROMPT_FLAG) || args.includes(prompt)) {
		throw new Error("Sanitized Role argv must contain no prompt flag or raw Role prompt.");
	}
	return { prompt, promptArgIndex, args };
}

function roleFingerprint(
	role: SubagentRole,
	canonicalRoleExtensions: readonly string[],
	promptSha256: string,
): string {
	return sha256(JSON.stringify({
		name: role.name,
		description: role.description,
		modelClass: role.modelClass ?? null,
		isolation: role.isolation ?? null,
		tools: [...role.tools],
		extensions: [...canonicalRoleExtensions],
		skills: [...role.skills],
		mcps: [...(role.mcps ?? [])],
		promptSha256,
	}));
}

async function fingerprintFile(path: string, label: string, signal?: AbortSignal): Promise<string> {
	const canonical = await canonicalRegularFile(path, label, signal);
	if (canonical !== path) throw new Error(`${label} path is no longer canonical: ${path}`);
	abortIfNeeded(signal);
	const contents = await readFile(canonical, { signal });
	abortIfNeeded(signal);
	return sha256(contents);
}

function assertExactReviewerRole(role: SubagentRole): void {
	if (role.tools.length !== REVIEWER_TOOLS.length
		|| new Set(role.tools).size !== REVIEWER_TOOLS.length
		|| REVIEWER_TOOLS.some((tool) => !role.tools.includes(tool))) {
		throw new Error(`Effective Reviewer Role must declare only ${REVIEWER_TOOLS.join(", ")}.`);
	}
}

function validateRoleDefinition(role: Role, effectiveRole: SubagentRole): void {
	if (effectiveRole.name !== role) throw new Error(`Effective Role identity drifted from ${role}.`);
	requireUnique(effectiveRole.tools, `Effective ${role} Role tools`);
	requireUnique(effectiveRole.skills, `Effective ${role} Role Skills`);
	requireUnique(effectiveRole.extensions, `Effective ${role} Role extensions`);
	if (role === "implementer") {
		for (const extension of effectiveRole.extensions) rejectForbiddenRoleExtensionSource(extension, role);
	} else {
		assertExactReviewerRole(effectiveRole);
	}
}

function validateSourceInfo(tool: ToolInfo): void {
	const sourceInfo = tool.sourceInfo as unknown;
	if (!sourceInfo || typeof sourceInfo !== "object" || Array.isArray(sourceInfo)) {
		throw new Error(`Tool ${tool.name} has unverifiable sourceInfo.`);
	}
	const source = sourceInfo as Record<string, unknown>;
	if (typeof source.path !== "string" || typeof source.source !== "string" || !source.source
		|| !["user", "project", "temporary"].includes(String(source.scope))
		|| !["package", "top-level"].includes(String(source.origin))) {
		throw new Error(`Tool ${tool.name} has unverifiable sourceInfo.`);
	}
}

async function validateRoleTools(
	role: SubagentRole,
	registry: readonly ToolInfo[],
	canonicalExtensions: readonly string[],
	signal?: AbortSignal,
): Promise<void> {
	const excluded = new Set<string>(CHILD_EXCLUDED_TOOL_NAMES);
	for (const name of role.tools) {
		abortIfNeeded(signal);
		if (excluded.has(name)) throw new Error(`Role ${role.name} tool ${name} is excluded from child launches.`);
		const matches = registry.filter((tool) => tool.name === name);
		if (matches.length === 0) throw new Error(`Role ${role.name} tool ${name} is missing from Main's effective tool registry.`);
		if (matches.length !== 1) throw new Error(`Role ${role.name} tool ${name} is ambiguous in Main's effective tool registry.`);
		const tool = matches[0]!;
		validateSourceInfo(tool);
		if (tool.sourceInfo.source === "builtin") {
			if (tool.sourceInfo.path !== `<builtin:${name}>`
				|| tool.sourceInfo.scope !== "temporary"
				|| tool.sourceInfo.origin !== "top-level") {
				throw new Error(`Built-in tool ${name} has unverifiable sourceInfo.`);
			}
			continue;
		}
		if (["sdk", "inline", "unknown"].includes(tool.sourceInfo.source.toLowerCase())) {
			throw new Error(`Role ${role.name} tool ${name} has forbidden ${tool.sourceInfo.source} provenance.`);
		}
		const sourcePath = await canonicalRegularFile(tool.sourceInfo.path, `Tool ${name} provenance`, signal);
		if (!canonicalExtensions.includes(sourcePath)) {
			throw new Error(`Role ${role.name} tool ${name} comes from an extension not included in that child launch: ${sourcePath}`);
		}
	}
}

async function canonicalizeValues(values: readonly string[], label: string, signal?: AbortSignal): Promise<string[]> {
	const canonical: string[] = [];
	for (const [index, path] of values.entries()) {
		canonical.push(await canonicalRegularFile(path, `${label}[${index}]`, signal));
	}
	requireUnique(canonical, label);
	return canonical;
}

function assertSameValues(actual: readonly string[], expected: readonly string[], label: string): void {
	if (!isDeepStrictEqual(actual, expected)) throw new Error(`${label} does not match the exact pi-subagent resolved launch.`);
}

async function canonicalExpectedSkills(
	role: SubagentRole,
	commands: ReturnType<ExtensionAPI["getCommands"]>,
	signal?: AbortSignal,
): Promise<string[]> {
	const pathsByName = new Map(commands
		.filter((command) => command.source === "skill")
		.map((command) => [command.name, command.sourceInfo.path]));
	const paths = role.skills.map((name) => {
		const path = pathsByName.get(`skill:${name}`);
		if (!path) throw new Error(`Role ${role.name} requires missing Skill ${name}.`);
		return path;
	});
	return await canonicalizeValues(paths, `Role ${role.name} Skill paths`, signal);
}

function expectedResolvedExtensions(role: SubagentRole, launch: ResolvedRoleLaunch, known: KnownLaunchFiles): string[] {
	return [
		...role.extensions,
		...(CODEX_ALIAS.test(launch.model.provider) ? [known.multiCodex] : []),
		...((role.mcps ?? []).length ? [known.roleMcp] : []),
		known.roleTools,
	];
}

async function normalizedResolvedRoleLaunch(
	input: NormalizeResolvedRoleLaunchInput,
): Promise<ResolvedSnapshot> {
	const {
		role, modelClass, effectiveRole, launch, commands, tools, knownFiles, signal,
		packageResources = { skills: [], prompts: [], themes: [], mcpResources: [] },
	} = input;
	validateRoleDefinition(role, effectiveRole);
	if (launch.missingSkills.length) {
		throw new Error(`Role ${role} requires missing Skills: ${launch.missingSkills.join(", ")}.`);
	}
	if (Object.keys(launch.env).length) throw new Error(`Resolved ${role} launch environment must be empty.`);
	const expectedMcps = effectiveRole.mcps ?? [];
	const expectedMcpPolicy = expectedMcps.length ? [JSON.stringify(expectedMcps)] : [];
	if (!isDeepStrictEqual(valuesAfter(launch.args, `--${ROLE_MCP_POLICY_FLAG}`), expectedMcpPolicy)) {
		throw new Error(`Resolved ${role} launch MCP allowlist does not match its Role policy.`);
	}
	const expectedMcpConfig = packageResources.mcpConfigSha256 ? [packageResources.mcpConfigSha256] : [];
	if (!isDeepStrictEqual(valuesAfter(launch.args, `--${ROLE_MCP_CONFIG_SHA256_FLAG}`), expectedMcpConfig)) {
		throw new Error(`Resolved ${role} launch MCP config fingerprint does not match its Role policy.`);
	}

	const resolvedExtensions = await canonicalizeValues(
		valuesAfter(launch.args, EXTENSION_FLAG),
		`Resolved ${role}/${modelClass} extensions`,
		signal,
	);
	const expectedExtensions = await canonicalizeValues(
		expectedResolvedExtensions(effectiveRole, launch, knownFiles),
		`Expected ${role}/${modelClass} extensions`,
		signal,
	);
	assertSameValues(resolvedExtensions, expectedExtensions, `Resolved ${role}/${modelClass} extensions`);
	for (const source of resolvedExtensions) {
		if (source === knownFiles.orchestratorEntrypoint
			|| source.split(sep).some((component) => FORBIDDEN_ROLE_SOURCE_NAMES.includes(component as typeof FORBIDDEN_ROLE_SOURCE_NAMES[number]))) {
			throw new Error(`Resolved ${role}/${modelClass} extension is a forbidden self source: ${source}`);
		}
	}
	if (role === "reviewer") {
		const allowed = CODEX_ALIAS.test(launch.model.provider)
			? [knownFiles.multiCodex, knownFiles.roleTools]
			: [knownFiles.roleTools];
		assertSameValues(resolvedExtensions, allowed, "Reviewer resolved extensions");
	}

	const resolvedSkills = await canonicalizeValues(
		valuesAfter(launch.args, SKILL_FLAG),
		`Resolved ${role}/${modelClass} Skill paths`,
		signal,
	);
	const expectedSkills = await canonicalizeValues([
		...await canonicalExpectedSkills(effectiveRole, commands, signal),
		...packageResources.skills,
	], `Expected ${role}/${modelClass} Skill paths`, signal);
	assertSameValues(resolvedSkills, expectedSkills, `Resolved ${role}/${modelClass} Skills`);
	const resolvedPrompts = await canonicalizeValues(
		valuesAfter(launch.args, PROMPT_TEMPLATE_FLAG),
		`Resolved ${role}/${modelClass} prompt paths`,
		signal,
	);
	const expectedPrompts = await canonicalizeValues(packageResources.prompts, `Expected ${role}/${modelClass} prompt paths`, signal);
	assertSameValues(resolvedPrompts, expectedPrompts, `Resolved ${role}/${modelClass} prompts`);
	const resolvedThemes = await canonicalizeValues(
		valuesAfter(launch.args, THEME_FLAG),
		`Resolved ${role}/${modelClass} theme paths`,
		signal,
	);
	const expectedThemes = await canonicalizeValues(packageResources.themes, `Expected ${role}/${modelClass} theme paths`, signal);
	assertSameValues(resolvedThemes, expectedThemes, `Resolved ${role}/${modelClass} themes`);
	const mcpResources = await canonicalizeValues(packageResources.mcpResources, `Expected ${role}/${modelClass} MCP resources`, signal);
	const allResourcePaths = [...resolvedExtensions, ...resolvedSkills, ...resolvedPrompts, ...resolvedThemes, ...mcpResources];
	requireUnique(allResourcePaths, `Resolved ${role}/${modelClass} resources`);
	await validateRoleTools(effectiveRole, tools, resolvedExtensions, signal);

	const resources: LaunchResourceFingerprint[] = [];
	for (const path of resolvedExtensions) {
		resources.push({ kind: "extension", path, sha256: await fingerprintFile(path, "Role extension", signal) });
	}
	for (const path of resolvedSkills) {
		resources.push({ kind: "skill", path, sha256: await fingerprintFile(path, "Role Skill", signal) });
	}
	for (const path of resolvedPrompts) {
		resources.push({ kind: "prompt", path, sha256: await fingerprintFile(path, "Role prompt", signal) });
	}
	for (const path of resolvedThemes) {
		resources.push({ kind: "theme", path, sha256: await fingerprintFile(path, "Role theme", signal) });
	}
	for (const path of mcpResources) {
		resources.push({ kind: "mcp-adapter", path, sha256: await fingerprintFile(path, "Role MCP adapter", signal) });
	}

	const stripped = stripRolePrompt(launch.args);
	const promptSha256 = sha256(stripped.prompt);
	const value: Omit<NormalizedLaunchRecord, "fingerprint"> = {
		key: launchKey(role, modelClass),
		role,
		modelClass,
		roleFingerprint: roleFingerprint(effectiveRole, expectedExtensions.slice(0, effectiveRole.extensions.length), promptSha256),
		promptSha256,
		promptArgIndex: stripped.promptArgIndex,
		model: `${launch.model.provider}/${launch.model.id}`,
		thinkingLevel: launch.thinkingLevel,
		args: stripped.args,
		env: {},
		tools: [...effectiveRole.tools],
		roleExtensions: resolvedExtensions,
		roleSkills: resolvedSkills,
		...(resolvedPrompts.length ? { rolePrompts: resolvedPrompts } : {}),
		...(resolvedThemes.length ? { roleThemes: resolvedThemes } : {}),
		...(expectedMcps.length ? { roleMcps: [...expectedMcps] } : {}),
		...(mcpResources.length ? { roleMcpResources: mcpResources } : {}),
		...(packageResources.mcpConfigSha256 ? { mcpConfigSha256: packageResources.mcpConfigSha256 } : {}),
		resources,
	};
	return {
		record: { ...value, fingerprint: launchRecordFingerprint(value) },
		prompt: stripped.prompt,
	};
}

/** Normalize one pi-subagent result into a durable prompt-free launch snapshot. */
export async function normalizeResolvedRoleLaunch(
	input: NormalizeResolvedRoleLaunchInput,
): Promise<NormalizedLaunchRecord> {
	return (await normalizedResolvedRoleLaunch(input)).record;
}

export function selectRequiredRolesForRequest(roles: readonly SubagentRole[], request: ExecuteRequest): Map<Role, SubagentRole> {
	const required = new Set([...requiredLaunchKeys(request).values()].map(({ role }) => role));
	const selected = new Map<Role, SubagentRole>();
	for (const role of required) {
		const matches = roles.filter((candidate) => candidate.name === role);
		if (matches.length !== 1) throw new Error(`Required effective Role ${role} is missing or ambiguous.`);
		selected.set(role, matches[0]!);
	}
	return selected;
}

async function knownLaunchFiles(orchestratorEntrypoint: string, signal?: AbortSignal): Promise<KnownLaunchFiles> {
	const subagentIndex = fileURLToPath(import.meta.resolve("@henryqw/pi-subagent"));
	const roleMcp = resolve(dirname(subagentIndex), "..", "extensions", "role-mcp.ts");
	const roleTools = resolve(dirname(subagentIndex), "..", "extensions", "role-tools.ts");
	const multiCodex = fileURLToPath(import.meta.resolve("@henryqw/pi-multi-codex/extensions/multi-codex.ts"));
	return {
		roleMcp: await canonicalRegularFile(roleMcp, "pi-subagent Role MCP extension", signal),
		roleTools: await canonicalRegularFile(roleTools, "pi-subagent Role tool-policy extension", signal),
		multiCodex: await canonicalRegularFile(multiCodex, "pi-multi-codex provider adapter", signal),
		orchestratorEntrypoint: await canonicalRegularFile(orchestratorEntrypoint, "pi-orchestrator entrypoint", signal),
	};
}

async function assertRecordResources(record: NormalizedLaunchRecord, signal?: AbortSignal): Promise<void> {
	const { fingerprint, ...fingerprinted } = record;
	if (launchRecordFingerprint(fingerprinted) !== fingerprint) {
		throw new Error(`Launch ${record.key} complete record fingerprint drifted.`);
	}
	const extensions = await canonicalizeValues(valuesAfter(record.args, EXTENSION_FLAG), `Launch ${record.key} argv extensions`, signal);
	const skills = await canonicalizeValues(valuesAfter(record.args, SKILL_FLAG), `Launch ${record.key} argv Skills`, signal);
	const prompts = await canonicalizeValues(valuesAfter(record.args, PROMPT_TEMPLATE_FLAG), `Launch ${record.key} argv prompts`, signal);
	const themes = await canonicalizeValues(valuesAfter(record.args, THEME_FLAG), `Launch ${record.key} argv themes`, signal);
	assertSameValues(extensions, record.roleExtensions, `Launch ${record.key} extension paths`);
	assertSameValues(skills, record.roleSkills, `Launch ${record.key} Skill paths`);
	assertSameValues(prompts, record.rolePrompts ?? [], `Launch ${record.key} prompt paths`);
	assertSameValues(themes, record.roleThemes ?? [], `Launch ${record.key} theme paths`);
	const mcpPolicy = record.roleMcps?.length ? [JSON.stringify(record.roleMcps)] : [];
	if (!isDeepStrictEqual(valuesAfter(record.args, `--${ROLE_MCP_POLICY_FLAG}`), mcpPolicy)) {
		throw new Error(`Launch ${record.key} MCP allowlist drifted.`);
	}
	const mcpConfig = record.mcpConfigSha256 ? [record.mcpConfigSha256] : [];
	if (!isDeepStrictEqual(valuesAfter(record.args, `--${ROLE_MCP_CONFIG_SHA256_FLAG}`), mcpConfig)) {
		throw new Error(`Launch ${record.key} MCP config fingerprint drifted.`);
	}
	const expected = [
		...record.roleExtensions.map((path) => ({ kind: "extension" as const, path })),
		...record.roleSkills.map((path) => ({ kind: "skill" as const, path })),
		...(record.rolePrompts ?? []).map((path) => ({ kind: "prompt" as const, path })),
		...(record.roleThemes ?? []).map((path) => ({ kind: "theme" as const, path })),
		...(record.roleMcpResources ?? []).map((path) => ({ kind: "mcp-adapter" as const, path })),
	];
	if (record.resources.length !== expected.length) throw new Error(`Launch ${record.key} resource list drifted.`);
	for (const [index, selected] of expected.entries()) {
		const resource = record.resources[index];
		if (!resource || resource.kind !== selected.kind || resource.path !== selected.path) {
			throw new Error(`Launch ${record.key} resource order or identity drifted.`);
		}
		const actual = await fingerprintFile(resource.path, `Launch ${record.key} ${resource.kind}`, signal);
		if (actual !== resource.sha256) throw new Error(`Launch ${record.key} ${resource.kind} fingerprint drifted: ${resource.path}`);
	}
	if (record.args.includes(PROMPT_FLAG) || record.promptArgIndex > record.args.length) {
		throw new Error(`Launch ${record.key} durable argv contains invalid prompt transport metadata.`);
	}
}

async function removeTransientLaunch(
	directory: string,
	promptPath: string,
	promptRequired: boolean,
): Promise<void> {
	const failures: unknown[] = [];
	try {
		await unlink(promptPath);
	} catch (error) {
		if (promptRequired || !isMissing(error)) {
			failures.push(new Error(`Could not remove transient Role prompt ${promptPath}.`, { cause: error }));
		}
	}
	try {
		await rmdir(directory);
	} catch (error) {
		failures.push(new Error(`Could not remove transient Role launch directory ${directory}.`, { cause: error }));
	}
	if (failures.length === 1) throw failures[0];
	if (failures.length > 1) throw new AggregateError(failures, "Transient Role launch cleanup was incomplete.");
}

async function materializeTransientLaunch(
	record: NormalizedLaunchRecord,
	prompt: string,
	signal?: AbortSignal,
): Promise<TransientLaunchHandle<VerifiedLaunch>> {
	abortIfNeeded(signal);
	const created = await mkdtemp(join(tmpdir(), "pi-orchestrator-role-"));
	let directory = normalize(created);
	let promptPath = join(directory, "system-prompt");
	let promptCreated = false;
	let file: Awaited<ReturnType<typeof open>> | undefined;
	try {
		directory = normalize(await realpath(created));
		promptPath = join(directory, "system-prompt");
		await chmod(directory, DIRECTORY_MODE);
		const directoryInfo = await lstat(directory);
		if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()
			|| (directoryInfo.mode & 0o7777) !== DIRECTORY_MODE
			|| !isWithin(normalize(await realpath(tmpdir())), directory)) {
			throw new Error("Transient Role launch directory is not unique canonical mode 0700 OS-temp storage.");
		}
		file = await open(
			promptPath,
			constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
			PROMPT_MODE,
		);
		promptCreated = true;
		await file.chmod(PROMPT_MODE);
		abortIfNeeded(signal);
		await file.writeFile(prompt, { encoding: "utf8", signal });
		await file.sync();
		await file.close();
		file = undefined;
		const promptInfo = await lstat(promptPath);
		if (promptInfo.isSymbolicLink() || !promptInfo.isFile()
			|| (promptInfo.mode & 0o7777) !== PROMPT_MODE
			|| normalize(await realpath(promptPath)) !== promptPath) {
			throw new Error("Transient Role prompt is not a canonical mode 0600 regular file.");
		}
		const contents = await readFile(promptPath, { signal });
		abortIfNeeded(signal);
		if (!contents.equals(Buffer.from(prompt, "utf8")) || sha256(contents) !== record.promptSha256) {
			throw new Error(`Transient Role prompt for ${record.key} failed exact verification.`);
		}
		const args = [...record.args];
		args.splice(record.promptArgIndex, 0, PROMPT_FLAG, promptPath);
		const common = {
			key: record.key,
			modelClass: record.modelClass,
			model: record.model,
			thinkingLevel: record.thinkingLevel,
			args: Object.freeze(args),
			env: Object.freeze({ ...record.env }),
			tools: Object.freeze([...record.tools]),
			fingerprint: record.fingerprint,
		};
		const launch: VerifiedLaunch = record.role === "implementer"
			? Object.freeze({ ...common, role: "implementer" as const })
			: Object.freeze({ ...common, role: "reviewer" as const });
		let cleanup: Promise<void> | undefined;
		return Object.freeze({
			launch,
			cleanup: async () => await (cleanup ??= removeTransientLaunch(directory, promptPath, true)),
		});
	} catch (error) {
		const failures: unknown[] = [error];
		if (file) {
			try {
				await file.close();
			} catch (closeError) {
				failures.push(closeError);
			}
		}
		try {
			await removeTransientLaunch(directory, promptPath, promptCreated);
		} catch (cleanupError) {
			failures.push(cleanupError);
		}
		if (failures.length > 1) {
			throw new AggregateError(failures, `Transient Role prompt materialization for ${record.key} failed and cleanup was incomplete.`);
		}
		throw error;
	}
}

export class RoleLaunchRuntime implements CoordinatorRuntime {
	private readonly options: LaunchRuntimeOptions;

	constructor(options: LaunchRuntimeOptions) {
		this.options = options;
		registerModelTask(options.pi, ORCHESTRATOR_MODEL_TASK);
	}

	now(): number {
		return this.options.now?.() ?? Date.now();
	}

	randomToken(): string {
		return this.options.randomToken?.() ?? randomBytes(12).toString("hex");
	}

	private async resolveSnapshot(
		role: Role,
		modelClass: ModelClass,
		context: OperationContext,
		knownFiles?: KnownLaunchFiles,
	): Promise<ResolvedSnapshot> {
		abortIfNeeded(context.signal);
		const matches = loadRoles(this.options.agentDir).filter((candidate) => candidate.name === role);
		if (matches.length !== 1) throw new Error(`Required effective Role ${role} is missing or ambiguous.`);
		const configuredRole = matches[0]!;
		validateRoleDefinition(role, configuredRole);
		const ctx = this.options.context();
		const resources = role === "implementer"
			? {
				...await resolveRoleResources(configuredRole.extensions, ctx, this.options.agentDir, context.signal),
				...await resolveRoleMcpResources(configuredRole.mcps ?? [], ctx, this.options.agentDir, context.signal),
			}
			: { extensions: [], skills: [], prompts: [], themes: [], mcpResources: [] };
		const effectiveRole: SubagentRole = {
			...configuredRole,
			extensions: resources.extensions,
			...(role === "reviewer" ? { skills: [], mcps: [] } : {}),
		};
		const commands = this.options.pi.getCommands();
		const launch = addPackageResources(resolveRoleLaunch({ getCommands: () => commands }, ctx, {
			role: effectiveRole,
			task: ORCHESTRATOR_MODEL_TASK,
			modelClass,
			agentDir: this.options.agentDir,
		}), resources);
		return await normalizedResolvedRoleLaunch({
			role,
			modelClass,
			effectiveRole,
			launch,
			commands,
			tools: this.options.pi.getAllTools(),
			knownFiles: knownFiles ?? await knownLaunchFiles(this.options.orchestratorEntrypoint, context.signal),
			packageResources: resources,
			signal: context.signal,
		});
	}

	private async prepareLaunchRecords(
		request: ExecuteRequest,
		context: OperationContext,
	): Promise<NormalizedLaunchRecord[]> {
		abortIfNeeded(context.signal);
		selectRequiredRolesForRequest(loadRoles(this.options.agentDir), request);
		const knownFiles = await knownLaunchFiles(this.options.orchestratorEntrypoint, context.signal);
		const records: NormalizedLaunchRecord[] = [];
		for (const [key, required] of requiredLaunchKeys(request)) {
			const { record } = await this.resolveSnapshot(required.role, required.modelClass, context, knownFiles);
			if (record.key !== key) throw new Error(`Resolved launch key drifted from ${key}.`);
			records.push(record);
		}
		const normalized = validateLaunchRecords(request, records);
		return [...requiredLaunchKeys(request).keys()].map((key) => normalized[key]!);
	}

	async preflight(input: { request: ExecuteRequest; cwd: string }, context: OperationContext): Promise<{
		root: string;
		main: WorkspaceIdentity;
		launchRecords: LaunchRecord[];
	}> {
		abortIfNeeded(context.signal);
		const resolvedRoot = await this.options.resolveRoot(input.cwd, context);
		if (typeof resolvedRoot !== "string" || !isAbsolute(resolvedRoot) || resolvedRoot.includes("\0")) {
			throw new Error("Pi Orchestrator root resolver must return an absolute canonical path.");
		}
		const root = normalize(await realpath(resolvedRoot));
		if (root !== resolvedRoot) throw new Error("Pi Orchestrator root resolver returned a non-canonical path.");
		const rootInfo = await lstat(root);
		if (!rootInfo.isDirectory()) throw new Error("Pi Orchestrator root must be an existing local directory.");
		abortIfNeeded(context.signal);
		const main = await this.options.inspectMain({ root }, context);
		const launchRecords = await this.prepareLaunchRecords(input.request, context);
		return { root, main, launchRecords };
	}

	async recoverLaunchRecords(
		input: { root: string; request: ExecuteRequest; records: Record<string, NormalizedLaunchRecord> },
		context: OperationContext,
	): Promise<LaunchRecord[]> {
		abortIfNeeded(context.signal);
		if (normalize(await realpath(input.root)) !== input.root) throw new Error("Recorded repository root is no longer canonical.");
		const recorded = validateLaunchRecords(input.request, Object.values(input.records));
		for (const record of Object.values(recorded)) await assertRecordResources(record, context.signal);
		const freshRecords = await this.prepareLaunchRecords(input.request, context);
		const fresh = validateLaunchRecords(input.request, freshRecords);
		if (!isDeepStrictEqual(fresh, recorded)) {
			throw new Error("Recorded Role identity, route, argv, resources, tools, or prompt hash drifted.");
		}
		return freshRecords;
	}

	async acquireLaunch(
		record: NormalizedLaunchRecord,
		context: OperationContext,
	): Promise<TransientLaunchHandle<VerifiedLaunch>> {
		await assertRecordResources(record, context.signal);
		const fresh = await this.resolveSnapshot(record.role, record.modelClass, context);
		if (!isDeepStrictEqual(fresh.record, record)) {
			throw new Error(`Recorded ${record.key} Role identity, route, argv, resources, tools, or prompt hash drifted immediately before launch.`);
		}
		return await materializeTransientLaunch(record, fresh.prompt, context.signal);
	}
}

export function createRoleLaunchRuntime(options: LaunchRuntimeOptions): RoleLaunchRuntime {
	return new RoleLaunchRuntime(options);
}
