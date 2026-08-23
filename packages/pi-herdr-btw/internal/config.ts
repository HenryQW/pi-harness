import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { lock } from "proper-lockfile";

export const TOOL_MODES = ["inherit", "all", "read-only", "none"] as const;
export type BtwToolMode = (typeof TOOL_MODES)[number];
export type BtwSplit = "right" | "down";

export type BtwConfig = {
	autoSubmit: boolean;
	tools: BtwToolMode;
	split: BtwSplit;
};

const CONFIG_LOCK_STALE_MS = 30_000;
const CONFIG_LOCK_WAIT_MS = 10_000;
const CONFIG_LOCK_RETRY_MS = 25;
const CONFIG_LOCK_UPDATE_MS = 5_000;

export const DEFAULT_CONFIG: Readonly<BtwConfig> = Object.freeze({
	autoSubmit: false,
	tools: "inherit",
	split: "right",
});

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

export function parseConfig(value: unknown): BtwConfig {
	if (!isRecord(value)) throw new Error("/btw config must be a JSON object");
	const allowedKeys = new Set(["autoSubmit", "tools", "split"]);
	for (const key of Object.keys(value)) {
		if (!allowedKeys.has(key)) throw new Error(`unknown config key: ${key}`);
	}

	const config = { ...DEFAULT_CONFIG };
	if ("autoSubmit" in value) {
		if (typeof value.autoSubmit !== "boolean") throw new Error("autoSubmit must be true or false");
		config.autoSubmit = value.autoSubmit;
	}
	if ("tools" in value) {
		if (!TOOL_MODES.includes(value.tools as BtwToolMode)) {
			throw new Error("tools must be inherit, all, read-only, or none");
		}
		config.tools = value.tools as BtwToolMode;
	}
	if ("split" in value) {
		if (value.split !== "right" && value.split !== "down") {
			throw new Error("split must be right or down");
		}
		config.split = value.split;
	}
	return config;
}

export function formatConfig(config: BtwConfig): string {
	return [
		`auto-submit: ${config.autoSubmit ? "on" : "off"}`,
		`tools: ${config.tools}`,
		`split: ${config.split}`,
	].join(" · ");
}

export const CONFIG_COMMAND_USAGE =
	"/btw config [auto-submit on|off | tools inherit|all|read-only|none | split right|down | reset]";

export type ConfigCommandResult = {
	action: "show" | "save" | "reset";
	config: BtwConfig;
};

export function applyConfigCommand(current: BtwConfig, input: string): ConfigCommandResult {
	const trimmed = input.trim();
	if (!trimmed || trimmed === "show") return { action: "show", config: current };
	if (trimmed === "reset") return { action: "reset", config: { ...DEFAULT_CONFIG } };

	const [key, value, ...extra] = trimmed.split(/\s+/);
	if (!key || !value || extra.length > 0) throw new Error(CONFIG_COMMAND_USAGE);
	const config = { ...current };

	switch (key) {
		case "auto-submit":
			if (value !== "on" && value !== "off") throw new Error(CONFIG_COMMAND_USAGE);
			config.autoSubmit = value === "on";
			break;
		case "tools":
			if (!TOOL_MODES.includes(value as BtwToolMode)) {
				throw new Error(CONFIG_COMMAND_USAGE);
			}
			config.tools = value as BtwToolMode;
			break;
		case "split":
			if (value !== "right" && value !== "down") throw new Error(CONFIG_COMMAND_USAGE);
			config.split = value;
			break;
		default:
			throw new Error(CONFIG_COMMAND_USAGE);
	}

	return { action: "save", config };
}

const configPath = () => join(getAgentDir(), "config", "pi-herdr-btw.json");

export class ConfigStore {
	readonly path: string;

	constructor(path = configPath()) {
		this.path = path;
	}

	async load(): Promise<BtwConfig> {
		try {
			return parseConfig(JSON.parse(await readFile(this.path, "utf8")));
		} catch (error) {
			if (error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT") {
				return { ...DEFAULT_CONFIG };
			}
			throw error;
		}
	}

	async save(config: BtwConfig): Promise<void> {
		const validated = parseConfig(config);
		await this.withLock(() => this.saveUnlocked(validated));
	}

	async update(mutator: (config: BtwConfig) => BtwConfig): Promise<BtwConfig> {
		return this.withLock(async () => {
			const next = parseConfig(mutator(await this.load()));
			await this.saveUnlocked(next);
			return next;
		});
	}

	async reset(): Promise<BtwConfig> {
		return this.withLock(async () => {
			await rm(this.path, { force: true });
			return { ...DEFAULT_CONFIG };
		});
	}

	private async saveUnlocked(validated: BtwConfig): Promise<void> {
		const directory = dirname(this.path);
		await mkdir(directory, { recursive: true, mode: 0o700 });
		const temporaryPath = `${this.path}.${process.pid}.${Date.now()}.tmp`;
		try {
			await writeFile(temporaryPath, `${JSON.stringify(validated, null, 2)}\n`, {
				encoding: "utf8",
				flag: "wx",
				mode: 0o600,
			});
			await chmod(temporaryPath, 0o600);
			await rename(temporaryPath, this.path);
		} catch (error) {
			await rm(temporaryPath, { force: true }).catch(() => undefined);
			throw error;
		}
	}

	private async withLock<T>(operation: () => Promise<T>): Promise<T> {
		await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
		const deadline = Date.now() + CONFIG_LOCK_WAIT_MS;
		while (true) {
			try {
				const release = await lock(this.path, {
					lockfilePath: `${this.path}.lock`,
					realpath: false,
					stale: CONFIG_LOCK_STALE_MS,
					update: CONFIG_LOCK_UPDATE_MS,
				});
				try {
					return await operation();
				} finally {
					await release();
				}
			} catch (error) {
				const code = error && typeof error === "object" ? (error as NodeJS.ErrnoException).code : undefined;
				if (code !== "ELOCKED") throw error;
				if (Date.now() >= deadline) throw new Error(`Timed out waiting for config lock: ${this.path}`);
				await new Promise((resolve) => setTimeout(resolve, CONFIG_LOCK_RETRY_MS));
			}
		}
	}
}
