import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { CONFIG_DIR_NAME, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createConfigStore, formatConfigIssues } from "@henryqw/pi-config-store";
import { modelReference, registerModelTask, resolveConfiguredTaskRoute, THINKING_LEVELS, type ModelTask } from "./index.js";

const roles = ["reviewer", "researcher", "worker", "planner", "oracle"] as const;
const tasks = roles.map((role) => ({
	id: `billion-context/acp-${role}`,
	label: `Delegate ${role}`,
	purpose: `Route the ${role} delegate.`,
	defaultProfile: role === "researcher" ? "fast" : "balanced",
} satisfies ModelTask));
type ObjectValue = Record<string, unknown>;
const isObject = (value: unknown): value is ObjectValue => value !== null && typeof value === "object" && !Array.isArray(value);
const unchanged = Symbol("unchanged");

export function biliConfigPath(env: NodeJS.ProcessEnv = process.env): string {
	return env.BILI_CONFIG_FILE ? resolve(env.BILI_CONFIG_FILE)
		: join(env.XDG_CONFIG_HOME ? resolve(env.XDG_CONFIG_HOME) : join(homedir(), ".config"), "billion-context", "billion-context.json");
}

function validateAgents(value: ObjectValue, label: string): void {
	if (value.agents !== undefined && !isObject(value.agents)) throw new Error(`${label}.agents must be an object`);
	const agents = value.agents as ObjectValue | undefined;
	for (const role of roles) {
		const agent = agents?.[role];
		if (agent !== undefined && !isObject(agent)) throw new Error(`${label}.agents.${role} must be an object`);
		if (isObject(agent) && ((agent.model !== undefined && (typeof agent.model !== "string" || !/^[^\s/]+\/\S+$/.test(agent.model)))
			|| (agent.thinkingLevel !== undefined && !(THINKING_LEVELS as readonly unknown[]).includes(agent.thinkingLevel)))) {
			throw new Error(`${label}.agents.${role} has invalid model or thinkingLevel`);
		}
	}
}

function subagents(root: ObjectValue): ObjectValue | undefined {
	if (root.pi === undefined) return;
	if (!isObject(root.pi)) throw new Error("pi must be an object");
	const value = root.pi.subagents;
	if (value === undefined || value === false) return;
	if (value === true) return {};
	if (!isObject(value)) throw new Error("pi.subagents must be an object or boolean");
	if (value.enabled === false) return;
	validateAgents(value, "pi.subagents");
	return value;
}

export function biliStore(path = biliConfigPath()) {
	return createConfigStore({ extensionId: "pi-task-models", path, entries: (raw) => {
		if (!isObject(raw)) throw new Error("config must be an object");
		subagents(raw);
		return raw;
	} });
}

function legacyStore(path: string) {
	return createConfigStore({ extensionId: "pi-task-models", path, entries: (raw) => {
		if (!isObject(raw)) throw new Error("config must be an object");
		const delegate = raw.delegate;
		if (delegate !== undefined && delegate !== true && delegate !== false) {
			if (!isObject(delegate)) throw new Error("delegate must be an object or boolean");
			validateAgents(delegate, "delegate");
		}
		return raw;
	} });
}

function loadValid(store: ReturnType<typeof biliStore>): ObjectValue {
	const snapshot = store.loadSync();
	if (snapshot.status !== "ok" || snapshot.issues.length) {
		const issues = snapshot.issues.map((issue) => issue.kind === "invalid-json" ? { ...issue, message: "invalid JSON" } : issue);
		throw new Error(`Config at ${store.path} has issues: ${formatConfigIssues(issues)}`);
	}
	return snapshot.value;
}

/** Sync the active delegate config without changing its other settings. */
export async function syncBiliModels(ctx: ExtensionContext, path: string, agentDir: string): Promise<string[]> {
	const store = biliStore(path);
	const root = loadValid(store);
	const section = isObject(root.pi) ? root.pi.subagents : undefined;
	if (section === false || (isObject(section) && section.enabled === false)) return [];
	let target = store;
	let legacy = false;
	if (section === undefined) {
		legacy = true;
		const configDir = typeof CONFIG_DIR_NAME === "string" && CONFIG_DIR_NAME.length > 0 ? CONFIG_DIR_NAME : ".pi";
		const project = legacyStore(join(ctx.cwd ?? process.cwd(), configDir, "acp.json"));
		const projectConfig = loadValid(project);
		target = Object.hasOwn(projectConfig, "delegate") ? project : legacyStore(join(homedir(), configDir, "acp.json"));
		const delegate = target === project ? projectConfig.delegate : loadValid(target).delegate;
		if (delegate === false || (isObject(delegate) && delegate.enabled === false)) return [];
	}
	const routes: Record<string, { model: string; thinkingLevel: string }> = {};
	const errors: string[] = [];
	const globalContext = { model: undefined, scopedModels: [], modelRegistry: ctx.modelRegistry };
	for (const [index, role] of roles.entries()) {
		try {
			const result = resolveConfiguredTaskRoute(globalContext, tasks[index]!, agentDir);
			routes[role] = { model: modelReference(result.model), thinkingLevel: result.thinkingLevel };
		} catch (error) {
			errors.push(error instanceof Error ? error.message : String(error));
		}
	}
	if (!Object.keys(routes).length) return errors;
	try {
		await target.update((root) => {
			const value = legacy ? root.delegate : subagents(root);
			if (value === false || (legacy && isObject(value) && value.enabled === false)) throw unchanged;
			if (!legacy && !value) throw unchanged;
			const current = isObject(value) ? value : {};
			const agents = (current.agents ?? {}) as ObjectValue;
			const next = { ...agents };
			for (const [role, route] of Object.entries(routes)) next[role] = { ...(agents[role] as ObjectValue | undefined), ...route };
			if (isDeepStrictEqual(agents, next)) throw unchanged;
			if (legacy) return { ...root, delegate: { ...current, agents: next } };
			return { ...root, pi: { ...(root.pi as ObjectValue), subagents: { ...current, agents: next } } };
		});
	} catch (error) {
		if (error !== unchanged) {
			if (error instanceof Error && error.message.includes("invalid JSON")) throw new Error(`Config at ${target.path} has invalid JSON; nothing was written.`);
			throw error;
		}
	}
	return errors;
}

export function registerBiliModels(pi: ExtensionAPI, agentDir: string, path = biliConfigPath()): (ctx: ExtensionContext) => Promise<void> {
	for (const task of tasks) registerModelTask(pi, task);
	let notice = "";
	return async (ctx) => {
		if (!pi.getAllTools().some(({ name, sourceInfo }) => name === "acp_delegate"
			&& sourceInfo.origin === "package" && /^npm:billion-context(?:@[^/]+)?$/.test(sourceInfo.source))) return;
		let message = "";
		try {
			const errors = await syncBiliModels(ctx, path, agentDir);
			if (errors.length) message = `Delegate model sync: ${errors.join("; ")}`;
		} catch (error) {
			message = `Delegate model sync failed: ${error instanceof Error ? error.message : String(error)}`;
		}
		if (message && message !== notice) {
			if (ctx.hasUI) ctx.ui.notify(message, "warning");
			else process.stderr.write(`${message}\n`);
		}
		notice = message;
	};
}
