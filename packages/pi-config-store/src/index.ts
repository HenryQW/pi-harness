import { randomUUID } from "node:crypto";
import { closeSync, openSync, readSync } from "node:fs";
import { chmod, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { lock } from "proper-lockfile";

const MAX_CONFIG_BYTES = 64 * 1024;
const EXTENSION_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function assertExtensionId(extensionId: string): void {
	if (typeof extensionId !== "string" || !EXTENSION_ID.test(extensionId)) {
		throw new TypeError("extensionId must be one lowercase path component");
	}
}

function isMissing(error: unknown): boolean {
	return !!error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function readBounded(path: string): Buffer {
	let file: number | undefined;
	try {
		file = openSync(path, "r");
		const bytes = Buffer.allocUnsafe(MAX_CONFIG_BYTES + 1);
		let offset = 0;
		while (offset < bytes.length) {
			const bytesRead = readSync(file, bytes, offset, bytes.length - offset, null);
			if (bytesRead === 0) break;
			offset += bytesRead;
		}
		if (offset > MAX_CONFIG_BYTES) throw new Error(`Config exceeds ${MAX_CONFIG_BYTES} bytes: ${path}`);
		return bytes.subarray(0, offset);
	} finally {
		if (file !== undefined) closeSync(file);
	}
}

function serialize(value: unknown): string {
	const json = JSON.stringify(value, null, 2);
	if (json === undefined) throw new TypeError("Config value must be JSON-serializable");
	const contents = `${json}\n`;
	if (Buffer.byteLength(contents, "utf8") > MAX_CONFIG_BYTES) {
		throw new Error(`Config exceeds ${MAX_CONFIG_BYTES} bytes`);
	}
	return contents;
}

async function withLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
	const directory = dirname(path);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	if (process.platform !== "win32") await chmod(directory, 0o700);

	const release = await lock(path, {
		lockfilePath: `${path}.lock`,
		realpath: false,
		stale: 30_000,
		update: 5_000,
		retries: { retries: 400, factor: 1, minTimeout: 25, maxTimeout: 25 },
	});
	try {
		return await operation();
	} finally {
		await release();
	}
}

async function writeAtomically(path: string, contents: string): Promise<void> {
	const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
	let file: import("node:fs/promises").FileHandle | undefined;
	let created = false;
	try {
		file = await open(temporaryPath, "wx", 0o600);
		created = true;
		await file.writeFile(contents, { encoding: "utf8" });
		await file.close();
		file = undefined;
		await rename(temporaryPath, path);
	} catch (error) {
		try {
			await file?.close();
		} finally {
			if (created) await rm(temporaryPath, { force: true });
		}
		throw error;
	}
}

class ConfigStore<T> {
	readonly path: string;
	private readonly defaults: () => T;
	private readonly parse: (value: unknown) => T;

	constructor(path: string, defaults: () => T, parse: (value: unknown) => T) {
		this.path = path;
		this.defaults = defaults;
		this.parse = parse;
	}

	loadSync(): { source: "file" | "missing"; value: T } {
		let bytes: Buffer;
		try {
			bytes = readBounded(this.path);
		} catch (error) {
			if (isMissing(error)) return { source: "missing", value: this.parse(this.defaults()) };
			throw error;
		}
		return {
			source: "file",
			value: this.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))),
		};
	}

	async save(value: T): Promise<void> {
		const contents = serialize(this.parse(value));
		await withLock(this.path, async () => {
			await writeAtomically(this.path, contents);
		});
	}

	async update(mutator: (value: T) => T): Promise<T> {
		return await withLock(this.path, async () => {
			const next = this.parse(mutator(this.loadSync().value));
			await writeAtomically(this.path, serialize(next));
			return next;
		});
	}

	async remove(): Promise<void> {
		await withLock(this.path, async () => {
			await rm(this.path, { force: true });
		});
	}
}

/** Return the directory owned by an extension under Pi's agent config home. */
export function extensionConfigDir(extensionId: string, agentDir?: string): string {
	assertExtensionId(extensionId);
	return join(agentDir ?? getAgentDir(), "config", extensionId);
}

/** Return an extension's default JSON configuration path. */
export function extensionConfigPath(extensionId: string, agentDir?: string): string {
	return join(extensionConfigDir(extensionId, agentDir), "config.json");
}

export function createConfigStore<T>(options: {
	extensionId: string;
	agentDir?: string;
	defaults: () => T;
	parse: (value: unknown) => T;
}): ConfigStore<T> {
	return new ConfigStore(extensionConfigPath(options.extensionId, options.agentDir), options.defaults, options.parse);
}
