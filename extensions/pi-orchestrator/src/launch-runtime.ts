import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { extensionConfigDir } from "@henryqw/pi-config-store";
import {
	CHILD_EXCLUDED_TOOL_NAMES,
	loadRoles,
	resolveRoleLaunch,
	type ResolvedRoleLaunch,
	type Role as SubagentRole,
} from "@henryqw/pi-subagent";
import { registerModelTask } from "@henryqw/pi-task-models";
import type { CoordinatorRuntime, OperationContext } from "./runner.ts";
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
const REQUEST_DIRECTORY_MODE = 0o700;
const PROMPT_MODE = 0o600 as const;
const FORBIDDEN_ROLE_SOURCE_NAMES = ["pi-orchestrator", "pi-auto-dag"] as const;

export const ORCHESTRATOR_MODEL_TASK = {
	id: "pi-orchestrator/roleLaunch",
	label: "Orchestrator Role launch",
	purpose: "Resolve one task-scoped orchestrator Role launch.",
	defaultProfile: "balanced",
} as const;

type LaunchPi = Pick<ExtensionAPI, "events" | "getAllTools" | "getCommands">;
type ToolInfo = ReturnType<ExtensionAPI["getAllTools"]>[number];

type KnownLaunchFiles = {
	roleTools: string;
	multiCodex: string;
	orchestratorEntrypoint: string;
};

export interface LaunchRuntimeOptions {
	pi: LaunchPi;
	context(): ExtensionContext;
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
	promptPath?: string;
	knownFiles: KnownLaunchFiles;
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

function isAlreadyPresent(error: unknown): boolean {
	return Boolean(error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "EEXIST");
}

function isWithin(root: string, candidate: string): boolean {
	const fromRoot = relative(root, candidate);
	return fromRoot === "" || (fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot));
}

function requireUnique(values: readonly string[], label: string): void {
	if (new Set(values).size !== values.length) throw new Error(`${label} contains duplicate or ambiguous entries.`);
}

