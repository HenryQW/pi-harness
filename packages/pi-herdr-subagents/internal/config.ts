import { access, chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rename, rm, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const DEFAULT_LIMIT = 10;
export const MODEL_CLASSES = ["fast", "balanced", "frontier"] as const;
const CONFIG_PATH = () => join(getAgentDir(), "config", "pi-herdr-subagents.json");
const CONFIG_LOCK_TIMEOUT_MS = 1_000;
const CONFIG_LOCK_RETRY_MS = 25;
export const CONFIG_LOCK_FAILURE = "Subagent config is busy; try again.";
const CONFIG_LOCK_OWNER = "owner";
const CODEX_ALIAS = /^openai-codex-(?:[2-9]|[1-9]\d+)$/;

export type ModelClass = typeof MODEL_CLASSES[number];
type ConfiguredModel = { model: string; thinkingLevel: string };
export type Config = {
	maxConcurrentSubagents: number;
	models: Partial<Record<ModelClass, ConfiguredModel>>;
};
type ConfigLockOwner = { raw: string; pid: number; token: string };

export const defaultConfig = (): Config => ({ maxConcurrentSubagents: DEFAULT_LIMIT, models: {} });
const configLimit = (value: unknown): number | undefined =>
	typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
export const isModelClass = (value: unknown): value is ModelClass =>
	typeof value === "string" && MODEL_CLASSES.includes(value as ModelClass);
export const isThinkingLevel = (value: unknown): value is string =>
	typeof value === "string" && Boolean(value) && value === value.trim() && !value.includes("\0");
export const isCodexProvider = (provider: string | undefined): boolean =>
	provider === "openai-codex" || Boolean(provider && CODEX_ALIAS.test(provider));
export const canonicalModelReference = (reference: string): string => {
	const separator = reference.indexOf("/");
	const provider = reference.slice(0, separator);
	return `${isCodexProvider(provider) ? "openai-codex" : provider}/${reference.slice(separator + 1)}`;
};
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
			models[modelClass] = { model: canonicalModelReference(configured.model), thinkingLevel: configured.thinkingLevel };
		} else invalid = true;
	}
	return { value: models, invalid };
}

export async function readConfig(path = CONFIG_PATH()): Promise<{ value: Config; invalid: boolean }> {
	try {
		const value = JSON.parse(await readFile(path, "utf8")) as unknown;
		if (!value || typeof value !== "object" || Array.isArray(value)) return { value: defaultConfig(), invalid: true };
		const record = value as Record<string, unknown>;
		const limit = configLimit(record.maxConcurrentSubagents);
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

export async function mutateConfig(mutate: (config: Config) => Config): Promise<void> {
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
