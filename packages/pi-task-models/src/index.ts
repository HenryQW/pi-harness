import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

export const PROFILE_NAMES = ["fast", "balanced", "frontier", "fav"] as const;
export type ProfileName = (typeof PROFILE_NAMES)[number];

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/** A consumer-owned independently executed model operation. */
export type ModelTask = Readonly<{
	id: string;
	label: string;
	purpose: string;
	defaultProfile: ProfileName;
}>;

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
	/** Explicit user overrides only; consumer defaults are declared at runtime. */
	tasks: Record<string, ProfileName>;
};

export type AvailableModel = ReturnType<ExtensionContext["modelRegistry"]["getAvailable"]>[number];

export type ResolvedTaskRoute = {
	model: AvailableModel;
	thinkingLevel: ThinkingLevel;
};

const CODEX_ALIAS = /^openai-codex-(?:[2-9]|[1-9]\d+)$/;
const CONFIG_FILE = "pi-task-models.json";
const MODEL_TASK_REQUEST_EVENT = "@henryqw/pi-task-models:model-task-request";
const MODEL_TASK_RESPONSE_EVENT = "@henryqw/pi-task-models:model-task-response";
const registeredModelTasks = new WeakMap<object, Map<string, ModelTask>>();
let modelTaskRequestNumber = 0;

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

function hasRequiredKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	return hasOnlyKeys(value, keys) && keys.every((key) => Object.hasOwn(value, key));
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

function isNonEmptyText(value: unknown): value is string {
	return typeof value === "string"
		&& value === value.trim()
		&& value.length > 0
		&& !/[\u0000-\u001f\u007f-\u009f]/.test(value);
}

function parseModelTask(value: unknown): ModelTask | undefined {
	try {
		if (!value || typeof value !== "object" || Array.isArray(value)) return;
		const task = value as Record<string, unknown>;
		if (
			!hasRequiredKeys(task, ["id", "label", "purpose", "defaultProfile"])
			|| !isNonEmptyText(task.id)
			|| !isTaskId(task.id)
			|| !isNonEmptyText(task.label)
			|| !isNonEmptyText(task.purpose)
			|| !isProfileName(task.defaultProfile)
		) return;
		return {
			id: task.id,
			label: task.label,
			purpose: task.purpose,
			defaultProfile: task.defaultProfile,
		};
	} catch {
		return;
	}
}

