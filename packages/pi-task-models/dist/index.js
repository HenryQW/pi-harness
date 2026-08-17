import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
export const PROFILE_NAMES = ["fast", "balanced", "frontier"];
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
export const DEFAULT_TASK_ASSIGNMENTS = {
    "pi-herdr-rename/rename": "fast",
    "pi-auto-compact/autoCompact": "balanced",
    "pi-subagent/delegateTask": "balanced",
};
const CODEX_ALIAS = /^openai-codex-(?:[2-9]|[1-9]\d+)$/;
const CONFIG_FILE = "pi-task-models.json";
const defaultTaskAssignments = () => ({ ...DEFAULT_TASK_ASSIGNMENTS });
export const configPath = (agentDir = getAgentDir()) => join(agentDir, "config", CONFIG_FILE);
function isCodexProvider(provider) {
    return provider === "openai-codex" || Boolean(provider && CODEX_ALIAS.test(provider));
}
function isProfileName(value) {
    return typeof value === "string" && PROFILE_NAMES.includes(value);
}
function isThinkingLevel(value) {
    return typeof value === "string" && THINKING_LEVELS.includes(value);
}
function hasOnlyKeys(value, keys) {
    return Object.keys(value).every((key) => keys.includes(key));
}
function isModelReference(value) {
    return typeof value === "string"
        && value === value.trim()
        && !value.includes("\0")
        && /^[^\s/]+\/\S+$/.test(value);
}
function isTaskId(value) {
    return /^[a-z0-9][a-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9-]*$/.test(value);
}
function isTaskRoute(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return false;
    const route = value;
    return hasOnlyKeys(route, ["model", "thinkingLevel"])
        && isModelReference(route.model)
        && isThinkingLevel(route.thinkingLevel);
}
function isTaskProfile(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return false;
    const profile = value;
    return hasOnlyKeys(profile, ["primary", "fallback"])
        && isTaskRoute(profile.primary)
        && (profile.fallback === undefined || isTaskRoute(profile.fallback));
}
function normalizeRoute(route) {
    return { model: canonicalModelReference(route.model), thinkingLevel: route.thinkingLevel };
}
function normalizeConfig(config) {
    return {
        profiles: Object.fromEntries(Object.entries(config.profiles).map(([name, profile]) => [name, {
                primary: normalizeRoute(profile.primary),
                ...(profile.fallback ? { fallback: normalizeRoute(profile.fallback) } : {}),
            }])),
        tasks: { ...config.tasks },
    };
}
function parseConfig(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("Config must be an object.");
    const record = value;
    if (!hasOnlyKeys(record, ["profiles", "tasks"]))
        throw new Error("Config contains unknown settings.");
    const profiles = {};
    const tasks = defaultTaskAssignments();
    if (record.profiles !== undefined) {
        if (!record.profiles || typeof record.profiles !== "object" || Array.isArray(record.profiles)) {
            throw new Error("profiles must be an object.");
        }
        for (const [name, profile] of Object.entries(record.profiles)) {
            if (!PROFILE_NAMES.includes(name))
                throw new Error(`Unknown profile: ${name}.`);
            if (!isTaskProfile(profile))
                throw new Error(`${name} profile is invalid.`);
            const profileName = name;
            profiles[profileName] = {
                primary: normalizeRoute(profile.primary),
                ...(profile.fallback ? { fallback: normalizeRoute(profile.fallback) } : {}),
            };
        }
    }
    if (record.tasks !== undefined) {
        if (!record.tasks || typeof record.tasks !== "object" || Array.isArray(record.tasks)) {
            throw new Error("tasks must be an object.");
        }
        for (const [task, profile] of Object.entries(record.tasks)) {
            if (!isTaskId(task) || !isProfileName(profile))
                throw new Error(`Invalid profile assignment for ${task}.`);
            tasks[task] = profile;
        }
    }
    return { profiles, tasks };
}
export function readTaskModelsConfig(agentDir = getAgentDir()) {
    try {
        const value = JSON.parse(readFileSync(configPath(agentDir), "utf8"));
        return parseConfig(value);
    }
    catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
            return { profiles: {}, tasks: defaultTaskAssignments() };
        }
        throw error;
    }
}
export function writeTaskModelsConfig(config, agentDir = getAgentDir()) {
    const file = configPath(agentDir);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(normalizeConfig(config), null, 2)}\n`);
}
export function canonicalModelReference(model) {
    const reference = typeof model === "string" ? model : `${model.provider}/${model.id}`;
    if (!isModelReference(reference))
        throw new Error("Model reference must be provider/model without whitespace.");
    const separator = reference.indexOf("/");
    const provider = reference.slice(0, separator);
    const id = reference.slice(separator + 1);
    return `${isCodexProvider(provider) ? "openai-codex" : provider}/${id}`;
}
export function modelReference(model) {
    return `${model.provider}/${model.id}`;
}
export function dedupeAvailableModels(models, preferredProvider) {
    const deduped = [];
    const indexes = new Map();
    for (const model of models) {
        const key = canonicalModelReference(model);
        const index = indexes.get(key);
        if (index === undefined) {
            indexes.set(key, deduped.length);
            deduped.push(model);
            continue;
        }
        const current = deduped[index];
        if (shouldPreferModel(model, current, preferredProvider))
            deduped[index] = model;
    }
    return deduped;
}
function shouldPreferModel(candidate, current, preferredProvider) {
    if (preferredProvider && candidate.provider === preferredProvider && current.provider !== preferredProvider)
        return true;
    if (preferredProvider && current.provider === preferredProvider && candidate.provider !== preferredProvider)
        return false;
    const candidateAlias = CODEX_ALIAS.test(candidate.provider);
    const currentAlias = CODEX_ALIAS.test(current.provider);
    if (candidateAlias !== currentAlias)
        return candidateAlias;
    return false;
}
export function resolveAvailableModel(models, reference, preferredProvider) {
    const canonical = canonicalModelReference(reference);
    const separator = canonical.indexOf("/");
    const provider = canonical.slice(0, separator);
    const id = canonical.slice(separator + 1);
    if (provider !== "openai-codex") {
        return models.find((model) => canonicalModelReference(model) === canonical);
    }
    return (preferredProvider && isCodexProvider(preferredProvider)
        ? models.find((model) => model.provider === preferredProvider && model.id === id)
        : undefined)
        ?? models.find((model) => CODEX_ALIAS.test(model.provider) && model.id === id)
        ?? models.find((model) => model.provider === "openai-codex" && model.id === id);
}
export function supportedThinkingLevels(model) {
    return getSupportedThinkingLevels(model);
}
export function availableTaskModels(ctx) {
    const scopedModels = ctx.scopedModels ?? [];
    return dedupeAvailableModels((scopedModels.length ? scopedModels.map(({ model }) => model) : ctx.modelRegistry.getAvailable())
        .filter((model) => model.input.includes("text")), ctx.model?.provider);
}
export function taskThinkingLevels(ctx, model) {
    const supported = supportedThinkingLevels(model);
    const pinned = (ctx.scopedModels ?? []).find(({ model: scoped }) => scoped.provider === model.provider && scoped.id === model.id)?.thinkingLevel;
    if (!pinned)
        return supported;
    return supported.includes(pinned) ? [pinned] : [];
}
export function resolveTaskModelRoute(ctx, route) {
    const model = resolveAvailableModel(availableTaskModels(ctx), route.model, ctx.model?.provider);
    return model && taskThinkingLevels(ctx, model).includes(route.thinkingLevel)
        ? { model, thinkingLevel: route.thinkingLevel }
        : undefined;
}
export function orderedProfileRoutes(profile) {
    return profile.fallback ? [profile.primary, profile.fallback] : [profile.primary];
}
export function activeTaskPackages(pi, tasks = DEFAULT_TASK_ASSIGNMENTS) {
    const sources = [
        ...pi.getCommands().map((command) => command.sourceInfo),
        ...pi.getAllTools().map((tool) => tool.sourceInfo),
    ];
    return Object.keys(tasks).flatMap((task) => {
        if (!isTaskId(task))
            return [];
        const packageName = `@henryqw/${task.slice(0, task.indexOf("/"))}`;
        return sources.some((source) => sourceMatchesPackage(source, packageName))
            ? [{ packageName, task }]
            : [];
    });
}
function sourceMatchesPackage(sourceInfo, packageName) {
    const npmSource = `npm:${packageName}`;
    if (sourceInfo.source === packageName || sourceInfo.source === npmSource || sourceInfo.source.startsWith(`${npmSource}@`))
        return true;
    const path = sourceInfo.path.replaceAll("\\", "/");
    const shortName = packageName.split("/").pop();
    return path.includes(`/node_modules/${packageName}/`)
        || Boolean(shortName && path.includes(`/packages/${shortName}/`));
}
export function createTaskModelsExtension(pi, options) {
    const agentDir = options?.agentDir ?? getAgentDir();
    pi.registerCommand("task-models", {
        description: "configure shared task model profiles",
        handler: async (_args, ctx) => {
            let config;
            try {
                config = readTaskModelsConfig(agentDir);
            }
            catch {
                ctx.ui.notify("Couldn't read task model config.", "error");
                return;
            }
            const profileOptions = PROFILE_NAMES.map((name) => {
                const configured = config.profiles[name];
                return {
                    name,
                    label: configured
                        ? `${name} · ${routeLabel(configured.primary)} → ${configured.fallback ? routeLabel(configured.fallback) : "none"}`
                        : `${name} · not configured`,
                };
            });
            const save = () => {
                try {
                    writeTaskModelsConfig(config, agentDir);
                    return true;
                }
                catch {
                    ctx.ui.notify("Couldn't save task model config.", "error");
                    return false;
                }
            };
            const taskOptions = activeTaskPackages(pi, config.tasks).map((entry) => ({
                entry,
                label: `${entry.task} · ${config.tasks[entry.task]}`,
            }));
            const selected = await ctx.ui.select("Task models", [
                ...profileOptions.map(({ label }) => label),
                ...taskOptions.map(({ label }) => label),
            ]);
            if (!selected)
                return;
            const task = taskOptions.find(({ label }) => label === selected)?.entry;
            if (task) {
                const profile = await ctx.ui.select(`${task.task} profile`, [...PROFILE_NAMES]);
                if (!isProfileName(profile))
                    return;
                config.tasks[task.task] = profile;
                if (!save())
                    return;
                ctx.ui.notify(`${task.task} assigned to ${profile}.`, "info");
                return;
            }
            const profile = profileOptions.find(({ label }) => label === selected)?.name;
            if (!profile)
                return;
            const models = availableTaskModels(ctx);
            if (!models.length) {
                ctx.ui.notify("No text models are available.", "error");
                return;
            }
            const primary = await selectRoute(ctx, `Profile ${profile} primary`, models);
            if (!primary)
                return;
            const fallbackModels = models.filter((model) => canonicalModelReference(model) !== primary.model);
            const fallbackModel = await ctx.ui.select(`Profile ${profile} fallback`, [
                "None",
                ...fallbackModels.map((model) => modelReference(model)),
            ]);
            if (!fallbackModel)
                return;
            const fallback = fallbackModel === "None"
                ? undefined
                : await selectThinkingLevel(ctx, `Profile ${profile} fallback`, fallbackModels, fallbackModel);
            if (fallbackModel !== "None" && !fallback)
                return;
            config.profiles[profile] = { primary, ...(fallback ? { fallback } : {}) };
            if (!save())
                return;
            ctx.ui.notify(`${profile} profile saved.`, "info");
        },
    });
}
function routeLabel(route) {
    return `${route.model} (${route.thinkingLevel})`;
}
async function selectRoute(ctx, title, models) {
    const selectedModel = await ctx.ui.select(title, models.map((model) => modelReference(model)));
    return selectedModel ? selectThinkingLevel(ctx, title, models, selectedModel) : undefined;
}
async function selectThinkingLevel(ctx, title, models, selectedModel) {
    const model = models.find((candidate) => modelReference(candidate) === selectedModel);
    if (!model)
        return;
    const thinkingLevel = await ctx.ui.select(`${title} thinking`, taskThinkingLevels(ctx, model));
    if (!isThinkingLevel(thinkingLevel))
        return;
    return { model: canonicalModelReference(model), thinkingLevel };
}
export default function taskModelsExtension(pi) {
    createTaskModelsExtension(pi);
}
