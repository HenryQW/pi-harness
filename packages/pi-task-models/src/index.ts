import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

export const PROFILE_NAMES = ["fast", "balanced", "frontier", "fav"] as const;
export type ProfileName = (typeof PROFILE_NAMES)[number];

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export const DEFAULT_TASK_ASSIGNMENTS = {
	"pi-herdr-btw/btw": "fast",
	"pi-herdr-rename/rename": "fast",
	"pi-auto-compact/autoCompact": "fast",
	"pi-subagent/delegateTask": "balanced",
	"pi-auto-dag/implement": "balanced",
	"pi-auto-dag/review": "frontier",
} as const satisfies Readonly<Record<string, ProfileName>>;

export type TaskModelRoute = {
	model: string;
	thinkingLevel: ThinkingLevel;
};

export type TaskModelProfile = {
	primary: TaskModelRoute;
	fallback?: TaskModelRoute;
};

export type TaskModelsConfig = {
	profiles: Partial<Record<ProfileName, TaskModelProfile>>;
	tasks: Record<string, ProfileName>;
};

export type AvailableModel = ReturnType<ExtensionContext["modelRegistry"]["getAvailable"]>[number];

export type ResolvedTaskRoute = {
	model: AvailableModel;
	thinkingLevel: ThinkingLevel;
};

export type ActiveTaskPackage = {
	packageName: string;
	task: string;
};

const CODEX_ALIAS = /^openai-codex-(?:[2-9]|[1-9]\d+)$/;
const CONFIG_FILE = "pi-task-models.json";
// Owned by @henryqw/pi-model-thinking; keys use the same canonical provider/model form.
const MODEL_THINKING_CONFIG_FILE = "pi-model-thinking.json";

const defaultTaskAssignments = (): Record<string, ProfileName> => ({ ...DEFAULT_TASK_ASSIGNMENTS });

export const configPath = (agentDir = getAgentDir()): string => join(agentDir, "config", CONFIG_FILE);

function isCodexProvider(provider: string | undefined): boolean {
	return provider === "openai-codex" || Boolean(provider && CODEX_ALIAS.test(provider));
}

function isProfileName(value: unknown): value is ProfileName {
	return typeof value === "string" && (PROFILE_NAMES as readonly string[]).includes(value);
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	return Object.keys(value).every((key) => keys.includes(key));
}

function isModelReference(value: unknown): value is string {
	return typeof value === "string"
		&& value === value.trim()
		&& !value.includes("\0")
		&& /^[^\s/]+\/\S+$/.test(value);
}

function isTaskId(value: string): boolean {
	return /^[a-z0-9][a-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9-]*$/.test(value);
}

function isTaskRoute(value: unknown): value is TaskModelRoute {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const route = value as Record<string, unknown>;
	return hasOnlyKeys(route, ["model", "thinkingLevel"])
		&& isModelReference(route.model)
		&& isThinkingLevel(route.thinkingLevel);
}

function isTaskProfile(value: unknown): value is TaskModelProfile {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const profile = value as Record<string, unknown>;
	return hasOnlyKeys(profile, ["primary", "fallback"])
		&& isTaskRoute(profile.primary)
		&& (profile.fallback === undefined || isTaskRoute(profile.fallback));
}

function normalizeRoute(route: TaskModelRoute): TaskModelRoute {
	return { model: canonicalModelReference(route.model), thinkingLevel: route.thinkingLevel };
}

function normalizeConfig(config: TaskModelsConfig): TaskModelsConfig {
	return {
		profiles: Object.fromEntries(Object.entries(config.profiles).map(([name, profile]) => [name, {
			primary: normalizeRoute(profile.primary),
			...(profile.fallback ? { fallback: normalizeRoute(profile.fallback) } : {}),
		}])),
		tasks: { ...config.tasks },
	};
}

