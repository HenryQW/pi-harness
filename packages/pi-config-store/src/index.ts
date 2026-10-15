import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { chmod, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
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

/** Read at most maxBytes + 1 bytes from an open file. */
function readOpenFileBoundedSync(file: number, maxBytes: number): Buffer {
	const chunks: Buffer[] = [];
	let bytesRead = 0;
	while (bytesRead <= maxBytes) {
		const chunk = Buffer.allocUnsafe(readBufferSize(maxBytes, bytesRead));
		const count = readSync(file, chunk, 0, chunk.length, null);
		if (count === 0) break;
		chunks.push(chunk.subarray(0, count));
		bytesRead += count;
	}
	return Buffer.concat(chunks, bytesRead);
}

/**
 * Read a config file's revision: at most maxBytes + 1 bytes of a regular file. A FIFO opens without blocking
 * (O_NONBLOCK, where supported), and fstat rejects it and any other non-regular file before a read.
 */
function readRevisionSync(path: string, maxBytes: number): Buffer {
	const file = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
	try {
		if (!fstatSync(file).isFile()) throw new Error("not a regular file");
		return readOpenFileBoundedSync(file, maxBytes);
	} finally {
		closeSync(file);
	}
}

/** Read strict UTF-8 text, consuming no more than maxBytes + 1 bytes synchronously. */
export function readTextFileBoundedSync(path: string, maxBytes: number): string {
	assertMaxBytes(maxBytes);
	const file = openSync(path, "r");
	try {
		const bytes = readOpenFileBoundedSync(file, maxBytes);
		return decodeBounded([bytes], bytes.length, path, maxBytes);
	} finally {
		closeSync(file);
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

export type ConfigIssueKind =
	| "unreadable"
	| "too-large"
	| "invalid-utf8"
	| "invalid-json"
	| "invalid-root"
	| "unknown-key"
	| "invalid-value"
	| "missing-required"
	| "invalid-config";

/** One config problem. `key` is the formatted key path, such as `jobs[2].cwd`; it is empty for the whole file. */
export interface ConfigIssue {
	kind: ConfigIssueKind;
	key: string;
	message: string;
}

export type KeyPath = readonly (string | number)[];

/** Record a problem at `path`, relative to the value being parsed. Use it for entries that a parser drops. */
export type Report = (path: KeyPath, message: string, kind?: "unknown-key" | "invalid-value") => void;

/** Parse one untrusted JSON value. Throw to reject the whole value; report and drop bad nested entries. */
export type FieldParser<T> = (raw: unknown, report: Report) => T;

export interface Field<T> {
	readonly parse: FieldParser<T>;
	/** Absent for a required field. */
	readonly fallback?: { readonly value: T };
	/** True when an invalid value disables the config instead of using the default. */
	readonly disableOnInvalid: boolean;
}

// Field tables mix value types, so entries use `any`.
export type Fields = Readonly<Record<string, Field<any>>>;
export type FieldsValue<F extends Fields> = { [K in keyof F]: F[K] extends Field<infer T> ? T : never };

/** An optional field. A missing value uses `fallback`; an invalid value uses it too unless `onInvalid` is `"disable"`. */
export function field<T>(parse: FieldParser<T>, fallback: NoInfer<T>, options: { onInvalid?: "default" | "disable" } = {}): Field<T> {
	return { parse, fallback: { value: fallback }, disableOnInvalid: options.onInvalid === "disable" };
}

/** A required field. A missing or invalid value disables the config. */
export function required<T>(parse: FieldParser<T>): Field<T> {
	return { parse, disableOnInvalid: true };
}

type Sink = (path: KeyPath, message: string, kind: ConfigIssueKind) => void;

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function formatKey(path: KeyPath): string {
	return path.map((segment, index) => {
		if (typeof segment === "number") return `[${segment}]`;
		if (/^[A-Za-z_$][\w$]*$/.test(segment)) return index === 0 ? segment : `.${segment}`;
		return `[${JSON.stringify(segment)}]`;
	}).join("");
}

/** Run a parser; keep its reports only when it succeeds, so a rejected value yields one issue. */
function parseValue<T>(parse: FieldParser<T>, raw: unknown, path: KeyPath, sink: Sink): { ok: true; value: T } | { ok: false; message: string } {
	const reports: [KeyPath, string, ConfigIssueKind][] = [];
	try {
		const value = parse(raw, (child, message, kind = "invalid-value") => reports.push([[...path, ...child], message, kind]));
		for (const report of reports) sink(...report);
		return { ok: true, value };
	} catch (error) {
		return { ok: false, message: errorMessage(error) };
	}
}

/** Case-insensitive optimal string alignment distance (Damerau-Levenshtein without repeated edits of one substring). */
function editDistance(left: string, right: string): number {
	const a = left.toLowerCase();
	const b = right.toLowerCase();
	const rows = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => i || j));
	for (let i = 1; i <= a.length; i++) {
		for (let j = 1; j <= b.length; j++) {
			rows[i][j] = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
			if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) rows[i][j] = Math.min(rows[i][j], rows[i - 2][j - 2] + 1);
		}
	}
	return rows[a.length][b.length];
}

