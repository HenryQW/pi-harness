import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { createHerdrClient, herdrCommandFailure, hasHerdrErrorCode } from "@henryqw/pi-herdr";
import { modelReference, orderedProfileRoutes, PROFILE_NAMES, readTaskModelsConfig, resolveConfiguredTaskRoute, resolveTaskModelRoute, } from "@henryqw/pi-task-models";
export { createChildWorktree, finalizeChildWorktree, worktreeContextNote, } from "./worktree.js";
const CODEX_ALIAS = /^openai-codex-(?:[2-9]|[1-9]\d+)$/;
const MULTI_CODEX_EXTENSION = fileURLToPath(import.meta.resolve("@henryqw/pi-multi-codex/extensions/multi-codex.ts"));
const ROLE_TOOLS_EXTENSION = fileURLToPath(new URL("../extensions/role-tools.ts", import.meta.url));
const CHILD_POLICY_EXTENSION = fileURLToPath(new URL("../extensions/child-policy.ts", import.meta.url));
const ROLE_TOOL_POLICY_FLAG = "pi-subagent-role-tools";
export const isProfileName = (value) => typeof value === "string" && PROFILE_NAMES.includes(value);
const cleanText = (value, field, source) => {
    if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
        throw new Error(`${source}: ${field} must be non-empty text.`);
    }
    return value.trim();
};
const stringList = (value, field, source, required = false) => {
    if (value === undefined) {
        if (required)
            throw new Error(`${source}: ${field} is required.`);
        return [];
    }
    const values = typeof value === "string" ? value.split(",") : value;
    if (!Array.isArray(values) || values.some((item) => typeof item !== "string" || !item.trim() || item.includes("\0"))) {
        throw new Error(`${source}: ${field} must be an array of strings.`);
    }
    return values.map((item) => item.trim());
};
function validateExtension(extension, source) {
    const value = cleanText(extension, "extension", source);
    const packageSource = /^(?:npm|git|github|https?|ssh):/.test(value);
    const userPath = isAbsolute(value) || value.startsWith("~/") || value.startsWith("~\\") || value.startsWith("file://");
    if (!packageSource && !userPath) {
        throw new Error(`${source}: extensions entries must be absolute paths or package sources.`);
    }
    return value;
}
function extensionList(value, source) {
    return stringList(value, "extensions", source).map((extension) => validateExtension(extension, source));
}
function validateIsolation(value, source) {
    if (value === undefined)
        return undefined;
    const isolation = cleanText(value, "isolation", source);
    if (isolation !== "worktree")
        throw new Error(`${source}: isolation must be "worktree".`);
    return isolation;
}
export function loadRoles(agentDir = getAgentDir()) {
    const dir = join(agentDir, "config", "pi-subagent");
    let entries;
    try {
        entries = readdirSync(dir, { withFileTypes: true });
    }
    catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
            return [];
        throw error;
    }
    const roles = entries
        .filter((entry) => entry.name.endsWith(".md") && (entry.isFile() || entry.isSymbolicLink()))
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((entry) => {
        const file = join(dir, entry.name);
        let parsed;
        try {
            parsed = parseFrontmatter(readFileSync(file, "utf8"));
        }
        catch (error) {
            throw new Error(`${file}: ${error instanceof Error ? error.message : String(error)}`);
        }
        const frontmatter = parsed.frontmatter;
        return {
            name: cleanText(frontmatter.name, "name", file),
            description: cleanText(frontmatter.description, "description", file),
            tools: frontmatter.tools === undefined ? undefined : stringList(frontmatter.tools, "tools", file, true),
            isolation: validateIsolation(frontmatter.isolation, file),
            extensions: extensionList(frontmatter.extensions, file),
            skills: stringList(frontmatter.skills, "skills", file),
            systemPrompt: cleanText(parsed.body, "system prompt", file),
        };
    });
    const names = new Set();
    for (const role of roles) {
        if (names.has(role.name))
            throw new Error(`Duplicate Subagent role: ${role.name}.`);
        names.add(role.name);
    }
    return roles;
}
export function resolveTaskRoute(ctx, profileName, agentDir = getAgentDir()) {
    let config;
    try {
        config = readTaskModelsConfig(agentDir);
    }
    catch {
        throw new Error("Couldn't read task model config. Run /task-models.");
    }
    return resolveConfiguredRoute(ctx, profileName, config.profiles[profileName], agentDir);
}
function resolveConfiguredRoute(ctx, profileName, profile, agentDir = getAgentDir()) {
    if (!profile)
        throw new Error(`No ${profileName} task model profile is configured. Run /task-models.`);
    for (const route of orderedProfileRoutes(profile)) {
        const resolved = resolveTaskModelRoute(ctx, route, agentDir);
        if (resolved)
            return resolved;
    }
    throw new Error(`No usable ${profileName} task model route. Run /task-models.`);
}
export function resolveRoleSkills(pi, role) {
    const skills = new Map(pi.getCommands()
        .filter((command) => command.source === "skill")
        .map((command) => [command.name, command.sourceInfo.path]));
    const paths = [];
    const missing = [];
    for (const name of role.skills) {
        const path = skills.get(`skill:${name}`);
        if (path)
            paths.push(path);
        else
            missing.push(name);
    }
    return { paths, missing };
}
export function createRoleLaunch(pi, ctx, input) {
    const role = input.role;
    const skills = resolveRoleSkills(pi, role);
    const tools = role.tools === undefined
        ? undefined
        : [...new Set([...role.tools, ...(input.tools ?? [])].map((tool) => cleanText(tool, "tool", `Role ${role.name}`)))];
    const extensions = [
        ...role.extensions,
        ...(input.extensions ?? []),
        ...(CODEX_ALIAS.test(input.route.model.provider) ? [MULTI_CODEX_EXTENSION] : []),
        ...(tools === undefined ? [] : [ROLE_TOOLS_EXTENSION]),
        CHILD_POLICY_EXTENSION,
    ].map((extension) => validateExtension(extension, `Role ${role.name}`));
    const env = Object.fromEntries(Object.entries(input.env ?? {}).map(([key, value]) => {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
            throw new Error(`Invalid launch environment name: ${key}`);
        if (typeof value !== "string" || value.includes("\0"))
            throw new Error(`Invalid launch environment value: ${key}`);
        return [key, value];
    }));
    const args = ["--no-session", "--no-extensions", "--no-skills"];
    for (const extension of new Set(extensions))
        args.push("--extension", extension);
    for (const skill of skills.paths)
        args.push("--skill", skill);
    if (tools !== undefined)
        args.push(`--${ROLE_TOOL_POLICY_FLAG}`, JSON.stringify(tools));
    args.push("--model", modelReference(input.route.model));
    if (input.route.thinkingLevel)
        args.push("--thinking", input.route.thinkingLevel);
    args.push(ctx.isProjectTrusted() ? "--approve" : "--no-approve");
    args.push("--append-system-prompt", cleanText(role.systemPrompt, "system prompt", `Role ${role.name}`));
    return {
        env,
        args,
        model: input.route.model,
        thinkingLevel: input.route.thinkingLevel,
        missingSkills: skills.missing,
    };
}
export function resolveRoleLaunch(pi, ctx, input) {
    const taskId = cleanText(input.taskId, "task ID", "Role launch");
    return createRoleLaunch(pi, ctx, {
        ...input,
        route: resolveConfiguredTaskRoute(ctx, taskId, input.agentDir),
    });
}
export function launchEnvironmentArgs(launch) {
    return Object.entries(launch.env).flatMap(([key, value]) => {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== "string" || value.includes("\0")) {
            throw new Error(`Invalid launch environment: ${key}`);
        }
        return ["--env", `${key}=${value}`];
    });
}
export function managedSubagentName(workspaceId, ...identity) {
    const parts = [nonEmptyString(workspaceId, "Herdr workspace id"), ...identity.map((part, index) => nonEmptyString(part, `Subagent identity ${index}`))];
    if (!identity.length)
        throw new Error("Managed Subagent identity is required");
    return `subagent-${createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 23)}`;
}
export async function managedSubagentWorkspaceId(cwd, mainPane, options) {
    const paneId = nonEmptyString(mainPane, "recorded main Herdr pane");
    const pane = (await listPanes(cwd, options))
        .map((entry, index) => object(entry, `Herdr pane ${index}`))
        .find((entry) => entry.pane_id === paneId);
    if (!pane)
        throw new Error(`Recorded main Herdr pane is missing: ${paneId}`);
    return nonEmptyString(pane.workspace_id, "recorded main Herdr workspace");
}
/** Returns pane ID to Herdr status for agents owned by this workspace. */
export async function listManagedSubagents(host, options) {
    const workspaceId = nonEmptyString(host.workspaceId, "recorded Herdr workspace");
    const response = object(await createHerdrClient(options.execute).json(["agent", "list"], { cwd: host.cwd }), "Herdr agent list response");
    const result = object(response.result, "Herdr agent list result");
    return new Map(array(result.agents, "Herdr agents").flatMap((entry, index) => {
        const agent = object(entry, `Herdr agent ${index}`);
        if (nonEmptyString(agent.workspace_id, `Herdr agent ${index} workspace`) !== workspaceId)
            return [];
        return [[
                nonEmptyString(agent.pane_id, `Herdr agent ${index} pane`),
                nonEmptyString(agent.agent_status, `Herdr agent ${index} status`),
            ]];
    }));
}
export async function createManagedSubagentTab(host, cwd, launch, label, options) {
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
export async function reconcileManagedSubagentTab(host, input, options) {
    if (input.tabId && input.paneId && await managedSubagentTabExists(host, input.tabId, options)) {
        return { tabId: input.tabId, paneId: input.paneId };
    }
    return await findManagedSubagentTab(host, input.label, options)
        ?? await createManagedSubagentTab(host, input.cwd, input.launch, input.label, options);
}
export async function findManagedSubagentTab(host, label, options) {
    const workspaceId = nonEmptyString(host.workspaceId, "recorded Herdr workspace");
    const matches = (await listTabs(host.cwd, options))
        .map((entry, index) => object(entry, `Herdr tab ${index}`))
        .filter((tab, index) => nonEmptyString(tab.workspace_id, `Herdr tab ${index} workspace`) === workspaceId)
        .filter((tab) => tab.label === label);
    if (matches.length > 1)
        throw new Error(`Multiple Herdr tabs match provisioning identity: ${label}`);
    if (!matches.length)
        return undefined;
    const tabId = nonEmptyString(object(matches[0], "Herdr tab").tab_id, "Herdr tab id");
    const panes = (await listPanes(host.cwd, options))
        .filter((entry, index) => object(entry, `Herdr pane ${index}`).tab_id === tabId);
    if (panes.length !== 1)
        throw new Error(`Provisioned Herdr tab ${tabId} must contain exactly one root pane`);
    return { tabId, paneId: nonEmptyString(object(panes[0], "Herdr pane").pane_id, "Herdr pane id") };
}
export async function managedSubagentTabExists(host, tabId, options) {
    const expected = nonEmptyString(host.workspaceId, "recorded Herdr workspace");
    const id = nonEmptyString(tabId, "Herdr tab id");
    const tab = (await listTabs(host.cwd, options))
        .map((entry, index) => object(entry, `Herdr tab ${index}`))
        .find((entry) => entry.tab_id === id);
    if (!tab)
        return false;
    const actual = nonEmptyString(tab.workspace_id, `Herdr tab ${id} workspace`);
    if (actual !== expected)
        throw new Error(`Herdr tab ${id} belongs to workspace ${actual}, expected initiating workspace ${expected}`);
    return true;
}
export async function reconcileManagedSubagentPane(host, tabId, rootPaneId, cwd, launch, label, options) {
    const tab = nonEmptyString(tabId, "Herdr tab id");
    const workspace = nonEmptyString(host.workspaceId, "recorded Herdr workspace");
    const ownerTab = (await listTabs(host.cwd, options))
        .map((entry, index) => object(entry, `Herdr tab ${index}`))
        .find((entry) => entry.tab_id === tab);
    if (!ownerTab)
        throw new Error(`Herdr tab is missing: ${tab}`);
    const ownerWorkspace = nonEmptyString(ownerTab.workspace_id, `Herdr tab ${tab} workspace`);
    if (ownerWorkspace !== workspace)
        throw new Error(`Herdr tab ${tab} belongs to workspace ${ownerWorkspace}, expected initiating workspace ${workspace}`);
    const root = nonEmptyString(rootPaneId, "Herdr root pane");
    const panes = (await listPanes(host.cwd, options)).map((entry, index) => object(entry, `Herdr pane ${index}`));
    const owner = panes.find((pane) => pane.pane_id === root);
    if (!owner)
        throw new Error(`Herdr root pane is missing: ${root}`);
    if (owner.tab_id !== tab)
        throw new Error(`Herdr root pane ${root} does not belong to tab ${tab}`);
    const siblings = panes.filter((pane) => pane.tab_id === tab && pane.pane_id !== root);
    const named = siblings.filter((pane) => pane.label === label);
    if (named.length > 1)
        throw new Error(`Multiple Herdr panes match provisioning identity: ${label}`);
    if (named.length)
        return nonEmptyString(named[0].pane_id, "Herdr Subagent pane id");
    if (siblings.length > 1)
        throw new Error(`Provisioned Herdr tab ${tab} has multiple Subagent panes`);
    if (siblings.length)
        return nonEmptyString(siblings[0].pane_id, "Herdr Subagent pane id");
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
export async function startManagedSubagent(host, agent, pane, launch, options, hooks = {}) {
    assertAgentName(agent);
    const name = nonEmptyString(agent, "Herdr agent name");
    const paneId = nonEmptyString(pane, "Herdr agent pane");
    const existing = await getManagedSubagent(host, name, options);
    if (existing) {
        assertAgentPane(name, paneId, existing);
        return "existing";
    }
    await hooks.beforeStart?.();
    const arguments_ = ["agent", "start", name, "--kind", "pi", "--pane", paneId, "--", ...launch.args];
    const herdr = createHerdrClient(options.execute);
    for (let attempt = 1; attempt <= 5; attempt += 1) {
        const result = await herdr.exec(arguments_, { cwd: host.cwd });
        if (result.code === 0 && !result.killed) {
            await hooks.onStarted?.();
            return "started";
        }
        if (hasHerdrErrorCode(result, "agent_name_taken")) {
            const raced = await getManagedSubagent(host, name, options);
            if (!raced)
                throw new Error(`Herdr agent ${name} reported agent_name_taken but could not be found; refusing to start a duplicate`);
            assertAgentPane(name, paneId, raced);
            return "existing";
        }
        if (!hasHerdrErrorCode(result, "agent_pane_busy") || attempt === 5) {
            throw new Error(herdrCommandFailure(arguments_, result));
        }
        await (options.delay ?? delay)(250);
    }
    throw new Error(`Herdr agent ${name} could not be started`);
}
export async function promptManagedSubagent(host, agent, prompt, options) {
    assertAgentName(agent);
    const text = typeof prompt === "string" ? nonEmptyString(prompt, "Subagent prompt") : JSON.stringify(prompt);
    await createHerdrClient(options.execute).run(["agent", "prompt", agent, text], { cwd: host.cwd });
}
export async function retireManagedSubagentTab(host, tabId, options) {
    const id = nonEmptyString(tabId, "Herdr tab id");
    try {
        if (!(await managedSubagentTabExists(host, id, options)))
            return;
        await createHerdrClient(options.execute).run(["tab", "close", id], { cwd: host.cwd });
    }
    catch (error) {
        if (!(await confirmsTabAbsent(host, id, options)))
            throw error;
    }
}
function assertAgentName(agent) {
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(agent))
        throw new Error(`Invalid Herdr agent name: ${agent}`);
}
function object(value, label) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error(`${label} must be an object`);
    return value;
}
function array(value, label) {
    if (!Array.isArray(value))
        throw new Error(`${label} must be an array`);
    return value;
}
function nonEmptyString(value, label) {
    if (typeof value !== "string")
        throw new Error(`${label} must be a string`);
    if (!value.trim() || value.includes("\0"))
        throw new Error(`${label} must not be empty`);
    return value;
}
async function listTabs(cwd, options) {
    const response = await createHerdrClient(options.execute).json(["tab", "list"], { cwd });
    return array(object(object(response, "Herdr tab list response").result, "Herdr tab list result").tabs, "Herdr tabs");
}
async function listPanes(cwd, options) {
    const response = await createHerdrClient(options.execute).json(["pane", "list"], { cwd });
    return array(object(object(response, "Herdr pane list response").result, "Herdr pane list result").panes, "Herdr panes");
}
async function getManagedSubagent(host, name, options) {
    const arguments_ = ["agent", "get", name];
    const result = await createHerdrClient(options.execute).exec(arguments_, { cwd: host.cwd });
    if (result.code !== 0 || result.killed) {
        if (hasHerdrErrorCode(result, "agent_not_found"))
            return undefined;
        throw new Error(herdrCommandFailure(arguments_, result));
    }
    const response = object(JSON.parse(result.stdout), "Herdr agent get response");
    return object(object(response.result, "Herdr agent get result").agent, `Herdr agent ${name}`);
}
function assertAgentPane(name, expected, agent) {
    const actual = typeof agent.pane_id === "string" ? agent.pane_id : "missing";
    if (actual !== expected) {
        throw new Error(`Herdr agent name collision for ${name}: expected pane ${expected}, found ${actual}; refusing to reuse or replace it`);
    }
}
async function confirmsTabAbsent(host, tabId, options) {
    try {
        const result = await createHerdrClient(options.execute).exec(["tab", "get", tabId], { cwd: host.cwd });
        return !result.killed && result.code !== 0 && hasHerdrErrorCode(result, "tab_not_found");
    }
    catch {
        return false;
    }
}
async function delay(milliseconds) {
    await new Promise((done) => { setTimeout(done, milliseconds); });
}
