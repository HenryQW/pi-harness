import { isDeepStrictEqual } from "node:util";
import { Container, Key, matchesKey, SelectList, Text } from "@earendil-works/pi-tui";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { getAgentDir, getSelectListTheme, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	createConfigStore,
	field,
	formatConfigIssues,
	parsers,
	registerConfigReporting,
	type ConfigIssue,
	type FieldParser,
} from "@henryqw/pi-config-store";

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

type TaskModelContext = Pick<ExtensionContext, "model" | "scopedModels"> & {
	modelRegistry: Pick<ExtensionContext["modelRegistry"], "getAvailable">;
};

export type ResolvedTaskRoute = {
	model: AvailableModel;
	thinkingLevel: ThinkingLevel;
};

const CODEX_ALIAS = /^openai-codex-(?:[2-9]|[1-9]\d+)$/;
const MODEL_TASK_REQUEST_EVENT = "@henryqw/pi-task-models:model-task-request";
const MODEL_TASK_RESPONSE_EVENT = "@henryqw/pi-task-models:model-task-response";
const registeredModelTasks = new WeakMap<object, Map<string, ModelTask>>();
let modelTaskRequestNumber = 0;

function isCodexProvider(provider: string): boolean {
	return provider === "openai-codex" || CODEX_ALIAS.test(provider);
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

function normalizeRoute(route: TaskModelRoute): TaskModelRoute {
	return { model: canonicalModelReference(route.model), thinkingLevel: route.thinkingLevel };
}

const parseProfile: FieldParser<TaskModelProfile> = (raw) => {
	if (!raw || typeof raw !== "object" || Array.isArray(raw) || !hasOnlyKeys(raw as Record<string, unknown>, ["primary", "fallback"])) {
		throw new Error("must be an object with only primary and optional fallback");
	}
	const { primary, fallback } = raw as Record<string, unknown>;
	for (const [name, route] of [["primary", primary], ["fallback", fallback]] as const) {
		if ((name === "primary" || route !== undefined) && !isTaskRoute(route)) {
			throw new Error(`${name} must contain only a provider/model reference and a thinking level`);
		}
	}
	return {
		primary: normalizeRoute(primary as TaskModelRoute),
		...(fallback ? { fallback: normalizeRoute(fallback as TaskModelRoute) } : {}),
	};
};

const profileNameParser = parsers.oneOf(PROFILE_NAMES);
const parseProfileRecord = parsers.record(parseProfile, { key: profileNameParser });

// A profile name maps to one profile; a bad profile is dropped and reported so others still load.
const parseProfiles: FieldParser<TaskModelsConfig["profiles"]> = (raw, report) => {
	const profiles = parseProfileRecord(raw, report);
	if (profiles.fav?.fallback) {
		report(["fav"], "fav profile has no fallback");
		delete profiles.fav;
	}
	return profiles;
};

const parseTaskId: FieldParser<string> = (raw) => {
	if (typeof raw !== "string" || !isTaskId(raw)) throw new Error("must be a task ID such as pi-package/task");
	return raw;
};

/** `repair` reads the same file without the disable rule, so `/task-models` keeps the settings that loaded. */
function taskModelsConfigStore(agentDir = getAgentDir(), repair = false) {
	return createConfigStore({
		extensionId: "pi-task-models",
		agentDir,
		fields: {
			// No default route exists, so a profile table that cannot load disables routing instead of hiding it.
			profiles: field(parseProfiles, {}, { onInvalid: repair ? "default" : "disable" }),
			tasks: field(parsers.record(profileNameParser, { key: parseTaskId }), {}),
		},
	});
}

const parsePresetName: FieldParser<string> = (raw) => {
	if (!isNonEmptyText(raw)) throw new Error("preset names must be non-empty text without surrounding whitespace or control characters");
	return raw;
};

function taskModelPresetsStore(agentDir = getAgentDir()) {
	return createConfigStore({
		extensionId: "pi-task-models",
		agentDir,
		fileName: "presets.json",
		entries: parsers.record(parseProfiles, { key: parsePresetName }),
	});
}

type TaskModelsConfigStore = ReturnType<typeof taskModelsConfigStore>;
type TaskModelPresetsStore = ReturnType<typeof taskModelPresetsStore>;

function disabledConfigMessage(path: string, issues: readonly ConfigIssue[]): string {
	return `Task model config at ${path} is disabled: ${formatConfigIssues(issues)}. Fix the file or run /task-models.`;
}

/** Load the owner config. Throws when the config is disabled; the error names the path and the issues. */
export function loadTaskModelsConfig(agentDir = getAgentDir()): { source: "file" | "missing"; value: TaskModelsConfig } {
	const store = taskModelsConfigStore(agentDir);
	const loaded = store.loadSync();
	if (loaded.status === "disabled") throw new Error(disabledConfigMessage(store.path, loaded.issues));
	return { source: loaded.source, value: loaded.value };
}

/**
 * Report task-model config issues at each session start, and return a function that reports them after
 * a lazy route resolution. Consumers register it so issues show also without the task-models extension.
 * Every pi-config-store reporter shares one record, so each issue shows one time in each session.
 */
export function registerTaskModelsConfigReporting(
	pi: Pick<ExtensionAPI, "on">,
	agentDir = getAgentDir(),
): (ctx: Pick<ExtensionContext, "hasUI" | "ui">) => void {
	const store = taskModelsConfigStore(agentDir);
	const reporter = registerConfigReporting(pi, [store]);
	return (ctx) => reporter.report(ctx, store, store.loadSync());
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
	return candidateAlias && !currentAlias;
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

export function availableTaskModels(ctx: TaskModelContext): AvailableModel[] {
	const scopedModels = ctx.scopedModels;
	return dedupeAvailableModels(
		(scopedModels.length ? scopedModels.map(({ model }) => model) : ctx.modelRegistry.getAvailable())
			.filter((model) => model.input.includes("text")),
		ctx.model?.provider,
	);
}

export function taskThinkingLevels(ctx: TaskModelContext, model: AvailableModel): ThinkingLevel[] {
	const supported = getSupportedThinkingLevels(model) as ThinkingLevel[];
	const pinned = ctx.scopedModels.find(({ model: scoped }) =>
		scoped.provider === model.provider && scoped.id === model.id)?.thinkingLevel;
	if (!pinned) return supported;
	return supported.includes(pinned as ThinkingLevel) ? [pinned as ThinkingLevel] : [];
}

export function resolveTaskModelRoute(
	ctx: TaskModelContext,
	route: TaskModelRoute,
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
	ctx: TaskModelContext,
	task: ModelTask,
	agentDir = getAgentDir(),
	thinking?: ThinkingLevel,
): ResolvedTaskRoute[] {
	const declaration = validatedModelTask(task);
	const store = taskModelsConfigStore(agentDir);
	const loaded = store.loadSync();
	if (loaded.status === "disabled") throw taskRouteError("config-disabled", disabledConfigMessage(store.path, loaded.issues));
	if (loaded.source === "missing") {
		throw taskRouteError("config-missing", "Task model config is missing. Run /task-models to configure task routes.");
	}
	const config = loaded.value;
	const profileName = config.tasks[declaration.id] ?? declaration.defaultProfile;
	const profile = config.profiles[profileName];
	if (!profile) {
		const issues = loaded.issues.filter(({ key }) => key === `profiles.${profileName}`);
		throw taskRouteError(
			"profile-missing",
			issues.length
				? `Task ${declaration.id} profile ${profileName} is invalid in ${store.path}: ${formatConfigIssues(issues)}. Run /task-models.`
				: `Task ${declaration.id} profile ${profileName} is not configured. Run /task-models.`,
			profileName,
		);
	}
	const routes: ResolvedTaskRoute[] = [];
	for (const route of orderedProfileRoutes(profile)) {
		const resolved = resolveTaskModelRoute(ctx, route, thinking);
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
export type TaskRouteErrorCode = "config-missing" | "config-disabled" | "profile-missing" | "no-route";
export type TaskRouteError = Error & { taskRouteCode: TaskRouteErrorCode; profileName?: ProfileName };

function taskRouteError(taskRouteCode: TaskRouteErrorCode, message: string, profileName?: ProfileName): TaskRouteError {
	return Object.assign(new Error(message), { taskRouteCode, ...(profileName ? { profileName } : {}) });
}

export function resolveConfiguredTaskRoute(
	ctx: TaskModelContext,
	task: ModelTask,
	agentDir = getAgentDir(),
	thinking?: ThinkingLevel,
): ResolvedTaskRoute {
	return resolveConfiguredTaskRoutes(ctx, task, agentDir, thinking)[0];
}

export async function executeTaskRoutes<T>(
	routes: readonly ResolvedTaskRoute[],
	attempt: (route: ResolvedTaskRoute) => Promise<T>,
	{ signal, shouldFallback }: { signal?: AbortSignal; shouldFallback: (error: unknown) => boolean },
): Promise<T> {
	if (!routes.length) throw new Error("Task route list must not be empty.");
	for (const route of routes.slice(0, -1)) {
		signal?.throwIfAborted();
		try {
			return await attempt(route);
		} catch (error) {
			if (signal?.aborted || !shouldFallback(error)) throw error;
		}
	}
	signal?.throwIfAborted();
	return attempt(routes[routes.length - 1]);
}

export function orderedProfileRoutes(profile: TaskModelProfile): TaskModelRoute[] {
	return profile.fallback ? [profile.primary, profile.fallback] : [profile.primary];
}

type ModelTaskDiscoveryRequest = { requestId: string };
type ModelTaskDiscoveryResponse = ModelTaskDiscoveryRequest & { task: ModelTask };

function parseModelTaskDiscoveryRequest(value: unknown): ModelTaskDiscoveryRequest | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return;
	const request = value as Record<string, unknown>;
	return hasRequiredKeys(request, ["requestId"]) && isNonEmptyText(request.requestId)
		? { requestId: request.requestId }
		: undefined;
}

function parseModelTaskDiscoveryResponse(value: unknown): ModelTaskDiscoveryResponse | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return;
	const response = value as Record<string, unknown>;
	if (!hasRequiredKeys(response, ["requestId", "task"]) || !isNonEmptyText(response.requestId)) return;
	const task = parseModelTask(response.task);
	return task ? { requestId: response.requestId, task } : undefined;
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
		if (!isDeepStrictEqual(existing, task)) throw new Error(`Conflicting Model Task declaration: ${task.id}.`);
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
		if (existing && !isDeepStrictEqual(existing, response.task)) conflicts.add(response.task.id);
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

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** `currentProfiles` reads the active profiles; the save uses its latest value, not the menu snapshot. */
async function saveTaskModelPreset(
	ctx: ExtensionContext,
	store: TaskModelPresetsStore,
	currentProfiles: () => TaskModelsConfig["profiles"],
	report: (loaded: ReturnType<TaskModelPresetsStore["loadSync"]>) => void,
): Promise<void> {
	if (!Object.keys(currentProfiles()).length) {
		ctx.ui.notify("Configure a task model profile before saving a preset.", "warning");
		return;
	}
	const name = await ctx.ui.input("Save task model preset", "Preset name");
	if (name === undefined) return;
	if (!isNonEmptyText(name)) {
		ctx.ui.notify("Preset names must be non-empty text without surrounding whitespace or control characters.", "error");
		return;
	}
	try {
		// Confirm before locking so an open dialog never blocks other sessions' saves.
		const loaded = store.loadSync();
		report(loaded);
		const replace = loaded.status === "ok" && Object.hasOwn(loaded.value, name);
		if (replace && !await ctx.ui.confirm("Replace task model preset?", `Replace "${name}" with the current profiles?`)) return;
		// update refuses a file with issues, so a malformed preset file is never overwritten.
		const profiles = currentProfiles();
		if (!Object.keys(profiles).length) throw new Error("the active config has no task model profiles now");
		await store.update((presets) => {
			if (Object.hasOwn(presets, name) && !replace) throw new Error(`Another session saved preset "${name}"; try again.`);
			return { ...presets, [name]: profiles };
		});
	} catch (error) {
		ctx.ui.notify(`Couldn't save task model presets at ${store.path}: ${errorMessage(error)}`, "error");
		return;
	}
	ctx.ui.notify(`Saved task model preset: ${name}.`, "info");
}

async function selectTaskModels(ctx: ExtensionContext, options: string[]): Promise<string | undefined> {
	if (ctx.mode !== "tui") return ctx.ui.select("Task models", options);
	return ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
		const container = new Container();
		container.addChild(new Text(theme.fg("accent", "Task models"), 1, 1));
		const list = new SelectList(options.map((label) => ({ value: label, label })), 10, getSelectListTheme());
		list.onSelect = (item) => done(item.value);
		list.onCancel = () => done(undefined);
		container.addChild(list);
		container.addChild(new Text(theme.fg("dim", "Option+S / Alt+S: save current profiles as a preset"), 1, 1));
		return Object.assign(container, {
			handleInput(data: string) {
				if (matchesKey(data, Key.alt("s"))) done("save-preset");
				else list.handleInput(data);
				tui.requestRender();
			},
		});
	});
}

export function createTaskModelsExtension(
	pi: ExtensionAPI,
	options?: { agentDir?: string },
): void {
	const agentDir = options?.agentDir ?? getAgentDir();
	const configStore = taskModelsConfigStore(agentDir);
	const repairStore = taskModelsConfigStore(agentDir, true);
	const presetsStore = taskModelPresetsStore(agentDir);
	const reporter = registerConfigReporting(pi, [configStore, presetsStore]);
	pi.on("session_start", (_event, ctx) => {
		if (configStore.loadSync().source === "missing") {
			ctx.ui.notify(`Task model config is missing at ${configStore.path}; run /task-models to configure task routes.`, "warning");
		}
	});
	pi.registerCommand("task-models", {
		description: "configure shared task model profiles; choose a saved setup with /task-models preset",
		handler: async (args, ctx) => {
			const action = args.trim();
			if (action && action !== "preset") {
				ctx.ui.notify("Usage: /task-models [preset]", "error");
				return;
			}
			reporter.report(ctx, configStore, configStore.loadSync());
			// The repair store never disables, so a disabled config still shows and keeps the settings that loaded.
			const snapshot = repairStore.loadSync();
			const config: TaskModelsConfig = snapshot.status === "ok" ? snapshot.value : { profiles: {}, tasks: {} };
			const save = (mutator: (current: TaskModelsConfig) => TaskModelsConfig) =>
				saveTaskModelsConfig(ctx, configStore, snapshot, config, mutator);

			if (action === "preset") {
				const presets = presetsStore.loadSync();
				reporter.report(ctx, presetsStore, presets);
				// Entry stores never disable; bad presets are dropped and reported.
				const names = presets.status === "ok" ? Object.keys(presets.value).sort() : [];
				if (presets.status !== "ok" || !names.length) {
					ctx.ui.notify(`No presets found in ${presetsStore.path}.`, "info");
					return;
				}
				const selected = await ctx.ui.select("Task model preset", names);
				if (!selected) return;
				const profiles = presets.value[selected]!;
				if (!await save((current) => ({ ...current, profiles: { ...current.profiles, ...profiles } }))) return;
				ctx.ui.notify(`Applied task model preset: ${selected}.`, "info");
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
			const taskOptions = discoverModelTasks(pi).map((task) => {
				const profile = config.tasks[task.id] ?? task.defaultProfile;
				return { task, label: `${task.label} · ${task.id} · ${profile}` };
			});
			const selected = await selectTaskModels(ctx, [
				...profileOptions.map(({ label }) => label),
				...taskOptions.map(({ label }) => label),
			]);
			if (!selected) return;
			if (selected === "save-preset") {
				await saveTaskModelPreset(ctx, presetsStore, () => {
					const latest = repairStore.loadSync();
					reporter.report(ctx, configStore, configStore.loadSync());
					return latest.status === "ok" ? latest.value.profiles : {};
				}, (loaded) => reporter.report(ctx, presetsStore, loaded));
				return;
			}

			const task = taskOptions.find(({ label }) => label === selected)?.task;
			if (task) {
				const profile = await ctx.ui.select(`${task.label}: ${task.purpose}`, [...PROFILE_NAMES]);
				if (!isProfileName(profile)) return;
				if (!await save((current) => {
					const tasks = { ...current.tasks };
					if (profile === task.defaultProfile) delete tasks[task.id];
					else tasks[task.id] = profile;
					return { ...current, tasks };
				})) return;
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
			let route: TaskModelProfile = { primary };
			if (profile !== "fav") {
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

				if (fallback) route = { primary, fallback };
			}
			if (!await save((current) => ({ ...current, profiles: { ...current.profiles, [profile]: route } }))) return;
			ctx.ui.notify(`${profile} profile saved.`, "info");
		},
	});
}

/**
 * Merge into the latest clean config under the store lock. A config with issues is replaced
 * only after the user confirms, keeping just the settings that loaded, and only when the file
 * still matches the snapshot under the lock, so a repair from another session is never overwritten.
 */
async function saveTaskModelsConfig(
	ctx: ExtensionContext,
	store: TaskModelsConfigStore,
	snapshot: ReturnType<TaskModelsConfigStore["loadSync"]>,
	config: TaskModelsConfig,
	mutator: (current: TaskModelsConfig) => TaskModelsConfig,
): Promise<boolean> {
	try {
		if (!snapshot.issues.length) {
			await store.update(mutator);
			return true;
		}
		if (!await ctx.ui.confirm(
			"Replace task model config?",
			`${store.path} has issues: ${formatConfigIssues(snapshot.issues)}. Saving removes the settings with issues.`,
		)) return false;
		await store.replaceIfUnchanged(snapshot, mutator(config));
		return true;
	} catch (error) {
		ctx.ui.notify(`Couldn't save task model config: ${errorMessage(error)}`, "error");
		return false;
	}
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