/**
 * The absent declared key that an unknown key most likely misspells: equal except for letter case, or at most
 * one edit for each three characters of the declared key, and at most two edits. Ties keep declaration order.
 */
function nearMiss(key: string, absent: readonly string[]): string | undefined {
	let best: { name: string; distance: number } | undefined;
	for (const name of absent) {
		const distance = editDistance(key, name);
		if (distance <= Math.min(2, Math.floor(name.length / 3)) && (!best || distance < best.distance)) best = { name, distance };
	}
	return best?.name;
}

/**
 * Apply a field table; `blocked` is true when a required or unsafe field has no usable value.
 * A near-miss unknown key counts as an invalid value of the absent field that it misspells.
 */
function applyFields(raw: Record<string, unknown>, fields: Fields, path: KeyPath, sink: Sink): { value: Record<string, unknown>; blocked: boolean } {
	const absent = Object.keys(fields).filter((key) => !Object.hasOwn(raw, key));
	const misspelled = new Map<string, string[]>();
	for (const key of Object.keys(raw)) {
		if (Object.hasOwn(fields, key)) continue;
		const match = nearMiss(key, absent);
		if (match === undefined) sink([...path, key], "unknown key", "unknown-key");
		else misspelled.set(match, [...misspelled.get(match) ?? [], key]);
	}
	const value: Record<string, unknown> = {};
	let blocked = false;
	for (const [key, spec] of Object.entries(fields)) {
		let parsed: { ok: true; value: unknown } | undefined;
		const misses = misspelled.get(key);
		if (misses) {
			for (const miss of misses) sink([...path, key], `unknown key ${JSON.stringify(miss)}; did you mean ${JSON.stringify(key)}?`, "invalid-value");
			blocked ||= spec.disableOnInvalid;
		} else if (!Object.hasOwn(raw, key)) {
			if (!spec.fallback) {
				sink([...path, key], "required", "missing-required");
				blocked = true;
			}
		} else {
			const result = parseValue(spec.parse, raw[key], [...path, key], sink);
			if (result.ok) parsed = result;
			else {
				sink([...path, key], result.message, "invalid-value");
				blocked ||= spec.disableOnInvalid;
			}
		}
		if (parsed) value[key] = parsed.value;
		else if (spec.fallback) value[key] = structuredClone(spec.fallback.value);
	}
	return { value, blocked };
}

