import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, parseFrontmatter, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createHerdrClient, herdrCommandFailure, hasHerdrErrorCode, startPiAgent, type HerdrExecutor } from "@henryqw/pi-herdr";
import {
	modelReference,
	orderedProfileRoutes,
	readTaskModelsConfig,
	resolveConfiguredTaskRoute,
	resolveTaskModelRoute,
	type AvailableModel,
	type ProfileName,
	type ResolvedTaskRoute,
	type ThinkingLevel,
} from "@henryqw/pi-task-models";

export {
	addUsage,
	capEphemeralSubagentOutput,
	createEphemeralSubagentExecutor,
	EphemeralSubagentError,
	formatDuration,
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
	worktreeContextNote,
	type WorktreeInfo,
	type WorktreePayload,
} from "./worktree.ts";

const CODEX_ALIAS = /^openai-codex-(?:[2-9]|[1-9]\d+)$/;
const MULTI_CODEX_EXTENSION = fileURLToPath(import.meta.resolve("@henryqw/pi-multi-codex/extensions/multi-codex.ts"));
const ROLE_TOOLS_EXTENSION = fileURLToPath(new URL("../extensions/role-tools.ts", import.meta.url));
export const ROLE_TOOL_POLICY_FLAG = "pi-subagent-role-tools";
export const CHILD_EXCLUDED_TOOLS = "delegate_task,ask_question,auto_dag_execute,auto_dag_acknowledge";
const CHILD_IDENTITY_POLICY = "You are a delegated Pi Subagent, not Main. Execute the assigned Role and task directly. Main-only delegation rules do not apply. Recursive delegation is unavailable; do not seek or invoke delegation tools.";