function rejectRoleExtensionSource(value: string, role: Role): void {
	const components = value.toLowerCase().split(/[\\/:@]+/);
	if (FORBIDDEN_ROLE_SOURCE_NAMES.some((name) => components.some((component) => component === name || component.startsWith(`${name}.`)))) {
		throw new Error(`Role ${role} extension explicitly names a forbidden ${FORBIDDEN_ROLE_SOURCE_NAMES.join("/")} source: ${value}`);
	}
	if (!isAbsolute(value)) {
		throw new Error(`Role ${role} extension must be an absolute local path, not a package, remote, or file URL: ${value}`);
	}
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

async function canonicalPlannedPath(path: string, signal?: AbortSignal): Promise<string> {
	let ancestor = resolve(path);
	const suffix: string[] = [];
	for (;;) {
		abortIfNeeded(signal);
		try {
			return resolve(await realpath(ancestor), ...suffix.reverse());
		} catch (error) {
			if (!isMissing(error)) throw error;
			const parent = dirname(ancestor);
			if (parent === ancestor) throw error;
			suffix.push(ancestor.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
			ancestor = parent;
		}
	}
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

function promptSubstitution(rawArgs: readonly string[], path: string): { rawValue: string; finalArgs: string[] } {
	const indexes = rawArgs.flatMap((arg, index) => arg === PROMPT_FLAG ? [index] : []);
	if (indexes.length !== 1) {
		throw new Error(`Implementer launch must contain exactly one ${PROMPT_FLAG} pair.`);
	}
	const flagIndex = indexes[0]!;
	const rawValue = rawArgs[flagIndex + 1];
	if (rawValue === undefined || !rawValue.includes("\n") || !rawValue.trim() || rawValue.includes("\0")) {
		throw new Error(`Implementer ${PROMPT_FLAG} value must be the exact multiline Role prompt.`);
	}
	const finalArgs = [...rawArgs];
	finalArgs[flagIndex + 1] = path;
	return { rawValue, finalArgs };
}

function assertExactPromptSubstitution(record: NormalizedLaunchRecord): void {
	if (record.role === "reviewer") {
		if (record.prompt) throw new Error(`Reviewer launch ${record.key} must not contain private prompt metadata.`);
		return;
	}
	if (!record.prompt) throw new Error(`Implementer launch ${record.key} has no private prompt metadata.`);
	const expected = promptSubstitution(record.rawArgs, record.prompt.path);
	if (record.prompt.rawValue !== expected.rawValue || !isDeepStrictEqual(record.prompt.finalArgs, expected.finalArgs)) {
		throw new Error(`Implementer launch ${record.key} final argv must replace only its single prompt value.`);
	}
	if (record.prompt.sha256 !== sha256(record.prompt.rawValue) || record.prompt.mode !== PROMPT_MODE) {
		throw new Error(`Implementer launch ${record.key} prompt metadata hash or mode drifted.`);
	}
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
	if (role.extensions.length || role.skills.length) {
		throw new Error("Effective Reviewer Role must declare no extensions or Skills.");
	}
	if (role.tools.length !== REVIEWER_TOOLS.length
		|| new Set(role.tools).size !== REVIEWER_TOOLS.length
		|| REVIEWER_TOOLS.some((tool) => !role.tools.includes(tool))) {
		throw new Error(`Effective Reviewer Role must declare only ${REVIEWER_TOOLS.join(", ")}.`);
	}
}

function validateRoleDefinition(role: Role, effectiveRole: SubagentRole): void {
	requireUnique(effectiveRole.tools, `Effective ${role} Role tools`);
	requireUnique(effectiveRole.skills, `Effective ${role} Role Skills`);
	requireUnique(effectiveRole.extensions, `Effective ${role} Role extensions`);
	for (const extension of effectiveRole.extensions) rejectRoleExtensionSource(extension, role);
	if (role === "reviewer") assertExactReviewerRole(effectiveRole);
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
		known.roleTools,
	];
}

/** Normalize one pi-subagent result without constructing or changing its route or argv. */
export async function normalizeResolvedRoleLaunch(
	input: NormalizeResolvedRoleLaunchInput,
): Promise<NormalizedLaunchRecord> {
	const { role, modelClass, effectiveRole, launch, commands, tools, promptPath, knownFiles, signal } = input;
	validateRoleDefinition(role, effectiveRole);
	if (launch.missingSkills.length) {
		throw new Error(`Role ${role} requires missing Skills: ${launch.missingSkills.join(", ")}.`);
	}
	if (Object.keys(launch.env).length) throw new Error(`Resolved ${role} launch environment must be empty.`);

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
			throw new Error(`Resolved ${role}/${modelClass} extension is a forbidden legacy/self source: ${source}`);
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
	const expectedSkills = await canonicalExpectedSkills(effectiveRole, commands, signal);
	assertSameValues(resolvedSkills, expectedSkills, `Resolved ${role}/${modelClass} Skills`);
	const allResourcePaths = [...resolvedExtensions, ...resolvedSkills];
	requireUnique(allResourcePaths, `Resolved ${role}/${modelClass} resources`);
	await validateRoleTools(effectiveRole, tools, resolvedExtensions, signal);

	const resources: LaunchResourceFingerprint[] = [];
	for (const path of resolvedExtensions) {
		resources.push({ kind: "extension", path, sha256: await fingerprintFile(path, "Role extension", signal) });
	}
	for (const path of resolvedSkills) {
		resources.push({ kind: "skill", path, sha256: await fingerprintFile(path, "Role Skill", signal) });
	}

	const rawArgs = [...launch.args];
	const value: Omit<NormalizedLaunchRecord, "fingerprint"> = {
		key: launchKey(role, modelClass),
		role,
		modelClass,
		model: `${launch.model.provider}/${launch.model.id}`,
		thinkingLevel: launch.thinkingLevel,
		rawArgs,
		env: {},
		tools: [...effectiveRole.tools],
		roleExtensions: resolvedExtensions,
		roleSkills: resolvedSkills,
		resources,
		...(role === "implementer" ? (() => {
			if (!promptPath) throw new Error(`Implementer ${modelClass} launch has no request-owned prompt path.`);
			const prompt = promptSubstitution(rawArgs, promptPath);
			return { prompt: {
				rawValue: prompt.rawValue,
				path: promptPath,
				mode: PROMPT_MODE,
				sha256: sha256(prompt.rawValue),
				finalArgs: prompt.finalArgs,
			} };
		})() : {}),
	};
	const record = { ...value, fingerprint: launchRecordFingerprint(value) };
	assertExactPromptSubstitution(record);
	return record;
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

async function requestLaunchDirectory(
	root: string,
	requestId: string,
	agentDir: string | undefined,
	signal?: AbortSignal,
): Promise<{ configHome: string; requestDirectory: string }> {
	const configHome = await canonicalPlannedPath(resolve(extensionConfigDir("pi-orchestrator", agentDir)), signal);
	const rootKey = sha256(root);
	const requestDirectory = resolve(configHome, "launches", rootKey, requestId);
	if (!isWithin(configHome, requestDirectory)) throw new Error("Private launch directory escaped pi-orchestrator's config home.");
	return { configHome, requestDirectory };
}

async function knownLaunchFiles(orchestratorEntrypoint: string, signal?: AbortSignal): Promise<KnownLaunchFiles> {
	const subagentIndex = fileURLToPath(import.meta.resolve("@henryqw/pi-subagent"));
	const roleTools = resolve(dirname(subagentIndex), "..", "extensions", "role-tools.ts");
	const multiCodex = fileURLToPath(import.meta.resolve("@henryqw/pi-multi-codex/extensions/multi-codex.ts"));
	return {
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
	const extensions = await canonicalizeValues(valuesAfter(record.rawArgs, EXTENSION_FLAG), `Launch ${record.key} argv extensions`, signal);
	const skills = await canonicalizeValues(valuesAfter(record.rawArgs, SKILL_FLAG), `Launch ${record.key} argv Skills`, signal);
	assertSameValues(extensions, record.roleExtensions, `Launch ${record.key} extension paths`);
	assertSameValues(skills, record.roleSkills, `Launch ${record.key} Skill paths`);
	const expected = [
		...record.roleExtensions.map((path) => ({ kind: "extension" as const, path })),
		...record.roleSkills.map((path) => ({ kind: "skill" as const, path })),
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
	assertExactPromptSubstitution(record);
}

async function verifyPromptFile(record: NormalizedLaunchRecord, signal?: AbortSignal): Promise<void> {
	if (!record.prompt) return;
	abortIfNeeded(signal);
	let info;
	try {
		info = await lstat(record.prompt.path);
	} catch (error) {
		if (isMissing(error)) throw new Error(`Launch ${record.key} private prompt file is missing.`);
		throw error;
	}
	if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Launch ${record.key} private prompt is not a regular non-symlink file.`);
	if ((info.mode & 0o777) !== PROMPT_MODE) throw new Error(`Launch ${record.key} private prompt mode drifted from 0600.`);
	if (normalize(await realpath(record.prompt.path)) !== record.prompt.path) {
		throw new Error(`Launch ${record.key} private prompt path is no longer canonical.`);
	}
	const contents = await readFile(record.prompt.path, { signal });
	abortIfNeeded(signal);
	const expected = Buffer.from(record.prompt.rawValue, "utf8");
	if (!contents.equals(expected) || sha256(contents) !== record.prompt.sha256) {
		throw new Error(`Launch ${record.key} private prompt content or hash drifted.`);
	}
}

/** Revalidate a persisted launch immediately before starting its child process. */
export async function verifyLaunchRecord(record: NormalizedLaunchRecord, options: { signal?: AbortSignal } = {}): Promise<void> {
	await assertRecordResources(record, options.signal);
	await verifyPromptFile(record, options.signal);
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
		return this.options.randomToken?.() ?? randomBytes(16).toString("hex");
	}

	private async prepareLaunchRecords(
		request: ExecuteRequest,
		root: string,
		context: OperationContext,
	): Promise<NormalizedLaunchRecord[]> {
		abortIfNeeded(context.signal);
		const roles = selectRequiredRolesForRequest(loadRoles(this.options.agentDir), request);
		const commands = this.options.pi.getCommands();
		const tools = this.options.pi.getAllTools();
		const ctx = this.options.context();
		const knownFiles = await knownLaunchFiles(this.options.orchestratorEntrypoint, context.signal);
		const { requestDirectory } = await requestLaunchDirectory(root, request.id, this.options.agentDir, context.signal);
		const records: NormalizedLaunchRecord[] = [];
		for (const [key, required] of requiredLaunchKeys(request)) {
			abortIfNeeded(context.signal);
			const effectiveRole = roles.get(required.role)!;
			validateRoleDefinition(required.role, effectiveRole);
			const launch = resolveRoleLaunch({ getCommands: () => commands }, ctx, {
				role: effectiveRole,
				task: ORCHESTRATOR_MODEL_TASK,
				modelClass: required.modelClass,
				agentDir: this.options.agentDir,
			});
			const promptPath = required.role === "implementer"
				? join(requestDirectory, `${required.role}-${required.modelClass}.prompt`)
				: undefined;
			const record = await normalizeResolvedRoleLaunch({
				...required,
				effectiveRole,
				launch,
				commands,
				tools,
				promptPath,
				knownFiles,
				signal: context.signal,
			});
			if (record.key !== key) throw new Error(`Resolved launch key drifted from ${key}.`);
			records.push(record);
		}
		const normalized = validateLaunchRecords(request, records);
		return [...requiredLaunchKeys(request).keys()].map((key) => normalized[key]!);
	}

	async preflight(input: { request: ExecuteRequest; root: string }, context: OperationContext): Promise<{
		root: string;
		main: WorkspaceIdentity;
		launchRecords: LaunchRecord[];
	}> {
		abortIfNeeded(context.signal);
		const root = normalize(await realpath(input.root));
		const rootInfo = await lstat(root);
		if (!rootInfo.isDirectory()) throw new Error("Pi Orchestrator root must be an existing local directory.");
		const main = await this.options.inspectMain({ root }, context);
		const launchRecords = await this.prepareLaunchRecords(input.request, root, context);
		return { root, main, launchRecords };
	}

	async materializeLaunchRecords(
		input: { root: string; request: ExecuteRequest; records: Record<string, NormalizedLaunchRecord> },
		context: OperationContext,
	): Promise<void> {
		abortIfNeeded(context.signal);
		const root = normalize(await realpath(input.root));
		const records = validateLaunchRecords(input.request, Object.values(input.records));
		const { configHome, requestDirectory } = await requestLaunchDirectory(root, input.request.id, this.options.agentDir, context.signal);
		const promptPaths = new Set<string>();
		for (const [key, required] of requiredLaunchKeys(input.request)) {
			const record = records[key]!;
			await assertRecordResources(record, context.signal);
			if (required.role !== "implementer") continue;
			const expectedPath = join(requestDirectory, `${required.role}-${required.modelClass}.prompt`);
			if (record.prompt?.path !== expectedPath) throw new Error(`Launch ${key} private prompt path is not request-owned.`);
			if (promptPaths.has(expectedPath)) throw new Error(`Launch ${key} duplicates a private prompt path.`);
			promptPaths.add(expectedPath);
		}
		if (!promptPaths.size) throw new Error("No Implementer private prompt files were prepared.");

		const currentLocation = await requestLaunchDirectory(root, input.request.id, this.options.agentDir, context.signal);
		if (currentLocation.configHome !== configHome || currentLocation.requestDirectory !== requestDirectory) {
			throw new Error("Private launch directory canonicalization drifted before materialization.");
		}
		const parent = dirname(requestDirectory);
		await mkdir(parent, { recursive: true, mode: REQUEST_DIRECTORY_MODE });
		abortIfNeeded(context.signal);
		if (!isWithin(normalize(await realpath(configHome)), normalize(await realpath(parent)))) {
			throw new Error("Private launch parent escaped pi-orchestrator's config home.");
		}
		try {
			await mkdir(requestDirectory, { mode: REQUEST_DIRECTORY_MODE });
		} catch (error) {
			if (isAlreadyPresent(error)) throw new Error(`Private launch directory already exists: ${requestDirectory}`);
			throw error;
		}
		const requestInfo = await lstat(requestDirectory);
		if (requestInfo.isSymbolicLink() || !requestInfo.isDirectory()
			|| (requestInfo.mode & 0o777) !== REQUEST_DIRECTORY_MODE
			|| normalize(await realpath(requestDirectory)) !== requestDirectory) {
			throw new Error("Private launch request directory is not canonical mode 0700 storage.");
		}

		for (const record of Object.values(records)) {
			if (!record.prompt) continue;
			let file: Awaited<ReturnType<typeof open>> | undefined;
			try {
				file = await open(record.prompt.path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, PROMPT_MODE);
				abortIfNeeded(context.signal);
				await file.writeFile(record.prompt.rawValue, { encoding: "utf8", signal: context.signal });
				await file.sync();
				await file.close();
				file = undefined;
			} catch (error) {
				await file?.close();
				if (isAlreadyPresent(error)) throw new Error(`Private prompt file already exists: ${record.prompt.path}`);
				throw error;
			}
		}
		for (const record of Object.values(records)) await verifyLaunchRecord(record, { signal: context.signal });
	}

	async recoverLaunchRecords(
		input: { root: string; request: ExecuteRequest; records: Record<string, NormalizedLaunchRecord> },
		context: OperationContext,
	): Promise<LaunchRecord[]> {
		abortIfNeeded(context.signal);
		const root = normalize(await realpath(input.root));
		const recorded = validateLaunchRecords(input.request, Object.values(input.records));
		const freshRecords = await this.prepareLaunchRecords(input.request, root, context);
		const fresh = validateLaunchRecords(input.request, freshRecords);
		if (!isDeepStrictEqual(fresh, recorded)) {
			throw new Error("Recorded Role/model launch route, argv, resources, or prompt metadata drifted.");
		}
		for (const record of Object.values(recorded)) await verifyLaunchRecord(record, { signal: context.signal });
		return freshRecords;
	}
}

export function createRoleLaunchRuntime(options: LaunchRuntimeOptions): RoleLaunchRuntime {
	return new RoleLaunchRuntime(options);
}