/** Reusable field parsers. Each throws on an invalid value. */
export const parsers = {
	boolean(): FieldParser<boolean> {
		return (raw) => {
			if (typeof raw !== "boolean") throw new Error("must be true or false");
			return raw;
		};
	},

	/** A finite number in range. `min`/`max` are inclusive; `greaterThan`/`lessThan` are exclusive. */
	number(range: NumberRange = {}): FieldParser<number> {
		return (raw) => {
			if (typeof raw !== "number" || !Number.isFinite(raw)) throw new Error(`must be a number${describeRange(range)}`);
			return checkRange(raw, range, "a number");
		};
	},

	/** A safe integer in range. */
	integer(range: NumberRange = {}): FieldParser<number> {
		return (raw) => {
			if (typeof raw !== "number" || !Number.isSafeInteger(raw)) throw new Error(`must be an integer${describeRange(range)}`);
			return checkRange(raw, range, "an integer");
		};
	},

	/** A string with non-whitespace text. `trim` returns it without surrounding whitespace. */
	string(options: { trim?: boolean } = {}): FieldParser<string> {
		return (raw) => {
			if (typeof raw !== "string" || !raw.trim()) throw new Error("must be non-empty text");
			return options.trim ? raw.trim() : raw;
		};
	},

	/** An absolute path without control characters. */
	absolutePath(): FieldParser<string> {
		return (raw) => {
			if (typeof raw !== "string" || !isAbsolute(raw) || /\p{C}/u.test(raw)) {
				throw new Error("must be an absolute path without control characters");
			}
			return raw;
		};
	},

	oneOf<const V extends readonly (string | number | boolean)[]>(values: V): FieldParser<V[number]> {
		return (raw) => {
			if (!values.includes(raw as V[number])) throw new Error(`must be one of ${values.join(", ")}`);
			return raw as V[number];
		};
	},

	nullable<T>(parse: FieldParser<T>): FieldParser<T | null> {
		return (raw, report) => raw === null ? null : parse(raw, report);
	},

	/** A nested object with its own field table. Unknown keys are reported and ignored. */
	object<F extends Fields>(fields: F): FieldParser<FieldsValue<F>> {
		return (raw, report) => {
			if (!isRecord(raw)) throw new Error("must be a JSON object");
			const issues: [KeyPath, string, ConfigIssueKind][] = [];
			const { value, blocked } = applyFields(raw, fields, [], (...issue) => issues.push(issue));
			// A blocked nested object rejects its parent value, which then follows the parent field's policy.
			if (blocked) throw new Error(issues.map(([path, message]) => `${formatKey(path)}: ${message}`).join("; "));
			for (const [path, message, kind] of issues) report(path, message, kind as "unknown-key" | "invalid-value");
			return value as FieldsValue<F>;
		};
	},

	/** A map. A bad key is reported as unknown and a bad value as invalid; either entry is dropped. */
	record<V, K extends string = string>(
		value: FieldParser<V>,
		options: { key?: FieldParser<K> } = {},
	): FieldParser<string extends K ? Record<string, V> : Partial<Record<K, V>>> {
		return (raw, report) => {
			if (!isRecord(raw)) throw new Error("must be a JSON object");
			const entries: [string, V][] = [];
			for (const [name, entry] of Object.entries(raw)) {
				if (options.key) {
					try {
						options.key(name, () => {});
					} catch (error) {
						report([name], errorMessage(error), "unknown-key");
						continue;
					}
				}
				const parsed = parseValue(value, entry, [name], (path, message, kind) => report(path, message, kind as "unknown-key" | "invalid-value"));
				if (parsed.ok) entries.push([name, parsed.value]);
				else report([name], parsed.message);
			}
			return Object.fromEntries(entries) as string extends K ? Record<string, V> : Partial<Record<K, V>>;
		};
	},

	/** An array. A bad item is reported and dropped; with `unique`, a later item with a repeated identity is dropped. */
	array<T>(item: FieldParser<T>, options: { unique?: (item: T) => unknown } = {}): FieldParser<T[]> {
		return (raw, report) => {
			if (!Array.isArray(raw)) throw new Error("must be an array");
			const items: T[] = [];
			const seen = new Set<unknown>();
			raw.forEach((entry, index) => {
				const parsed = parseValue(item, entry, [index], (path, message, kind) => report(path, message, kind as "unknown-key" | "invalid-value"));
				if (!parsed.ok) return report([index], parsed.message);
				if (options.unique) {
					const identity = options.unique(parsed.value);
					if (seen.has(identity)) return report([index], `duplicates ${JSON.stringify(identity)}`);
					seen.add(identity);
				}
				items.push(parsed.value);
			});
			return items;
		};
	},
};

export type NumberRange = { min?: number; max?: number; greaterThan?: number; lessThan?: number };

function describeRange({ min, max, greaterThan, lessThan }: NumberRange): string {
	const bounds = [
		min === undefined ? undefined : `>= ${min}`,
		greaterThan === undefined ? undefined : `> ${greaterThan}`,
		max === undefined ? undefined : `<= ${max}`,
		lessThan === undefined ? undefined : `< ${lessThan}`,
	].filter(Boolean);
	return bounds.length ? ` ${bounds.join(" and ")}` : "";
}

