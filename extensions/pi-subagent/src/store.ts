import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { lstat, mkdir, open, readdir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { extensionConfigDir, readTextFileBounded, writePrivateTextFileAtomically } from "@henryqw/pi-config-store";
import { check, lock } from "proper-lockfile";
import { parseRunState, RUN_STATE_VERSION, type RunState } from "./schema.ts";
import { discardResources } from "./discard.ts";
import { isMissing, isWithin } from "./worktree.ts";

const INITIAL_STATE_MAX_BYTES = 2 * 1024 * 1024;
/*
 * create() caps the complete initial serialization at 2 MiB. Loaded requests
 * are independently bounded by parseExecuteRequest.
 *
 * Saves validate and reject atomically instead of dropping valid evidence.
 * Reads use the same finite ceiling and preserve rejected files.
 */
const STATE_MAX_BYTES = 128 * 1024 * 1024;
const ADMISSION_MAX_FILES = 256;
const ADMISSION_MAX_BYTES = STATE_MAX_BYTES;
const V4_TERMINAL_STATUSES = new Set(["completed", "final_failed", "superseded", "aborted"]);
const V4_UNFINISHED_STATUSES = new Set(["pending", "running", "needs_attention"]);
const LOCK_OPTIONS = { realpath: false, stale: 30_000, update: 5_000, retries: 0 } as const;
const LIFECYCLE_LOCK_OPTIONS = {
	...LOCK_OPTIONS,
	retries: { forever: true, factor: 1, minTimeout: 25, maxTimeout: 25 },
} as const;

type ReleaseLock = Awaited<ReturnType<typeof lock>>;
const productiveRunLeaseBrand: unique symbol = Symbol("productiveRunLease");

export class ProductiveRunLeaseBusyError extends Error {
	constructor() {
		super("Another Pi Subagent productive request is active in this repository.");
	}
}

export interface ProductiveRunLease {
	readonly [productiveRunLeaseBrand]: true;
}

export type LifecycleLockOptions =
	| { readonly purpose?: "productive"; readonly productiveRunLease?: ProductiveRunLease }
	| { readonly purpose: "status" | "abort"; readonly productiveRunLease?: never };

export interface LifecycleLock {
	readonly productiveRunLeaseActive: boolean;
}

function isAlreadyPresent(error: unknown): boolean {
	return Boolean(error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "EEXIST");
}

function isLocked(error: unknown): boolean {
	return Boolean(error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ELOCKED");
}

async function canonicalPlannedPath(path: string): Promise<string> {
	let ancestor = resolve(path);
	const suffix: string[] = [];
	for (;;) {
		try {
			return resolve(await realpath(ancestor), ...suffix.reverse());
		} catch (error) {
			if (!isMissing(error)) throw error;
			const parent = dirname(ancestor);
			if (parent === ancestor) throw error;
			suffix.push(basename(ancestor));
			ancestor = parent;
		}
	}
}

function serialize(state: RunState, maxBytes = STATE_MAX_BYTES): string {
	const validated = parseRunState(state);
	const contents = `${JSON.stringify(validated, null, 2)}\n`;
	if (Buffer.byteLength(contents, "utf8") > maxBytes) {
		throw new Error(`pi-subagent state exceeds ${maxBytes} bytes.`);
	}
	return contents;
}

export class RunStateHandle {
	state: RunState;
	readonly path: string;
	private writes: Promise<void> = Promise.resolve();
	private readonly root: string;
	private readonly requestId: string;
	private readonly replace: (contents: string) => Promise<void>;

	constructor(state: RunState, path: string, replace: (contents: string) => Promise<void>) {
		this.state = state;
		this.path = path;
		this.root = state.root;
		this.requestId = state.request.id;
		this.replace = replace;
	}

	async save(): Promise<void> {
		if (this.state.root !== this.root || this.state.request.id !== this.requestId) {
			throw new Error("A state handle cannot change its owned repository or request ID.");
		}
		const contents = serialize(this.state);
		this.writes = this.writes.then(async () => await this.replace(contents));
		await this.writes;
	}
}

export class FileRunStore {
	private readonly agentDir?: string;
	private readonly onStateSaved?: (state: RunState) => void;
	private readonly productiveRunLeases = new WeakMap<ProductiveRunLease, string>();

	constructor(agentDir?: string, onStateSaved?: (state: RunState) => void) {
		this.agentDir = agentDir;
		this.onStateSaved = onStateSaved;
	}

	stateDirectory(root: string): string {
		const canonicalRoot = realpathSync.native(root);
		const directory = join(
			extensionConfigDir("pi-subagent", this.agentDir),
			"state",
			createHash("sha256").update(canonicalRoot).digest("hex"),
		);
		if (isWithin(canonicalRoot, resolve(directory))) {
			throw new Error("Pi Subagent state directory must be outside the Git workspace.");
		}
		return directory;
	}

	statePath(root: string, id: string): string {
		return join(this.stateDirectory(root), `${id}.json`);
	}

	private lockPath(root: string): string {
		return join(this.stateDirectory(root), "lifecycle.lock");
	}

	private productiveRunPath(root: string): string {
		return join(this.stateDirectory(root), "productive-run");
	}

	private async assertSafeDestination(root: string, destination: string): Promise<void> {
		if (isWithin(await canonicalPlannedPath(root), await canonicalPlannedPath(destination))) {
			throw new Error("Pi Subagent state directory must be outside the Git workspace.");
		}
	}

	async withProductiveRunLease<T>(
		root: string,
		operation: (lease: ProductiveRunLease) => Promise<T>,
	): Promise<T> {
		const directory = this.stateDirectory(root);
		await this.assertSafeDestination(root, directory);
		await mkdir(directory, { recursive: true, mode: 0o700 });
		const path = this.productiveRunPath(root);
		let release: ReleaseLock;
		try {
			release = await lock(path, { ...LOCK_OPTIONS, lockfilePath: `${path}.lock` });
		} catch (error) {
			if (isLocked(error)) {
				throw new ProductiveRunLeaseBusyError();
			}
			throw error;
		}
		const lease: ProductiveRunLease = { [productiveRunLeaseBrand]: true };
		this.productiveRunLeases.set(lease, path);
		try {
			return await operation(lease);
		} finally {
			this.productiveRunLeases.delete(lease);
			await release();
		}
	}

	async hasProductiveRunLease(root: string): Promise<boolean> {
		const directory = this.stateDirectory(root);
		await this.assertSafeDestination(root, directory);
		const path = this.productiveRunPath(root);
		return await check(path, { realpath: false, stale: LOCK_OPTIONS.stale, lockfilePath: `${path}.lock` });
	}

	async withLock<T>(
		root: string,
		operation: (lifecycle: LifecycleLock) => Promise<T>,
		options: LifecycleLockOptions = {},
	): Promise<T> {
		const directory = this.stateDirectory(root);
		await this.assertSafeDestination(root, directory);
		await mkdir(directory, { recursive: true, mode: 0o700 });
		const path = this.lockPath(root);
		const release: ReleaseLock = await lock(path, { ...LIFECYCLE_LOCK_OPTIONS, lockfilePath: `${path}.lock` });
		try {
			const productiveRunLeaseActive = await this.hasProductiveRunLease(root);
			const ownedProductiveRunPath = options.productiveRunLease
				? this.productiveRunLeases.get(options.productiveRunLease)
				: undefined;
			if (productiveRunLeaseActive
				&& (options.purpose ?? "productive") === "productive"
				&& ownedProductiveRunPath !== this.productiveRunPath(root)) {
				throw new Error("Another Pi Subagent productive request is active in this repository.");
			}
			const lifecycle: LifecycleLock = { productiveRunLeaseActive };
			return await operation(lifecycle);
		} finally {
			await release();
		}
	}

	async create(state: RunState): Promise<RunStateHandle> {
		const path = this.statePath(state.root, state.request.id);
		await this.assertSafeDestination(state.root, path);
		await mkdir(dirname(path), { recursive: true, mode: 0o700 });
		const contents = serialize(state, INITIAL_STATE_MAX_BYTES);
		let file: Awaited<ReturnType<typeof open>> | undefined;
		try {
			file = await open(path, "wx", 0o600);
			await file.writeFile(contents, "utf8");
			await file.sync();
			await file.close();
			file = undefined;
		} catch (error) {
			await file?.close();
			if (isAlreadyPresent(error)) throw new Error(`Pi Subagent request ${state.request.id} already exists.`);
			throw error;
		}
		const saved = JSON.parse(contents) as RunState;
		this.onStateSaved?.(structuredClone(saved));
		return this.handle(saved, path);
	}

	async load(root: string, id: string): Promise<RunStateHandle> {
		const path = this.statePath(root, id);
		let raw: string;
		try {
			raw = await readTextFileBounded(path, STATE_MAX_BYTES);
		} catch (error) {
			if (error instanceof Error && error.message === `Text file exceeds ${STATE_MAX_BYTES} bytes: ${path}`) {
				throw new Error(`pi-subagent state exceeds ${STATE_MAX_BYTES} bytes.`);
			}
			throw error;
		}
		const state = parseRunState(JSON.parse(raw));
		if (state.root !== realpathSync.native(root) || state.request.id !== id) {
			throw new Error("pi-subagent state identity does not match its repository and filename.");
		}
		return this.handle(state, path);
	}

	/** Address saved state without resolving a parent checkout that may no longer exist. */
	private async validateDirectory(directory: string): Promise<void> {
		const parent = join(extensionConfigDir("pi-subagent", this.agentDir), "state");
		if (dirname(directory) !== parent || !/^[a-f0-9]{64}$/.test(basename(directory))
			|| !(await lstat(directory)).isDirectory() || await realpath(directory) !== join(await realpath(parent), basename(directory))) {
			throw new Error("Invalid Pi Subagent state directory.");
		}
	}

	async loadFromDirectory(directory: string, id: string): Promise<RunStateHandle> {
		await this.validateDirectory(directory);
		return await this.loadFromValidatedDirectory(directory, id);
	}

	private async loadFromValidatedDirectory(directory: string, id: string): Promise<RunStateHandle> {
		if (basename(id) !== id || !id || id === "." || id === "..") throw new Error("Invalid request ID.");
		const path = join(directory, `${id}.json`);
		if (!(await lstat(path)).isFile()) throw new Error("State is not a regular file.");
		const state = parseRunState(JSON.parse(await readTextFileBounded(path, STATE_MAX_BYTES)));
		if (state.request.id !== id || !isAbsolute(state.root)
			|| createHash("sha256").update(state.root).digest("hex") !== basename(directory)) {
			throw new Error("pi-subagent state identity does not match its directory and filename.");
		}
		await this.assertSafeDestination(state.root, path);
		return this.handle(state, path);
	}

	async hasProductiveRunLeaseInDirectory(directory: string): Promise<boolean> {
		await this.validateDirectory(directory);
		const path = join(directory, "productive-run");
		return await check(path, { realpath: false, stale: LOCK_OPTIONS.stale, lockfilePath: `${path}.lock` });
	}

	async withDirectoryLock<T>(directory: string, operation: () => Promise<T>): Promise<T> {
		await this.validateDirectory(directory);
		const path = join(directory, "lifecycle.lock");
		const release = await lock(path, { ...LIFECYCLE_LOCK_OPTIONS, lockfilePath: `${path}.lock` });
		try { return await operation(); } finally { await release(); }
	}

	/** Missing roots only; repoRoot records the stable primary checkout, not the removed parent. */
	async listOrphans(primary: string): Promise<{ states: RunStateHandle[]; invalidIds: string[] }> {
		const parent = join(extensionConfigDir("pi-subagent", this.agentDir), "state");
		let directories;
		try { directories = await readdir(parent, { withFileTypes: true }); }
		catch (error) { if (isMissing(error)) return { states: [], invalidIds: [] }; throw error; }
		const states: RunStateHandle[] = [];
		const invalidIds: string[] = [];
		for (const entry of directories) {
			const directory = join(parent, entry.name);
			try {
				await this.validateDirectory(directory);
				// Every state in a directory shares one root; a live root means no orphan can be here.
				const invalid: string[] = [];
				let live = false;
				for (const file of await readdir(directory)) {
					if (!file.endsWith(".json")) continue;
					try {
						const handle = await this.loadFromValidatedDirectory(directory, file.slice(0, -5));
						try { await lstat(handle.state.root); live = true; break; }
						catch (error) { if (!isMissing(error)) throw error; }
						const worktrees = discardResources(handle.state).flatMap((resource) => resource.worktree ? [resource.worktree] : []);
						if (worktrees.length && worktrees.every((item) => item.repoRoot === primary)) states.push(handle);
					} catch { invalid.push(join(directory, file)); }
				}
				if (!live) invalidIds.push(...invalid);
			} catch { invalidIds.push(directory); }
		}
		return { states, invalidIds };
	}

	private async stateEntries(root: string) {
		try {
			return (await readdir(this.stateDirectory(root), { withFileTypes: true }))
				.filter((item) => item.name.endsWith(".json"))
				.sort((a, b) => a.name.localeCompare(b.name));
		} catch (error) {
			if (isMissing(error)) return [];
			throw error;
		}
	}

	/** Read only version and request status; never migrate or interpret v4 worker evidence. */
	async assertLegacyAdmissionSafe(root: string): Promise<void> {
		const directory = this.stateDirectory(root);
		await this.assertSafeDestination(root, directory);
		const entries = await this.stateEntries(root);
		if (entries.length > ADMISSION_MAX_FILES) {
			throw new Error(`Pi Subagent cannot inventory more than ${ADMISSION_MAX_FILES} state files for safe admission; recover older requests with their owning version first.`);
		}
		let remainingBytes = ADMISSION_MAX_BYTES;
		for (const entry of entries) {
			const id = entry.name.slice(0, -5);
			const path = join(directory, entry.name);
			const recovery = `State preserved at ${path}. Inspect and recover any retained workers with their compatible owner before starting new isolated work.`;
			let value: unknown;
			try {
				if (!entry.isFile()) throw new Error("State is not a regular file.");
				if (remainingBytes === 0) throw new Error("Admission inventory byte limit reached.");
				const raw = await readTextFileBounded(path, remainingBytes);
				remainingBytes -= Buffer.byteLength(raw, "utf8");
				value = JSON.parse(raw);
			} catch {
				throw new Error(`Pi Subagent cannot read state ${id} for safe admission. ${recovery}`);
			}
			if (!value || typeof value !== "object" || Array.isArray(value) || !("version" in value)) {
				throw new Error(`Pi Subagent malformed state ${id} blocks safe admission. ${recovery}`);
			}
			if (value.version === RUN_STATE_VERSION) continue;
			if (value.version !== 4 || !("status" in value) || typeof value.status !== "string"
				|| (!V4_TERMINAL_STATUSES.has(value.status) && !V4_UNFINISHED_STATUSES.has(value.status))) {
				throw new Error(`Pi Subagent malformed or unsupported legacy state ${id} blocks safe admission. ${recovery}`);
			}
			if (V4_UNFINISHED_STATUSES.has(value.status)) {
				throw new Error(`Pi Subagent unfinished v4 request ${id} (${value.status}) blocks new isolated work. ${recovery}`);
			}
		}
	}

	async list(root: string): Promise<{ states: RunStateHandle[]; invalidIds: string[] }> {
		const entries = await this.stateEntries(root);
		const states: RunStateHandle[] = [];
		const invalidIds: string[] = [];
		for (const entry of entries) {
			const id = entry.name.slice(0, -5);
			// A symlink, directory, or other non-regular entry is unreadable state, never absent state.
			if (!entry.isFile()) { invalidIds.push(id); continue; }
			try {
				states.push(await this.load(root, id));
			} catch {
				invalidIds.push(id);
			}
		}
		return { states, invalidIds };
	}

	/** Raw text of a state file, for evidence when it does not parse. */
	async readRaw(root: string, id: string): Promise<string> {
		const path = this.statePath(root, id);
		if (!(await lstat(path)).isFile()) throw new Error(`State entry ${id} is not a regular file.`);
		return await readTextFileBounded(path, STATE_MAX_BYTES);
	}

	private handle(state: RunState, path: string): RunStateHandle {
		return new RunStateHandle(state, path, async (contents) => {
			await this.assertSafeDestination(state.root, path);
			await writePrivateTextFileAtomically(path, contents);
			this.onStateSaved?.(JSON.parse(contents) as RunState);
		});
	}
}