function parseConfig(value: unknown): TaskModelsConfig {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Config must be an object.");
	const record = value as Record<string, unknown>;
	if (!hasOnlyKeys(record, ["profiles", "tasks"])) throw new Error("Config contains unknown settings.");
	const profiles: TaskModelsConfig["profiles"] = {};
	const tasks: Record<string, ProfileName> = defaultTaskAssignments();

	if (record.profiles !== undefined) {
		if (!record.profiles || typeof record.profiles !== "object" || Array.isArray(record.profiles)) {
			throw new Error("profiles must be an object.");
		}
		for (const [name, profile] of Object.entries(record.profiles as Record<string, unknown>)) {
			if (!(PROFILE_NAMES as readonly string[]).includes(name)) throw new Error(`Unknown profile: ${name}.`);
			if (!isTaskProfile(profile)) throw new Error(`${name} profile is invalid.`);
			const profileName = name as ProfileName;
			if (profileName === "fav" && profile.fallback) throw new Error("fav profile has no fallback.");
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
		for (const [task, profile] of Object.entries(record.tasks as Record<string, unknown>)) {
			if (!isTaskId(task) || !isProfileName(profile)) throw new Error(`Invalid profile assignment for ${task}.`);
			tasks[task] = profile;
		}
	}

	return { profiles, tasks };
}

export function readTaskModelsConfig(agentDir = getAgentDir()): TaskModelsConfig {
	try {
		const value: unknown = JSON.parse(readFileSync(configPath(agentDir), "utf8"));
		return parseConfig(value);
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
			return { profiles: {}, tasks: defaultTaskAssignments() };
		}
		throw error;
	}
}

export function writeTaskModelsConfig(config: TaskModelsConfig, agentDir = getAgentDir()): void {
	if (config.profiles.fav?.fallback) throw new Error("fav profile has no fallback.");
	const file = configPath(agentDir);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, `${JSON.stringify(normalizeConfig(config), null, 2)}\n`);
}

export function canonicalModelReference(model: { provider: string; id: string } | string): string {
	const reference = typeof model === "string" ? model : `${model.provider}/${model.id}`;
	if (!isModelReference(reference)) throw new Error("Model reference must be provider/model without whitespace.");
	const separator = reference.indexOf("/");
	const provider = reference.slice(0, separator);
	const id = reference.slice(separator + 1);
	return `${isCodexProvider(provider) ? "openai-codex" : provider}/${id}`;
}

export function modelReference(model: { provider: string; id: string }): string {
	return `${model.provider}/${model.id}`;
}

export function dedupeAvailableModels(models: readonly AvailableModel[], preferredProvider?: string): AvailableModel[] {
	const deduped: AvailableModel[] = [];
	const indexes = new Map<string, number>();
	for (const model of models) {
		const key = canonicalModelReference(model);
		const index = indexes.get(key);
		if (index === undefined) {
			indexes.set(key, deduped.length);
			deduped.push(model);
			continue;
		}
		const current = deduped[index];
		if (shouldPreferModel(model, current, preferredProvider)) deduped[index] = model;
	}
	return deduped;
}

function shouldPreferModel(candidate: AvailableModel, current: AvailableModel, preferredProvider?: string): boolean {
	if (preferredProvider && candidate.provider === preferredProvider && current.provider !== preferredProvider) return true;
	if (preferredProvider && current.provider === preferredProvider && candidate.provider !== preferredProvider) return false;
	const candidateAlias = CODEX_ALIAS.test(candidate.provider);
	const currentAlias = CODEX_ALIAS.test(current.provider);
	if (candidateAlias !== currentAlias) return candidateAlias;
	return false;
}