function checkRange(value: number, range: NumberRange, noun: string): number {
	if (
		(range.min !== undefined && value < range.min)
		|| (range.max !== undefined && value > range.max)
		|| (range.greaterThan !== undefined && value <= range.greaterThan)
		|| (range.lessThan !== undefined && value >= range.lessThan)
	) throw new Error(`must be ${noun}${describeRange(range)}`);
	return value;
}

export type ConfigLoad<T> =
	| { status: "ok"; source: "file" | "missing"; value: T; issues: ConfigIssue[] }
	| { status: "disabled"; source: "file" | "missing"; issues: ConfigIssue[] };

/** Format issues as `key: message; ...`. */
export function formatConfigIssues(issues: readonly ConfigIssue[]): string {
	return issues.map(({ key, message }) => key ? `${key}: ${message}` : message).join("; ");
}

type RootSchema<T> =
	| { kind: "fields"; fields: Fields; check?: (value: T) => void }
	| { kind: "entries"; entries: FieldParser<T>; check?: (value: T) => void };

function readIssue(error: unknown): ConfigIssue {
	if (error instanceof BoundedTextFileTooLargeError) return { kind: "too-large", key: "", message: `file exceeds ${MAX_CONFIG_BYTES} bytes` };
	if ((error as NodeJS.ErrnoException).code === "ERR_ENCODING_INVALID_ENCODED_DATA") {
		return { kind: "invalid-utf8", key: "", message: "file is not valid UTF-8" };
	}
	return { kind: "unreadable", key: "", message: `cannot read file: ${errorMessage(error)}` };
}

/** The bytes a load read (at most the limit + 1), `null` for a missing file, or a read error message. */
type Revision = Buffer | string | null;

/** What each `loadSync()` result read, so `replaceIfUnchanged` can detect a later change. */
const revisions = new WeakMap<object, { path: string; revision: Revision }>();

/** Why a revision cannot prove the file's exact contents: a read error, or a file larger than the limit. */
function incompleteRevision(revision: Revision): string | undefined {
	if (typeof revision === "string") return revision;
	if (revision && revision.length > MAX_CONFIG_BYTES) return `file exceeds ${MAX_CONFIG_BYTES} bytes`;
	return undefined;
}

/** Equal only when both files are missing, or both were read completely with the same bytes. */
function sameRevision(left: Revision, right: Revision): boolean {
	if (incompleteRevision(left) !== undefined || incompleteRevision(right) !== undefined) return false;
	return Buffer.isBuffer(left) && Buffer.isBuffer(right) ? left.equals(right) : left === null && right === null;
}

class ConfigStore<T> {
	readonly extensionId: string;
	readonly path: string;
	private readonly schema: RootSchema<T>;

	constructor(extensionId: string, path: string, schema: RootSchema<T>) {
		this.extensionId = extensionId;
		this.path = path;
		this.schema = schema;
	}

	/** Read and validate the file. Never throws for file content or I/O problems, and never writes. */
	loadSync(): ConfigLoad<T> {
		const revision = this.readRevision();
		const result = this.load(revision);
		revisions.set(result, { path: this.path, revision });
		return result;
	}

	/** The file's revision, `null` when it is missing, or the read error message. */
	private readRevision(): Revision {
		try {
			return readRevisionSync(this.path, MAX_CONFIG_BYTES);
		} catch (error) {
			return isMissing(error) ? null : readIssue(error).message;
		}
	}

	private load(revision: Revision): ConfigLoad<T> {
		if (revision === null) return this.validate({}, "missing");
		if (typeof revision === "string") return this.fallback("file", [{ kind: "unreadable", key: "", message: revision }]);
		let contents: string;
		try {
			contents = decodeBounded([revision], revision.length, this.path, MAX_CONFIG_BYTES);
		} catch (error) {
			return this.fallback("file", [readIssue(error)]);
		}
		let raw: unknown;
		try {
			raw = JSON.parse(contents);
		} catch (error) {
			return this.fallback("file", [{ kind: "invalid-json", key: "", message: `invalid JSON: ${errorMessage(error)}` }]);
		}
		return this.validate(raw, "file");
	}