function validatedModelTask(value: unknown): ModelTask {
	const task = parseModelTask(value);
	if (!task) throw new Error("Model Task declaration is invalid.");
	return task;
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
	const tasks: Record<string, ProfileName> = {};

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
			return { profiles: {}, tasks: {} };
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

export function availableTaskModels(ctx: ExtensionContext): AvailableModel[] {
	const scopedModels = ctx.scopedModels ?? [];
	return dedupeAvailableModels(
		(scopedModels.length ? scopedModels.map(({ model }) => model) : ctx.modelRegistry.getAvailable())
			.filter((model) => model.input.includes("text")),
		ctx.model?.provider,
	);
}

export function taskThinkingLevels(ctx: ExtensionContext, model: AvailableModel): ThinkingLevel[] {
	const supported = getSupportedThinkingLevels(model) as ThinkingLevel[];
	const pinned = (ctx.scopedModels ?? []).find(({ model: scoped }) =>
		scoped.provider === model.provider && scoped.id === model.id)?.thinkingLevel;
	if (!pinned) return supported;
	return supported.includes(pinned as ThinkingLevel) ? [pinned as ThinkingLevel] : [];
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
	// An explicit requested level wins over the profile level; a model
	// that cannot honor it is skipped so later fallback routes get considered.
	if (thinking !== undefined) {
		return levels.includes(thinking) ? { model, thinkingLevel: thinking } : undefined;
	}
	if (!levels.includes(route.thinkingLevel)) return undefined;
	return { model, thinkingLevel: route.thinkingLevel };
}

export function resolveConfiguredTaskRoutes(
	ctx: ExtensionContext,
	task: ModelTask,
	agentDir = getAgentDir(),
	thinking?: ThinkingLevel,
): ResolvedTaskRoute[] {
	const declaration = validatedModelTask(task);
	let config: TaskModelsConfig;
	try {
		config = readTaskModelsConfig(agentDir);
	} catch {
		throw taskRouteError("config-read", "Couldn't read task model config. Run /task-models.");
	}
	const profileName = config.tasks[declaration.id] ?? declaration.defaultProfile;
	const profile = config.profiles[profileName];
	if (!profile) throw taskRouteError("profile-missing", `Task ${declaration.id} profile ${profileName} is not configured. Run /task-models.`, profileName);
	const routes: ResolvedTaskRoute[] = [];
	for (const route of orderedProfileRoutes(profile)) {
		const resolved = resolveTaskModelRoute(ctx, route, agentDir, thinking);
		if (resolved) routes.push(resolved);
	}
	if (!routes.length) {
		throw taskRouteError(
			"no-route",
			`Task ${declaration.id} profile ${profileName} has no available route${thinking ? ` supporting thinking ${thinking}` : ""}. Run /task-models.`,
			profileName,
		);
	}
	return routes;
}

// Machine-readable cause so consumers can render their own user-facing wording.
export type TaskRouteErrorCode = "config-read" | "profile-missing" | "no-route";
export type TaskRouteError = Error & { taskRouteCode: TaskRouteErrorCode; profileName?: ProfileName };

function taskRouteError(taskRouteCode: TaskRouteErrorCode, message: string, profileName?: ProfileName): TaskRouteError {
	return Object.assign(new Error(message), { taskRouteCode, ...(profileName ? { profileName } : {}) });
}

export function resolveConfiguredTaskRoute(
	ctx: ExtensionContext,
	task: ModelTask,
	agentDir = getAgentDir(),
	thinking?: ThinkingLevel,
): ResolvedTaskRoute {
	return resolveConfiguredTaskRoutes(ctx, task, agentDir, thinking)[0];
}

export function orderedProfileRoutes(profile: TaskModelProfile): TaskModelRoute[] {
	return profile.fallback ? [profile.primary, profile.fallback] : [profile.primary];
}

function sameModelTask(left: ModelTask, right: ModelTask): boolean {
	return left.id === right.id
		&& left.label === right.label
		&& left.purpose === right.purpose
		&& left.defaultProfile === right.defaultProfile;
}

type ModelTaskDiscoveryRequest = { requestId: string };
type ModelTaskDiscoveryResponse = ModelTaskDiscoveryRequest & { task: ModelTask };

function parseModelTaskDiscoveryRequest(value: unknown): ModelTaskDiscoveryRequest | undefined {
	try {
		if (!value || typeof value !== "object" || Array.isArray(value)) return;
		const request = value as Record<string, unknown>;
		return hasRequiredKeys(request, ["requestId"]) && isNonEmptyText(request.requestId)
			? { requestId: request.requestId }
			: undefined;
	} catch {
		return;
	}
}

function parseModelTaskDiscoveryResponse(value: unknown): ModelTaskDiscoveryResponse | undefined {
	try {
		if (!value || typeof value !== "object" || Array.isArray(value)) return;
		const response = value as Record<string, unknown>;
		if (!hasRequiredKeys(response, ["requestId", "task"]) || !isNonEmptyText(response.requestId)) return;
		const task = parseModelTask(response.task);
		return task ? { requestId: response.requestId, task } : undefined;
	} catch {
		return;
	}
}

/** Register one consumer-owned declaration for on-demand control-plane discovery. */
export function registerModelTask(pi: Pick<ExtensionAPI, "events">, declaration: ModelTask): void {
	const task = validatedModelTask(declaration);
	let tasks = registeredModelTasks.get(pi);
	if (!tasks) {
		tasks = new Map();
		registeredModelTasks.set(pi, tasks);
	}
	const existing = tasks.get(task.id);
	if (existing) {
		if (!sameModelTask(existing, task)) throw new Error(`Conflicting Model Task declaration: ${task.id}.`);
		return;
	}
	tasks.set(task.id, task);
	pi.events.on(MODEL_TASK_REQUEST_EVENT, (payload) => {
		// Event payloads cross extension boundaries and are not trusted.
		const request = parseModelTaskDiscoveryRequest(payload);
		if (!request) return;
		pi.events.emit(MODEL_TASK_RESPONSE_EVENT, { requestId: request.requestId, task });
	});
}

function discoverModelTasks(pi: Pick<ExtensionAPI, "events">): ModelTask[] {
	const requestId = `model-task-${++modelTaskRequestNumber}`;
	const tasks = new Map<string, ModelTask>();
	const conflicts = new Set<string>();
	const off = pi.events.on(MODEL_TASK_RESPONSE_EVENT, (payload) => {
		// Event payloads cross extension boundaries and are not trusted.
		const response = parseModelTaskDiscoveryResponse(payload);
		if (!response || response.requestId !== requestId) return;
		const existing = tasks.get(response.task.id);
		if (existing && !sameModelTask(existing, response.task)) conflicts.add(response.task.id);
		else tasks.set(response.task.id, response.task);
	});
	try {
		pi.events.emit(MODEL_TASK_REQUEST_EVENT, { requestId });
	} finally {
		off();
	}
	if (conflicts.size) throw new Error(`Conflicting Model Task declarations: ${[...conflicts].join(", ")}.`);
	return [...tasks.values()].sort((left, right) => left.id.localeCompare(right.id));
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
			const taskOptions = discoverModelTasks(pi).map((task) => {
				const profile = config.tasks[task.id] ?? task.defaultProfile;
				return { task, label: `${task.label} · ${task.id} · ${profile}` };
			});
			const selected = await ctx.ui.select("Task models", [
				...profileOptions.map(({ label }) => label),
				...taskOptions.map(({ label }) => label),
			]);
			if (!selected) return;

			const task = taskOptions.find(({ label }) => label === selected)?.task;
			if (task) {
				const profile = await ctx.ui.select(`${task.label}: ${task.purpose}`, [...PROFILE_NAMES]);
				if (!isProfileName(profile)) return;
				if (profile === task.defaultProfile) delete config.tasks[task.id];
				else config.tasks[task.id] = profile;
				if (!save()) return;
				ctx.ui.notify(`${task.id} assigned to ${profile}.`, "info");
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

export default createTaskModelsExtension;