export function resolveAvailableModel(
	models: readonly AvailableModel[],
	reference: string,
	preferredProvider?: string,
): AvailableModel | undefined {
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

export function supportedThinkingLevels(model: AvailableModel): ThinkingLevel[] {
	return getSupportedThinkingLevels(model) as ThinkingLevel[];
}

export function availableTaskModels(ctx: ExtensionContext): AvailableModel[] {
	const scopedModels = ctx.scopedModels ?? [];
	return dedupeAvailableModels(
		(scopedModels.length ? scopedModels.map(({ model }) => model) : ctx.modelRegistry.getAvailable())
			.filter((model) => model.input.includes("text")),
		ctx.model?.provider,
	);
}

export function taskThinkingLevels(ctx: ExtensionContext, model: AvailableModel): ThinkingLevel[] {
	const supported = supportedThinkingLevels(model);
	const pinned = (ctx.scopedModels ?? []).find(({ model: scoped }) =>
		scoped.provider === model.provider && scoped.id === model.id)?.thinkingLevel;
	if (!pinned) return supported;
	return supported.includes(pinned as ThinkingLevel) ? [pinned as ThinkingLevel] : [];
}

// pi-model-thinking's config is untrusted user data; keep only recognized levels for this model.
export function rememberedThinkingLevel(
	model: { provider: string; id: string } | string,
	agentDir = getAgentDir(),
): ThinkingLevel | undefined {
	try {
		const value: unknown = JSON.parse(readFileSync(join(agentDir, "config", MODEL_THINKING_CONFIG_FILE), "utf8"));
		if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
		const level = (value as Record<string, unknown>)[canonicalModelReference(model)];
		return isThinkingLevel(level) ? level : undefined;
	} catch {
		return undefined;
	}
}

export function resolveTaskModelRoute(
	ctx: ExtensionContext,
	route: TaskModelRoute,
	agentDir = getAgentDir(),
	thinking?: ThinkingLevel,
): ResolvedTaskRoute | undefined {
	const model = resolveAvailableModel(availableTaskModels(ctx), route.model, ctx.model?.provider);
	if (!model) return undefined;
	const levels = taskThinkingLevels(ctx, model);
	// An explicit requested level wins over remembered and profile levels; a model
	// that cannot honor it is skipped so later fallback routes get considered.
	if (thinking !== undefined) {
		return levels.includes(thinking) ? { model, thinkingLevel: thinking } : undefined;
	}
	// Remembered per-model thinking (pi-model-thinking) wins over the profile level when supported.
	const remembered = rememberedThinkingLevel(model, agentDir);
	const thinkingLevel = remembered && levels.includes(remembered) ? remembered : route.thinkingLevel;
	if (!levels.includes(thinkingLevel)) return undefined;
	return { model, thinkingLevel };
}

export function resolveConfiguredTaskRoute(
	ctx: ExtensionContext,
	task: string,
	agentDir = getAgentDir(),
	thinking?: ThinkingLevel,
): ResolvedTaskRoute {
	let config: TaskModelsConfig;
	try {
		config = readTaskModelsConfig(agentDir);
	} catch {
		throw new Error("Couldn't read task model config. Run /task-models.");
	}
	const profileName = config.tasks[task];
	if (!profileName) throw new Error(`Task ${task} is not assigned to a profile. Run /task-models.`);
	const profile = config.profiles[profileName];
	if (!profile) throw new Error(`Task ${task} profile ${profileName} is not configured. Run /task-models.`);
	for (const route of orderedProfileRoutes(profile)) {
		const resolved = resolveTaskModelRoute(ctx, route, agentDir, thinking);
		if (resolved) return resolved;
	}
	throw new Error(`Task ${task} profile ${profileName} has no available route${thinking ? ` supporting thinking ${thinking}` : ""}. Run /task-models.`);
}

export function orderedProfileRoutes(profile: TaskModelProfile): TaskModelRoute[] {
	return profile.fallback ? [profile.primary, profile.fallback] : [profile.primary];
}

export function activeTaskPackages(
	pi: Pick<ExtensionAPI, "getCommands" | "getAllTools">,
	tasks: Readonly<Record<string, ProfileName>> = DEFAULT_TASK_ASSIGNMENTS,
): ActiveTaskPackage[] {
	const sources = [
		...pi.getCommands().map((command) => command.sourceInfo),
		...pi.getAllTools().map((tool) => tool.sourceInfo),
	];
	return Object.keys(tasks).flatMap((task) => {
		if (!isTaskId(task)) return [];
		const packageName = `@henryqw/${task.slice(0, task.indexOf("/"))}`;
		return sources.some((source) => sourceMatchesPackage(source, packageName))
			? [{ packageName, task }]
			: [];
	});
}

function sourceMatchesPackage(sourceInfo: { source: string; path: string }, packageName: string): boolean {
	const npmSource = `npm:${packageName}`;
	if (sourceInfo.source === packageName || sourceInfo.source === npmSource || sourceInfo.source.startsWith(`${npmSource}@`)) return true;
	const path = sourceInfo.path.replaceAll("\\", "/");
	const shortName = packageName.split("/").pop();
	return path.includes(`/node_modules/${packageName}/`)
		|| Boolean(shortName && path.includes(`/packages/${shortName}/`));
}

export function createTaskModelsExtension(
	pi: ExtensionAPI,
	options?: { agentDir?: string },
): void {
	const agentDir = options?.agentDir ?? getAgentDir();
	pi.registerCommand("task-models", {
		description: "configure shared task model profiles",
		handler: async (_args, ctx) => {
			let config: TaskModelsConfig;
			try {
				config = readTaskModelsConfig(agentDir);
			} catch {
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
			const save = (): boolean => {
				try {
					writeTaskModelsConfig(config, agentDir);
					return true;
				} catch {
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
			if (!selected) return;

			const task = taskOptions.find(({ label }) => label === selected)?.entry;
			if (task) {
				const profile = await ctx.ui.select(`${task.task} profile`, [...PROFILE_NAMES]);
				if (!isProfileName(profile)) return;
				config.tasks[task.task] = profile;
				if (!save()) return;
				ctx.ui.notify(`${task.task} assigned to ${profile}.`, "info");
				return;
			}

			const profile = profileOptions.find(({ label }) => label === selected)?.name;
			if (!profile) return;
			const models = availableTaskModels(ctx);
			if (!models.length) {
				ctx.ui.notify("No text models are available.", "error");
				return;
			}
			const primary = await selectRoute(ctx, `Profile ${profile} primary`, models);
			if (!primary) return;
			if (profile === "fav") {
				config.profiles[profile] = { primary };
			} else {
				const fallbackModels = models.filter((model) => canonicalModelReference(model) !== primary.model);
				const fallbackModel = await ctx.ui.select(`Profile ${profile} fallback`, [
					"None",
					...fallbackModels.map((model) => modelReference(model)),
				]);
				if (!fallbackModel) return;
				const fallback = fallbackModel === "None"
					? undefined
					: await selectThinkingLevel(ctx, `Profile ${profile} fallback`, fallbackModels, fallbackModel);
				if (fallbackModel !== "None" && !fallback) return;

				config.profiles[profile] = { primary, ...(fallback ? { fallback } : {}) };
			}
			if (!save()) return;
			ctx.ui.notify(`${profile} profile saved.`, "info");
		},
	});
}

function routeLabel(route: TaskModelRoute): string {
	return `${route.model} (${route.thinkingLevel})`;
}

async function selectRoute(
	ctx: ExtensionContext,
	title: string,
	models: AvailableModel[],
): Promise<TaskModelRoute | undefined> {
	const selectedModel = await ctx.ui.select(title, models.map((model) => modelReference(model)));
	return selectedModel ? selectThinkingLevel(ctx, title, models, selectedModel) : undefined;
}

async function selectThinkingLevel(
	ctx: ExtensionContext,
	title: string,
	models: AvailableModel[],
	selectedModel: string,
): Promise<TaskModelRoute | undefined> {
	const model = models.find((candidate) => modelReference(candidate) === selectedModel);
	if (!model) return;
	const thinkingLevel = await ctx.ui.select(`${title} thinking`, taskThinkingLevels(ctx, model));
	if (!isThinkingLevel(thinkingLevel)) return;
	return { model: canonicalModelReference(model), thinkingLevel };
}

export default function taskModelsExtension(pi: ExtensionAPI): void {
	createTaskModelsExtension(pi);
}
