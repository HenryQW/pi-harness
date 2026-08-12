import { access, chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rename, rm, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, randomUUID } from "node:crypto";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createHerdrClient, hasHerdrErrorCode, herdrCommandFailure } from "@henryqw/pi-herdr";
import { Type } from "typebox";
import {
	PROTOCOL_VERSION,
	parseCompletionNotices,
	parseTerminalResult,
} from "../internal/protocol.ts";

const DEFAULT_LIMIT = 10;
const MODEL_CLASSES = ["fast", "balanced", "frontier"] as const;
const CONFIG_PATH = () => join(getAgentDir(), "config", "pi-herdr-subagents.json");
const CONFIG_LOCK_TIMEOUT_MS = 1_000;
const CONFIG_LOCK_RETRY_MS = 25;
const CONFIG_LOCK_FAILURE = "Subagent config is busy; try again.";
const CONFIG_LOCK_OWNER = "owner";
const SUBAGENT_EXTENSION = fileURLToPath(new URL("../internal/subagent.ts", import.meta.url));
const HERDR_NAME = /^[a-z][a-z0-9_-]{0,31}$/;
const DEFINITIVE_PROMPT_ERRORS = new Set([
	"agent_not_found", "agent_not_running", "agent_not_ready", "agent_not_idle",
	"empty_agent_prompt", "invalid_agent_name", "agent_prompt_failed",
]);

type ModelClass = typeof MODEL_CLASSES[number];
type ConfiguredModel = { model: string; thinkingLevel: string };
type Config = {
	maxConcurrentSubagents: number;
	models: Partial<Record<ModelClass, ConfiguredModel>>;
};
type ConfigLockOwner = { raw: string; pid: number; token: string };

type OwnedSubagent = {
	taskId: string;
	task: string;
	subagentName: string;
	resultPath: string;
	tempDir: string;
	label: string;
	existingTabs: Set<string>;
	tabId?: string;
};

type HerdrLocation = { workspace: string; pane: string };
type HerdrTab = { id: string; label?: string };