	/** Validate `value` strictly and replace the whole file, even a malformed one. */
	async save(value: T): Promise<void> {
		const { contents } = this.strict(value);
		await withLock(this.path, async () => {
			await writePrivateTextFileAtomically(this.path, contents);
		});
	}

	/**
	 * Validate `value` strictly and replace the whole file under a lock, but only when the file is unchanged
	 * since `snapshot`, a `loadSync()` result of a store for the same file. A changed file throws and stays unchanged.
	 * A snapshot that could not read the whole file cannot prove that, so it throws too.
	 */
	async replaceIfUnchanged(snapshot: ConfigLoad<unknown>, value: T): Promise<void> {
		const expected = revisions.get(snapshot);
		if (expected?.path !== this.path) throw new TypeError(`snapshot must be a loadSync() result for ${this.path}`);
		const incomplete = incompleteRevision(expected.revision);
		if (incomplete !== undefined) {
			throw new Error(`Config at ${this.path} was not read completely (${incomplete}), so it cannot be replaced safely; nothing was written. Fix, shrink, or remove the file, then retry.`);
		}
		const { contents } = this.strict(value);
		await withLock(this.path, async () => {
			if (!sameRevision(this.readRevision(), expected.revision)) {
				throw new Error(`Config at ${this.path} changed since it was read; nothing was written. Read it again and retry.`);
			}
			await writePrivateTextFileAtomically(this.path, contents);
		});
	}

	/** Locked read-modify-write. Refuses when the current file has any issue or the config is disabled. */
	async update(mutator: (value: T) => T): Promise<T> {
		return await withLock(this.path, async () => {
			const current = this.loadSync();
			if (current.status === "disabled" || current.issues.length) {
				throw new Error(`Config at ${this.path} has issues; fix or replace it before updating: ${formatConfigIssues(current.issues)}`);
			}
			const next = this.strict(mutator(current.value));
			await writePrivateTextFileAtomically(this.path, next.contents);
			return next.value;
		});
	}

	async remove(): Promise<void> {
		await withLock(this.path, async () => {
			await rm(this.path, { force: true });
		});
	}

	/** Validate a value to write with the read rules; any issue rejects it. */
	private strict(value: T): { value: T; contents: string } {
		const result = this.validate(JSON.parse(serialize(value)), "file");
		if (result.status === "disabled" || result.issues.length) {
			throw new Error(`Invalid config for ${this.path}: ${formatConfigIssues(result.issues)}`);
		}
		return { value: result.value, contents: serialize(result.value) };
	}

	/** True when defaults cannot replace the file's values. */
	private unsafeFallback(): boolean {
		return this.schema.kind === "fields" && Object.values(this.schema.fields).some((spec) => spec.disableOnInvalid);
	}

	private defaults(): T {
		if (this.schema.kind === "entries") return {} as T;
		return Object.fromEntries(Object.entries(this.schema.fields).map(([key, spec]) => [key, structuredClone(spec.fallback?.value)])) as T;
	}

	private fallback(source: "file" | "missing", issues: ConfigIssue[]): ConfigLoad<T> {
		return this.unsafeFallback() ? { status: "disabled", source, issues } : { status: "ok", source, value: this.defaults(), issues };
	}

	private validate(raw: unknown, source: "file" | "missing"): ConfigLoad<T> {
		if (!isRecord(raw)) return this.fallback(source, [{ kind: "invalid-root", key: "", message: "file must contain a JSON object" }]);
		const issues: ConfigIssue[] = [];
		const sink: Sink = (path, message, kind) => issues.push({ kind, key: formatKey(path), message });
		let value: T;
		if (this.schema.kind === "fields") {
			const applied = applyFields(raw, this.schema.fields, [], sink);
			if (applied.blocked) return { status: "disabled", source, issues };
			value = applied.value as T;
		} else {
			const parsed = parseValue(this.schema.entries, raw, [], sink);
			if (!parsed.ok) return this.fallback(source, [...issues, { kind: "invalid-root", key: "", message: parsed.message }]);
			value = parsed.value;
		}
		try {
			this.schema.check?.(value);
		} catch (error) {
			return this.fallback(source, [...issues, { kind: "invalid-config", key: "", message: errorMessage(error) }]);
		}
		return { status: "ok", source, value, issues };
	}
}