export interface Role {
	name: string;
	description: string;
	tools?: string[];
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
	taskId: string;
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

const stringList = (value: unknown, field: string, source: string, required = false): string[] => {
	if (value === undefined) {
		if (required) throw new Error(`${source}: ${field} is required.`);
		return [];
	}
	const values = typeof value === "string" ? value.split(",") : value;
	if (!Array.isArray(values) || values.some((item) => typeof item !== "string" || !item.trim() || item.includes("\0"))) {
		throw new Error(`${source}: ${field} must be an array of strings.`);
	}
	return values.map((item) => item.trim());
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

// Built-in Roles required by the bundled pi-subagent-delegated-development Skill;
// resolved from the package-shipped Markdown relative to this module.
const BUILTIN_ROLE_FILES = ["implementer.md", "reviewer.md"] as const;

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
		tools: frontmatter.tools === undefined ? undefined : stringList(frontmatter.tools, "tools", file, true),
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

function builtinRoles(): Role[] {
	return BUILTIN_ROLE_FILES.map((name) =>
		readRoleFile(fileURLToPath(new URL(`../examples/roles/${name}`, import.meta.url))));
}

/**
 * Validated built-in implementer/reviewer Roles plus valid user roles from
 * `config/pi-subagent`. A user role with a built-in name overrides the default;
 * duplicate names among user files are an error. Missing user directory returns
 * the built-ins.
 */
export function loadRoles(agentDir = getAgentDir()): Role[] {
	const byName = new Map(builtinRoles().map((role) => [role.name, role]));
	const dir = join(agentDir, "config", "pi-subagent");
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
	thinking?: ThinkingLevel,
): ResolvedTaskRoute {
	let config;
	try {
		config = readTaskModelsConfig(agentDir);
	} catch {
		throw new Error("Couldn't read task model config. Run /task-models.");
	}
	return resolveConfiguredRoute(ctx, profileName, config.profiles[profileName], agentDir, thinking);
}

function resolveConfiguredRoute(
	ctx: ExtensionContext,
	profileName: ProfileName,
	profile: ReturnType<typeof readTaskModelsConfig>["profiles"][ProfileName],
	agentDir = getAgentDir(),
	thinking?: ThinkingLevel,
): ResolvedTaskRoute {
	if (!profile) throw new Error(`No ${profileName} task model profile is configured. Run /task-models.`);
	for (const route of orderedProfileRoutes(profile)) {
		const resolved = resolveTaskModelRoute(ctx, route, agentDir, thinking);
		if (resolved) return resolved;
	}
	throw new Error(`No usable ${profileName} task model route${thinking ? ` supporting thinking ${thinking}` : ""}. Run /task-models.`);
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
	pi: Pick<ExtensionAPI, "getActiveTools" | "getAllTools" | "getCommands">,
	ctx: Pick<ExtensionContext, "isProjectTrusted">,
	input: CreateRoleLaunchInput,
): ResolvedRoleLaunch {
	const role = input.role;
	const skills = resolveRoleSkills(pi, role);
	let baseTools = role.tools;
	if (baseTools === undefined && input.tools !== undefined) {
		const builtins = new Set(pi.getAllTools()
			.filter((tool) => tool.sourceInfo.source === "builtin")
			.map((tool) => tool.name));
		baseTools = pi.getActiveTools().filter((tool) => builtins.has(tool));
	}
	const tools = baseTools === undefined
		? undefined
		: [...new Set([...baseTools, ...(input.tools ?? [])].map((tool) => cleanText(tool, "tool", `Role ${role.name}`)))];
	const extensions = [
		...role.extensions,
		...(input.extensions ?? []),
		...(CODEX_ALIAS.test(input.route.model.provider) ? [MULTI_CODEX_EXTENSION] : []),
		...(tools === undefined ? [] : [ROLE_TOOLS_EXTENSION]),
	].map((extension) => validateExtension(extension, `Role ${role.name}`));
	const env = Object.fromEntries(Object.entries(input.env ?? {}).map(([key, value]) => {
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Invalid launch environment name: ${key}`);
		if (typeof value !== "string" || value.includes("\0")) throw new Error(`Invalid launch environment value: ${key}`);
		return [key, value];
	}));
	const args = ["--no-session", "--no-extensions", "--no-skills", "--exclude-tools", CHILD_EXCLUDED_TOOLS];
	for (const extension of new Set(extensions)) args.push("--extension", extension);
	for (const skill of skills.paths) args.push("--skill", skill);
	if (tools !== undefined) args.push(`--${ROLE_TOOL_POLICY_FLAG}`, JSON.stringify(tools));
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
	pi: Pick<ExtensionAPI, "getActiveTools" | "getAllTools" | "getCommands">,
	ctx: ExtensionContext,
	input: ResolveRoleLaunchInput,
): ResolvedRoleLaunch {
	const taskId = cleanText(input.taskId, "task ID", "Role launch");
	return createRoleLaunch(pi, ctx, {
		...input,
		route: resolveConfiguredTaskRoute(ctx, taskId, input.agentDir),
	});
}

export interface ManagedSubagentHost {
	cwd: string;
	workspaceId: string;
}

export interface ManagedSubagentCommandOptions {
	cwd: string;
}

export type ManagedSubagentExecutor = HerdrExecutor<ManagedSubagentCommandOptions>;

export interface ManagedSubagentHostOptions {
	execute: ManagedSubagentExecutor;
	delay?: (milliseconds: number) => Promise<void>;
}

export interface ManagedSubagentTab {
	tabId: string;
	paneId: string;
}

function launchEnvironmentArgs(launch: PiLaunch): string[] {
	return Object.entries(launch.env).flatMap(([key, value]) => {
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== "string" || value.includes("\0")) {
			throw new Error(`Invalid launch environment: ${key}`);
		}
		return ["--env", `${key}=${value}`];
	});
}

export function managedSubagentName(workspaceId: string, ...identity: string[]): string {
	const parts = [nonEmptyString(workspaceId, "Herdr workspace id"), ...identity.map((part, index) => nonEmptyString(part, `Subagent identity ${index}`))];
	if (!identity.length) throw new Error("Managed Subagent identity is required");
	return `subagent-${createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 23)}`;
}

export async function managedSubagentWorkspaceId(
	cwd: string,
	mainPane: string,
	options: ManagedSubagentHostOptions,
): Promise<string> {
	const paneId = nonEmptyString(mainPane, "recorded main Herdr pane");
	const pane = (await listPanes(cwd, options))
		.map((entry, index) => object(entry, `Herdr pane ${index}`))
		.find((entry) => entry.pane_id === paneId);
	if (!pane) throw new Error(`Recorded main Herdr pane is missing: ${paneId}`);
	return nonEmptyString(pane.workspace_id, "recorded main Herdr workspace");
}

/** Returns pane ID to Herdr status for agents owned by this workspace. */
export async function listManagedSubagents(
	host: ManagedSubagentHost,
	options: ManagedSubagentHostOptions,
): Promise<Map<string, string>> {
	const workspaceId = nonEmptyString(host.workspaceId, "recorded Herdr workspace");
	const response = object(await createHerdrClient(options.execute).json(["agent", "list"], { cwd: host.cwd }), "Herdr agent list response");
	const result = object(response.result, "Herdr agent list result");
	return new Map(array(result.agents, "Herdr agents").flatMap((entry, index) => {
		const agent = object(entry, `Herdr agent ${index}`);
		if (nonEmptyString(agent.workspace_id, `Herdr agent ${index} workspace`) !== workspaceId) return [];
		return [[
			nonEmptyString(agent.pane_id, `Herdr agent ${index} pane`),
			nonEmptyString(agent.agent_status, `Herdr agent ${index} status`),
		] as const];
	}));
}

export async function createManagedSubagentTab(
	host: ManagedSubagentHost,
	cwd: string,
	launch: PiLaunch,
	label: string,
	options: ManagedSubagentHostOptions,
): Promise<ManagedSubagentTab> {
	const response = await createHerdrClient(options.execute).json([
		"tab", "create", "--workspace", nonEmptyString(host.workspaceId, "recorded Herdr workspace"), "--cwd", cwd,
		...launchEnvironmentArgs(launch), "--label", nonEmptyString(label, "Herdr tab label"), "--no-focus",
	], { cwd: host.cwd });
	const result = object(object(response, "Herdr tab response").result, "Herdr tab result");
	return {
		tabId: nonEmptyString(object(result.tab, "Herdr tab").tab_id, "Herdr tab id"),
		paneId: nonEmptyString(object(result.root_pane, "Herdr root pane").pane_id, "Herdr root pane id"),
	};
}

export async function reconcileManagedSubagentTab(
	host: ManagedSubagentHost,
	input: {
		tabId?: string;
		paneId?: string;
		cwd: string;
		launch: PiLaunch;
		label: string;
	},
	options: ManagedSubagentHostOptions,
): Promise<ManagedSubagentTab> {
	if (input.tabId && input.paneId && await managedSubagentTabExists(host, input.tabId, options)) {
		return { tabId: input.tabId, paneId: input.paneId };
	}
	return await findManagedSubagentTab(host, input.label, options)
		?? await createManagedSubagentTab(host, input.cwd, input.launch, input.label, options);
}

export async function findManagedSubagentTab(
	host: ManagedSubagentHost,
	label: string,
	options: ManagedSubagentHostOptions,
): Promise<ManagedSubagentTab | undefined> {
	const workspaceId = nonEmptyString(host.workspaceId, "recorded Herdr workspace");
	const matches = (await listTabs(host.cwd, options))
		.map((entry, index) => object(entry, `Herdr tab ${index}`))
		.filter((tab, index) => nonEmptyString(tab.workspace_id, `Herdr tab ${index} workspace`) === workspaceId)
		.filter((tab) => tab.label === label);
	if (matches.length > 1) throw new Error(`Multiple Herdr tabs match provisioning identity: ${label}`);
	if (!matches.length) return undefined;
	const tabId = nonEmptyString(object(matches[0], "Herdr tab").tab_id, "Herdr tab id");
	const panes = (await listPanes(host.cwd, options))
		.filter((entry, index) => object(entry, `Herdr pane ${index}`).tab_id === tabId);
	if (panes.length !== 1) throw new Error(`Provisioned Herdr tab ${tabId} must contain exactly one root pane`);
	return { tabId, paneId: nonEmptyString(object(panes[0], "Herdr pane").pane_id, "Herdr pane id") };
}

export async function managedSubagentTabExists(
	host: ManagedSubagentHost,
	tabId: string,
	options: ManagedSubagentHostOptions,
): Promise<boolean> {
	const expected = nonEmptyString(host.workspaceId, "recorded Herdr workspace");
	const id = nonEmptyString(tabId, "Herdr tab id");
	const tab = (await listTabs(host.cwd, options))
		.map((entry, index) => object(entry, `Herdr tab ${index}`))
		.find((entry) => entry.tab_id === id);
	if (!tab) return false;
	const actual = nonEmptyString(tab.workspace_id, `Herdr tab ${id} workspace`);
	if (actual !== expected) throw new Error(`Herdr tab ${id} belongs to workspace ${actual}, expected initiating workspace ${expected}`);
	return true;
}

export async function reconcileManagedSubagentPane(
	host: ManagedSubagentHost,
	tabId: string,
	rootPaneId: string,
	cwd: string,
	launch: PiLaunch,
	label: string,
	options: ManagedSubagentHostOptions,
): Promise<string> {
	const tab = nonEmptyString(tabId, "Herdr tab id");
	const workspace = nonEmptyString(host.workspaceId, "recorded Herdr workspace");
	const ownerTab = (await listTabs(host.cwd, options))
		.map((entry, index) => object(entry, `Herdr tab ${index}`))
		.find((entry) => entry.tab_id === tab);
	if (!ownerTab) throw new Error(`Herdr tab is missing: ${tab}`);
	const ownerWorkspace = nonEmptyString(ownerTab.workspace_id, `Herdr tab ${tab} workspace`);
	if (ownerWorkspace !== workspace) throw new Error(`Herdr tab ${tab} belongs to workspace ${ownerWorkspace}, expected initiating workspace ${workspace}`);
	const root = nonEmptyString(rootPaneId, "Herdr root pane");
	const panes = (await listPanes(host.cwd, options)).map((entry, index) => object(entry, `Herdr pane ${index}`));
	const owner = panes.find((pane) => pane.pane_id === root);
	if (!owner) throw new Error(`Herdr root pane is missing: ${root}`);
	if (owner.tab_id !== tab) throw new Error(`Herdr root pane ${root} does not belong to tab ${tab}`);
	const siblings = panes.filter((pane) => pane.tab_id === tab && pane.pane_id !== root);
	const named = siblings.filter((pane) => pane.label === label);
	if (named.length > 1) throw new Error(`Multiple Herdr panes match provisioning identity: ${label}`);
	if (named.length) return nonEmptyString(named[0].pane_id, "Herdr Subagent pane id");
	if (siblings.length > 1) throw new Error(`Provisioned Herdr tab ${tab} has multiple Subagent panes`);
	if (siblings.length) return nonEmptyString(siblings[0].pane_id, "Herdr Subagent pane id");
	const herdr = createHerdrClient(options.execute);
	const response = await herdr.json([
		"pane", "split", "--pane", root, "--direction", "right", "--cwd", cwd,
		...launchEnvironmentArgs(launch), "--no-focus",
	], { cwd: host.cwd });
	const result = object(object(response, "Herdr pane response").result, "Herdr pane result");
	const pane = nonEmptyString(object(result.pane, "Herdr Subagent pane").pane_id, "Herdr Subagent pane id");
	await herdr.run(["pane", "rename", pane, nonEmptyString(label, "Herdr pane label")], { cwd: host.cwd });
	return pane;
}

export async function startManagedSubagent(
	host: ManagedSubagentHost,
	agent: string,
	pane: string,
	launch: PiLaunch,
	options: ManagedSubagentHostOptions,
	hooks: { beforeStart?: () => Promise<void>; onStarted?: () => Promise<void> } = {},
): Promise<"existing" | "started"> {
	assertAgentName(agent);
	const name = nonEmptyString(agent, "Herdr agent name");
	const paneId = nonEmptyString(pane, "Herdr agent pane");
	const existing = await getManagedSubagent(host, name, options);
	if (existing) {
		assertAgentPane(name, paneId, existing);
		return "existing";
	}
	await hooks.beforeStart?.();
	const herdr = createHerdrClient(options.execute);
	const startArgs = ["agent", "start", name, "--kind", "pi", "--pane", paneId, "--", ...launch.args];
	const result = await startPiAgent(herdr, {
		name,
		pane: paneId,
		args: launch.args,
		options: { cwd: host.cwd },
		delay: options.delay,
	});
	if (result.code === 0 && !result.killed) {
		await hooks.onStarted?.();
		return "started";
	}
	if (hasHerdrErrorCode(result, "agent_name_taken")) {
		const raced = await getManagedSubagent(host, name, options);
		if (!raced) throw new Error(`Herdr agent ${name} reported agent_name_taken but could not be found; refusing to start a duplicate`);
		assertAgentPane(name, paneId, raced);
		return "existing";
	}
	throw new Error(herdrCommandFailure(startArgs, result));
}

export async function promptManagedSubagent(
	host: ManagedSubagentHost,
	agent: string,
	prompt: string | Record<string, unknown>,
	options: ManagedSubagentHostOptions,
): Promise<void> {
	assertAgentName(agent);
	const text = typeof prompt === "string" ? nonEmptyString(prompt, "Subagent prompt") : JSON.stringify(prompt);
	await createHerdrClient(options.execute).run(["agent", "prompt", agent, text], { cwd: host.cwd });
}

export async function retireManagedSubagentTab(
	host: ManagedSubagentHost,
	tabId: string,
	options: ManagedSubagentHostOptions,
): Promise<void> {
	const id = nonEmptyString(tabId, "Herdr tab id");
	try {
		if (!(await managedSubagentTabExists(host, id, options))) return;
		await createHerdrClient(options.execute).run(["tab", "close", id], { cwd: host.cwd });
	} catch (error) {
		if (!(await confirmsTabAbsent(host, id, options))) throw error;
	}
}

function assertAgentName(agent: string): void {
	if (!/^[a-z][a-z0-9_-]{0,31}$/.test(agent)) throw new Error(`Invalid Herdr agent name: ${agent}`);
}

function object(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
	return value as Record<string, unknown>;
}

function array(value: unknown, label: string): unknown[] {
	if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
	return value;
}

function nonEmptyString(value: unknown, label: string): string {
	if (typeof value !== "string") throw new Error(`${label} must be a string`);
	if (!value.trim() || value.includes("\0")) throw new Error(`${label} must not be empty`);
	return value;
}

async function listTabs(cwd: string, options: ManagedSubagentHostOptions): Promise<unknown[]> {
	const response = await createHerdrClient(options.execute).json(["tab", "list"], { cwd });
	return array(object(object(response, "Herdr tab list response").result, "Herdr tab list result").tabs, "Herdr tabs");
}

async function listPanes(cwd: string, options: ManagedSubagentHostOptions): Promise<unknown[]> {
	const response = await createHerdrClient(options.execute).json(["pane", "list"], { cwd });
	return array(object(object(response, "Herdr pane list response").result, "Herdr pane list result").panes, "Herdr panes");
}

async function getManagedSubagent(
	host: ManagedSubagentHost,
	name: string,
	options: ManagedSubagentHostOptions,
): Promise<Record<string, unknown> | undefined> {
	const arguments_ = ["agent", "get", name];
	const result = await createHerdrClient(options.execute).exec(arguments_, { cwd: host.cwd });
	if (result.code !== 0 || result.killed) {
		if (hasHerdrErrorCode(result, "agent_not_found")) return undefined;
		throw new Error(herdrCommandFailure(arguments_, result));
	}
	const response = object(JSON.parse(result.stdout), "Herdr agent get response");
	return object(object(response.result, "Herdr agent get result").agent, `Herdr agent ${name}`);
}

function assertAgentPane(name: string, expected: string, agent: Record<string, unknown>): void {
	const actual = typeof agent.pane_id === "string" ? agent.pane_id : "missing";
	if (actual !== expected) {
		throw new Error(`Herdr agent name collision for ${name}: expected pane ${expected}, found ${actual}; refusing to reuse or replace it`);
	}
}

async function confirmsTabAbsent(
	host: ManagedSubagentHost,
	tabId: string,
	options: ManagedSubagentHostOptions,
): Promise<boolean> {
	try {
		const result = await createHerdrClient(options.execute).exec(["tab", "get", tabId], { cwd: host.cwd });
		return !result.killed && result.code !== 0 && hasHerdrErrorCode(result, "tab_not_found");
	} catch {
		return false;
	}
}