const object = (value: unknown, label: string): Record<string, unknown> => {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is invalid.`);
	return value as Record<string, unknown>;
};

const text = (value: unknown, label: string): string => {
	if (typeof value !== "string" || !value) throw new Error(`${label} is missing.`);
	return value;
};

const herdrName = (value: unknown, label: string): string => {
	const name = text(value, label);
	if (!HERDR_NAME.test(name)) throw new Error(`${label} is invalid.`);
	return name;
};

const parseJson = (value: string, label: string): Record<string, unknown> => {
	try {
		return object(JSON.parse(value), label);
	} catch {
		throw new Error(`${label} is not JSON.`);
	}
};

const defaultConfig = (): Config => ({ maxConcurrentSubagents: DEFAULT_LIMIT, models: {} });
const configLimit = (value: unknown): number | undefined =>
	typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
const isModelClass = (value: unknown): value is ModelClass =>
	typeof value === "string" && MODEL_CLASSES.includes(value as ModelClass);
const isThinkingLevel = (value: unknown): value is string =>
	typeof value === "string" && Boolean(value) && value === value.trim() && !value.includes("\0");
const isModelReference = (value: unknown): value is string => {
	if (typeof value !== "string" || value !== value.trim() || value.includes("\0")) return false;
	const slash = value.indexOf("/");
	return slash > 0 && slash < value.length - 1;
};

function configModels(value: unknown): { value: Config["models"]; invalid: boolean } {
	if (value === undefined) return { value: {}, invalid: false };
	if (!value || typeof value !== "object" || Array.isArray(value)) return { value: {}, invalid: true };
	const record = value as Record<string, unknown>;
	const models: Config["models"] = {};
	let invalid = Object.keys(record).some((key) => !isModelClass(key));
	for (const modelClass of MODEL_CLASSES) {
		if (!Object.hasOwn(record, modelClass)) continue;
		const candidate = record[modelClass];
		if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
			invalid = true;
			continue;
		}
		const configured = candidate as Record<string, unknown>;
		if (isModelReference(configured.model) && isThinkingLevel(configured.thinkingLevel)) {
			models[modelClass] = { model: configured.model, thinkingLevel: configured.thinkingLevel };
		} else invalid = true;
	}
	return { value: models, invalid };
}

async function readConfig(path = CONFIG_PATH()): Promise<{ value: Config; invalid: boolean }> {
	try {
		const value = JSON.parse(await readFile(path, "utf8")) as unknown;
		if (!value || typeof value !== "object" || Array.isArray(value)) return { value: defaultConfig(), invalid: true };
		const record = value as Record<string, unknown>;
		const limit = configLimit(record.maxConcurrentSubagents ?? record.maxConcurrentWorkers);
		const models = configModels(record.models);
		return {
			value: { maxConcurrentSubagents: limit ?? DEFAULT_LIMIT, models: models.value },
			invalid: limit === undefined || models.invalid,
		};
	} catch (error: unknown) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
			return { value: defaultConfig(), invalid: false };
		}
		return { value: defaultConfig(), invalid: true };
	}
}

function parseConfigLockOwner(raw: string): ConfigLockOwner | undefined {
	try {
		const value = JSON.parse(raw) as unknown;
		if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
		const record = value as Record<string, unknown>;
		if (Object.keys(record).length !== 2 || !Number.isSafeInteger(record.pid) || Number(record.pid) <= 0) return undefined;
		if (typeof record.token !== "string" || !/^[a-f0-9]{32}$/.test(record.token)) return undefined;
		return { raw, pid: Number(record.pid), token: record.token };
	} catch {
		return undefined;
	}
}

type ConfigReclaim = { path: string; token: string };

async function configReclaims(lock: string): Promise<ConfigReclaim[]> {
	const prefix = `${basename(lock)}.`;
	return (await readdir(dirname(lock)))
		.filter((name) => name.startsWith(prefix) && name.endsWith(".reclaim"))
		.map((name) => ({ path: join(dirname(lock), name), token: name.slice(prefix.length, -".reclaim".length) }))
		.filter(({ token }) => /^[a-f0-9]{32}$/.test(token));
}

async function removeEmptyConfigReclaim(path: string): Promise<boolean> {
	try {
		await rmdir(path);
		return true;
	} catch (error: unknown) {
		if (error && typeof error === "object" && "code" in error) {
			if (error.code === "ENOENT") return true;
			if (error.code === "ENOTEMPTY" || error.code === "EEXIST") return false;
		}
		throw error;
	}
}

async function cleanupConfigReclaim(reclaim: ConfigReclaim): Promise<boolean> {
	let entries: string[];
	try {
		if (!(await lstat(reclaim.path)).isDirectory()) return false;
		entries = await readdir(reclaim.path);
	} catch (error: unknown) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return true;
		throw error;
	}
	if (entries.length === 0) return await removeEmptyConfigReclaim(reclaim.path);
	if (!entries.includes(CONFIG_LOCK_OWNER)) return false;
	const owner = await readFile(join(reclaim.path, CONFIG_LOCK_OWNER), "utf8")
		.then(parseConfigLockOwner)
		.catch((error: unknown) => {
			if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
			throw error;
		});
	if (!owner) return await removeEmptyConfigReclaim(reclaim.path);
	if (owner.token !== reclaim.token) return false;
	const reclaimers: Array<{ name: string; pid: number }> = [];
	for (const name of entries) {
		if (name === CONFIG_LOCK_OWNER) continue;
		const match = /^\.reclaimer\.([1-9]\d*)\.[a-f0-9]{32}$/.exec(name);
		const pid = Number(match?.[1]);
		if (!match || !Number.isSafeInteger(pid)) return false;
		reclaimers.push({ name, pid });
	}
	for (const reclaimer of reclaimers) {
		try {
			process.kill(reclaimer.pid, 0);
			return false;
		} catch (error: unknown) {
			if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ESRCH") return false;
		}
		try {
			await rmdir(join(reclaim.path, reclaimer.name));
		} catch (error: unknown) {
			if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error;
		}
	}
	try {
		entries = await readdir(reclaim.path);
	} catch (error: unknown) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return true;
		throw error;
	}
	if (entries.length !== 1 || entries[0] !== CONFIG_LOCK_OWNER) return false;
	try {
		await unlink(join(reclaim.path, CONFIG_LOCK_OWNER));
	} catch (error: unknown) {
		if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error;
	}
	return await removeEmptyConfigReclaim(reclaim.path);
}

async function cleanupConfigReclaims(lock: string): Promise<boolean> {
	for (const reclaim of await configReclaims(lock)) {
		if (!(await cleanupConfigReclaim(reclaim))) return false;
	}
	return true;
}

async function removeConfigReclaimer(lock: string, reclaim: string, name: string): Promise<void> {
	for (const parent of [lock, reclaim]) {
		try {
			await rmdir(join(parent, name));
		} catch (error: unknown) {
			if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error;
		}
	}
}

// Rename carries every pre-handoff reclaimer registration into the tombstone.
// The base path is reusable only after those reclaimers have finished or reached ESRCH.
async function reclaimConfigLock(lock: string, stale: ConfigLockOwner): Promise<boolean> {
	const reclaim = `${lock}.${stale.token}.reclaim`;
	const reclaimer = `.reclaimer.${process.pid}.${randomBytes(16).toString("hex")}`;
	let registered = false;
	let moved = false;
	try {
		try {
			await mkdir(join(lock, reclaimer));
			registered = true;
		} catch (error: unknown) {
			if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
			throw error;
		}
		const current = await readFile(join(lock, CONFIG_LOCK_OWNER), "utf8").catch((error: unknown) => {
			if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return "";
			throw error;
		});
		if (current !== stale.raw) return false;
		try {
			process.kill(stale.pid, 0);
			return false;
		} catch (error: unknown) {
			if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ESRCH") return false;
		}
		try {
			await rename(lock, reclaim);
			moved = true;
			return true;
		} catch (error: unknown) {
			if (error && typeof error === "object" && "code" in error && ["ENOENT", "EEXIST", "ENOTEMPTY"].includes(String(error.code))) return false;
			throw error;
		}
	} finally {
		if (registered) await removeConfigReclaimer(lock, reclaim, reclaimer);
		if (moved) await cleanupConfigReclaim({ path: reclaim, token: stale.token });
	}
}

async function removeConfigLock(lock: string, owner: string): Promise<void> {
	if (await readFile(join(lock, CONFIG_LOCK_OWNER), "utf8") !== owner) {
		throw new Error("Subagent config lock ownership changed.");
	}
	const tombstone = `${lock}.${randomUUID()}.tombstone`;
	await rename(lock, tombstone);
	await rm(tombstone, { recursive: true, force: true });
}

async function configWritePath(path: string): Promise<string> {
	const links = new Set<string>();
	for (;;) {
		try {
			if (!(await lstat(path)).isSymbolicLink()) return path;
			const parent = await realpath(dirname(path));
			const link = join(parent, basename(path));
			if (links.has(link)) throw new Error("Cyclic config symlink.");
			links.add(link);
			const target = await readlink(path);
			path = isAbsolute(target) ? target : resolve(parent, target);
		} catch (error: unknown) {
			if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return path;
			throw error;
		}
	}
}

async function mutateConfig(mutate: (config: Config) => Config): Promise<void> {
	const path = CONFIG_PATH();
	const lock = `${path}.lock`;
	await mkdir(dirname(path), { recursive: true });
	const deadline = Date.now() + CONFIG_LOCK_TIMEOUT_MS;
	let lockOwner = "";
	for (;;) {
		if (!(await cleanupConfigReclaims(lock))) {
			if (Date.now() >= deadline) throw new Error(CONFIG_LOCK_FAILURE);
			await new Promise((resolve) => setTimeout(resolve, CONFIG_LOCK_RETRY_MS));
			continue;
		}
		let lockExists = true;
		try {
			await lstat(lock);
		} catch (error: unknown) {
			if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error;
			lockExists = false;
		}
		if (lockExists) {
			const owner = parseConfigLockOwner(await readFile(join(lock, CONFIG_LOCK_OWNER), "utf8").catch(() => ""));
			if (owner) {
				try {
					process.kill(owner.pid, 0);
				} catch (error: unknown) {
					if (error && typeof error === "object" && "code" in error && error.code === "ESRCH" && await reclaimConfigLock(lock, owner)) continue;
				}
			}
			if (Date.now() >= deadline) throw new Error(CONFIG_LOCK_FAILURE);
			await new Promise((resolve) => setTimeout(resolve, CONFIG_LOCK_RETRY_MS));
			continue;
		}
		const temporaryLock = await mkdtemp(`${lock}.tmp-`);
		lockOwner = JSON.stringify({ pid: process.pid, token: randomBytes(16).toString("hex") });
		try {
			await writeFile(join(temporaryLock, CONFIG_LOCK_OWNER), lockOwner, { encoding: "utf8", flag: "wx", mode: 0o600 });
		} catch (error) {
			await rm(temporaryLock, { recursive: true, force: true });
			throw error;
		}
		try {
			await rename(temporaryLock, lock);
		} catch (error: unknown) {
			await rm(temporaryLock, { recursive: true, force: true });
			lockOwner = "";
			if (error && typeof error === "object" && "code" in error && ["EEXIST", "ENOTEMPTY"].includes(String(error.code))) continue;
			throw error;
		}
		if (await cleanupConfigReclaims(lock)) break;
		await removeConfigLock(lock, lockOwner);
		lockOwner = "";
		if (Date.now() >= deadline) throw new Error(CONFIG_LOCK_FAILURE);
		await new Promise((resolve) => setTimeout(resolve, CONFIG_LOCK_RETRY_MS));
	}
	try {
		const writePath = await configWritePath(path);
		await access(writePath, constants.W_OK).catch((error: unknown) => {
			if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
			throw error;
		});
		const mode = await stat(writePath).then(({ mode }) => mode & 0o777).catch((error: unknown) => {
			if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
			throw error;
		});
		const config = mutate((await readConfig(writePath)).value);
		const temporary = `${writePath}.${randomUUID()}.tmp`;
		try {
			await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: mode ?? 0o600 });
			if (mode !== undefined) await chmod(temporary, mode);
			await rename(temporary, writePath);
		} finally {
			await rm(temporary, { force: true });
		}
	} finally {
		await removeConfigLock(lock, lockOwner);
	}
}

const availableTextModels = (ctx: ExtensionContext) => ctx.modelRegistry
	.getAvailable()
	.filter((model) => model.input.includes("text"));
const modelReference = (model: { provider: string; id: string }) => `${model.provider}/${model.id}`;

const subagentName = (taskId: string) => `subagent_${taskId.replaceAll("-", "").slice(0, 8)}`;
const mainName = () => `main_${randomBytes(4).toString("hex")}`;

function subagentLabel(task: string, taskId: string): string {
	// Used as recovery key when Herdr loses a tab-create response.
	const suffix = ` · ${taskId.replaceAll("-", "").slice(0, 8)}`;
	const words = task.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim().split(/\s+/).slice(0, 4).join(" ");
	return `${words.slice(0, 40 - suffix.length).trim() || "subagent"}${suffix}`;
}

function location(): HerdrLocation {
	if (process.env.HERDR_ENV !== "1") throw new Error("delegate_task requires Herdr (HERDR_ENV=1).");
	const workspace = process.env.HERDR_WORKSPACE_ID;
	const pane = process.env.HERDR_PANE_ID;
	if (!workspace || !pane) throw new Error("delegate_task requires Herdr workspace and pane identity.");
	return { workspace, pane };
}

function rollbackCleanupError(subagent: OwnedSubagent, tabId: string, launchError: unknown, cleanupError: unknown): Error {
	const launch = launchError instanceof Error ? launchError.message : String(launchError);
	const cleanup = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
	return new Error(`Delegated Task ${subagent.taskId} launch failed and Subagent tab cleanup also failed; Subagent remains owned.\nSubagent: ${subagent.subagentName}\nTab: ${tabId}\nResult: ${subagent.resultPath}\nStop: herdr tab close ${tabId}\nLaunch error: ${launch}\nCleanup error: ${cleanup}`);
}

function provisioningReconciliationError(subagent: OwnedSubagent, where: HerdrLocation, launchError: unknown, reconciliationError: unknown): Error {
	const launch = launchError instanceof Error ? launchError.message : String(launchError);
	const reconciliation = reconciliationError instanceof Error ? reconciliationError.message : String(reconciliationError);
	return new Error(`Delegated Task ${subagent.taskId} tab creation outcome and reconciliation also failed; provisioning remains owned.\nSubagent: ${subagent.subagentName}\nLabel: ${subagent.label}\nResult: ${subagent.resultPath}\nInspect: herdr tab list --workspace ${where.workspace}\nClose matching tab: herdr tab close <tab-id>\nLaunch error: ${launch}\nReconciliation error: ${reconciliation}`);
}

function resultOf(response: Record<string, unknown>, label: string): Record<string, unknown> {
	return object(response.result, `${label} result`);
}

function agentInfo(response: Record<string, unknown>, label: string): Record<string, unknown> {
	const result = resultOf(response, label);
	if (result.type !== "agent_info") throw new Error(`${label} did not return agent_info.`);
	return object(result.agent, `${label} agent`);
}

function assertAgent(agent: Record<string, unknown>, expected: { name?: string; pane: string; workspace: string; tab?: string }): void {
	if (agent.pane_id !== expected.pane || agent.workspace_id !== expected.workspace) {
		throw new Error("Herdr agent identity does not match Main location.");
	}
	if (expected.name && agent.name !== expected.name) throw new Error("Herdr agent name does not match request.");
	if (expected.tab && agent.tab_id !== expected.tab) throw new Error("Herdr agent tab does not match request.");
}

export default function subagentsExtension(pi: ExtensionAPI): void {
	const herdr = createHerdrClient((command, args, options: { cwd: string; signal?: AbortSignal }) =>
		pi.exec(command, [...args], options));
	const subagents = new Map<string, OwnedSubagent>();
	let config = defaultConfig();
	let cachedMainName: string | undefined;

	const closeTab = async (tabId: string, ctx: ExtensionContext): Promise<void> => {
		const args = ["tab", "close", tabId];
		const result = await herdr.exec(args, { cwd: ctx.cwd });
		if (result.killed || (result.code !== 0 && !hasHerdrErrorCode(result, "tab_not_found"))) {
			throw new Error(herdrCommandFailure(args, result));
		}
	};

	const listTabs = async (where: HerdrLocation, ctx: ExtensionContext, signal?: AbortSignal): Promise<HerdrTab[]> => {
		const result = resultOf(await herdr.json(["tab", "list", "--workspace", where.workspace], { cwd: ctx.cwd, signal }), "Herdr tab list");
		if (result.type !== "tab_list" || !Array.isArray(result.tabs)) throw new Error("Herdr tab list is invalid.");
		return result.tabs.map((candidate, index) => {
			const tab = object(candidate, `Herdr tab list entry ${index + 1}`);
			const id = text(tab.tab_id, `Herdr tab list entry ${index + 1} tab ID`);
			if (tab.workspace_id !== where.workspace) throw new Error(`Herdr tab list entry ${index + 1} workspace is invalid.`);
			if (tab.label !== undefined && typeof tab.label !== "string") throw new Error(`Herdr tab list entry ${index + 1} label is invalid.`);
			return { id, label: tab.label as string | undefined };
		});
	};

	const reconcile = async (where: HerdrLocation, ctx: ExtensionContext, signal?: AbortSignal): Promise<Set<string>> => {
		const tabs = await listTabs(where, ctx, signal);
		const present = new Set(tabs.map((tab) => tab.id));
		// Missing tab ID means create response was indeterminate. Adopt only one matching new label; ambiguity stays owned.
		for (const [taskId, subagent] of subagents) {
			if (subagent.tabId) {
				if (!present.has(subagent.tabId)) subagents.delete(taskId);
				continue;
			}
			const provisioned = tabs.filter((tab) => !subagent.existingTabs.has(tab.id) && tab.label === subagent.label);
			if (provisioned.length === 1) subagent.tabId = provisioned[0].id;
			else if (provisioned.length === 0) subagents.delete(taskId);
		}
		return present;
	};

	const ensureMainName = async (where: HerdrLocation, ctx: ExtensionContext, signal?: AbortSignal): Promise<string> => {
		if (cachedMainName) return cachedMainName;
		const current = agentInfo(await herdr.json(["agent", "get", where.pane], { cwd: ctx.cwd, signal }), "Herdr Main lookup");
		assertAgent(current, { pane: where.pane, workspace: where.workspace });
		if (typeof current.name === "string") {
			cachedMainName = herdrName(current.name, "Herdr Main name");
			return cachedMainName;
		}
		if (current.name !== null && current.name !== undefined) throw new Error("Herdr Main name is invalid.");
		const name = mainName();
		const renamed = agentInfo(await herdr.json(["agent", "rename", where.pane, name], { cwd: ctx.cwd, signal }), "Herdr Main rename");
		assertAgent(renamed, { name, pane: where.pane, workspace: where.workspace });
		cachedMainName = name;
		return name;
	};

	const startSubagent = async (name: string, tabId: string, paneId: string, model: string, thinkingLevel: string | undefined, where: HerdrLocation, ctx: ExtensionContext, signal?: AbortSignal) => {
		const args = [
			"agent", "start", name, "--kind", "pi", "--pane", paneId, "--",
			"--no-session", "--no-extensions", "--extension", SUBAGENT_EXTENSION,
			"--tools", "read,bash,edit,write,finish_task",
			"--model", model,
			...(thinkingLevel ? ["--thinking", thinkingLevel] : []),
			ctx.isProjectTrusted() ? "--approve" : "--no-approve",
		];
		for (let attempt = 0; attempt < 5; attempt++) {
			// Pane setup can briefly be busy after tab creation. Retry only this known transient Herdr error.
			const result = await herdr.exec(args, { cwd: ctx.cwd, signal });
			if (result.code === 0 && !result.killed) {
				const started = resultOf(parseJson(result.stdout, "Herdr Subagent start"), "Herdr Subagent start");
				if (started.type !== "agent_started") throw new Error("Herdr Subagent start did not return agent_started.");
				const agent = object(started.agent, "Herdr Subagent agent");
				assertAgent(agent, { name, pane: paneId, workspace: where.workspace, tab: tabId });
				if (agent.interactive_ready !== true) throw new Error("Herdr Subagent is not interactive.");
				return;
			}
			if (!hasHerdrErrorCode(result, "agent_pane_busy") || attempt === 4) {
				throw new Error(herdrCommandFailure(args, result));
			}
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		// Pi does not watch models-store.json. Reload cached metadata without network; catalog errors must not block startup.
		await ctx.modelRegistry.refresh({ allowNetwork: false }).catch(() => undefined);
		const loaded = await readConfig();
		config = loaded.value;
		if (loaded.invalid) ctx.ui.notify("Invalid pi-herdr-subagents config values were ignored.", "warning");
	});

	pi.registerCommand("subagent-limit", {
		description: "set maximum live Herdr Subagents for this Main session",
		handler: async (_args, ctx) => {
			const selected = await ctx.ui.input("Subagent Limit", String(config.maxConcurrentSubagents));
			if (selected === undefined) return;
			const parsed = /^[1-9]\d*$/.test(selected.trim()) ? Number(selected.trim()) : NaN;
			if (!Number.isSafeInteger(parsed)) {
				ctx.ui.notify("Subagent Limit must be a positive integer.", "warning");
				return;
			}
			try {
				// Merge against disk so another Main session's model mappings survive this limit update.
				await mutateConfig((latest) => ({ ...latest, maxConcurrentSubagents: parsed }));
				config = { ...config, maxConcurrentSubagents: parsed };
				ctx.ui.notify(`Subagent Limit set to ${config.maxConcurrentSubagents}.`, "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error && error.message === CONFIG_LOCK_FAILURE ? error.message : "Couldn't save Subagent Limit config.", "warning");
			}
		},
	});

	pi.registerCommand("subagent-model", {
		description: "map a Subagent model class to an available Pi model and thinking level",
		handler: async (_args, ctx) => {
			const modelClass = await ctx.ui.select("Subagent model class", [...MODEL_CLASSES]);
			if (!isModelClass(modelClass)) return;
			const models = availableTextModels(ctx);
			if (!models.length) {
				ctx.ui.notify("No authenticated text models are available.", "warning");
				return;
			}
			const saved = config.models[modelClass];
			const references = models.map(modelReference).sort();
			const selected = await ctx.ui.select(
				`${modelClass} Subagent model · saved: ${saved?.model ?? "none"}`,
				references,
			);
			const selectedModel = models.find((model) => modelReference(model) === selected);
			if (!selectedModel) return;
			const levels = getSupportedThinkingLevels(selectedModel);
			const thinkingLevel = await ctx.ui.select(
				`${modelClass} Subagent thinking level · saved: ${saved?.thinkingLevel ?? "none"}`,
				levels,
			);
			if (!isThinkingLevel(thinkingLevel) || !levels.some((level) => level === thinkingLevel)) return;
			try {
				const route = { model: selected, thinkingLevel };
				// Merge against disk so another Main session's limit and model mappings survive this route update.
				await mutateConfig((latest) => ({ ...latest, models: { ...latest.models, [modelClass]: route } }));
				config = { ...config, models: { ...config.models, [modelClass]: route } };
				ctx.ui.notify(`${modelClass} Subagent set to ${selected} with thinking ${thinkingLevel}.`, "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error && error.message === CONFIG_LOCK_FAILURE ? error.message : "Couldn't save Subagent model config.", "warning");
			}
		},
	});

	pi.registerTool({
		name: "delegate_task",
		label: "Delegate Task",
		description: "Delegate one bounded task to one interactive Herdr Pi Subagent. Split independent work, keep tightly coupled steps together, include only needed context, and choose the lowest model class likely to succeed. Never delegate overlapping writes.",
		parameters: Type.Object({
			task: Type.String({
				minLength: 1,
				description: "Self-contained task with only relevant context, exact paths, constraints, and success criteria. Request a concise Result.",
			}),
			modelClass: Type.Optional(Type.String({
				enum: MODEL_CLASSES,
				description: "Classify each task by complexity: fast for lookups, single-file summaries, or mechanical edits; balanced for bounded bug fixes, focused reviews, or clear multi-file features; frontier for architecture, ambiguous cross-cutting changes, or subtle concurrency/security reasoning. Defaults to balanced; falls back to Main model and thinking level when balanced route is unavailable.",
			})),
		}),
		executionMode: "sequential",
		execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
			const task = params.task;
			if (!task.trim()) throw new Error("delegate_task task must not be blank.");
			if (task.includes("\0")) throw new Error("delegate_task task must not contain NUL bytes.");
			if (!ctx.model) throw new Error("delegate_task requires an active Pi model.");
			if (params.modelClass !== undefined && !isModelClass(params.modelClass)) {
				throw new Error("delegate_task modelClass must be fast, balanced, or frontier.");
			}
			const modelClass = params.modelClass ?? "balanced";
			const configuredModel = config.models[modelClass];
			if (params.modelClass && !configuredModel) {
				throw new Error(`No ${modelClass} Subagent model configured; run /subagent-model.`);
			}
			const availableModel = configuredModel && availableTextModels(ctx)
				.find((model) => modelReference(model) === configuredModel.model);
			if (params.modelClass && configuredModel && !availableModel) {
				throw new Error(`Configured ${modelClass} Subagent model is unavailable; run /subagent-model.`);
			}
			const thinkingAvailable = Boolean(configuredModel && availableModel
				&& getSupportedThinkingLevels(availableModel).some((level) => level === configuredModel.thinkingLevel));
			if (params.modelClass && configuredModel && availableModel && !thinkingAvailable) {
				throw new Error(`Configured ${modelClass} Subagent thinking level is unavailable; run /subagent-model.`);
			}
			// Explicit unavailable routes reject above. Omitted balanced routes alone may fall back to Main.
			const configuredRoute = thinkingAvailable ? configuredModel : undefined;
			const selectedModel = configuredRoute?.model ?? `${ctx.model.provider}/${ctx.model.id}`;
			const selectedThinkingLevel = configuredRoute?.thinkingLevel ?? ctx.thinkingLevel;
			const where = location();
			const existingTabs = await reconcile(where, ctx, signal);
			if (subagents.size >= config.maxConcurrentSubagents) throw new Error(`Subagent Limit reached (${config.maxConcurrentSubagents}); no task was queued.`);

			const taskId = randomUUID();
			const tempDir = await mkdtemp(join(tmpdir(), "pi-herdr-subagents-"));
			await chmod(tempDir, 0o700);
			const resultPath = join(tempDir, "result.json");
			const label = subagentLabel(task, taskId);
			const subagent: OwnedSubagent = { taskId, task, subagentName: subagentName(taskId), resultPath, tempDir, label, existingTabs };
			let tabCreationAttempted = false;
			let promptOutcomeUnknown = false;
			// Claim ownership before side effects; indeterminate tab creation still needs reconciliation and cleanup.
			subagents.set(taskId, subagent);
			try {
				const createdAt = new Date().toISOString();
				await writeFile(resultPath, `${JSON.stringify({ version: PROTOCOL_VERSION, taskId, state: "pending", task, createdAt })}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
				await chmod(resultPath, 0o600);
				const main = await ensureMainName(where, ctx, signal);
				tabCreationAttempted = true;
				const created = resultOf(await herdr.json([
					"tab", "create", "--workspace", where.workspace, "--cwd", ctx.cwd,
					"--label", label, "--no-focus",
					"--env", `PI_HERDR_SUBAGENT_PROTOCOL=${PROTOCOL_VERSION}`,
					"--env", `PI_HERDR_SUBAGENT_TASK_ID=${taskId}`,
					"--env", `PI_HERDR_SUBAGENT_RESULT_PATH=${resultPath}`,
					"--env", `PI_HERDR_SUBAGENT_MAIN=${main}`,
				], { cwd: ctx.cwd, signal }), "Herdr tab create");
				if (created.type !== "tab_created") throw new Error("Herdr tab create did not return tab_created.");
				const tab = object(created.tab, "Herdr Subagent tab");
				const pane = object(created.root_pane, "Herdr Subagent root pane");
				const tabId = text(tab.tab_id, "Herdr Subagent tab ID");
				subagent.tabId = tabId;
				const paneId = text(pane.pane_id, "Herdr Subagent pane ID");
				if (
					tab.workspace_id !== where.workspace || pane.workspace_id !== where.workspace || pane.tab_id !== tabId
					|| tab.focused !== false || pane.focused !== false || tab.pane_count !== 1 || pane.cwd !== ctx.cwd
				) throw new Error("Herdr Subagent tab identity is invalid.");
				await startSubagent(subagent.subagentName, tabId, paneId, selectedModel, selectedThinkingLevel, where, ctx, signal);
				if (signal?.aborted) throw new Error("delegate_task was aborted before task submission.");
				const promptArgs = ["agent", "prompt", subagent.subagentName, task];
				// Lost prompt response can still mean Herdr accepted task, so retain ownership until outcome is known.
				promptOutcomeUnknown = true;
				const response = await herdr.exec(promptArgs, { cwd: ctx.cwd, signal });
				if (response.code !== 0 || response.killed) {
					if (!response.killed && [...DEFINITIVE_PROMPT_ERRORS].some((code) => hasHerdrErrorCode(response, code))) {
						promptOutcomeUnknown = false;
					}
					throw new Error(herdrCommandFailure(promptArgs, response));
				}
				const prompted = resultOf(parseJson(response.stdout, "Herdr Subagent prompt"), "Herdr Subagent prompt");
				if (prompted.type !== "agent_prompted") throw new Error("Herdr Subagent prompt was not accepted.");
				const agent = object(prompted.agent, "Herdr prompted Subagent");
				assertAgent(agent, { name: subagent.subagentName, pane: paneId, workspace: where.workspace, tab: tabId });
				promptOutcomeUnknown = false;
				return {
					content: [{ type: "text", text: `Delegated Task ${taskId}\nSubagent: ${subagent.subagentName}\nModel: ${selectedModel} (${configuredRoute ? modelClass : "Main"})\nThinking: ${selectedThinkingLevel ?? "Pi default"}\nTab: ${tabId}\nResult: ${resultPath}\nStop: herdr tab close ${tabId}` }],
					details: {},
					terminate: true,
				};
			} catch (error) {
				// Never close a tab with unknown prompt outcome: task may already be running.
				if (promptOutcomeUnknown) {
					const message = error instanceof Error ? error.message : String(error);
					throw new Error(`Delegated Task ${taskId} prompt outcome is unknown; Subagent may be running and remains owned.\nSubagent: ${subagent.subagentName}\nTab: ${subagent.tabId}\nResult: ${subagent.resultPath}\nStop: herdr tab close ${subagent.tabId}\n${message}`);
				}
				if (subagent.tabId) {
					try {
						await closeTab(subagent.tabId, ctx);
					} catch (cleanupError) {
						throw rollbackCleanupError(subagent, subagent.tabId, error, cleanupError);
					}
				} else if (tabCreationAttempted) {
					let tabs: HerdrTab[];
					try {
						tabs = await listTabs(where, ctx);
					} catch (reconciliationError) {
						throw provisioningReconciliationError(subagent, where, error, reconciliationError);
					}
					for (const tab of tabs.filter((candidate) => !existingTabs.has(candidate.id) && candidate.label === label)) {
						try {
							await closeTab(tab.id, ctx);
						} catch (cleanupError) {
							subagent.tabId = tab.id;
							throw rollbackCleanupError(subagent, tab.id, error, cleanupError);
						}
					}
				}
				subagents.delete(taskId);
				await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
				throw error;
			}
		},
	});

	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") return { action: "continue" } as const;
		// Coalesced notices are atomic: invalid frame must not release another Subagent's capacity.
		const notices = parseCompletionNotices(event.text);
		if (!notices) return { action: "continue" } as const;
		const seen = new Set<string>();
		const owned = [];
		for (const notice of notices) {
			if (seen.has(notice.taskId)) return { action: "continue" } as const;
			seen.add(notice.taskId);
			const subagent = subagents.get(notice.taskId);
			if (!subagent || subagent.resultPath !== notice.resultPath || !isAbsolute(notice.resultPath)) return { action: "continue" } as const;
			owned.push({ notice, subagent });
		}
		let validated;
		try {
			validated = await Promise.all(owned.map(async ({ notice, subagent }) => {
				const terminal = parseTerminalResult(JSON.parse(await readFile(subagent.resultPath, "utf8")) as unknown);
				if (!terminal || terminal.taskId !== subagent.taskId || terminal.task !== subagent.task) return;
				return { notice, subagent, terminal };
			}));
		} catch {
			return { action: "continue" } as const;
		}
		const completed = validated.flatMap((entry) => entry ? [entry] : []);
		if (completed.length !== notices.length || completed.some(({ notice, subagent }) => subagents.get(notice.taskId) !== subagent)) {
			return { action: "continue" } as const;
		}
		// Result is durable; free capacity even if best-effort tab cleanup later fails.
		for (const { subagent } of completed) subagents.delete(subagent.taskId);
		for (const { subagent } of completed) if (subagent.tabId) void closeTab(subagent.tabId, ctx).catch(() => undefined);
		return {
			action: "transform",
			text: completed.map(({ subagent, terminal }) => `Subagent ${subagent.subagentName} completed Delegated Task ${subagent.taskId} (${terminal.state}). Read Result before relying on it: ${subagent.resultPath}`).join("\n\n"),
		};
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		// No persistent registry: cleanup applies only to tabs this Main session recorded.
		try {
			await reconcile(location(), ctx);
		} catch { }
		const owned = [...subagents.values()];
		subagents.clear();
		await Promise.all(owned.flatMap((subagent) => subagent.tabId ? [closeTab(subagent.tabId, ctx).catch(() => undefined)] : []));
	});
}