export type { ConfigStore };

/** The part of a store that launch reporting needs. */
export type ReportableConfig = Pick<ConfigStore<unknown>, "extensionId" | "path" | "loadSync">;

export interface ConfigReporter {
	/** Show issues in `result` that this session has not shown yet. Use it after lazy per-command or per-render reads. */
	report(ctx: Pick<ExtensionContext, "hasUI" | "ui">, store: Pick<ReportableConfig, "extensionId" | "path">, result: ConfigLoad<unknown>): void;
}

const REPORTED = Symbol.for("@henryqw/pi-config-store/reported");

/**
 * Issues shown in this session. Pi loads each extension, and so each copy of this module, separately,
 * so process state lets every reporter share one set. Pi passes one event object to all `session_start`
 * handlers; the first handler of a new event starts a new set.
 */
function reported(event?: { value: unknown }): Set<string> {
	const state = globalThis as { [REPORTED]?: { event: unknown; shown: Set<string> } };
	state[REPORTED] ??= { event: undefined, shown: new Set() };
	if (event && state[REPORTED].event !== event.value) state[REPORTED] = { event: event.value, shown: new Set() };
	return state[REPORTED].shown;
}

/**
 * On each `session_start`, load every store and show one notification per file with issues:
 * `error` when the config is disabled, otherwise `warning`. Without UI, write the text to stderr.
 * Each issue shows once per session, across every reporter of every extension.
 */
export function registerConfigReporting(pi: Pick<ExtensionAPI, "on">, stores: readonly ReportableConfig[]): ConfigReporter {
	const reporter: ConfigReporter = {
		report(ctx, store, result) {
			const shown = reported();
			const fresh = result.issues.filter((issue) => {
				const fingerprint = JSON.stringify([store.path, issue.kind, issue.key, issue.message]);
				if (shown.has(fingerprint)) return false;
				shown.add(fingerprint);
				return true;
			});
			if (!fresh.length) return;
			const disabled = result.status === "disabled";
			const text = disabled
				? `${store.extensionId} disabled (${store.path}): ${formatConfigIssues(fresh)}`
				: `${store.extensionId} config issues (${store.path}): ${formatConfigIssues(fresh)}; defaults replace invalid settings.`;
			if (ctx.hasUI) ctx.ui.notify(text, disabled ? "error" : "warning");
			else process.stderr.write(`${text}\n`);
		},
	};
	pi.on("session_start", (event, ctx) => {
		reported({ value: event });
		for (const store of stores) reporter.report(ctx, store, store.loadSync());
	});
	return reporter;
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

type StoreLocation = {
	extensionId: string;
	agentDir?: string;
	/** A JSON file name in the extension's config home. Defaults to `config.json`. */
	fileName?: string;
};

function storePath({ extensionId, agentDir, fileName = "config.json" }: StoreLocation): string {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/.test(fileName)) throw new TypeError("fileName must be one JSON file name");
	return join(extensionConfigDir(extensionId, agentDir), fileName);
}

/** Create a store for a JSON object with a fixed field table. */
export function createConfigStore<F extends Fields>(options: StoreLocation & {
	fields: F;
	/** Cross-field rule; throw to reject the whole config. */
	check?: (value: FieldsValue<F>) => void;
}): ConfigStore<FieldsValue<F>>;
/** Create a store for a JSON object whose keys are entry names, such as a map built with `parsers.record`. */
export function createConfigStore<T extends Record<string, unknown>>(options: StoreLocation & {
	entries: FieldParser<T>;
	check?: (value: T) => void;
}): ConfigStore<T>;
export function createConfigStore(options: StoreLocation & {
	fields?: Fields;
	entries?: FieldParser<Record<string, unknown>>;
	check?: (value: Record<string, unknown>) => void;
}): ConfigStore<Record<string, unknown>> {
	const schema: RootSchema<Record<string, unknown>> = options.entries
		? { kind: "entries", entries: options.entries, check: options.check }
		: { kind: "fields", fields: options.fields ?? {}, check: options.check };
	return new ConfigStore(options.extensionId, storePath(options), schema);
}
