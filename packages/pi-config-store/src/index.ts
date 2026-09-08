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

function assertMaxBytes(maxBytes: number): void {
	if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
		throw new TypeError("maxBytes must be a positive safe integer");
	}
}

function readBufferSize(maxBytes: number, bytesRead: number): number {
	return Math.min(64 * 1024, maxBytes - bytesRead + 1);
}

class BoundedTextFileTooLargeError extends Error {}

function decodeBounded(chunks: Buffer[], bytesRead: number, path: string, maxBytes: number): string {
	if (bytesRead > maxBytes) throw new BoundedTextFileTooLargeError(`Text file exceeds ${maxBytes} bytes: ${path}`);
	return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytesRead));
}

/** Read strict UTF-8 text, consuming no more than maxBytes + 1 bytes synchronously. */
export function readTextFileBoundedSync(path: string, maxBytes: number): string {
	assertMaxBytes(maxBytes);
	let file: number | undefined;
	const chunks: Buffer[] = [];
	let bytesRead = 0;
	try {
		file = openSync(path, "r");
		while (bytesRead <= maxBytes) {
			const chunk = Buffer.allocUnsafe(readBufferSize(maxBytes, bytesRead));
			const count = readSync(file, chunk, 0, chunk.length, null);
			if (count === 0) break;
			chunks.push(chunk.subarray(0, count));
			bytesRead += count;
		}
		return decodeBounded(chunks, bytesRead, path, maxBytes);
	} finally {
		if (file !== undefined) closeSync(file);
	}
}

/** Read strict UTF-8 text, consuming no more than maxBytes + 1 bytes. */
export async function readTextFileBounded(
	path: string,
	maxBytes: number,
	options: { signal?: AbortSignal } = {},
): Promise<string> {
	assertMaxBytes(maxBytes);
	options.signal?.throwIfAborted();
	const file = await open(path, "r");
	const chunks: Buffer[] = [];
	let bytesRead = 0;
	try {
		while (bytesRead <= maxBytes) {
			options.signal?.throwIfAborted();
			const chunk = Buffer.allocUnsafe(readBufferSize(maxBytes, bytesRead));
			const result = await file.read(chunk, 0, chunk.length, null);
			options.signal?.throwIfAborted();
			if (result.bytesRead === 0) break;
			chunks.push(chunk.subarray(0, result.bytesRead));
			bytesRead += result.bytesRead;
		}
		return decodeBounded(chunks, bytesRead, path, maxBytes);
	} finally {
		await file.close();
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

async function ensurePrivateDirectory(directory: string, signal?: AbortSignal): Promise<void> {
	signal?.throwIfAborted();
	await mkdir(directory, { recursive: true, mode: 0o700 });
	signal?.throwIfAborted();
	if (process.platform !== "win32") await chmod(directory, 0o700);
	signal?.throwIfAborted();
}

async function withLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
	await ensurePrivateDirectory(dirname(path));

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

/** Atomically replace a UTF-8 text file using private directory and file modes. */
export async function writePrivateTextFileAtomically(
	path: string,
	contents: string,
	options: { signal?: AbortSignal } = {},
): Promise<void> {
	await ensurePrivateDirectory(dirname(path), options.signal);
	const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
	let file: import("node:fs/promises").FileHandle | undefined;
	let created = false;
	try {
		file = await open(temporaryPath, "wx", 0o600);
		created = true;
		options.signal?.throwIfAborted();
		await file.writeFile(contents, { encoding: "utf8", signal: options.signal });
		options.signal?.throwIfAborted();
		await file.sync();
		options.signal?.throwIfAborted();
		await file.close();
		file = undefined;
		options.signal?.throwIfAborted();
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
		let contents: string;
		try {
			contents = readTextFileBoundedSync(this.path, MAX_CONFIG_BYTES);
		} catch (error) {
			if (isMissing(error)) return { source: "missing", value: this.parse(this.defaults()) };
			if (error instanceof BoundedTextFileTooLargeError) {
				throw new Error(`Config exceeds ${MAX_CONFIG_BYTES} bytes: ${this.path}`);
			}
			throw error;
		}
		return { source: "file", value: this.parse(JSON.parse(contents)) };
	}

	async save(value: T): Promise<void> {
		const contents = serialize(this.parse(value));
		await withLock(this.path, async () => {
			await writePrivateTextFileAtomically(this.path, contents);
		});
	}

	async update(mutator: (value: T) => T): Promise<T> {
		return await withLock(this.path, async () => {
			const next = this.parse(mutator(this.loadSync().value));
			await writePrivateTextFileAtomically(this.path, serialize(next));
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
